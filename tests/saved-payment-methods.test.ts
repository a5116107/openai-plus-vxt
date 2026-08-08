import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SAVED_PAYMENT_BRIDGE_REQUEST,
  SAVED_PAYMENT_BRIDGE_VERSION,
  SAVED_PAYMENT_PHASES,
  classifyStoredPaymentMethodType,
  createSavedPaymentOrchestrator,
  createSavedPaymentStripePageController,
  evaluateSavedPaymentFeatureGate,
  evaluateSavedPaymentMethodPolicy,
  exportSavedPaymentAuditCsv,
  exportSavedPaymentAuditJson,
  getSavedPaymentCapability,
  isSavedPaymentStartMessage,
  isSavedPaymentBridgeRequestEvent,
  normalizeSavedPaymentFeatureSettings,
  normalizeSavedPaymentState,
  reconcileSavedPaymentMethod,
  supportsSavedPaymentPath,
  createSavedPaymentTransport,
  verifyStripeCheckoutKeyOwnership,
  verifyStripeSetupIntentKeyOwnership,
  type SavedPaymentBridgeRequest,
  type SavedPaymentElementBridge,
  type SavedPaymentTransport,
} from '../src/features/saved-payment-methods';
import { loadStripeJsInDocument } from '../src/features/saved-payment-methods/stripe-element-page';

test('saved payment rollout defaults off and stays Card test-only', () => {
  const defaults = normalizeSavedPaymentFeatureSettings(undefined);
  const tampered = normalizeSavedPaymentFeatureSettings({
    enabled: true,
    environment: 'live',
    allowedMethods: ['paypal'],
  });

  assert.deepEqual(defaults, {
    enabled: false,
    environment: 'test',
    allowedMethods: ['card'],
    updatedAt: 0,
  });
  assert.equal(tampered.enabled, true);
  assert.equal(tampered.environment, 'test');
  assert.deepEqual(tampered.allowedMethods, ['card']);
  assert.equal(evaluateSavedPaymentFeatureGate(defaults, 'pk_test_fixture').code, 'SAVED_PAYMENT_DISABLED');
  assert.equal(evaluateSavedPaymentFeatureGate(tampered, 'pk_live_fixture').code, 'SAVED_PAYMENT_TEST_KEY_REQUIRED');
  assert.equal(evaluateSavedPaymentFeatureGate(tampered, 'pk_test_fixture').ok, true);
});

test('card is reusable through setup while wallets remain wallet-managed', () => {
  const card = getSavedPaymentCapability('card');
  const applePay = getSavedPaymentCapability('apple_pay');

  assert.equal(card.status, 'supported');
  assert.equal(card.reusePolicy, 'reusable');
  assert.equal(supportsSavedPaymentPath('card', 'setup', 'inline-elements'), true);
  assert.equal(applePay.reusePolicy, 'wallet-managed');
  assert.equal(supportsSavedPaymentPath('apple_pay', 'setup', 'inline-elements'), false);
});

test('one-time redirect methods do not enter a setup path', () => {
  const pix = getSavedPaymentCapability('pix');
  assert.equal(pix.reusePolicy, 'one-time-only');
  assert.equal(pix.status, 'unsupported');
  assert.equal(supportsSavedPaymentPath('pix', 'setup', 'native-redirect'), false);
});

test('Stripe key ownership rejects mode mismatch without a network call', async () => {
  let calls = 0;
  const result = await verifyStripeCheckoutKeyOwnership({
    publishableKey: 'pk_test_fixture',
    checkoutSessionId: 'cs_live_fixture',
    fetchImpl: async () => {
      calls += 1;
      return new Response('{}');
    },
  });

  assert.equal(result.status, 'rejected');
  assert.equal(result.code, 'MODE_MISMATCH');
  assert.equal(calls, 0);
});

