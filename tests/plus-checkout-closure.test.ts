import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPlusCheckoutClosureOrchestrator,
  normalizePlusCheckoutClosureRun,
  normalizePlusCheckoutClosureSettings,
  type ClosureCheckoutEvidence,
  type PlusCheckoutClosureDependencies,
  type PlusCheckoutClosureRun,
} from '../src/features/automation/plus-checkout-closure';

const network = {
  plane: 'server-checkout' as const, requestId: 'req-fixture', ip: '203.0.113.7', country: 'PH',
  colo: 'MNL', asn: 'AS64500', verified: true, capturedAt: 1,
};

test('closure defaults off and live remains a separate switch', () => {
  assert.deepEqual(normalizePlusCheckoutClosureSettings(undefined), {
    enabled: false, liveEnabled: false, requireVerifiedNetwork: true,
    targetCountry: 'PH', billingCountry: 'US', expectedCurrency: 'PHP',
  });
});

test('full A/save/B/Saved/billing/submit/verify flow reaches Plus once', async () => {
  const calls: string[] = [];
  const checkpoints: PlusCheckoutClosureRun[] = [];
  const orchestrator = createPlusCheckoutClosureOrchestrator(fixtureDependencies({ calls, checkpoints }), {
    enabled: true,
  });
  const result = await orchestrator.run();
  assert.equal(result.phase, 'subscription_verified');
  assert.equal(result.subscriptionVerified, true);
  assert.equal(result.submitCount, 1);
  assert.equal(result.checkoutA?.sessionId, 'oaics_a');
  assert.equal(result.checkoutB?.sessionId, 'oaics_b');
  assert.equal(result.savedMethod?.last4, '4242');
  assert.equal(result.billingCountry, 'US');
  assert.equal(result.finalPlanType, 'chatgpt-plus');
  assert.equal(calls.filter((item) => item === 'submit').length, 1);
  assert.ok(checkpoints.some((item) => item.phase === 'checkout_a_qualified'));
  assert.ok(checkpoints.some((item) => item.phase === 'card_reconciled'));
});

test('single-flight prevents duplicate submit', async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const calls: string[] = [];
  const dependencies = fixtureDependencies({ calls });
  const originalSubmit = dependencies.submitQualifiedCheckout;
  dependencies.submitQualifiedCheckout = async () => { await hold; return originalSubmit(); };
  const orchestrator = createPlusCheckoutClosureOrchestrator(dependencies, { enabled: true });
  const first = orchestrator.run();
  const second = orchestrator.run();
  assert.equal(first, second);
  release();
  await first;
  assert.equal(calls.filter((item) => item === 'submit').length, 1);
});

test('distinct and qualification drift stop before card selection and submit', async () => {
  const calls: string[] = [];
  const dependencies = fixtureDependencies({ calls });
  dependencies.createCheckout = async ({ slot }) => checkout(slot === 'A' ? 'oaics_same' : 'oaics_same');
  const result = await createPlusCheckoutClosureOrchestrator(dependencies, { enabled: true }).run();
  assert.equal(result.phase, 'failed_terminal');
  assert.equal(result.errorCode, 'CHECKOUT_NOT_DISTINCT');
  assert.equal(calls.includes('select'), false);
  assert.equal(calls.includes('submit'), false);
});

test('unknown submit side effect verifies original reference without replay', async () => {
  const calls: string[] = [];
  const dependencies = fixtureDependencies({ calls });
  dependencies.submitQualifiedCheckout = async () => {
    calls.push('submit');
    return { submitted: false, sideEffectUnknown: true, verifyReference: 'https://chatgpt.com/checkout/verify?stripe_session_id=oaics_b' };
  };
  const result = await createPlusCheckoutClosureOrchestrator(dependencies, { enabled: true }).run();
  assert.equal(result.phase, 'subscription_verified');
  assert.equal(result.submitCount, 1);
  assert.equal(calls.filter((item) => item === 'submit').length, 1);
  assert.equal(calls.filter((item) => item === 'verify').length, 1);
});

test('normalization strips raw secrets and rejects foreign state shapes', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123456789';
  const normalized = normalizePlusCheckoutClosureRun({
    id: 'run-1', accountDigest: 'acct-digest', phase: 'failed_terminal',
    message: `pk_live_secret accessToken=raw-token Authorization: Bearer auth-token ${jwt} 4242 4242 4242 4242`,
    accessToken: 'raw-token', client_secret: 'seti_secret', cardNumber: '4242424242424242',
    networkEvidence: [], createdAt: 1, updatedAt: 2,
  });
  assert.ok(normalized);
  const serialized = JSON.stringify(normalized);
  assert.doesNotMatch(serialized, /raw-token|auth-token|4242 4242|4242424242424242|pk_live_secret|seti_secret|eyJhbGci/);
  assert.match(normalized.message, /\[redacted-key\]|\[redacted-pan\]/);
  assert.equal(normalizePlusCheckoutClosureRun({ phase: 'idle' }), undefined);
});

