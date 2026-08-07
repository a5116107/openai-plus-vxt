import assert from 'node:assert/strict';
import test from 'node:test';

import { listCheckoutRegions } from '../src/features/link-extractor/checkout';
import { isAllowedFinalPaymentUrl, resolvePaymentCapability } from '../src/features/payment/methods';
import { runNativePaymentRunner, paymentProxyRoleForStage } from '../src/features/payment/native-runner';
import { evaluateStrictZeroGate } from '../src/features/payment/strict-zero-gate';
import { buildPaymentLinkEvidence } from '../src/features/probe/payment-evidence';
import type {
  PaymentRunnerCheckpoint,
  PaymentRunnerContext,
  PaymentRunnerTransport,
  PaymentStepResult,
} from '../src/features/payment/runner-types';

const validGatePayload = {
  amount_total: 0,
  mode: 'subscription',
  currency: 'inr',
  payment_method_types: ['upi'],
};

const context: PaymentRunnerContext = {
  method: 'upi',
  checkoutSessionId: 'cs_test_runner',
  stripePublishableKey: 'pk_test_runner',
  accessToken: 'token',
  processorEntity: 'openai_ie',
  billingCountry: 'IN',
  billingEmail: 'runner@example.test',
};

function ok<T>(data: T, code: string): PaymentStepResult<T> {
  return { ok: true, data, code, message: code, sideEffect: 'confirmed' };
}

function makeTransport(overrides: Partial<PaymentRunnerTransport> = {}): PaymentRunnerTransport {
  return {
    screen: async () => ok(validGatePayload, 'SCREEN_OK'),
    revalidate: async () => ok(validGatePayload, 'REVALIDATE_OK'),
    createPaymentMethod: async () => ok({ id: 'pm_test_runner' }, 'PM_OK'),
    confirm: async () => ok({ payload: {}, requiresApproval: false }, 'CONFIRM_OK'),
    approve: async () => ok({ payload: {}, approved: true }, 'APPROVE_OK'),
    poll: async () => ok({ payload: {}, redirectUrl: 'https://payments.stripe.com/upi/instructions/test' }, 'POLL_OK'),
    finalize: async () => ok({ url: 'https://payments.stripe.com/upi/instructions/test' }, 'FINAL_OK'),
    ...overrides,
  };
}

test('严格零元门只接受完整且一致的可信字段', () => {
  const gate = evaluateStrictZeroGate(validGatePayload, 'upi', 'inr', 123);
  assert.equal(gate.passed, true);
  assert.equal(gate.amount, 0);
  assert.equal(gate.mode, 'subscription');
  assert.equal(gate.currency, 'inr');
  assert.deepEqual(gate.methods, ['upi']);
  assert.equal(gate.checkedAt, 123);
});

test('严格零元门拒绝金额、mode、币种和方式冲突', () => {
  const cases = [
    [{ ...validGatePayload, amount: 1 }, 'amount_conflict'],
    [{ ...validGatePayload, elements_options: { mode: 'payment' } }, 'mode_conflict'],
    [{ ...validGatePayload, elements_options: { currency: 'usd' } }, 'currency_conflict'],
    [{ ...validGatePayload, elements_options: { payment_method_types: ['pix'] } }, 'methods_conflict'],
  ] as const;
  for (const [payload, reason] of cases) {
    const gate = evaluateStrictZeroGate(payload, 'upi', 'inr');
    assert.equal(gate.passed, false, reason);
    assert.ok(gate.reasons.includes(reason), reason);
  }
});

test('严格零元门拒绝缺失金额及非零金额', () => {
  const { amount_total: _amount, ...missingAmount } = validGatePayload;
  assert.ok(evaluateStrictZeroGate(missingAmount, 'upi', 'inr').reasons.includes('amount_missing'));
  assert.ok(evaluateStrictZeroGate({ ...validGatePayload, amount_total: 1 }, 'upi', 'inr').reasons.includes('amount_not_zero'));
});

test('Runner 使用适配器币种作为唯一币种规则', async () => {
  const wrongCurrency = { ...validGatePayload, currency: 'usd' };
  const result = await runNativePaymentRunner(context, makeTransport({
    screen: async () => ok(wrongCurrency, 'SCREEN_OK'),
  }));
  assert.equal(result.ok, false);
  assert.equal(result.status, 'not_qualified');
  assert.ok(result.gate?.reasons.includes('currency_unexpected'));
});

