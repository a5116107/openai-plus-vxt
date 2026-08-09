import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildReadinessReport,
  containsSensitiveShapes,
  inspectJwt,
  parseProxyDescriptor,
  parseTraceOutput,
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
    target: 'chatgpt', plane: 'proxy', proxy: { configured: true },
    trace: { ok: true, httpStatus: 200, country: 'SG', colo: 'SIN', ip },
  }));
  const ready = buildReadinessReport({ token: { valid: true, present: true }, sessions: {}, payment: { ok: true }, traces });
  assert.equal(ready.gates.fullLiveReady, true);
  const blocked = buildReadinessReport({ token: { valid: false }, sessions: { valid: 0 }, payment: { ok: false }, traces: traces.slice(0, 1) });
  assert.equal(blocked.gates.fullLiveReady, false);
  assert.deepEqual(blocked.blockedReasons, ['identity-missing', 'fewer-than-three-unique-egresses', 'saved-payment-preflight']);
});

test('readiness evidence rejects sensitive shapes', () => {
  assert.equal(containsSensitiveShapes({ token: 'eyJabc.def.ghi', ip: '203.0.113.1' }), true);
  assert.equal(containsSensitiveShapes({ tokenConfigured: true, country: 'SG', httpStatus: 200 }), false);
});