test('normalization rejects non-finite, fractional, and negative persisted numbers', () => {
  const normalized = normalizePlusCheckoutClosureRun({
    id: 'run-numbers', accountDigest: 'acct-digest', phase: 'checkout_a_qualified',
    checkoutA: {
      sessionId: 'oaics_a', processorEntity: 'openai_llc', canonicalUrl: 'https://chatgpt.com/checkout/openai_llc/oaics_a',
      planName: 'chatgptplusplan', country: 'PH', currency: 'PHP', amountMinor: Number.POSITIVE_INFINITY,
      zeroVerified: true, networkEvidence: {
        plane: 'server-checkout', requestId: 'req-a', ip: '203.0.113.10', country: 'PH', verified: true, capturedAt: -1,
      },
    },
    submitCount: 0.5, networkEvidence: [], createdAt: Number.NaN, updatedAt: -2,
  });
  assert.ok(normalized);
  assert.equal(normalized.submitCount, 0);
  assert.equal(normalized.createdAt, 0);
  assert.equal(normalized.updatedAt, 0);
  assert.equal(normalized.checkoutA?.amountMinor, null);
  assert.equal(normalized.checkoutA?.networkEvidence?.capturedAt, 0);
});

test('strict Checkout A gates stop before card setup', async () => {
  for (const mutate of [
    (item: ClosureCheckoutEvidence) => ({ ...item, amountMinor: 100, zeroVerified: false }),
    (item: ClosureCheckoutEvidence) => ({ ...item, country: 'US' }),
    (item: ClosureCheckoutEvidence) => ({ ...item, networkEvidence: { ...item.networkEvidence!, verified: false } }),
  ]) {
    const calls: string[] = [];
    const dependencies = fixtureDependencies({ calls });
    dependencies.createCheckout = async () => mutate(checkout('oaics_a'));
    const result = await createPlusCheckoutClosureOrchestrator(dependencies, { enabled: true }).run();
    assert.equal(result.phase, 'failed_terminal');
    assert.equal(calls.includes('save'), false);
  }
});

test('malformed reconciled card evidence fails without entering selection', async () => {
  const calls: string[] = [];
  const dependencies = fixtureDependencies({ calls });
  dependencies.saveCard = async () => ({
    status: 'reconciled',
    evidence: {
      paymentMethodDigest: '', brand: 'visa', last4: '',
      intentSucceeded: true, attached: true, reusable: true, defaultVerified: true,
    },
  });

  const result = await createPlusCheckoutClosureOrchestrator(dependencies, { enabled: true }).run();

  assert.equal(result.phase, 'failed_terminal');
  assert.equal(result.errorCode, 'CARD_RECONCILE_FAILED');
  assert.equal(calls.includes('select'), false);
  assert.equal(calls.includes('submit'), false);
});

test('qualification drift, Saved Card, billing and Plus gates stop submit or success', async () => {
  const cases: Array<{
    change(dependencies: PlusCheckoutClosureDependencies): void;
    code: string;
    submitCalls: number;
  }> = [
    {
      change(dependencies) {
        dependencies.createCheckout = async ({ slot }) => ({ ...checkout(slot === 'A' ? 'oaics_a' : 'oaics_b'), currency: slot === 'A' ? 'PHP' : 'USD' });
      },
      code: 'QUALIFICATION_DRIFT', submitCalls: 0,
    },
    {
      change(dependencies) { dependencies.selectSavedCard = async () => ({ selected: false, last4: '' }); },
      code: 'SAVED_CARD_NOT_FOUND', submitCalls: 0,
    },
    {
      change(dependencies) { dependencies.selectSavedCard = async () => { throw new Error('saved card frame unavailable'); }; },
      code: 'SAVED_CARD_NOT_FOUND', submitCalls: 0,
    },
    {
      change(dependencies) { dependencies.fillAndVerifyBilling = async () => ({ verified: false, country: 'US' }); },
      code: 'BILLING_VERIFY_FAILED', submitCalls: 0,
    },
    {
      change(dependencies) { dependencies.fillAndVerifyBilling = async () => { throw new Error('billing form unavailable'); }; },
      code: 'BILLING_VERIFY_FAILED', submitCalls: 0,
    },
    {
      change(dependencies) { dependencies.verifySubscription = async () => ({ verified: false, planType: 'free' }); },
      code: 'SUBSCRIPTION_NOT_VERIFIED', submitCalls: 1,
    },
  ];
  for (const item of cases) {
    const calls: string[] = [];
    const dependencies = fixtureDependencies({ calls });
    item.change(dependencies);
    const result = await createPlusCheckoutClosureOrchestrator(dependencies, { enabled: true }).run();
    assert.equal(result.errorCode, item.code);
    assert.equal(calls.filter((call) => call === 'submit').length, item.submitCalls);
  }
});

