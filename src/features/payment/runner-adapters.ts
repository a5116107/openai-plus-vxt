import { getPaymentMethodProfile, isAllowedFinalPaymentUrl, resolvePaymentCapability } from './methods';
import type { PaymentProxyRole, PaymentRunnerStage } from './runner-types';
import type { PaymentMethodId } from './types';

export interface PaymentMethodAdapter {
  method: PaymentMethodId;
  stripeType?: string;
  expectedCurrency: string;
  currencyPolicy: 'checkout' | 'fixed';
  capabilityScope: 'global' | 'regional';
  supportsNativeRunner: boolean;
  resolveExpectedCurrency(checkoutCurrency?: string): string;
  proxyRole(stage: PaymentRunnerStage): PaymentProxyRole;
  acceptsFinalUrl(url: string): boolean;
  acceptsIntermediateUrl(url: string): boolean;
}

const RUNNER_METHODS = new Set<PaymentMethodId>([
  'paypal', 'momo', 'gopay', 'ideal', 'upi', 'pix', 'blik', 'twint', 'kakao',
]);

export function getPaymentMethodAdapter(method: PaymentMethodId): PaymentMethodAdapter {
  const profile = getPaymentMethodProfile(method);
  return {
    method,
    stripeType: profile.stripeType,
    expectedCurrency: profile.expectedCurrency,
    currencyPolicy: profile.currencyPolicy,
    capabilityScope: profile.capabilityScope,
    supportsNativeRunner: RUNNER_METHODS.has(method) && Boolean(profile.stripeType),
    resolveExpectedCurrency(checkoutCurrency) {
      return resolvePaymentCapability(method, { currency: checkoutCurrency }).expectedCurrency;
    },
    proxyRole(stage) {
      if (stage === 'createPM' || stage === 'confirm' || stage === 'finalize') return 'provider';
      if (stage === 'approve' || stage === 'poll') return 'approve';
      return 'checkout';
    },
    acceptsFinalUrl(url) {
      return isAllowedFinalPaymentUrl(method, url);
    },
    acceptsIntermediateUrl(value) {
      try {
        const url = new URL(value);
        const host = url.hostname.toLowerCase();
        return url.protocol === 'https:' && !url.username && !url.password && !url.port
          && ['hooks.stripe.com', 'pm-redirects.stripe.com'].includes(host);
      } catch {
        return false;
      }
    },
  };
}
