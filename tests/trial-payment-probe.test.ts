import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendQualificationEvidence,
  classifyCheckoutQualification,
  qualificationLinkAggregateStatus,
} from '../src/features/probe/qualification';
import {
  buildPaymentOperationIdempotencyKey,
  evaluateProbeBudget,
  recoveryActionForPaymentCheckpoint,
} from '../src/features/probe/execution-policy';
import { DEFAULT_PROBE_TASK_CONFIG, normalizeProbeState, normalizeTaskConfig } from '../src/features/probe/state';

test('统一资格分类覆盖八类资格与严格证据等级', () => {
  const cases = [
    [{ amount_total: 0, currency: 'usd' }, 'zero_amount', 'strict-response', true],
    [{ amount_total: 0, currency: 'usd', free_trial: { days: 30 } }, 'free_trial', 'strict-response', true],
    [{ amount_total: 0, currency: 'usd', promo_campaign: { id: 'summer' } }, 'promo_zero', 'strict-response', true],
    [{ amount_total: 0, recurring_amount_minor: 2000, currency: 'usd', introductory: true }, 'intro_discount_zero', 'strict-response', true],
    [{ amount_total: 0, recurring_amount_minor: 2000, currency: 'usd', payment_method_collection: 'always' }, 'deferred_payment', 'strict-response', true],
    [{ amount_total: 2000, currency: 'usd' }, 'nonzero', 'strict-response', false],
    [{ message: 'free trial may be available' }, 'candidate', 'candidate', false],
    [{ message: 'ordinary checkout' }, 'unknown', 'candidate', false],
  ] as const;

  for (const [payload, expectedType, expectedLevel, qualified] of cases) {
    const evidence = classifyCheckoutQualification(payload, { source: 'create-response', observedAt: 100 });
    assert.equal(evidence.type, expectedType);
    assert.equal(evidence.level, expectedLevel);
    assert.equal(evidence.qualified, qualified);
  }

  const page = classifyCheckoutQualification({ amount_total: 0, currency: 'usd' }, {
    source: 'checkout-page', observedAt: 101,
  });
  assert.equal(page.level, 'strict-page');
  const entitlement = classifyCheckoutQualification({ amount_total: 0, currency: 'usd' }, {
    source: 'entitlement', entitlementVerified: true, observedAt: 102,
  });
  assert.equal(entitlement.level, 'entitlement-verified');
  assert.equal(classifyCheckoutQualification({
    amount_total: 0, currency: 'usd', free_trial: false, promo: false,
  }, { source: 'create-response', observedAt: 103 }).type, 'zero_amount');
});

test('资格账本保留晋级证据并记录金额、币种、身份、方式和资格漂移', () => {
  const first = classifyCheckoutQualification({
    amount_total: 0, currency: 'usd', free_trial: true, payment_method_types: ['paypal', 'upi'],
  }, { source: 'create-response', sessionId: 'cs_a', identityKey: 'account-a', observedAt: 100 });
  const initial = appendQualificationEvidence([], [], first);
  assert.equal(initial.ledger.length, 1);
  assert.equal(initial.driftEvents.length, 0);

  const changed = classifyCheckoutQualification({
    amount_total: 100, currency: 'eur', payment_method_types: ['pix'],
  }, { source: 'provider-final', sessionId: 'cs_a', identityKey: 'account-b', observedAt: 200 });
  const next = appendQualificationEvidence(initial.ledger, initial.driftEvents, changed);
  assert.deepEqual(new Set(next.driftEvents.map((item) => item.kind)), new Set([
    'amount', 'currency', 'identity', 'payment-method', 'qualification',
  ]));
  assert.equal(next.ledger.length, 2);
  assert.equal(next.stopRequired, true);
});

test('支付终链聚合状态严格要求源资格、方式呈现、资格保持和终链白名单', () => {
  const base = {
    sourceQualificationVerified: true,
    sourceSessionReused: true,
    methodOffered: true,
    qualificationPreserved: true,
    qualificationVerified: true,
    finalLinkVerified: true,
  };
  assert.equal(qualificationLinkAggregateStatus(base), 'qualified_payment_link');
  assert.equal(qualificationLinkAggregateStatus({ ...base, methodOffered: false }), 'probe_required');
  assert.equal(qualificationLinkAggregateStatus({ ...base, qualificationPreserved: false }), 'probe_required');
  assert.equal(qualificationLinkAggregateStatus({ ...base, finalLinkVerified: false }), 'probe_required');
  assert.equal(qualificationLinkAggregateStatus({ ...base, forcedProbe: true }), 'probe_required');
  assert.equal(qualificationLinkAggregateStatus({
    ...base, sessionMode: 'independent_checkout', sessionDistinct: false,
  }), 'probe_required');
  assert.equal(qualificationLinkAggregateStatus({
    ...base, sessionMode: 'independent_checkout', sessionDistinct: true, sourceSessionReused: false,
  }), 'qualified_payment_link');
});