test('account change and cancellation stop before the next write', async () => {
  const calls: string[] = [];
  const dependencies = fixtureDependencies({ calls });
  let reads = 0;
  dependencies.readSession = async () => ({ accountDigest: ++reads >= 3 ? 'other-account' : 'acct-digest' });
  const changed = await createPlusCheckoutClosureOrchestrator(dependencies, { enabled: true }).run();
  assert.equal(changed.errorCode, 'IDENTITY_CHANGED');
  assert.equal(calls.includes('save'), true);
  assert.equal(calls.includes('checkout-B'), false);

  const cancelledCalls: string[] = [];
  const cancelledDependencies = fixtureDependencies({ calls: cancelledCalls });
  cancelledDependencies.isCancelled = () => true;
  const cancelled = await createPlusCheckoutClosureOrchestrator(cancelledDependencies, { enabled: true }).run();
  assert.equal(cancelled.phase, 'cancelled');
  assert.equal(cancelledCalls.includes('checkout-A'), false);
});

test('resuming unknown setup or submit never replays the write', async () => {
  const setupCalls: string[] = [];
  const setupDependencies = fixtureDependencies({ calls: setupCalls });
  const setupUnknown = normalizePlusCheckoutClosureRun({
    id: 'setup-unknown', accountDigest: 'acct-digest', phase: 'side_effect_unknown', errorCode: 'SETUP_SIDE_EFFECT_UNKNOWN',
    checkoutA: checkout('oaics_a'), billingCountry: '', submitted: false, subscriptionVerified: false,
    networkEvidence: [], submitCount: 0, verifyReference: '', finalPlanType: '', message: '', createdAt: 1, updatedAt: 2,
  })!;
  const setupResult = await createPlusCheckoutClosureOrchestrator(setupDependencies, { enabled: true }).run(setupUnknown);
  assert.equal(setupResult.errorCode, 'SETUP_SIDE_EFFECT_UNKNOWN');
  assert.equal(setupCalls.includes('save'), false);

  const submitCalls: string[] = [];
  const submitDependencies = fixtureDependencies({ calls: submitCalls });
  const submitUnknown = normalizePlusCheckoutClosureRun({
    id: 'submit-unknown', accountDigest: 'acct-digest', phase: 'side_effect_unknown', errorCode: 'SUBMIT_SIDE_EFFECT_UNKNOWN',
    checkoutA: checkout('oaics_a'), checkoutB: checkout('oaics_b'),
    savedMethod: { paymentMethodDigest: 'pm-digest', brand: 'visa', last4: '4242', intentSucceeded: true, attached: true, reusable: true, defaultVerified: true },
    billingCountry: 'US', submitted: false, subscriptionVerified: false, networkEvidence: [], submitCount: 1,
    verifyReference: 'https://chatgpt.com/checkout/verify?stripe_session_id=oaics_b', finalPlanType: '', message: '', createdAt: 1, updatedAt: 2,
  })!;
  const submitResult = await createPlusCheckoutClosureOrchestrator(submitDependencies, { enabled: true }).run(submitUnknown);
  assert.equal(submitResult.phase, 'subscription_verified');
  assert.equal(submitCalls.filter((call) => call === 'submit').length, 0);
  assert.equal(submitCalls.filter((call) => call === 'verify').length, 1);
});

test('unknown Checkout create is checkpointed and never replayed on resume', async () => {
  let creates = 0;
  const dependencies = fixtureDependencies({ calls: [] });
  dependencies.createCheckout = async () => {
    creates += 1;
    throw new Error('connection lost after create');
  };
  const orchestrator = createPlusCheckoutClosureOrchestrator(dependencies, { enabled: true });
  const unknown = await orchestrator.run();
  assert.equal(unknown.phase, 'side_effect_unknown');
  assert.equal(unknown.errorCode, 'CHECKOUT_SIDE_EFFECT_UNKNOWN');
  assert.equal(creates, 1);
  const resumed = await orchestrator.run(unknown);
  assert.equal(resumed.errorCode, 'CHECKOUT_SIDE_EFFECT_UNKNOWN');
  assert.equal(creates, 1);
});

