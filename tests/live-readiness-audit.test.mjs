import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildReadinessReport,
  buildStageEgressSummary,
  containsSensitiveShapes,
  inspectJwt,
  parseLiveProbePlan,
  parseProxyDescriptor,
  parseTraceOutput,
  publicPaymentPreflight,
  publicTrace,
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
  const ready = buildReadinessReport({ token: { valid: true, present: true }, sessions: {}, payment: { ok: true }, probePlan: { ready: true }, traces });
  assert.equal(ready.gates.fullLiveReady, true);
  const blocked = buildReadinessReport({ token: { valid: false }, sessions: { valid: 0 }, payment: { ok: false }, traces: traces.slice(0, 1) });
  assert.equal(blocked.gates.fullLiveReady, false);
  assert.deepEqual(blocked.blockedReasons, [
    'identity-missing',
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

test('saved payment runtime readiness is projected into the public payment gate', () => {
  assert.deepEqual(publicPaymentPreflight({ preflightOk: true, preflight: { profileExists: true } }), {
    ok: true,
    profileExists: true,
  });
});

test('readiness evidence rejects sensitive shapes', () => {
  assert.equal(containsSensitiveShapes({ token: 'eyJabc.def.ghi', ip: '203.0.113.1' }), true);
  assert.equal(containsSensitiveShapes({ tokenConfigured: true, country: 'SG', httpStatus: 200 }), false);
});
