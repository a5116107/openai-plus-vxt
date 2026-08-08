import type { SavedPaymentCapability, SavedPaymentMethodKind } from './types';

const CAPABILITIES: Record<SavedPaymentMethodKind, SavedPaymentCapability> = {
  card: capability('card', ['setup'], ['inline-elements', 'hosted-checkout', 'saved-method-picker'], 'reusable', 'supported',
    ['SetupIntent succeeded', 'PaymentMethod is attached to the expected Customer', 'server list confirms reusable/default state'],
    'Primary implementation path: SetupIntent plus Card or Payment Element.'),
  paypal: capability('paypal', ['setup', 'mandate'], ['inline-elements', 'native-redirect', 'saved-method-picker'], 'conditional', 'probe-required',
    ['merchant capability', 'country/currency support', 'mandate or reusable PaymentMethod returned by Stripe'],
    'Availability depends on merchant, region, currency, and mandate support.'),
  apple_pay: wallet('apple_pay'),
  google_pay: wallet('google_pay'),
  link: capability('link', ['setup', 'payment-checkout'], ['inline-elements', 'saved-method-picker'], 'wallet-managed', 'probe-required',
    ['Link authenticated state', 'Stripe Elements exposes Link', 'merchant-side list is not presented as the Link vault'],
    'Stripe Link owns its vault; it is not the merchant saved-method list.'),
  bank_debit: capability('bank_debit', ['setup', 'mandate'], ['inline-elements', 'native-redirect', 'saved-method-picker'], 'conditional', 'probe-required',
    ['mandate accepted', 'reusable debit PaymentMethod returned', 'server attachment verified'],
    'Use a debit/mandate adapter with scheme-specific customer acceptance evidence.'),
  bank_redirect: capability('bank_redirect', ['payment-checkout', 'mandate'], ['native-redirect'], 'conditional', 'probe-required',
    ['redirect completed', 'downstream mandate or reusable debit instrument returned'],
    'The redirect method itself is not automatically reusable.'),
  upi: conditionalRedirect('upi', 'Only mandate/autopay evidence may upgrade UPI to reusable.'),
  pix: oneTime('pix'),
  blik: oneTime('blik'),
  twint: oneTime('twint'),
  momo: oneTime('momo'),
  gopay: oneTime('gopay'),
  kakao_pay: oneTime('kakao_pay'),
};

export function listSavedPaymentCapabilities(): SavedPaymentCapability[] {
  return Object.values(CAPABILITIES).map(cloneCapability);
}

export function getSavedPaymentCapability(method: SavedPaymentMethodKind): SavedPaymentCapability {
  return cloneCapability(CAPABILITIES[method]);
}

export function supportsSavedPaymentPath(
  method: SavedPaymentMethodKind,
  intent: SavedPaymentCapability['intentKinds'][number],
  channel: SavedPaymentCapability['channels'][number],
): boolean {
  const item = CAPABILITIES[method];
  return item.status !== 'unsupported' && item.intentKinds.includes(intent) && item.channels.includes(channel);
}

function wallet(method: 'apple_pay' | 'google_pay'): SavedPaymentCapability {
  return capability(method, ['payment-checkout'], ['inline-elements'], 'wallet-managed', 'probe-required',
    ['wallet availability', 'domain/origin verification', 'tokenized card result'],
    'Wallet interaction normally yields a card token; the wallet does not become a generic merchant-owned credential.');
}

function conditionalRedirect(method: 'upi', note: string): SavedPaymentCapability {
  return capability(method, ['payment-checkout', 'mandate'], ['native-redirect'], 'conditional', 'probe-required',
    ['provider exposes mandate/autopay', 'mandate completion', 'reusable server-side object'], note);
}

function oneTime(method: 'pix' | 'blik' | 'twint' | 'momo' | 'gopay' | 'kakao_pay'): SavedPaymentCapability {
  return capability(method, ['payment-checkout'], ['native-redirect'], 'one-time-only', 'unsupported',
    ['runtime evidence proving a reusable provider object'],
    'Default classification is one-time-only; runtime evidence is required before promotion.');
}

function capability(
  method: SavedPaymentMethodKind,
  intentKinds: SavedPaymentCapability['intentKinds'],
  channels: SavedPaymentCapability['channels'],
  reusePolicy: SavedPaymentCapability['reusePolicy'],
  status: SavedPaymentCapability['status'],
  evidenceRequired: string[],
  note: string,
): SavedPaymentCapability {
  return { method, intentKinds, channels, reusePolicy, status, evidenceRequired, note };
}

function cloneCapability(value: SavedPaymentCapability): SavedPaymentCapability {
  return {
    ...value,
    intentKinds: [...value.intentKinds],
    channels: [...value.channels],
    evidenceRequired: [...value.evidenceRequired],
  };
}
