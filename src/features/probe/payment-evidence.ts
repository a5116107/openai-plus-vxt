import type { StrictZeroGateResult } from '../payment/strict-zero-gate';
import type { PaymentMethodId } from '../payment/types';
import type { ProbePaymentCheckoutSessionMode } from './types';

export interface PaymentLinkEvidenceInput {
  method: PaymentMethodId;
  sessionMode: ProbePaymentCheckoutSessionMode;
  sourceCheckoutSessionId: string;
  checkoutSessionId: string;
  sourceQualificationVerified: boolean;
  gate?: StrictZeroGateResult;
}

export interface PaymentLinkEvidence {
  sourceQualificationVerified: boolean;
  sourceSessionReused: boolean;
  methodOffered: boolean;
  qualificationPreserved: boolean;
}

export interface PaymentProbeCandidate {
  method: PaymentMethodId;
  forcedProbe: boolean;
}

export function selectPaymentProbeCandidates(input: {
  detectedMethods: PaymentMethodId[];
  requestedMethods: PaymentMethodId[];
  forceUnlisted: boolean;
}): PaymentProbeCandidate[] {
  const detected = [...new Set(input.detectedMethods)];
  const detectedSet = new Set(detected);
  if (!input.forceUnlisted) {
    return detected.map((method) => ({ method, forcedProbe: false }));
  }

  const requested = [...new Set(input.requestedMethods)];
  return [...requested, ...detected.filter((method) => !requested.includes(method))]
    .map((method) => ({ method, forcedProbe: !detectedSet.has(method) }));
}

/**
 * A method-specific link is only a preservation result when it stayed on the
 * already-qualified Checkout and the runner revalidated that same Checkout.
 */
export function buildPaymentLinkEvidence(input: PaymentLinkEvidenceInput): PaymentLinkEvidence {
  const sourceCheckoutSessionId = String(input.sourceCheckoutSessionId || '').trim();
  const checkoutSessionId = String(input.checkoutSessionId || '').trim();
  const sourceSessionReused = Boolean(sourceCheckoutSessionId)
    && sourceCheckoutSessionId === checkoutSessionId;
  const expectedMethod = input.method === 'kakao' ? 'kakao_pay' : input.method;
  const methodOffered = Boolean(input.gate?.methods?.includes(expectedMethod));
  const sourceQualificationVerified = Boolean(input.sourceQualificationVerified);

  return {
    sourceQualificationVerified,
    sourceSessionReused,
    methodOffered,
    qualificationPreserved: sourceSessionReused
      && sourceQualificationVerified
      && Boolean(input.gate?.passed)
      && methodOffered,
  };
}
