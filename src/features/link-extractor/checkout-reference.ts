export type CheckoutSessionKind = 'openai' | 'stripe';

export type CheckoutPageKind = 'checkout' | 'verify' | 'success';

export interface CheckoutReference {
  kind: CheckoutSessionKind;
  sessionId: string;
  processorEntity: string;
  canonicalUrl: string;
  page: CheckoutPageKind;
}

const SESSION_ID_PATTERN = /^(oaics_[A-Za-z0-9_-]+|cs_[A-Za-z0-9_-]+)$/;

export function parseCheckoutReference(input: string | URL): CheckoutReference | null {
  const url = toUrl(input);
  if (!url) return null;

  if (url.hostname === 'chatgpt.com' && normalizePath(url.pathname) === '/payments/success') {
    return {
      kind: 'openai',
      sessionId: '',
      processorEntity: '',
      canonicalUrl: canonicalize(url),
      page: 'success',
    };
  }

  if (url.hostname === 'chatgpt.com' && normalizePath(url.pathname) === '/checkout/verify') {
    const sessionId = firstSessionId(url.searchParams, [
      'stripe_session_id',
      'checkout_session_id',
      'session_id',
    ]);
    if (!sessionId) return null;
    return buildReference(url, sessionId, url.searchParams.get('processor_entity') || '', 'verify');
  }

  if (url.hostname === 'chatgpt.com') {
    const match = normalizePath(url.pathname).match(/^\/checkout\/([^/]+)\/(oaics_[A-Za-z0-9_-]+|cs_[A-Za-z0-9_-]+)$/);
    if (match) return buildReference(url, match[2], decodeURIComponent(match[1]), 'checkout');
  }

  if (url.hostname === 'pay.openai.com') {
    const match = normalizePath(url.pathname).match(/^\/c\/pay\/(oaics_[A-Za-z0-9_-]+|cs_[A-Za-z0-9_-]+)$/);
    if (match) return buildReference(url, match[1], url.searchParams.get('processor_entity') || '', 'checkout');
  }

  return null;
}

export function isCheckoutPageUrl(input: string | URL): boolean {
  return parseCheckoutReference(input)?.page === 'checkout';
}

export function isCheckoutVerifyUrl(input: string | URL): boolean {
  return parseCheckoutReference(input)?.page === 'verify';
}

export function isCheckoutSuccessUrl(input: string | URL): boolean {
  return parseCheckoutReference(input)?.page === 'success';
}

export function isLiveCheckoutPageUrl(input: string | URL): boolean {
  const reference = parseCheckoutReference(input);
  return reference?.page === 'checkout' && (
    reference.kind === 'openai' || /^cs_live_/.test(reference.sessionId)
  );
}

export function checkoutSessionId(input: string | URL): string {
  return parseCheckoutReference(input)?.sessionId || '';
}

function buildReference(
  url: URL,
  sessionId: string,
  processorEntity: string,
  page: CheckoutPageKind,
): CheckoutReference | null {
  if (!SESSION_ID_PATTERN.test(sessionId)) return null;
  return {
    kind: sessionId.startsWith('oaics_') ? 'openai' : 'stripe',
    sessionId,
    processorEntity,
    canonicalUrl: canonicalize(url),
    page,
  };
}

function firstSessionId(params: URLSearchParams, names: string[]): string {
  for (const name of names) {
    const value = String(params.get(name) || '').trim();
    if (SESSION_ID_PATTERN.test(value)) return value;
  }
  return '';
}

function canonicalize(url: URL): string {
  const canonical = new URL(url.href);
  canonical.hash = '';
  return canonical.href;
}

function normalizePath(pathname: string): string {
  const normalized = pathname.replace(/\/+$/, '');
  return normalized || '/';
}

function toUrl(input: string | URL): URL | null {
  if (input instanceof URL) return input;
  try {
    return new URL(input);
  } catch {
    return null;
  }
}
