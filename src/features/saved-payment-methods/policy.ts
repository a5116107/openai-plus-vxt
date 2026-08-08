import { getSavedPaymentCapability } from './capabilities';
import type { SavedPaymentCapabilityStatus, SavedPaymentMethodKind } from './types';

export interface SavedPaymentMethodEvidence {
  merchantEnabled?: boolean;
  regionEnabled?: boolean;
  providerObjectType?: string;
  setupSucceeded?: boolean;
  mandateAccepted?: boolean;
  reusableObject?: boolean;
  serverListed?: boolean;
  walletAvailable?: boolean;
  tokenizedCard?: boolean;
}

export interface SavedPaymentMethodPolicyDecision {
  method: SavedPaymentMethodKind;
  status: SavedPaymentCapabilityStatus;
  displayGroup: 'merchant-saved' | 'wallet' | 'one-time';
  mayStartSetup: boolean;
  mayPersistMerchantCredential: boolean;
  code: string;
  missingEvidence: string[];
}

const ONE_TIME_METHODS = new Set<SavedPaymentMethodKind>([
  'pix',
  'blik',
  'twint',
  'momo',
  'gopay',
  'kakao_pay',
]);

export function evaluateSavedPaymentMethodPolicy(
  method: SavedPaymentMethodKind,
  evidence: SavedPaymentMethodEvidence = {},
): SavedPaymentMethodPolicyDecision {
  const capability = getSavedPaymentCapability(method);
  if (ONE_TIME_METHODS.has(method)) {
    return decision(method, 'unsupported', 'one-time', false, false, 'ONE_TIME_METHOD', []);
  }
  if (method === 'apple_pay' || method === 'google_pay') {
    const missing = missingEvidence(evidence, ['walletAvailable', 'tokenizedCard']);
    return decision(
      method,
      missing.length ? 'probe-required' : 'supported',
      'wallet',
      false,
      false,
      missing.length ? 'WALLET_EVIDENCE_REQUIRED' : 'WALLET_MANAGED',
      missing,
    );
  }
  if (method === 'link') {
    const missing = missingEvidence(evidence, ['merchantEnabled', 'regionEnabled', 'serverListed']);
    return decision(
      method,
      missing.length ? 'probe-required' : 'supported',
      'wallet',
      false,
      false,
      missing.length ? 'LINK_EVIDENCE_REQUIRED' : 'LINK_ACCOUNT_AVAILABLE',
      missing,
    );
  }
  if (method === 'card') {
    const missing = missingEvidence(evidence, ['setupSucceeded', 'reusableObject', 'serverListed']);
    return decision(
      method,
      missing.length ? capability.status : 'supported',
      'merchant-saved',
      true,
      missing.length === 0,
      missing.length ? 'CARD_RECONCILE_REQUIRED' : 'CARD_SAVED_VERIFIED',
      missing,
    );
  }

  const required: Array<keyof SavedPaymentMethodEvidence> = [
    'merchantEnabled',
    'regionEnabled',
    'mandateAccepted',
    'reusableObject',
    'serverListed',
  ];
  const missing = missingEvidence(evidence, required);
  const isDebitOrMandate = method === 'paypal' || method === 'bank_debit' || method === 'bank_redirect' || method === 'upi';
  return decision(
    method,
    missing.length || !isDebitOrMandate ? 'probe-required' : 'supported',
    'merchant-saved',
    missing.length === 0 && isDebitOrMandate,
    missing.length === 0 && isDebitOrMandate,
    missing.length ? 'MANDATE_EVIDENCE_REQUIRED' : 'MANDATE_SAVED_VERIFIED',
    missing,
  );
}

export function listSavedPaymentPolicyDecisions(
  evidence: Partial<Record<SavedPaymentMethodKind, SavedPaymentMethodEvidence>> = {},
): SavedPaymentMethodPolicyDecision[] {
  const methods: SavedPaymentMethodKind[] = [
    'card', 'paypal', 'apple_pay', 'google_pay', 'link', 'bank_debit', 'bank_redirect', 'upi',
    'pix', 'blik', 'twint', 'momo', 'gopay', 'kakao_pay',
  ];
  return methods.map((method) => evaluateSavedPaymentMethodPolicy(method, evidence[method]));
}

export function classifyStoredPaymentMethodType(
  type: string,
): SavedPaymentMethodPolicyDecision['displayGroup'] {
  const normalized = String(type || '').trim().toLowerCase();
  if (normalized === 'link' || normalized === 'apple_pay' || normalized === 'google_pay') return 'wallet';
  if (ONE_TIME_METHODS.has(normalized as SavedPaymentMethodKind)) return 'one-time';
  return 'merchant-saved';
}

function missingEvidence(
  evidence: SavedPaymentMethodEvidence,
  keys: Array<keyof SavedPaymentMethodEvidence>,
): string[] {
  return keys.filter((key) => evidence[key] !== true);
}

function decision(
  method: SavedPaymentMethodKind,
  status: SavedPaymentCapabilityStatus,
  displayGroup: SavedPaymentMethodPolicyDecision['displayGroup'],
  mayStartSetup: boolean,
  mayPersistMerchantCredential: boolean,
  code: string,
  missingEvidence: string[],
): SavedPaymentMethodPolicyDecision {
  return {
    method,
    status,
    displayGroup,
    mayStartSetup,
    mayPersistMerchantCredential,
    code,
    missingEvidence,
  };
}