test('Hosted 与 PayPal 跟随已验证 Checkout 的实际国家和币种', async () => {
  for (const region of listCheckoutRegions()) {
    for (const method of ['hosted', 'paypal'] as const) {
      const capability = resolvePaymentCapability(method, region);
      assert.equal(capability.scope, 'global');
      assert.equal(capability.currencyPolicy, 'checkout');
      assert.equal(capability.expectedCurrency, region.currency.toLowerCase());
      assert.equal(capability.bootstrapCountry, region.country);
      assert.equal(capability.promotionCountry, region.country);
      assert.equal(capability.providerCountry, region.country);
    }
  }

  for (const checkout of [
    { country: 'PH', currency: 'php' },
    { country: 'JP', currency: 'jpy' },
    { country: 'DE', currency: 'eur' },
  ]) {
    const payload = { amount_total: 0, mode: 'subscription', currency: checkout.currency, payment_method_types: ['paypal'] };
    const finalUrl = 'https://www.paypal.com/agreements/approve?ba_token=dynamic';
    const result = await runNativePaymentRunner({
      ...context,
      method: 'paypal',
      billingCountry: checkout.country,
      checkoutCurrency: checkout.currency,
    }, makeTransport({
      screen: async () => ok(payload, 'SCREEN_OK'),
      revalidate: async () => ok(payload, 'REVALIDATE_OK'),
      poll: async () => ok({ payload: {}, redirectUrl: finalUrl }, 'POLL_OK'),
      finalize: async () => ok({ url: finalUrl }, 'FINAL_OK'),
    }));
    assert.equal(result.ok, true, `${checkout.country}/${checkout.currency}`);
    assert.equal(result.gate?.currency, checkout.currency);
    assert.equal(result.finalUrl, finalUrl);
  }
});

test('区域支付方式继续使用固定国家币种档案', () => {
  const upi = resolvePaymentCapability('upi', { country: 'PH', currency: 'PHP' });
  assert.deepEqual(upi, {
    scope: 'regional',
    currencyPolicy: 'fixed',
    countryPolicy: 'profile',
    expectedCurrency: 'inr',
    bootstrapCountry: 'IN',
    promotionCountry: 'VN',
    providerCountry: 'IN',
  });
  const overridden = resolvePaymentCapability('upi', { country: 'PH', currency: 'PHP' }, {
    bootstrap: 'JP', promotion: 'PH', provider: 'DE',
  });
  assert.deepEqual([
    overridden.bootstrapCountry, overridden.promotionCountry, overridden.providerCountry,
  ], ['JP', 'PH', 'DE']);
});

test('各支付方式仅接纳方式专属 HTTPS 终链', () => {
  const allowed = {
    hosted: 'https://checkout.stripe.com/c/pay/cs_test',
    paypal: 'https://www.paypal.com/agreements/approve?ba_token=test',
    momo: 'https://payment.momo.vn/pay/test',
    gopay: 'https://app.midtrans.com/snap/v4/redirection/test',
    ideal: 'https://pay.bunq.com/test',
    upi: 'https://payments.stripe.com/upi/instructions/test',
    pix: 'https://payments.stripe.com/pix/test',
    blik: 'https://payments.stripe.com/actions/blik/test',
    twint: 'https://pay.twint.ch/test',
    kakao: 'https://online-pay.kakaopay.com/test',
  } as const;
  for (const [method, url] of Object.entries(allowed)) {
    assert.equal(isAllowedFinalPaymentUrl(method as keyof typeof allowed, url), true, `${method}: ${url}`);
  }
  assert.equal(isAllowedFinalPaymentUrl('paypal', 'https://www.paypal.com/'), false);
  assert.equal(isAllowedFinalPaymentUrl('upi', 'https://example.test/upi/instructions/test'), false);
  assert.equal(isAllowedFinalPaymentUrl('upi', 'https://payments.stripe.com/upi/instructions/test#fragment'), false);
});

test('正常链路中 confirm 只提交一次', async () => {
  let confirms = 0;
  const result = await runNativePaymentRunner(context, makeTransport({
    confirm: async () => {
      confirms += 1;
      return ok({ payload: {}, requiresApproval: false }, 'CONFIRM_OK');
    },
  }));
  assert.equal(result.ok, true);
  assert.equal(result.status, 'link_ready');
  assert.equal(confirms, 1);
  assert.equal(result.confirmSubmitted, true);
  assert.equal(result.approveSubmitted, false);
});

