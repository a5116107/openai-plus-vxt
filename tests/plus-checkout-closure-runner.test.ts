import assert from 'node:assert/strict';
import test from 'node:test';
import { enforceRequiredNetworkPlanes } from '../src/features/automation/plus-checkout-closure-runner';
import type { PlusCheckoutClosureRun } from '../src/features/automation/plus-checkout-closure';

test('strict closure success requires verified auth, checkout and billing planes', () => {
  const base: PlusCheckoutClosureRun = {
    id: 'pcc-test', accountDigest: 'digest', phase: 'subscription_verified', billingCountry: 'US',
    submitted: true, subscriptionVerified: true, submitCount: 1, verifyReference: '', finalPlanType: 'chatgpt-plus',
    message: '', createdAt: 1, updatedAt: 2,
    networkEvidence: [
      evidence('browser-auth'),
      evidence('server-checkout'),
    ],
  };
  const blocked = enforceRequiredNetworkPlanes(base, true);
  assert.equal(blocked.phase, 'failed_terminal');
  assert.equal(blocked.errorCode, 'NETWORK_EVIDENCE_MISSING');
  assert.match(blocked.message, /browser-billing/);

  const passed = enforceRequiredNetworkPlanes({
    ...base,
    networkEvidence: [...base.networkEvidence, evidence('browser-billing')],
  }, true);
  assert.equal(passed.phase, 'subscription_verified');
});

function evidence(plane: 'browser-auth' | 'browser-billing' | 'server-checkout') {
  return {
    plane, requestId: `req-${plane}`, ip: '203.0.113.7', country: 'PH', colo: 'MNL',
    asn: 'AS64500', verified: true, capturedAt: 1,
  };
}