test('Stripe key ownership verifies a Checkout init response and never returns the full key', async () => {
  const key = 'pk_test_fixture_123456789';
  const result = await verifyStripeCheckoutKeyOwnership({
    publishableKey: key,
    checkoutSessionId: 'cs_test_fixture',
    fetchImpl: async (url, init) => {
      assert.match(String(url), /payment_pages\/cs_test_fixture\/init$/);
      assert.equal(init?.method, 'POST');
      assert.match(String(init?.body), /key=pk_test_fixture_123456789/);
      return new Response(JSON.stringify({ mode: 'setup', payment_method_types: ['card'] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  assert.equal(result.status, 'verified');
  assert.equal(result.code, 'OWNERSHIP_VERIFIED');
  assert.equal(result.keyFingerprint.includes(key), false);
  assert.match(result.keyFingerprint, /^pk_test\.\.\./);
});

test('Stripe key ownership classifies provider rejection', async () => {
  const result = await verifyStripeCheckoutKeyOwnership({
    publishableKey: 'pk_live_fixture',
    checkoutSessionId: 'cs_live_fixture',
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'No such checkout session' } }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    }),
  });

  assert.equal(result.status, 'rejected');
  assert.equal(result.code, 'STRIPE_REJECTED');
  assert.equal(result.httpStatus, 403);
});

test('SetupIntent ownership verifies the exact intent without exposing secrets', async () => {
  const secret = 'seti_fixture123_secret_value456';
  const result = await verifyStripeSetupIntentKeyOwnership({
    publishableKey: 'pk_live_fixture',
    clientSecret: secret,
    retrieveSetupIntent: async (key, clientSecret) => {
      assert.equal(key, 'pk_live_fixture');
      assert.equal(clientSecret, secret);
      return { setupIntent: { id: 'seti_fixture123', status: 'requires_payment_method' } };
    },
  });
  assert.equal(result.status, 'verified');
  assert.equal(result.targetId, 'seti_fixture123');
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('ChatGPT transport creates an account-bound SetupIntent', async () => {
  let calls = 0;
  const transport = createSavedPaymentTransport({
    fetchImpl: async (url, init) => {
      calls += 1;
      assert.equal(String(url), 'https://chatgpt.com/backend-api/payments/payment_method');
      assert.equal(init?.method, 'POST');
      assert.equal((init?.headers as Record<string, string>)['chatgpt-account-id'], 'account-fixture');
      assert.deepEqual(JSON.parse(String(init?.body)), { account_id: 'account-fixture' });
      return new Response(JSON.stringify({ client_secret: 'seti_fixture123_secret_value456' }), { status: 200 });
    },
  });
  const result = await transport.createSetupIntent({
    chatgptAccountId: 'account-fixture',
    accessToken: 'access-fixture',
  }, 'attempt-fixture');
  const duplicate = await transport.createSetupIntent({
    chatgptAccountId: 'account-fixture',
    accessToken: 'access-fixture',
  }, 'attempt-fixture');

  assert.equal(result.ok, true);
  assert.equal(result.data?.setupIntentId, 'seti_fixture123');
  assert.equal(result.data?.clientSecret, 'seti_fixture123_secret_value456');
  assert.equal(result.sideEffect, 'confirmed');
  assert.equal(duplicate.data?.setupIntentId, 'seti_fixture123');
  assert.equal(calls, 1);
});

test('ChatGPT transport keeps create 5xx as an unknown side effect', async () => {
  const transport = createSavedPaymentTransport({
    fetchImpl: async () => new Response(JSON.stringify({ message: 'upstream unavailable' }), { status: 503 }),
  });
  const result = await transport.createSetupIntent({
    chatgptAccountId: 'account-fixture',
    accessToken: 'access-fixture',
  }, 'attempt-fixture');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'PAYMENTS_HTTP_ERROR');
  assert.equal(result.retryable, true);
  assert.equal(result.sideEffect, 'unknown');
});

test('ChatGPT transport treats 401 as a terminal credential rejection', async () => {
  const transport = createSavedPaymentTransport({
    fetchImpl: async () => new Response(JSON.stringify({ detail: 'expired token' }), { status: 401 }),
  });
  const result = await transport.createSetupIntent({
    chatgptAccountId: 'account-fixture',
    accessToken: 'expired-access-fixture',
  }, 'attempt-fixture');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'PAYMENTS_CREDENTIAL_REJECTED');
  assert.equal(result.retryable, false);
  assert.equal(result.sideEffect, 'none');
});

test('ChatGPT transport normalizes the server payment method list and default', async () => {
  const transport = createSavedPaymentTransport({
    fetchImpl: async (url, init) => {
      assert.match(String(url), /payment_methods\?account_id=account-fixture$/);
      assert.equal(init?.method, 'GET');
      return new Response(JSON.stringify({
        default_payment_method_id: 'pm_default',
        payment_methods: [
          { id: 'pm_default', type: 'card', card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 } },
          { id: 'invalid', type: 'card' },
        ],
      }), { status: 200 });
    },
  });
  const result = await transport.listPaymentMethods({
    chatgptAccountId: 'account-fixture',
    accessToken: 'access-fixture',
  });

  assert.equal(result.ok, true);
  assert.equal(result.data?.paymentMethods.length, 1);
  assert.equal(result.data?.paymentMethods[0].isDefault, true);
  assert.equal(result.data?.paymentMethods[0].card?.last4, '4242');
});

test('page bridge request gate checks source, origin, version, ids, account digest, and payload', () => {
  const source = {} as Window;
  const request = bridgeRequest('retrieve-setup-intent', {
    publishableKey: 'pk_test_fixture',
    clientSecret: 'seti_fixture_secret_value',
  });
  const event = { source, origin: 'https://chatgpt.com', data: request } as MessageEvent<unknown>;

  assert.equal(isSavedPaymentBridgeRequestEvent(event, 'https://chatgpt.com', source), true);
  assert.equal(isSavedPaymentBridgeRequestEvent({ ...event, source: {} as Window }, 'https://chatgpt.com', source), false);
  assert.equal(isSavedPaymentBridgeRequestEvent({ ...event, origin: 'https://example.com' }, 'https://chatgpt.com', source), false);
  assert.equal(isSavedPaymentBridgeRequestEvent({
    ...event,
    data: { ...request, version: 'stale-version' },
  }, 'https://chatgpt.com', source), false);
  assert.equal(isSavedPaymentBridgeRequestEvent({
    ...event,
    data: { ...request, accountDigest: 'account-fixture' },
  }, 'https://chatgpt.com', source), false);
  assert.equal(isSavedPaymentBridgeRequestEvent({
    ...event,
    data: { ...request, payload: { publishableKey: 'bad', clientSecret: 'bad' } },
  }, 'https://chatgpt.com', source), false);
});

test('Stripe page controller mounts hosted Card Element and confirms each attempt once', async () => {
  let mountCalls = 0;
  let unmountCalls = 0;
  let confirmCalls = 0;
  let loadCalls = 0;
  const cardElement = {
    mount() { mountCalls += 1; },
    unmount() { unmountCalls += 1; },
  };
  const stripe = {
    elements: (options?: { clientSecret: string }) => {
      assert.equal(options, undefined);
      return { create: () => cardElement };
    },
    retrieveSetupIntent: async () => ({
      setupIntent: { id: 'seti_fixture', status: 'succeeded', payment_method: 'pm_fixture' },
    }),
    confirmCardSetup: async (_secret: string, options: Record<string, unknown>) => {
      confirmCalls += 1;
      const paymentMethod = options.payment_method as Record<string, unknown>;
      assert.equal(paymentMethod.card, cardElement);
      assert.equal('allow_redisplay' in paymentMethod, false);
      assert.equal('set_as_default_payment_method' in options, false);
      return { setupIntent: { id: 'seti_fixture', status: 'succeeded', payment_method: 'pm_fixture' } };
    },
  };
  const controller = createSavedPaymentStripePageController({
    loadStripe: async () => {
      loadCalls += 1;
      return stripe;
    },
    resolveTarget: () => ({}) as Element,
  });

  const mounted = await controller.handle(bridgeRequest('mount-card', {
    publishableKey: 'pk_test_fixture',
    clientSecret: 'seti_fixture_secret_value',
    targetSelector: '#saved-card',
  }));
  const confirmed = await controller.handle(bridgeRequest('confirm-card-setup', {
    clientSecret: 'seti_fixture_secret_value',
    billingName: 'Fixture User',
    setAsDefault: true,
  }));
  const retrieved = await controller.handle(bridgeRequest('retrieve-setup-intent', {
    publishableKey: 'pk_test_fixture',
    clientSecret: 'seti_fixture_secret_value',
  }));
  const duplicate = await controller.handle(bridgeRequest('confirm-card-setup', {
    clientSecret: 'seti_fixture_secret_value',
    billingName: 'Fixture User',
    setAsDefault: true,
  }));

  assert.equal(mounted.result.ok, true);
  assert.equal(confirmed.result.ok, true);
  assert.equal(retrieved.result.ok, true);
  assert.equal(confirmed.result.data?.paymentMethodId, 'pm_fixture');
  assert.equal(JSON.stringify(confirmed).includes('seti_fixture_secret_value'), false);
  assert.equal(JSON.stringify(confirmed).includes('pk_test_fixture'), false);
  assert.equal(duplicate.result.code, 'CONFIRM_ALREADY_SUBMITTED');
  assert.equal(mountCalls, 1);
  assert.equal(confirmCalls, 1);
  assert.equal(loadCalls, 1);
  controller.destroy();
  assert.equal(unmountCalls >= 1, true);
});

test('Stripe.js loader removes a failed script and retries before creating the client', async () => {
  const scripts: Array<Record<string, any>> = [];
  let appendCalls = 0;
  let stripeKey = '';
  const windowFixture = {} as Window & { Stripe?: (key: string) => any };
  const documentFixture = {
    querySelector: () => scripts.find((script) => script.attached) || null,
    createElement: () => {
      const listeners = new Map<string, () => void>();
      const script: Record<string, any> = {
        dataset: {},
        attached: false,
        addEventListener: (event: string, handler: () => void) => listeners.set(event, handler),
        remove: () => { script.attached = false; },
        listeners,
      };
      scripts.push(script);
      return script;
    },
    head: {
      appendChild: (script: Record<string, any>) => {
        appendCalls += 1;
        script.attached = true;
        queueMicrotask(() => {
          if (appendCalls === 1) {
            script.listeners.get('error')?.();
            return;
          }
          windowFixture.Stripe = (key: string) => {
            stripeKey = key;
            return { elements: () => ({ create: () => ({}) }) };
          };
          script.listeners.get('load')?.();
        });
      },
    },
  } as unknown as Document;

  await loadStripeJsInDocument('pk_test_retry_fixture', documentFixture, windowFixture, {
    attempts: 2,
    retryDelayMs: 0,
  });

  assert.equal(appendCalls, 2);
  assert.equal(stripeKey, 'pk_test_retry_fixture');
  assert.equal(scripts[0].attached, false);
});

test('Stripe page controller destroys the old Element on account context mismatch', async () => {
  let unmountCalls = 0;
  const controller = createSavedPaymentStripePageController({
    loadStripe: async () => ({
      elements: () => ({ create: () => ({ mount() {}, unmount() { unmountCalls += 1; } }) }),
      retrieveSetupIntent: async () => ({ setupIntent: { id: 'seti_fixture', status: 'requires_payment_method' } }),
      confirmCardSetup: async () => ({ setupIntent: { id: 'seti_fixture', status: 'succeeded' } }),
    }),
    resolveTarget: () => ({}) as Element,
  });
  await controller.handle(bridgeRequest('mount-card', {
    publishableKey: 'pk_test_fixture',
    clientSecret: 'seti_fixture_secret_value',
    targetSelector: '#saved-card',
  }));
  const mismatch = await controller.handle({
    ...bridgeRequest('retrieve-setup-intent', {
      publishableKey: 'pk_test_fixture',
      clientSecret: 'seti_fixture_secret_value',
    }),
    accountDigest: 'b'.repeat(64),
  });

  assert.equal(mismatch.result.code, 'BRIDGE_CONTEXT_MISMATCH');
  assert.equal(unmountCalls, 1);
});

test('reconcile keeps attached, reusable, and default evidence independent', () => {
  const reconciliation = reconcileSavedPaymentMethod({
    expectedSetupIntentId: 'seti_fixture',
    intent: { id: 'seti_fixture', status: 'succeeded', paymentMethodId: 'pm_fixture' },
    list: {
      defaultPaymentMethodId: 'pm_other',
      paymentMethods: [{ id: 'pm_fixture', type: 'card', isDefault: false }],
    },
    requestedDefault: true,
  });

  assert.equal(reconciliation.intentSucceeded, true);
  assert.equal(reconciliation.attachedVerified, true);
  assert.equal(reconciliation.reusableVerified, true);
  assert.equal(reconciliation.defaultVerified, false);
  assert.equal(reconciliation.status, 'mismatch');
  assert.equal(reconciliation.code, 'DEFAULT_PAYMENT_METHOD_MISMATCH');
});

test('reconcile preserves requires-action as a distinct UI state', () => {
  const reconciliation = reconcileSavedPaymentMethod({
    expectedSetupIntentId: 'seti_fixture',
    intent: { id: 'seti_fixture', status: 'requires_action', paymentMethodId: 'pm_fixture' },
    list: { defaultPaymentMethodId: '', paymentMethods: [] },
    requestedDefault: false,
  });
  assert.equal(reconciliation.status, 'mismatch');
  assert.equal(reconciliation.code, 'SETUP_INTENT_REQUIRES_ACTION');
});

test('orchestrator completes all phases and single-flights duplicate attempts', async () => {
  let createCalls = 0;
  let confirmCalls = 0;
  let listCalls = 0;
  let unmountCalls = 0;
  const transport = fixtureTransport({
    onCreate: () => { createCalls += 1; },
    onList: () => { listCalls += 1; },
  });
  const bridge = fixtureBridge({
    onConfirm: () => { confirmCalls += 1; },
    onUnmount: () => { unmountCalls += 1; },
  });
  const orchestrator = createSavedPaymentOrchestrator({
    transport,
    createBridge: () => bridge,
    resolveMerchantKey: async () => verifiedOwnership(),
  });
  const input = {
    attemptId: 'attempt-fixture',
    session: { chatgptAccountId: 'account-fixture', accessToken: 'access-fixture' },
    publishableKey: 'pk_test_fixture',
    targetSelector: '#saved-card',
    billingName: 'Fixture User',
    setAsDefault: true,
  };
  const [result, duplicate] = await Promise.all([
    orchestrator.runCardSetup(input),
    orchestrator.runCardSetup(input),
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.code, 'SAVED_PAYMENT_VERIFIED');
  assert.deepEqual(result.attempt.trace, [...SAVED_PAYMENT_PHASES]);
  assert.equal(result.attempt.attachedVerified, true);
  assert.equal(result.attempt.reusableVerified, true);
  assert.equal(result.attempt.defaultVerified, true);
  assert.equal(duplicate, result);
  assert.equal(createCalls, 1);
  assert.equal(confirmCalls, 1);
  assert.equal(listCalls, 1);
  assert.equal(unmountCalls, 1);
});

test('orchestrator retrieves the original Intent after an inconclusive confirm', async () => {
  let retrieveCalls = 0;
  const bridge = fixtureBridge({
    confirmResult: {
      ok: false,
      code: 'CONFIRM_TIMEOUT_INCONCLUSIVE',
      message: 'timeout',
      sideEffect: 'unknown',
    },
    onRetrieve: () => { retrieveCalls += 1; },
  });
  const orchestrator = createSavedPaymentOrchestrator({
    transport: fixtureTransport(),
    createBridge: () => bridge,
    resolveMerchantKey: async () => verifiedOwnership(),
  });
  const result = await orchestrator.runCardSetup({
    attemptId: 'attempt-unknown',
    session: { chatgptAccountId: 'account-fixture', accessToken: 'access-fixture' },
    publishableKey: 'pk_test_fixture',
    targetSelector: '#saved-card',
    billingName: 'Fixture User',
  });

  assert.equal(result.ok, true);
  assert.equal(retrieveCalls, 1);
  assert.equal(result.attempt.confirmSubmitted, true);
});

test('orchestrator invalidates and unmounts an active attempt when account changes', async () => {
  let releaseConfirm: ((value: Awaited<ReturnType<SavedPaymentElementBridge['confirmCardSetup']>>) => void) | undefined;
  let confirmStartedResolve: (() => void) | undefined;
  const confirmStarted = new Promise<void>((resolve) => { confirmStartedResolve = resolve; });
  let unmountCalls = 0;
  const bridge = fixtureBridge({ onUnmount: () => { unmountCalls += 1; } });
  bridge.confirmCardSetup = () => {
    confirmStartedResolve?.();
    return new Promise((resolve) => { releaseConfirm = resolve; });
  };
  const orchestrator = createSavedPaymentOrchestrator({
    transport: fixtureTransport(),
    createBridge: () => bridge,
    resolveMerchantKey: async () => verifiedOwnership(),
  });
  const running = orchestrator.runCardSetup({
    attemptId: 'attempt-switch',
    session: { chatgptAccountId: 'account-a', accessToken: 'access-fixture' },
    publishableKey: 'pk_test_fixture',
    targetSelector: '#saved-card',
    billingName: 'Fixture User',
  });
  await confirmStarted;
  await orchestrator.switchAccount('account-b');
  releaseConfirm?.({
    ok: true,
    code: 'CONFIRM_COMPLETED',
    message: 'confirmed',
    data: { id: 'seti_fixture', status: 'succeeded', paymentMethodId: 'pm_fixture' },
    sideEffect: 'confirmed',
  });
  const result = await running;

  assert.equal(result.ok, false);
  assert.equal(result.code, 'ACCOUNT_SWITCHED');
  assert.equal(result.attempt.state, 'invalidated');
  assert.equal(unmountCalls >= 1, true);
});

test('orchestrator invalidates an older attempt when the same account explicitly restarts', async () => {
  let firstConfirmResolve: ((value: Awaited<ReturnType<SavedPaymentElementBridge['confirmCardSetup']>>) => void) | undefined;
  let firstStartedResolve: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => { firstStartedResolve = resolve; });
  let firstUnmounts = 0;
  const firstBridge = fixtureBridge({ onUnmount: () => { firstUnmounts += 1; } });
  firstBridge.confirmCardSetup = () => {
    firstStartedResolve?.();
    return new Promise((resolve) => { firstConfirmResolve = resolve; });
  };
  const secondBridge = fixtureBridge();
  let bridgeCount = 0;
  const orchestrator = createSavedPaymentOrchestrator({
    transport: fixtureTransport(),
    createBridge: () => bridgeCount++ === 0 ? firstBridge : secondBridge,
    resolveMerchantKey: async () => verifiedOwnership(),
  });
  const common = {
    session: { chatgptAccountId: 'account-fixture', accessToken: 'access-fixture' },
    publishableKey: 'pk_test_fixture',
    targetSelector: '#saved-card',
    billingName: 'Fixture User',
  };
  const firstRun = orchestrator.runCardSetup({ ...common, attemptId: 'attempt-old' });
  await firstStarted;
  const secondResult = await orchestrator.runCardSetup({ ...common, attemptId: 'attempt-new' });
  firstConfirmResolve?.({
    ok: true,
    code: 'CONFIRM_COMPLETED',
    message: 'confirmed',
    data: { id: 'seti_fixture', status: 'succeeded', paymentMethodId: 'pm_fixture' },
    sideEffect: 'confirmed',
  });
  const firstResult = await firstRun;

  assert.equal(secondResult.ok, true);
  assert.equal(firstResult.code, 'ATTEMPT_SUPERSEDED');
  assert.equal(firstResult.attempt.state, 'invalidated');
  assert.equal(firstUnmounts >= 1, true);
});

test('conditional payment methods require merchant, region, mandate, reusable object, and server evidence', () => {
  const missing = evaluateSavedPaymentMethodPolicy('paypal', {
    merchantEnabled: true,
    regionEnabled: true,
  });
  const supported = evaluateSavedPaymentMethodPolicy('paypal', {
    merchantEnabled: true,
    regionEnabled: true,
    mandateAccepted: true,
    reusableObject: true,
    serverListed: true,
  });

  assert.equal(missing.status, 'probe-required');
  assert.deepEqual(missing.missingEvidence, ['mandateAccepted', 'reusableObject', 'serverListed']);
  assert.equal(missing.mayStartSetup, false);
  assert.equal(supported.status, 'supported');
  assert.equal(supported.mayPersistMerchantCredential, true);
});

test('wallets remain wallet-managed and one-time rails never enter merchant saved credentials', () => {
  const wallet = evaluateSavedPaymentMethodPolicy('apple_pay', {
    walletAvailable: true,
    tokenizedCard: true,
  });
  const pix = evaluateSavedPaymentMethodPolicy('pix', {
    merchantEnabled: true,
    regionEnabled: true,
    mandateAccepted: true,
    reusableObject: true,
    serverListed: true,
  });

  assert.equal(wallet.status, 'supported');
  assert.equal(wallet.displayGroup, 'wallet');
  assert.equal(wallet.mayPersistMerchantCredential, false);
  assert.equal(pix.status, 'unsupported');
  assert.equal(pix.displayGroup, 'one-time');
  assert.equal(pix.mayStartSetup, false);
  assert.equal(classifyStoredPaymentMethodType('link'), 'wallet');
  assert.equal(classifyStoredPaymentMethodType('pix'), 'one-time');
  assert.equal(classifyStoredPaymentMethodType('card'), 'merchant-saved');
});

test('saved payment state migrates attempts and strips secrets, full keys, and raw card fields', () => {
  const secret = 'seti_fixture_secret_sensitivevalue';
  const fullKey = 'pk_live_fixture_sensitive_key_value';
  const state = normalizeSavedPaymentState({
    attempts: [{
      id: 'attempt-migrated',
      chatgptAccountId: 'account-fixture',
      method: 'card',
      state: 'failed',
      setupIntentId: 'seti_fixture',
      keyFingerprint: fullKey,
      confirmSubmitted: true,
      attachedVerified: false,
      reusableVerified: false,
      defaultVerified: false,
      trace: ['session', 'createSetupIntent'],
      createdAt: 1,
      updatedAt: 2,
      clientSecret: secret,
      cardNumber: '4000000000000002',
    }],
    accounts: {
      'account-fixture': {
        accountId: 'account-fixture',
        audit: [{
          id: 'audit-fixture',
          attemptId: 'attempt-migrated',
          phase: 'failed',
          code: 'FIXTURE',
          message: `provider rejected ${secret} using ${fullKey}`,
          createdAt: 2,
        }],
      },
    },
  });
  const account = state.accounts['account-fixture'];
  const json = exportSavedPaymentAuditJson(state, 'account-fixture');
  const csv = exportSavedPaymentAuditCsv(state, 'account-fixture');

  assert.equal(account.attempts.length, 1);
  assert.equal(account.attempts[0].keyFingerprint, undefined);
  assert.equal(JSON.stringify(account).includes(secret), false);
  assert.equal(JSON.stringify(account).includes(fullKey), false);
  assert.equal(JSON.stringify(account).includes('4000000000000002'), false);
  assert.equal(json.includes(secret), false);
  assert.equal(csv.includes(fullKey), false);
  assert.match(json, /\[SETUP_SECRET\]/);
  assert.match(json, /\[PUBLISHABLE_KEY\]/);
});

test('orchestrator supports a user confirmation pause and exits without confirm when cancelled', async () => {
  let confirmCalls = 0;
  const bridge = fixtureBridge({ onConfirm: () => { confirmCalls += 1; } });
  const orchestrator = createSavedPaymentOrchestrator({
    transport: fixtureTransport(),
    createBridge: () => bridge,
    resolveMerchantKey: async () => verifiedOwnership(),
    beforeConfirm: async ({ attempt }) => {
      assert.equal(attempt.state, 'mountElement');
      return false;
    },
  });
  const result = await orchestrator.runCardSetup({
    attemptId: 'attempt-cancelled',
    session: { chatgptAccountId: 'account-fixture', accessToken: 'access-fixture' },
    publishableKey: 'pk_test_fixture',
    targetSelector: '#saved-card',
    billingName: 'Fixture User',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'USER_CANCELLED');
  assert.equal(result.attempt.state, 'cancelled');
  assert.equal(result.attempt.confirmSubmitted, false);
  assert.equal(confirmCalls, 0);
});

test('saved payment content command accepts only fixed, bounded start messages', () => {
  assert.equal(isSavedPaymentStartMessage({
    type: 'opx:saved-payment:start',
    publishableKey: 'pk_test_fixture',
    billingName: 'Fixture User',
    setAsDefault: true,
  }), true);
  assert.equal(isSavedPaymentStartMessage({
    type: 'opx:saved-payment:start',
    publishableKey: 'bad-key',
    billingName: 'Fixture User',
  }), false);
  assert.equal(isSavedPaymentStartMessage({
    type: 'opx:saved-payment:script',
    publishableKey: 'pk_test_fixture',
    billingName: 'Fixture User',
  }), false);
});

function bridgeRequest(
  command: SavedPaymentBridgeRequest['command'],
  payload: Record<string, unknown>,
): SavedPaymentBridgeRequest {
  return {
    type: SAVED_PAYMENT_BRIDGE_REQUEST,
    version: SAVED_PAYMENT_BRIDGE_VERSION,
    command,
    requestId: 'request-fixture',
    attemptId: 'attempt-fixture',
    accountDigest: 'a'.repeat(64),
    payload,
  };
}

function fixtureTransport(hooks: {
  onCreate?: () => void;
  onList?: () => void;
} = {}): SavedPaymentTransport {
  return {
    async createSetupIntent() {
      hooks.onCreate?.();
      return {
        ok: true,
        code: 'SETUP_INTENT_CREATED',
        message: 'created',
        data: { setupIntentId: 'seti_fixture', clientSecret: 'seti_fixture_secret_value' },
        retryable: false,
        sideEffect: 'confirmed',
      };
    },
    async listPaymentMethods() {
      hooks.onList?.();
      return {
        ok: true,
        code: 'PAYMENT_METHODS_LISTED',
        message: 'listed',
        data: {
          defaultPaymentMethodId: 'pm_fixture',
          paymentMethods: [{ id: 'pm_fixture', type: 'card', isDefault: true }],
        },
        retryable: false,
        sideEffect: 'none',
      };
    },
  };
}

function fixtureBridge(options: {
  onConfirm?: () => void;
  onRetrieve?: () => void;
  onUnmount?: () => void;
  confirmResult?: Awaited<ReturnType<SavedPaymentElementBridge['confirmCardSetup']>>;
} = {}): SavedPaymentElementBridge {
  return {
    async retrieveSetupIntent() {
      options.onRetrieve?.();
      return {
        ok: true,
        code: 'SETUP_INTENT_RETRIEVED',
        message: 'retrieved',
        data: { id: 'seti_fixture', status: 'succeeded', paymentMethodId: 'pm_fixture' },
        sideEffect: 'none',
      };
    },
    async mountCard() {
      return { ok: true, code: 'CARD_ELEMENT_READY', message: 'ready', data: { ready: true }, sideEffect: 'none' };
    },
    async confirmCardSetup() {
      options.onConfirm?.();
      return options.confirmResult || {
        ok: true,
        code: 'CONFIRM_COMPLETED',
        message: 'confirmed',
        data: { id: 'seti_fixture', status: 'succeeded', paymentMethodId: 'pm_fixture' },
        sideEffect: 'confirmed',
      };
    },
    async unmount() {
      options.onUnmount?.();
      return { ok: true, code: 'ELEMENT_UNMOUNTED', message: 'unmounted', data: { unmounted: true }, sideEffect: 'none' };
    },
    dispose() {},
  };
}

function verifiedOwnership() {
  return {
    status: 'verified' as const,
    code: 'OWNERSHIP_VERIFIED' as const,
    message: 'verified',
    targetId: 'seti_fixture',
    keyFingerprint: 'pk_test...ixture',
  };
}
