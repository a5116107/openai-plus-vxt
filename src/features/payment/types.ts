export type PaymentMethodId =
  | 'hosted'
  | 'paypal'
  | 'momo'
  | 'gopay'
  | 'ideal'
  | 'upi'
  | 'pix'
  | 'blik'
  | 'twint'
  | 'kakao';

export type PaymentPipelineStage = 'bootstrap' | 'promotion' | 'provider';
export type PaymentCapabilityScope = 'global' | 'regional';
export type PaymentCurrencyPolicy = 'checkout' | 'fixed';
export type PaymentCountryPolicy = 'checkout' | 'profile';

export interface PaymentMethodProfile {
  id: PaymentMethodId;
  label: string;
  /** Global methods follow the qualified Checkout context; regional methods keep profile constraints. */
  capabilityScope: PaymentCapabilityScope;
  currencyPolicy: PaymentCurrencyPolicy;
  countryPolicy: PaymentCountryPolicy;
  /** Default countries for three-stage UPL flow. */
  bootstrapCountry: string;
  promotionCountry: string;
  providerCountry: string;
  /** Canonical lowercase currency required by the strict qualification gate. */
  expectedCurrency: string;
  /** Stripe payment_method type string when applicable. */
  stripeType?: string;
  /** Extra Stripe fields e.g. ideal[bank]=n26 */
  stripeExtras?: Record<string, string>;
  /** Host/path patterns that identify a final payment URL. */
  finalUrlPatterns: RegExp[];
  /** Human hints shown in UI. */
  notes: string;
}

export interface PaymentFinalUrlMatch {
  method: PaymentMethodId | 'unknown';
  url: string;
  source: 'pattern' | 'next_action' | 'sniff' | 'stripe_confirm' | 'raw';
  confidence: 'high' | 'medium' | 'low';
}

export interface PaymentFinalUrlResult {
  ok: boolean;
  message: string;
  matches: PaymentFinalUrlMatch[];
  best?: PaymentFinalUrlMatch;
}

export interface StripeConfirmInput {
  stripePk: string;
  checkoutSessionId: string;
  method: PaymentMethodId;
  billingCountry: string;
  billingName?: string;
  billingEmail?: string;
  returnUrl?: string;
  expectedAmount?: string;
  idealBank?: string;
}

export interface StripeConfirmResult {
  ok: boolean;
  message: string;
  paymentMethodId?: string;
  redirectUrl?: string;
  raw?: unknown;
}

export interface MethodStageProxyPool {
  method: PaymentMethodId;
  /** Multi-line raw proxy list for bootstrap stage. */
  bootstrapRaw: string;
  promotionRaw: string;
  providerRaw: string;
  /** Round-robin cursors. */
  bootstrapIndex: number;
  promotionIndex: number;
  providerIndex: number;
}

export interface PaymentExtractOptions {
  preferredMethods?: PaymentMethodId[];
  stripePk?: string;
  enableStripeConfirm?: boolean;
  idealBank?: string;
  checkoutSessionId?: string;
  billingCountry?: string;
  pageText?: string;
  raw?: unknown;
  existingUrls?: string[];
}