test('unknown submit remains retryable verification evidence without replay', async () => {
  const calls: string[] = [];
  const dependencies = fixtureDependencies({ calls });
  dependencies.submitQualifiedCheckout = async () => {
    calls.push('submit');
    return { submitted: false, sideEffectUnknown: true };
  };
  dependencies.verifySubscription = async () => {
    calls.push('verify');
    return { verified: false, planType: 'free' };
  };
  const orchestrator = createPlusCheckoutClosureOrchestrator(dependencies, { enabled: true });
  const unknown = await orchestrator.run();
  assert.equal(unknown.phase, 'side_effect_unknown');
  assert.equal(unknown.errorCode, 'SUBMIT_SIDE_EFFECT_UNKNOWN');
  const resumed = await orchestrator.run(unknown);
  assert.equal(resumed.phase, 'side_effect_unknown');
  assert.equal(calls.filter((item) => item === 'submit').length, 1);
  assert.equal(calls.filter((item) => item === 'verify').length, 2);
});

test('resume preserves checkout B gates before the first submit', async () => {
  const calls: string[] = [];
  const dependencies = fixtureDependencies({ calls });
  const resumed = normalizePlusCheckoutClosureRun({
    id: 'resume-checkout-b', accountDigest: 'acct-digest', phase: 'checkout_b_qualified',
    checkoutA: checkout('oaics_a'), checkoutB: checkout('oaics_b'),
    savedMethod: { paymentMethodDigest: 'pm-digest', brand: 'visa', last4: '4242', intentSucceeded: true, attached: true, reusable: true, defaultVerified: true },
    billingCountry: '', submitted: false, subscriptionVerified: false, networkEvidence: [], submitCount: 0,
    verifyReference: '', finalPlanType: '', message: '', createdAt: 1, updatedAt: 2,
  })!;

  const result = await createPlusCheckoutClosureOrchestrator(dependencies, { enabled: true }).run(resumed);

  assert.equal(result.phase, 'subscription_verified');
  assert.deepEqual(calls.filter((item) => ['select', 'billing', 'submit', 'verify'].includes(item)), ['select', 'billing', 'submit', 'verify']);
  assert.equal(calls.some((item) => item.startsWith('checkout-')), false);
  assert.equal(calls.includes('save'), false);
});

test('interrupted write checkpoints never replay create, setup, or submit', async () => {
  const cases: Array<{ phase: PlusCheckoutClosureRun['phase']; code: string; forbidden: string }> = [
    { phase: 'checkout_a_creating', code: 'CHECKOUT_SIDE_EFFECT_UNKNOWN', forbidden: 'checkout-A' },
    { phase: 'card_setup_running', code: 'SETUP_SIDE_EFFECT_UNKNOWN', forbidden: 'save' },
    { phase: 'checkout_b_creating', code: 'CHECKOUT_SIDE_EFFECT_UNKNOWN', forbidden: 'checkout-B' },
  ];
  for (const item of cases) {
    const calls: string[] = [];
    const dependencies = fixtureDependencies({ calls });
    const existing = normalizePlusCheckoutClosureRun({
      id: `interrupted-${item.phase}`, accountDigest: 'acct-digest', phase: item.phase,
      ...(item.phase !== 'checkout_a_creating' ? { checkoutA: checkout('oaics_a') } : {}),
      ...(item.phase === 'checkout_b_creating' ? {
        savedMethod: { paymentMethodDigest: 'pm-digest', brand: 'visa', last4: '4242', intentSucceeded: true, attached: true, reusable: true, defaultVerified: true },
      } : {}),
      billingCountry: '', submitted: false, subscriptionVerified: false, networkEvidence: [], submitCount: 0,
      verifyReference: '', finalPlanType: '', message: '', createdAt: 1, updatedAt: 2,
    })!;
    const result = await createPlusCheckoutClosureOrchestrator(dependencies, { enabled: true }).run(existing);
    assert.equal(result.phase, 'side_effect_unknown');
    assert.equal(result.errorCode, item.code);
    assert.equal(calls.includes(item.forbidden), false);
  }
});

