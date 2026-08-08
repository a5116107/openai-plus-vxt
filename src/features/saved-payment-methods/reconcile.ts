import type { SavedPaymentIntentSnapshot } from './element-bridge';
import type { SavedPaymentMethodList } from './transport';

export interface SavedPaymentReconciliation {
  status: 'verified' | 'mismatch';
  setupIntentId: string;
  paymentMethodId: string;
  intentMatched: boolean;
  intentSucceeded: boolean;
  attachedVerified: boolean;
  reusableVerified: boolean;
  defaultVerified: boolean;
  code: string;
}

export function reconcileSavedPaymentMethod(input: {
  expectedSetupIntentId: string;
  intent: SavedPaymentIntentSnapshot;
  list: SavedPaymentMethodList;
  requestedDefault: boolean;
}): SavedPaymentReconciliation {
  const paymentMethodId = /^pm_[A-Za-z0-9]+$/.test(input.intent.paymentMethodId)
    ? input.intent.paymentMethodId
    : '';
  const intentMatched = input.intent.id === input.expectedSetupIntentId;
  const intentSucceeded = intentMatched && input.intent.status === 'succeeded';
  const listed = input.list.paymentMethods.find((method) => method.id === paymentMethodId);
  const attachedVerified = Boolean(intentSucceeded && paymentMethodId && listed);
  const reusableVerified = Boolean(attachedVerified && listed?.type === 'card');
  const defaultVerified = !input.requestedDefault || Boolean(
    attachedVerified &&
    input.list.defaultPaymentMethodId === paymentMethodId &&
    listed?.isDefault,
  );
  const verified = intentSucceeded && attachedVerified && reusableVerified && defaultVerified;
  return {
    status: verified ? 'verified' : 'mismatch',
    setupIntentId: input.expectedSetupIntentId,
    paymentMethodId,
    intentMatched,
    intentSucceeded,
    attachedVerified,
    reusableVerified,
    defaultVerified,
    code: verified ? 'SAVED_PAYMENT_VERIFIED' : reconciliationCode({
      intentStatus: input.intent.status,
      intentMatched,
      intentSucceeded,
      attachedVerified,
      reusableVerified,
      defaultVerified,
    }),
  };
}

function reconciliationCode(value: {
  intentStatus: string;
  intentMatched: boolean;
  intentSucceeded: boolean;
  attachedVerified: boolean;
  reusableVerified: boolean;
  defaultVerified: boolean;
}): string {
  if (!value.intentMatched) return 'SETUP_INTENT_MISMATCH';
  if (value.intentStatus === 'requires_action') return 'SETUP_INTENT_REQUIRES_ACTION';
  if (!value.intentSucceeded) return 'SETUP_INTENT_NOT_SUCCEEDED';
  if (!value.attachedVerified) return 'PAYMENT_METHOD_NOT_ATTACHED';
  if (!value.reusableVerified) return 'PAYMENT_METHOD_NOT_REUSABLE';
  return value.defaultVerified ? 'RECONCILE_MISMATCH' : 'DEFAULT_PAYMENT_METHOD_MISMATCH';
}
