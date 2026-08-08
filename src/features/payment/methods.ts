import type {
  PaymentCapabilityScope,
  PaymentCountryPolicy,
  PaymentCurrencyPolicy,
  PaymentMethodId,
  PaymentMethodProfile,
  PaymentPipelineStage,
} from './types';

const FINAL = {
  ideal: [/^https:\/\/[^/]*\.ideal\.nl\//i, /^https:\/\/ideal\.nl\//i, /^https:\/\/pay\.bunq\.com\//i],
  upi: [/^https:\/\/payments\.stripe\.com\/upi\/instructions\//i],
  pix: [/^https:\/\/payments\.stripe\.com\/pix\//i],
  blik: [/^https:\/\/payments\.stripe\.com\/[^?#]*blik/i],
  twint: [/^https:\/\/[^/]*twint\.ch\//i],
  kakao: [/^https:\/\/[^/]*(?:kakao|nicepay)[^/]*\//i],
  momo: [/^https:\/\/payment\.momo\.vn\//i],
  gopay: [/^https:\/\/app\.midtrans\.com\/snap\/v\d+\/redirection\//i],
  paypal: [/^https:\/\/[^/]*paypal\.com\//i],
  hosted: [/^https:\/\/checkout\.stripe\.com\/c\/pay\//i, /^https:\/\/pay\.openai\.com\/c\/pay\//i],
};

export const PAYMENT_METHOD_PROFILES: Record<PaymentMethodId, PaymentMethodProfile> = {
  hosted: {
    id: 'hosted',
    label: 'Hosted Checkout',
    capabilityScope: 'global',
    currencyPolicy: 'checkout',
    countryPolicy: 'checkout',
    bootstrapCountry: 'US',
    promotionCountry: 'VN',
    providerCountry: 'US',
    expectedCurrency: 'usd',
    finalUrlPatterns: FINAL.hosted,
    notes: 'Stripe hosted / pay.openai.com 长链',
  },
  paypal: {
    id: 'paypal',
    label: 'PayPal',
    capabilityScope: 'global',
    currencyPolicy: 'checkout',
    countryPolicy: 'checkout',
    bootstrapCountry: 'US',
    promotionCountry: 'VN',
    providerCountry: 'US',
    expectedCurrency: 'usd',
    stripeType: 'paypal',
    finalUrlPatterns: FINAL.paypal,
    notes: 'PayPal 跳转链',
  },
  momo: {
    id: 'momo',
    label: 'MoMo',
    capabilityScope: 'regional',
    currencyPolicy: 'fixed',
    countryPolicy: 'profile',
    bootstrapCountry: 'VN',
    promotionCountry: 'VN',
    providerCountry: 'VN',
    expectedCurrency: 'vnd',
    stripeType: 'momo',
    finalUrlPatterns: FINAL.momo,
    notes: 'VN · payment.momo.vn',
  },
  gopay: {
    id: 'gopay',
    label: 'GoPay',
    capabilityScope: 'regional',
    currencyPolicy: 'fixed',
    countryPolicy: 'profile',
    bootstrapCountry: 'ID',
    promotionCountry: 'ID',
    providerCountry: 'ID',
    expectedCurrency: 'idr',
    stripeType: 'gopay',
    finalUrlPatterns: FINAL.gopay,
    notes: 'ID · Midtrans redirect',
  },
  ideal: {
    id: 'ideal',
    label: 'iDEAL',
    capabilityScope: 'regional',
    currencyPolicy: 'fixed',
    countryPolicy: 'profile',
    bootstrapCountry: 'NL',
    promotionCountry: 'VN',
    providerCountry: 'NL',
    expectedCurrency: 'eur',
    stripeType: 'ideal',
    stripeExtras: { 'ideal[bank]': 'n26' },
    finalUrlPatterns: FINAL.ideal,
    notes: 'NL bootstrap/provider · VN promotion · 银行授权 URL',
  },
  upi: {
    id: 'upi',
    label: 'UPI',
    capabilityScope: 'regional',
    currencyPolicy: 'fixed',
    countryPolicy: 'profile',
    bootstrapCountry: 'IN',
    promotionCountry: 'VN',
    providerCountry: 'IN',
    expectedCurrency: 'inr',
    stripeType: 'upi',
    finalUrlPatterns: FINAL.upi,
    notes: 'IN bootstrap/provider · VN promotion · payments.stripe.com/upi/instructions',
  },
  pix: {
    id: 'pix',
    label: 'PIX',
    capabilityScope: 'regional',
    currencyPolicy: 'fixed',
    countryPolicy: 'profile',
    bootstrapCountry: 'BR',
    promotionCountry: 'VN',
    providerCountry: 'BR',
    expectedCurrency: 'brl',
    stripeType: 'pix',
    finalUrlPatterns: FINAL.pix,
    notes: 'BR bootstrap/provider · VN promotion',
  },
  blik: {
    id: 'blik',
    label: 'BLIK',
    capabilityScope: 'regional',
    currencyPolicy: 'fixed',
    countryPolicy: 'profile',
    bootstrapCountry: 'PL',
    promotionCountry: 'VN',
    providerCountry: 'PL',
    expectedCurrency: 'pln',
    stripeType: 'blik',
    finalUrlPatterns: FINAL.blik,
    notes: 'PL bootstrap/provider · VN promotion',
  },
  twint: {
    id: 'twint',
    label: 'TWINT',
    capabilityScope: 'regional',
    currencyPolicy: 'fixed',
    countryPolicy: 'profile',
    bootstrapCountry: 'CH',
    promotionCountry: 'VN',
    providerCountry: 'CH',
    expectedCurrency: 'chf',
    stripeType: 'twint',
    finalUrlPatterns: FINAL.twint,
    notes: 'CH bootstrap/provider · VN promotion',
  },
  kakao: {
    id: 'kakao',
    label: 'Kakao Pay',
    capabilityScope: 'regional',
    currencyPolicy: 'fixed',
    countryPolicy: 'profile',
    bootstrapCountry: 'KR',
    promotionCountry: 'VN',
    providerCountry: 'KR',
    expectedCurrency: 'krw',
    stripeType: 'kakao_pay',
    finalUrlPatterns: FINAL.kakao,
    notes: 'KR bootstrap/provider · VN promotion',
  },
};

export const PAYMENT_METHOD_IDS = Object.keys(PAYMENT_METHOD_PROFILES) as PaymentMethodId[];

export function getPaymentMethodProfile(method: string | undefined | null): PaymentMethodProfile {
  const id = String(method || '').trim().toLowerCase() as PaymentMethodId;
  return PAYMENT_METHOD_PROFILES[id] || PAYMENT_METHOD_PROFILES.hosted;
}

export function listPaymentMethodProfiles(): PaymentMethodProfile[] {
  return PAYMENT_METHOD_IDS.map((id) => PAYMENT_METHOD_PROFILES[id]);
}

export function resolveMethodStageCountry(
  method: PaymentMethodId | string,
  stage: PaymentPipelineStage,
  override?: Partial<Record<PaymentPipelineStage, string>>,
  checkoutCountry?: string,
): string {
  const profile = getPaymentMethodProfile(method);
  const fromOverride = override?.[stage];
  if (fromOverride && /^[A-Z]{2}$/i.test(fromOverride)) {
    return fromOverride.toUpperCase();
  }
  const actualCountry = normalizeCountry(checkoutCountry);
  if (profile.countryPolicy === 'checkout' && actualCountry) return actualCountry;
  if (stage === 'bootstrap') return profile.bootstrapCountry;
  if (stage === 'promotion') return profile.promotionCountry;
  return profile.providerCountry;
}

export interface ResolvedPaymentCapability {
  scope: PaymentCapabilityScope;
  currencyPolicy: PaymentCurrencyPolicy;
  countryPolicy: PaymentCountryPolicy;
  expectedCurrency: string;
  bootstrapCountry: string;
  promotionCountry: string;
  providerCountry: string;
}

export function resolvePaymentCapability(
  method: PaymentMethodId | string,
  checkoutContext: { country?: string; currency?: string } = {},
  override?: Partial<Record<PaymentPipelineStage, string>>,
): ResolvedPaymentCapability {
  const profile = getPaymentMethodProfile(method);
  const checkoutCountry = normalizeCountry(checkoutContext.country);
  const checkoutCurrency = normalizeCurrency(checkoutContext.currency);
  return {
    scope: profile.capabilityScope,
    currencyPolicy: profile.currencyPolicy,
    countryPolicy: profile.countryPolicy,
    expectedCurrency: profile.currencyPolicy === 'checkout' && checkoutCurrency
      ? checkoutCurrency
      : profile.expectedCurrency,
    bootstrapCountry: resolveMethodStageCountry(method, 'bootstrap', override, checkoutCountry),
    promotionCountry: resolveMethodStageCountry(method, 'promotion', override, checkoutCountry),
    providerCountry: resolveMethodStageCountry(method, 'provider', override, checkoutCountry),
  };
}

function normalizeCountry(value: string | undefined): string {
  const country = String(value || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(country) ? country : '';
}

function normalizeCurrency(value: string | undefined): string {
  const currency = String(value || '').trim().toLowerCase();
  return /^[a-z]{3}$/.test(currency) ? currency : '';
}

export function preferredMethodsFromChannels(channels: string[] | undefined): PaymentMethodId[] {
  const list = (channels || []).map((item) => String(item || '').trim().toLowerCase());
  const out: PaymentMethodId[] = [];
  for (const id of PAYMENT_METHOD_IDS) {
    if (list.includes(id)) out.push(id);
  }
  if (!out.length) out.push('hosted');
  return out;
}

export function matchMethodByUrl(url: string): PaymentMethodId | 'unknown' {
  const raw = String(url || '').trim();
  for (const id of PAYMENT_METHOD_IDS) {
    if (id === 'hosted') continue;
    if (isAllowedFinalPaymentUrl(id, raw)) {
      return id;
    }
  }
  if (isAllowedFinalPaymentUrl('hosted', raw)) {
    return 'hosted';
  }
  return 'unknown';
}

export function isAllowedFinalPaymentUrl(method: PaymentMethodId, value: string): boolean {
  let url: URL;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const path = url.pathname.toLowerCase();
  const exactOrSubdomain = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  if (method === 'hosted') {
    return (host === 'pay.openai.com' || host === 'checkout.stripe.com') && path.startsWith('/c/pay/');
  }
  if (method === 'paypal') {
    return exactOrSubdomain('paypal.com') && [
      '/agreements/approve', '/checkoutnow', '/webapps/hermes', '/checkoutweb/', '/myaccount/autopay/',
    ].some((prefix) => path.startsWith(prefix));
  }
  if (method === 'momo') return host === 'payment.momo.vn' && path.length > 1;
  if (method === 'gopay') return host === 'app.midtrans.com' && /^\/snap\/v\d+\/redirection\//.test(path);
  if (method === 'upi') return host === 'payments.stripe.com' && path.startsWith('/upi/instructions/');
  if (method === 'pix') return host === 'payments.stripe.com' && path.startsWith('/pix/');
  if (method === 'twint') return exactOrSubdomain('twint.ch') && path.length > 1;
  if (method === 'kakao') {
    return path.length > 1 && ['kakao.com', 'kakaopay.com', 'nicepay.co.kr', 'nicepay.com'].some(exactOrSubdomain);
  }
  if (method === 'ideal') {
    return path.length > 1 && (exactOrSubdomain('ideal.nl') || host === 'pay.bunq.com');
  }
  if (method === 'blik') return host === 'payments.stripe.com' && path.includes('blik');
  return false;
}