test('interrupted submit and failed verification retry only entitlement lookup', async () => {
  const calls: string[] = [];
  const dependencies = fixtureDependencies({ calls });
  let verificationAttempts = 0;
  dependencies.verifySubscription = async () => {
    calls.push('verify');
    verificationAttempts += 1;
    if (verificationAttempts === 1) throw new Error('session endpoint unavailable');
    return { verified: true, planType: 'chatgpt-plus' };
  };
  const submitting = normalizePlusCheckoutClosureRun({
    id: 'submit-interrupted', accountDigest: 'acct-digest', phase: 'subscription_submitting',
    checkoutA: checkout('oaics_a'), checkoutB: checkout('oaics_b'),
    savedMethod: { paymentMethodDigest: 'pm-digest', brand: 'visa', last4: '4242', intentSucceeded: true, attached: true, reusable: true, defaultVerified: true },
    billingCountry: 'US', submitted: false, subscriptionVerified: false, networkEvidence: [], submitCount: 1,
    verifyReference: 'https://chatgpt.com/checkout/verify?stripe_session_id=oaics_b', finalPlanType: '', message: '', createdAt: 1, updatedAt: 2,
  })!;
  const orchestrator = createPlusCheckoutClosureOrchestrator(dependencies, { enabled: true });

  const unknown = await orchestrator.run(submitting);
  assert.equal(unknown.phase, 'side_effect_unknown');
  assert.equal(unknown.errorCode, 'SUBMIT_SIDE_EFFECT_UNKNOWN');
  const verified = await orchestrator.run(unknown);
  assert.equal(verified.phase, 'subscription_verified');
  assert.equal(verified.errorCode, undefined);
  assert.equal(verified.submitted, true);
  assert.equal(calls.filter((item) => item === 'submit').length, 0);
  assert.equal(calls.filter((item) => item === 'verify').length, 2);
});

test('paused card setup can continue after user action without recreating Checkout A', async () => {
  const calls: string[] = [];
  const dependencies = fixtureDependencies({ calls });
  let saveAttempts = 0;
  const originalSave = dependencies.saveCard;
  dependencies.saveCard = async (input) => {
    saveAttempts += 1;
    if (saveAttempts === 1) return { status: 'paused', message: 'card input required' };
    return originalSave(input);
  };
  const orchestrator = createPlusCheckoutClosureOrchestrator(dependencies, { enabled: true });

  const paused = await orchestrator.run();
  assert.equal(paused.phase, 'paused_user_action');
  const result = await orchestrator.run(paused);
  assert.equal(result.phase, 'subscription_verified');
  assert.equal(calls.filter((item) => item === 'checkout-A').length, 1);
  assert.equal(saveAttempts, 2);
});

function fixtureDependencies(input: { calls: string[]; checkpoints?: PlusCheckoutClosureRun[] }): PlusCheckoutClosureDependencies {
  let timestamp = 10;
  return {
    readSession: async () => ({ accountDigest: 'acct-digest' }),
    createCheckout: async ({ slot }) => {
      input.calls.push(`checkout-${slot}`);
      return checkout(slot === 'A' ? 'oaics_a' : 'oaics_b');
    },
    saveCard: async () => {
      input.calls.push('save');
      return {
        status: 'reconciled',
        evidence: {
          paymentMethodDigest: 'pm-digest', brand: 'visa', last4: '4242',
          intentSucceeded: true, attached: true, reusable: true, defaultVerified: true,
        },
      };
    },
    selectSavedCard: async ({ expectedLast4 }) => {
      input.calls.push('select');
      return { selected: true, last4: expectedLast4 };
    },
    fillAndVerifyBilling: async ({ country }) => {
      input.calls.push('billing');
      return { verified: true, country };
    },
    submitQualifiedCheckout: async () => {
      input.calls.push('submit');
      return { submitted: true, verifyReference: 'https://chatgpt.com/checkout/verify?stripe_session_id=oaics_b' };
    },
    verifySubscription: async () => {
      input.calls.push('verify');
      return { verified: true, planType: 'chatgpt-plus' };
    },
    onCheckpoint: (run) => { input.checkpoints?.push(run); },
    now: () => timestamp++,
    randomId: () => 'closure-fixture',
  };
}

function checkout(sessionId: string): ClosureCheckoutEvidence {
  return {
    sessionId, processorEntity: 'openai_llc', canonicalUrl: `https://chatgpt.com/checkout/openai_llc/${sessionId}`,
    planName: 'chatgptplusplan', country: 'PH',
    currency: 'PHP', amountMinor: 0, zeroVerified: true, networkEvidence: { ...network, requestId: `req-${sessionId}` },
  };
}