test('目标方式未暴露时停在 screen，不创建方式也不提交 confirm', async () => {
  let paymentMethods = 0;
  let confirms = 0;
  const result = await runNativePaymentRunner(context, makeTransport({
    screen: async () => ok({ ...validGatePayload, payment_method_types: ['pix'] }, 'SCREEN_OK'),
    createPaymentMethod: async () => {
      paymentMethods += 1;
      return ok({ id: 'pm_should_not_exist' }, 'PM_OK');
    },
    confirm: async () => {
      confirms += 1;
      return ok({ payload: {}, requiresApproval: false }, 'CONFIRM_OK');
    },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.status, 'not_qualified');
  assert.ok(result.gate?.reasons.includes('expected_method_missing'));
  assert.equal(paymentMethods, 0);
  assert.equal(confirms, 0);
});

test('复用同一资格 Checkout 且方式已暴露才标记为资格保持', () => {
  const gate = evaluateStrictZeroGate(validGatePayload, 'upi', 'inr');
  const reused = buildPaymentLinkEvidence({
    method: 'upi',
    sessionMode: 'reuse_eligibility_session',
    sourceCheckoutSessionId: 'cs_qualified',
    checkoutSessionId: 'cs_qualified',
    sessionDistinct: false,
    sourceQualificationVerified: true,
    gate,
  });
  assert.deepEqual(reused, {
    sourceQualificationVerified: true,
    sourceSessionReused: true,
    methodOffered: true,
    qualificationPreserved: true,
  });
});

test('独立 Checkout 保留真实会话关系并以独立资格重验证作为成功条件', () => {
  const gate = evaluateStrictZeroGate(validGatePayload, 'upi', 'inr');
  const independent = buildPaymentLinkEvidence({
    method: 'upi',
    sessionMode: 'independent_checkout',
    sourceCheckoutSessionId: 'cs_qualified',
    checkoutSessionId: 'cs_control',
    sessionDistinct: false,
    sourceQualificationVerified: true,
    gate,
  });
  assert.equal(independent.sourceSessionReused, false);
  assert.equal(independent.qualificationPreserved, false);

  const independentQualified = buildPaymentLinkEvidence({
    method: 'upi',
    sessionMode: 'independent_checkout',
    sourceCheckoutSessionId: 'cs_qualified',
    checkoutSessionId: 'cs_control',
    sessionDistinct: true,
    sourceQualificationVerified: true,
    gate,
  });
  assert.equal(independentQualified.sourceSessionReused, false);
  assert.equal(independentQualified.qualificationPreserved, true);
});

test('confirm 结果不明后仅轮询同一 Checkout', async () => {
  let confirms = 0;
  let approves = 0;
  let polls = 0;
  const result = await runNativePaymentRunner(context, makeTransport({
    confirm: async () => {
      confirms += 1;
      return {
        ok: false,
        data: { payload: {}, requiresApproval: true },
        code: 'CONFIRM_NETWORK',
        message: 'network outcome unknown',
        errorClass: 'side-effect-unknown',
        sideEffect: 'unknown',
      };
    },
    approve: async () => {
      approves += 1;
      return ok({ payload: {}, approved: true }, 'APPROVE_OK');
    },
    poll: async () => {
      polls += 1;
      return ok({ payload: {}, redirectUrl: 'https://payments.stripe.com/upi/instructions/unknown-confirm' }, 'POLL_OK');
    },
  }));
  assert.equal(result.ok, true);
  assert.equal(confirms, 1);
  assert.equal(approves, 0);
  assert.equal(polls, 1);
});

test('approve 结果不明后不重复 approve，只进入 poll', async () => {
  let approves = 0;
  let polls = 0;
  const result = await runNativePaymentRunner(context, makeTransport({
    confirm: async () => ok({ payload: {}, requiresApproval: true }, 'CONFIRM_OK'),
    approve: async () => {
      approves += 1;
      return {
        ok: false,
        code: 'APPROVE_HTTP_500',
        message: 'approve outcome unknown',
        errorClass: 'side-effect-unknown',
        sideEffect: 'unknown',
      };
    },
    poll: async () => {
      polls += 1;
      return ok({ payload: {}, redirectUrl: 'https://payments.stripe.com/upi/instructions/unknown-approve' }, 'POLL_OK');
    },
  }));
  assert.equal(result.ok, true);
  assert.equal(approves, 1);
  assert.equal(polls, 1);
  assert.equal(result.approveSubmitted, true);
});

test('持久检查点恢复只查询原 Checkout，不重复任何支付写操作', async () => {
  const checkpoints: PaymentRunnerCheckpoint[] = [];
  await runNativePaymentRunner(context, makeTransport({
    confirm: async () => ({
      ok: false,
      data: { payload: {}, requiresApproval: false },
      code: 'CONFIRM_NETWORK',
      message: 'network outcome unknown',
      errorClass: 'side-effect-unknown',
      sideEffect: 'unknown',
    }),
  }), {
    operationKey: 'payment-operation/run/account/cs_test_runner/upi',
    onCheckpoint: (checkpoint) => { checkpoints.push(checkpoint); },
  });
  const recovery = checkpoints.find((item) => item.code === 'CONFIRM_SUBMITTED');
  assert.ok(recovery);
  assert.equal(recovery.confirmSubmitted, true);
  assert.equal(recovery.sideEffect, 'unknown');
  assert.doesNotMatch(JSON.stringify(recovery), /accessToken|token|payload/i);

  const calls = { screen: 0, revalidate: 0, createPM: 0, confirm: 0, approve: 0, poll: 0, finalize: 0 };
  const transport = makeTransport({
    screen: async () => { calls.screen += 1; return ok(validGatePayload, 'SCREEN_OK'); },
    revalidate: async () => { calls.revalidate += 1; return ok(validGatePayload, 'REVALIDATE_OK'); },
    createPaymentMethod: async () => { calls.createPM += 1; return ok({ id: 'pm_duplicate' }, 'PM_OK'); },
    confirm: async () => { calls.confirm += 1; return ok({ payload: {}, requiresApproval: false }, 'CONFIRM_OK'); },
    approve: async () => { calls.approve += 1; return ok({ payload: {}, approved: true }, 'APPROVE_OK'); },
    poll: async () => {
      calls.poll += 1;
      return ok({ payload: {}, redirectUrl: 'https://payments.stripe.com/upi/instructions/recovered' }, 'POLL_OK');
    },
    finalize: async () => {
      calls.finalize += 1;
      return ok({ url: 'https://payments.stripe.com/upi/instructions/recovered' }, 'FINAL_OK');
    },
  });
  const result = await runNativePaymentRunner(context, transport, { recovery });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, { screen: 0, revalidate: 1, createPM: 0, confirm: 0, approve: 0, poll: 1, finalize: 1 });
});

test('finalize 前资格漂移时不返回链接', async () => {
  let revalidations = 0;
  let finalizes = 0;
  const result = await runNativePaymentRunner(context, makeTransport({
    revalidate: async () => {
      revalidations += 1;
      return ok(revalidations === 3 ? { ...validGatePayload, amount_total: 1 } : validGatePayload, 'REVALIDATE_OK');
    },
    finalize: async () => {
      finalizes += 1;
      return ok({ url: 'https://payments.stripe.com/upi/instructions/should-not-return' }, 'FINAL_OK');
    },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.status, 'not_qualified');
  assert.equal(result.code, 'STRICT_GATE_NOT_QUALIFIED');
  assert.equal(result.finalUrl, undefined);
  assert.equal(finalizes, 0);
});

test('计划方式与终链方式不一致时关闭 finalize', async () => {
  const result = await runNativePaymentRunner(context, makeTransport({
    finalize: async () => ok({ url: 'https://payments.stripe.com/pix/test' }, 'FINAL_OK'),
  }));
  assert.equal(result.ok, false);
  assert.equal(result.status, 'invalid_final_url');
  assert.equal(result.code, 'FINAL_URL_NOT_ALLOWED');
});

test('Runner 阶段使用 checkout/provider/approve 三种代理角色', () => {
  assert.equal(paymentProxyRoleForStage('screen', 'upi'), 'checkout');
  assert.equal(paymentProxyRoleForStage('revalidate', 'upi'), 'checkout');
  assert.equal(paymentProxyRoleForStage('createPM', 'upi'), 'provider');
  assert.equal(paymentProxyRoleForStage('confirm', 'upi'), 'provider');
  assert.equal(paymentProxyRoleForStage('finalize', 'upi'), 'provider');
  assert.equal(paymentProxyRoleForStage('approve', 'upi'), 'approve');
  assert.equal(paymentProxyRoleForStage('poll', 'upi'), 'approve');
});
