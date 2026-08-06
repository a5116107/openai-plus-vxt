export type SavedPaymentIntentKind = 'setup' | 'payment-checkout' | 'mandate';

export type SavedPaymentMethodKind =
  | 'card'
  | 'paypal'
  | 'apple_pay'
  | 'google_pay'
  | 'link'
  | 'bank_debit'
  | 'bank_redirect'
  | 'upi'
  | 'pix'
  | 'blik'
  | 'twint'
  | 'momo'
  | 'gopay'
  | 'kakao_pay';

export type SavedPaymentChannel =
  | 'inline-elements'
  | 'hosted-checkout'
  | 'native-redirect'
  | 'saved-method-picker';

export type SavedPaymentReusePolicy =
  | 'reusable'
  | 'conditional'
  | 'wallet-managed'
  | 'one-time-only';

export type SavedPaymentCapabilityStatus = 'supported' | 'probe-required' | 'unsupported';

export interface SavedPaymentCapability {
  method: SavedPaymentMethodKind;
  intentKinds: SavedPaymentIntentKind[];
  channels: SavedPaymentChannel[];
  reusePolicy: SavedPaymentReusePolicy;
  status: SavedPaymentCapabilityStatus;
  evidenceRequired: string[];
  note: string;
}

export interface SavedPaymentAccountBinding {
  chatgptAccountId: string;
  email: string;
  stripeCustomerId?: string;
  capturedAt: number;
}

export type StripeKeyOwnershipStatus = 'verified' | 'rejected' | 'inconclusive';

export interface StripeKeyOwnershipResult {
  status: StripeKeyOwnershipStatus;
  code:
    | 'OWNERSHIP_VERIFIED'
    | 'INVALID_PUBLISHABLE_KEY'
    | 'INVALID_CHECKOUT_SESSION'
    | 'MODE_MISMATCH'
    | 'STRIPE_REJECTED'
    | 'NETWORK_INCONCLUSIVE'
    | 'RESPONSE_INCONCLUSIVE';
  message: string;
  targetId: string;
  keyFingerprint: string;
  httpStatus?: number;
}
