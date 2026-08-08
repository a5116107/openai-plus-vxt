import {
  digestSavedPaymentAccountId,
  sanitizeSavedPaymentMessage,
  type SavedPaymentBridgeResult,
  type SavedPaymentElementBridge,
  type SavedPaymentIntentSnapshot,
} from './element-bridge';
import { reconcileSavedPaymentMethod, type SavedPaymentReconciliation } from './reconcile';
import { verifyStripeSetupIntentKeyOwnership } from './stripe-key-ownership';
import type { StripeKeyOwnershipResult } from './types';
import type { SavedPaymentSessionContext, SavedPaymentTransport } from './transport';

export const SAVED_PAYMENT_OPERATION_PHASES = [
  'createSetupIntent',
  'resolveMerchantKey',
  'mountElement',
  'confirmSetup',
  'retrieveIntent',
  'listPaymentMethods',
  'verifyAttachedAndDefault',
] as const;

export const SAVED_PAYMENT_PHASES = [
  'session',
  ...SAVED_PAYMENT_OPERATION_PHASES,
] as const;

export type SavedPaymentPhase = typeof SAVED_PAYMENT_PHASES[number];

export interface SavedPaymentAttemptRecord {
  id: string;
  chatgptAccountId: string;
  method: 'card';
  state: SavedPaymentPhase | 'completed' | 'failed' | 'invalidated' | 'cancelled';
  setupIntentId?: string;
  paymentMethodId?: string;
  keyFingerprint?: string;
  confirmSubmitted: boolean;
  attachedVerified: boolean;
  reusableVerified: boolean;
  defaultVerified: boolean;
  trace: SavedPaymentPhase[];
  createdAt: number;
  updatedAt: number;
}

export interface RunSavedCardSetupInput {
  attemptId: string;
  session: SavedPaymentSessionContext;
  publishableKey: string;
  targetSelector: string;
  billingName: string;
  setAsDefault?: boolean;
}

export interface SavedPaymentOrchestratorResult {
  ok: boolean;
  code: string;
  message: string;
  attempt: SavedPaymentAttemptRecord;
  reconciliation?: SavedPaymentReconciliation;
}

export interface SavedPaymentOrchestratorDependencies {
  transport: SavedPaymentTransport;
  createBridge(input: { attemptId: string; accountDigest: string }): SavedPaymentElementBridge;
  resolveMerchantKey?: (input: {
    publishableKey: string;
    clientSecret: string;
    bridge: SavedPaymentElementBridge;
  }) => Promise<StripeKeyOwnershipResult>;
  beforeConfirm?: (input: {
    attempt: SavedPaymentAttemptRecord;
  }) => Promise<boolean>;
  now?: () => number;
}

export interface SavedPaymentOrchestrator {
  runCardSetup(input: RunSavedCardSetupInput): Promise<SavedPaymentOrchestratorResult>;
  switchAccount(chatgptAccountId: string): Promise<void>;
  dispose(): Promise<void>;
}

