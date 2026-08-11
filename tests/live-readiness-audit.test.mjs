import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildReadinessReport,
  buildStageEgressSummary,
  buildLiveStageProxyEnvironment,
  containsSensitiveShapes,
  evaluateTargetStability,
  inspectSessions,
  inspectJwt,
  parseLiveProbePlan,
  parseProxyDescriptor,
  parseTraceOutput,
  publicPaymentPreflight,
  publicHistoryEntry,
  publicTrace,
  validateIdentityToken,
} from '../scripts/live-readiness-audit.mjs';

function jwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode(payload)}.signature`;
}

test('JWT inspection is fail-closed and never returns claims', () => {
  const valid = inspectJwt(jwt({ exp: 200 }), 100);
  const expired = inspectJwt(jwt({ exp: 99 }), 100);
  const malformed = inspectJwt('not-a-token', 100);
  assert.deepEqual(valid, { present: true, shapeValid: true, expired: false, valid: true });
  assert.equal(expired.valid, false);
  assert.equal(malformed.shapeValid, false);
  assert.equal(Object.prototype.hasOwnProperty.call(valid, 'email'), false);
});

test('identity validation requires server acceptance and never reads the response body', async () => {
  const token = jwt({ exp: 200 });
  let bodyRead = false;
  const accepted = await validateIdentityToken(token, {
    now: 100,
    request: async () => ({ ok: true, status: 200, text: async () => { bodyRead = true; } }),
  });
  assert.deepEqual(accepted, {
    present: true,
    shapeValid: true,
    expired: false,
    locallyValid: true,
    serverAttempted: true,
    serverAccepted: true,
    status: 'accepted',
    httpStatus: 200,
    valid: true,
  });
  assert.equal(bodyRead, false);

  const rejected = await validateIdentityToken(token, {
    now: 100,
    request: async () => ({ ok: false, status: 401 }),
  });
  assert.equal(rejected.serverAccepted, false);
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.valid, false);
});

test('identity validation skips malformed tokens and fails closed on network errors', async () => {
  let requestCount = 0;
  const malformed = await validateIdentityToken('not-a-token', {
    request: async () => { requestCount += 1; },
  });
  assert.equal(malformed.status, 'invalid');
  assert.equal(malformed.serverAttempted, false);
  assert.equal(requestCount, 0);

  const unreachable = await validateIdentityToken(jwt({ exp: 200 }), {
    now: 100,
    request: async () => { throw new Error('offline'); },
  });
  assert.equal(unreachable.status, 'unreachable');
  assert.equal(unreachable.serverAccepted, false);
  assert.equal(unreachable.valid, false);
});

test('session candidates require the same server acceptance before becoming valid', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'opx-live-sessions-'));
  try {
    await writeFile(path.join(directory, 'candidate.json'), JSON.stringify({ access_token: jwt({ exp: 200 }) }));
    await writeFile(path.join(directory, 'invalid.json'), JSON.stringify({ access_token: 'not-a-token' }));
    let validationCount = 0;
    const sessions = await inspectSessions(directory, {
      now: 100,
      validateToken: async () => {
        validationCount += 1;
        return { serverAttempted: true, serverAccepted: false };
      },
    });
    assert.deepEqual(sessions, {
      configured: true,
      exists: true,
      files: 2,
      candidates: 1,
      checked: 1,
      valid: 0,
      invalid: 2,
    });
    assert.equal(validationCount, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('proxy and trace summaries exclude host credentials and IP', () => {
  const descriptor = parseProxyDescriptor('socks5h://user:secret@127.0.0.1:10808');
  assert.equal(descriptor.accepted, true);
  assert.equal(descriptor.hasCredentials, true);
  const trace = parseTraceOutput('ip=203.0.113.10\nloc=SG\ncolo=SIN\n', 200);
  assert.deepEqual(publicTrace(trace), { ok: true, httpStatus: 200, country: 'SG', colo: 'SIN' });
  assert.equal(Object.prototype.hasOwnProperty.call(publicTrace(trace), 'ip'), false);
});

test('full readiness requires identity, three egresses, target reachability and payment preflight', () => {
  const traces = ['a', 'b', 'c'].map((ip, index) => ({
    target: 'chatgpt', plane: 'stage', stage: ['auth', 'checkout', 'billing'][index], proxy: { configured: true, accepted: true },
    trace: { ok: true, httpStatus: 200, country: 'SG', colo: 'SIN', ip },
  }));
  const ready = buildReadinessReport({ token: { valid: true, serverAccepted: true, present: true }, sessions: {}, payment: { ok: true }, probePlan: { ready: true }, targetStability: { ready: true }, traces });
  assert.equal(ready.gates.fullLiveReady, true);
  const localOnly = buildReadinessReport({ token: { valid: true, serverAccepted: false, present: true }, sessions: {}, payment: { ok: true }, probePlan: { ready: true }, targetStability: { ready: true }, traces });
  assert.equal(localOnly.gates.identityReady, false);
  assert.equal(localOnly.gates.fullLiveReady, false);
  const blocked = buildReadinessReport({ token: { valid: false }, sessions: { valid: 0 }, payment: { ok: false }, traces: traces.slice(0, 1) });
  assert.equal(blocked.gates.fullLiveReady, false);
  assert.deepEqual(blocked.blockedReasons, [
    'identity-missing',
    'target-stability-missing',
    'fewer-than-three-unique-egresses',
    'multi-stage-egress-missing',
    'saved-payment-preflight',
    'probe-plan-missing',
  ]);
});

test('egress diversity counts only successful ChatGPT target observations', () => {
  const traces = [
    { target: 'chatgpt', trace: { ok: true, ip: 'same' } },
    { target: 'chatgpt', trace: { ok: false, ip: 'failed' } },
    { target: 'cloudflare', trace: { ok: true, ip: 'other-target' } },
  ];
  const report = buildReadinessReport({ token: { valid: true }, payment: { ok: true }, traces });
  assert.equal(report.egress.uniqueEgressCount, 1);
  assert.equal(report.gates.exitDiversityReady, false);
});

test('multi-stage readiness requires accepted, reachable and distinct stage exits', () => {
  const traces = ['auth', 'checkout', 'billing'].map((stage) => ({
    target: 'chatgpt', stage, proxy: { configured: true, accepted: true }, trace: { ok: true, ip: stage },
  }));
  assert.equal(buildStageEgressSummary(traces).ready, true);
  traces[2].trace.ip = 'auth';
  assert.equal(buildStageEgressSummary(traces).ready, false);
});

test('live probe plan requires explicit countries, two supported methods and UI mode', () => {
  const plan = parseLiveProbePlan({
    OPX_LIVE_COUNTRIES: 'sg,us',
    OPX_LIVE_PAYMENT_METHODS: 'hosted,paypal,unknown',
    OPX_LIVE_CHECKOUT_UI_MODE: 'both',
    OPX_LIVE_SAMPLE_COUNT: '99',
  });
  assert.equal(plan.ready, true);
  assert.deepEqual(plan.countries, ['SG', 'US']);
  assert.deepEqual(plan.paymentMethods, ['hosted', 'paypal']);
  assert.equal(plan.invalidPaymentMethodCount, 1);
  assert.equal(plan.sampleCount, 20);
  assert.equal(JSON.stringify(plan).includes('unknown'), false);
});

test('stage proxy component input constructs distinct SOCKS5 stage URLs without overriding explicit URLs', () => {
  const resolved = buildLiveStageProxyEnvironment({
    OPX_LIVE_PROXY_HOST: 'proxy.fixture.test:3000',
    OPX_LIVE_PROXY_ACCOUNT: 'account',
    OPX_LIVE_PROXY_PASSWORD: 'secret value',
    OPX_LIVE_PROXY_COUNTRIES: 'jp,sg,de',
    OPX_LIVE_PROXY_SESSION_IDS: 'auth-id,checkout-id,billing-id',
    OPX_LIVE_PROXY_SESSION_MINUTES: '5',
    OPX_LIVE_AUTH_PROXY: 'socks5://explicit.fixture.test:1080',
  });
  assert.equal(resolved.OPX_LIVE_AUTH_PROXY, 'socks5://explicit.fixture.test:1080');
  const checkout = new URL(resolved.OPX_LIVE_CHECKOUT_PROXY);
  const billing = new URL(resolved.OPX_LIVE_BILLING_PROXY);
  assert.equal(checkout.protocol, 'socks5:');
  assert.equal(checkout.host, 'proxy.fixture.test:3000');
  assert.equal(decodeURIComponent(checkout.username), 'account-region-SG-sid-checkout-id-t-5');
  assert.equal(decodeURIComponent(checkout.password), 'secret value');
  assert.equal(decodeURIComponent(billing.username), 'account-region-DE-sid-billing-id-t-5');
  assert.notEqual(resolved.OPX_LIVE_CHECKOUT_PROXY, resolved.OPX_LIVE_BILLING_PROXY);
  assert.equal(decodeURIComponent(new URL(resolved.OPX_LIVE_FRONT_PROXY).username), 'account-region-JP-sid-auth-id-t-5');
  assert.equal(resolved.OPX_LIVE_EXIT_PROXIES, `${resolved.OPX_LIVE_CHECKOUT_PROXY},${resolved.OPX_LIVE_BILLING_PROXY}`);
});

test('stage proxy component input requires a complete country and session mapping', () => {
  const input = {
    OPX_LIVE_PROXY_HOST: 'proxy.fixture.test:3000',
    OPX_LIVE_PROXY_ACCOUNT: 'account',
    OPX_LIVE_PROXY_PASSWORD: 'secret',
    OPX_LIVE_PROXY_COUNTRIES: 'JP,SG',
    OPX_LIVE_PROXY_SESSION_IDS: 'auth-id,checkout-id,billing-id',
  };
  const resolved = buildLiveStageProxyEnvironment(input);
  assert.equal(resolved.OPX_LIVE_AUTH_PROXY, undefined);
  assert.equal(resolved.OPX_LIVE_CHECKOUT_PROXY, undefined);
  assert.equal(resolved.OPX_LIVE_BILLING_PROXY, undefined);
});

test('saved payment runtime readiness is projected into the public payment gate', () => {
  assert.deepEqual(publicPaymentPreflight({ preflightOk: true, preflight: { profileExists: true } }), {
    ok: true,
    profileExists: true,
  });
});

test('target stability requires two consecutive successes within a bounded window', () => {
  assert.equal(evaluateTargetStability([], true).ready, false);
  assert.equal(evaluateTargetStability([{ targetReachable: true }], true).ready, true);
  const unstable = evaluateTargetStability([{ targetReachable: true }, { targetReachable: false }], true);
  assert.equal(unstable.ready, false);
  assert.equal(unstable.sampleCount, 3);
});

test('history entries keep only sanitized readiness fields', () => {
  const entry = publicHistoryEntry({
    generatedAt: '2026-08-09T00:00:00.000Z',
    gates: { targetReachable: true, fullLiveReady: false },
    egress: { uniqueEgressCount: 1, stageEgress: { uniqueEgressCount: 0 } },
    blockedReasons: ['identity-missing'],
    token: 'eyJabc.def.ghi',
  });
  assert.equal(entry.targetReachable, true);
  assert.equal(containsSensitiveShapes(entry), false);
  assert.equal(Object.prototype.hasOwnProperty.call(entry, 'token'), false);
});

test('readiness evidence rejects sensitive shapes', () => {
  assert.equal(containsSensitiveShapes({ token: 'eyJabc.def.ghi', ip: '203.0.113.1' }), true);
  assert.equal(containsSensitiveShapes({ tokenConfigured: true, country: 'SG', httpStatus: 200 }), false);
});