test('默认 hybrid 流量和运行预算与 SSOT 一致', () => {
  const config = normalizeTaskConfig({});
  assert.deepEqual([
    config.exploitTrafficPercent, config.balancedTrafficPercent, config.explorationTrafficPercent,
  ], [60, 25, 15]);
  assert.equal(config.maxProbeUnitsPerRun, DEFAULT_PROBE_TASK_CONFIG.maxProbeUnitsPerRun);
  assert.equal(config.maxCheckoutAttemptsPerUnit, 3);
  assert.equal(config.maxPaymentMethodsPerQualification, 10);
  assert.equal(config.maxWriteOperationsPerMethod, 2);

  const allowed = evaluateProbeBudget(config, {
    probeUnits: 0, checkoutAttempts: 0, methodAttempts: 0, confirmWrites: 0, approveWrites: 0,
    consecutiveQualificationDrifts: 0,
  }, 'confirm');
  assert.equal(allowed.allowed, true);
  const blocked = evaluateProbeBudget(config, {
    probeUnits: 0, checkoutAttempts: 0, methodAttempts: 0, confirmWrites: 1, approveWrites: 1,
    consecutiveQualificationDrifts: 0,
  }, 'confirm');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.code, 'WRITE_BUDGET_EXHAUSTED');
});

test('支付写操作使用稳定幂等键，未知副作用恢复只查询原 Checkout', () => {
  const key = buildPaymentOperationIdempotencyKey('run-a', 'account-a', 'cs_test_a', 'upi');
  assert.equal(key, buildPaymentOperationIdempotencyKey('run-a', 'account-a', 'cs_test_a', 'upi'));
  assert.notEqual(key, buildPaymentOperationIdempotencyKey('run-a', 'account-a', 'cs_test_b', 'upi'));
  assert.notEqual(key, buildPaymentOperationIdempotencyKey('run-a', 'account-a', 'cs_test_a', 'upi', 'route-b'));
  assert.notEqual(key, buildPaymentOperationIdempotencyKey('run-a', 'account-a', 'cs_test_a', 'upi', 'default', 2));
  assert.equal(recoveryActionForPaymentCheckpoint({
    status: 'link_ready', confirmSubmitted: true, approveSubmitted: false, sideEffect: 'confirmed',
  }), 'revalidate_completed');
  assert.equal(recoveryActionForPaymentCheckpoint({
    status: 'side_effect_inconclusive', confirmSubmitted: true, approveSubmitted: false, sideEffect: 'unknown',
  }), 'query_original_checkout');
  assert.equal(recoveryActionForPaymentCheckpoint({
    status: 'network_inconclusive', confirmSubmitted: false, approveSubmitted: false, sideEffect: 'none',
  }), 'restart_read_only');
});

test('支付恢复收据归一化只保留脱敏状态和严格门摘要', () => {
  const state = normalizeProbeState({
    paymentOperationReceipts: [{
      version: 1,
      operationKey: 'payment-operation/run/account/cs_test/upi',
      checkoutSessionId: 'cs_test',
      method: 'upi',
      stage: 'confirm',
      status: 'running',
      code: 'CONFIRM_SUBMITTED',
      updatedAt: 123,
      confirmSubmitted: true,
      approveSubmitted: false,
      sideEffect: 'unknown',
      paymentMethodId: 'pm_test',
      payload: { accessToken: 'secret' },
      gate: {
        passed: true, amount: 0, mode: 'subscription', currency: 'inr', methods: ['upi'], reasons: [], checkedAt: 120,
      },
    }],
  });
  assert.equal(state.paymentOperationReceipts.length, 1);
  assert.equal(state.paymentOperationReceipts[0].gate?.passed, true);
  assert.doesNotMatch(JSON.stringify(state.paymentOperationReceipts[0]), /secret|accessToken|payload/);
});