export function createSavedPaymentOrchestrator(
  dependencies: SavedPaymentOrchestratorDependencies,
): SavedPaymentOrchestrator {
  const now = dependencies.now || Date.now;
  const resolveMerchantKey = dependencies.resolveMerchantKey || resolveKeyWithBridge;
  const runs = new Map<string, Promise<SavedPaymentOrchestratorResult>>();
  let activeAccountId = '';
  let activeAttemptId = '';
  let activeBridge: SavedPaymentElementBridge | null = null;
  let generation = 0;

  const switchAccount = async (chatgptAccountId: string) => {
    const normalized = String(chatgptAccountId || '').trim();
    if (normalized === activeAccountId) return;
    generation += 1;
    const staleBridge = activeBridge;
    activeBridge = null;
    activeAccountId = normalized;
    activeAttemptId = '';
    if (staleBridge) {
      await staleBridge.unmount().catch(() => undefined);
      staleBridge.dispose();
    }
  };

  const activateAttempt = async (chatgptAccountId: string, attemptId: string) => {
    await switchAccount(chatgptAccountId);
    if (activeAttemptId === attemptId) return;
    if (activeAttemptId) generation += 1;
    const staleBridge = activeBridge;
    activeBridge = null;
    activeAttemptId = attemptId;
    if (staleBridge) {
      await staleBridge.unmount().catch(() => undefined);
      staleBridge.dispose();
    }
  };

  const runCardSetup = (input: RunSavedCardSetupInput): Promise<SavedPaymentOrchestratorResult> => {
    const key = `${input.session.chatgptAccountId}|card|${input.attemptId}`;
    const existing = runs.get(key);
    if (existing) return existing;
    const run = runInternal(input);
    runs.set(key, run);
    return run;
  };

  const runInternal = async (input: RunSavedCardSetupInput): Promise<SavedPaymentOrchestratorResult> => {
    await activateAttempt(input.session.chatgptAccountId, String(input.attemptId || '').trim());
    const runGeneration = generation;
    const attempt: SavedPaymentAttemptRecord = {
      id: String(input.attemptId || '').trim(),
      chatgptAccountId: String(input.session.chatgptAccountId || '').trim(),
      method: 'card',
      state: 'session',
      confirmSubmitted: false,
      attachedVerified: false,
      reusableVerified: false,
      defaultVerified: false,
      trace: [],
      createdAt: now(),
      updatedAt: now(),
    };
    const enter = (phase: SavedPaymentPhase) => {
      attempt.state = phase;
      attempt.trace.push(phase);
      attempt.updatedAt = now();
    };
    const current = () => generation === runGeneration && activeAccountId === attempt.chatgptAccountId;
    const fail = (code: string, message: string): SavedPaymentOrchestratorResult => {
      const isCurrent = current();
      const invalidationCode = activeAccountId === attempt.chatgptAccountId
        ? 'ATTEMPT_SUPERSEDED'
        : 'ACCOUNT_SWITCHED';
      attempt.state = isCurrent ? 'failed' : 'invalidated';
      attempt.updatedAt = now();
      return {
        ok: false,
        code: isCurrent ? code : invalidationCode,
        message: sanitizeSavedPaymentMessage(message),
        attempt,
      };
    };

    if (!attempt.id || !attempt.chatgptAccountId || !String(input.session.accessToken || '').trim()) {
      return fail('IDENTITY_REQUIRED', 'saved payment session identity is incomplete');
    }

    enter('session');
    enter('createSetupIntent');
    const created = await dependencies.transport.createSetupIntent(input.session, attempt.id);
    if (!current()) return fail('ACCOUNT_SWITCHED', 'account changed during SetupIntent creation');
    if (!created.ok || !created.data) return fail(created.code, created.message);
    attempt.setupIntentId = created.data.setupIntentId;

    const accountDigest = await digestSavedPaymentAccountId(attempt.chatgptAccountId);
    if (!current()) return fail('ACCOUNT_SWITCHED', 'account changed before bridge initialization');
    const bridge = dependencies.createBridge({ attemptId: attempt.id, accountDigest });
    activeBridge = bridge;

    try {
      enter('resolveMerchantKey');
      const ownership = await resolveMerchantKey({
        publishableKey: input.publishableKey,
        clientSecret: created.data.clientSecret,
        bridge,
      });
      if (!current()) return fail('ACCOUNT_SWITCHED', 'account changed during key verification');
      attempt.keyFingerprint = ownership.keyFingerprint;
      if (ownership.status !== 'verified') return fail(ownership.code, ownership.message);

      enter('mountElement');
      const mounted = await bridge.mountCard({
        publishableKey: input.publishableKey,
        clientSecret: created.data.clientSecret,
        targetSelector: input.targetSelector,
      });
      if (!current()) return fail('ACCOUNT_SWITCHED', 'account changed while mounting card element');
      if (!mounted.ok || !mounted.data?.ready) return fail(mounted.code, mounted.message);

      if (dependencies.beforeConfirm) {
        let approved = false;
        try {
          approved = await dependencies.beforeConfirm({
            attempt: { ...attempt, trace: [...attempt.trace] },
          });
        } catch (error) {
          return fail('USER_CONFIRMATION_FAILED', error instanceof Error ? error.message : String(error));
        }
        if (!current()) return fail('ACCOUNT_SWITCHED', 'payment attempt changed before confirmation');
        if (!approved) {
          attempt.state = 'cancelled';
          attempt.updatedAt = now();
          return {
            ok: false,
            code: 'USER_CANCELLED',
            message: 'card setup was cancelled before confirmation',
            attempt,
          };
        }
      }

      enter('confirmSetup');
      attempt.confirmSubmitted = true;
      const confirmed = await bridge.confirmCardSetup({
        clientSecret: created.data.clientSecret,
        billingName: input.billingName,
        setAsDefault: input.setAsDefault !== false,
      });
      if (!current()) return fail('ACCOUNT_SWITCHED', 'account changed during card confirmation');
      if (!confirmed.ok && confirmed.sideEffect === 'none') return fail(confirmed.code, confirmed.message);

      enter('retrieveIntent');
      const retrieved = await bridge.retrieveSetupIntent({
        publishableKey: input.publishableKey,
        clientSecret: created.data.clientSecret,
      });
      if (!current()) return fail('ACCOUNT_SWITCHED', 'account changed during SetupIntent retrieval');
      if (!retrieved.ok || !retrieved.data) return fail(retrieved.code, retrieved.message);
      const intent = retrieved.data;
      attempt.paymentMethodId = intent.paymentMethodId || undefined;

      enter('listPaymentMethods');
      const listed = await dependencies.transport.listPaymentMethods(input.session);
      if (!current()) return fail('ACCOUNT_SWITCHED', 'account changed during saved method reconciliation');
      if (!listed.ok || !listed.data) return fail(listed.code, listed.message);

      enter('verifyAttachedAndDefault');
      const reconciliation = reconcileSavedPaymentMethod({
        expectedSetupIntentId: created.data.setupIntentId,
        intent,
        list: listed.data,
        requestedDefault: input.setAsDefault !== false,
      });
      attempt.attachedVerified = reconciliation.attachedVerified;
      attempt.reusableVerified = reconciliation.reusableVerified;
      attempt.defaultVerified = reconciliation.defaultVerified;
      attempt.state = reconciliation.status === 'verified' ? 'completed' : 'failed';
      attempt.updatedAt = now();
      return {
        ok: reconciliation.status === 'verified',
        code: reconciliation.code,
        message: reconciliation.status === 'verified'
          ? 'saved card is attached and reconciled'
          : 'saved card reconciliation did not match',
        attempt,
        reconciliation,
      };
    } finally {
      if (activeBridge === bridge) {
        activeBridge = null;
        if (activeAttemptId === attempt.id) activeAttemptId = '';
      }
      await bridge.unmount().catch(() => undefined);
      bridge.dispose();
    }
  };

  return {
    runCardSetup,
    switchAccount,
    async dispose() {
      generation += 1;
      const bridge = activeBridge;
      activeBridge = null;
      activeAccountId = '';
      activeAttemptId = '';
      if (bridge) {
        await bridge.unmount().catch(() => undefined);
        bridge.dispose();
      }
    },
  };
}

async function resolveKeyWithBridge(input: {
  publishableKey: string;
  clientSecret: string;
  bridge: SavedPaymentElementBridge;
}): Promise<StripeKeyOwnershipResult> {
  return verifyStripeSetupIntentKeyOwnership({
    publishableKey: input.publishableKey,
    clientSecret: input.clientSecret,
    retrieveSetupIntent: async (publishableKey, clientSecret) => {
      const result: SavedPaymentBridgeResult<SavedPaymentIntentSnapshot> = await input.bridge.retrieveSetupIntent({
        publishableKey,
        clientSecret,
      });
      return result.ok && result.data
        ? { setupIntent: { id: result.data.id, status: result.data.status } }
        : { error: { message: result.message } };
    },
  });
}
