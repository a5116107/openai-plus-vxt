import type { CheckoutIdentitySnapshot } from '../link-extractor/types';

export type HostedResolutionStatus =
  | 'not_required'
  | 'identity_required'
  | 'identity_mismatch'
  | 'resolved_hosted'
  | 'checkout_loaded'
  | 'failed';

export interface HostedPageEvidence {
  finalUrl?: string;
  pageText?: string;
  pageHtml?: string;
  resourceUrls?: string[];
}

export interface HostedResolutionArtifacts {
  status: HostedResolutionStatus;
  message: string;
  finalUrl: string;
  hostedUrl: string;
  checkoutSessionId: string;
  checkoutSessionType: 'oaics' | 'stripe' | 'unknown';
  stripePublishableKey: string;
  methods: string[];
  stripeResourceCount: number;
  authRequired: boolean;
}

const METHOD_PATTERNS: Array<[string, RegExp]> = [
  ['paypal', /\bpaypal\b/i],
  ['momo', /\bmomo\b|vi\s*momo/i],
  ['kakao', /kakao\s*pay|kakaopay|\uCE74\uCE74\uC624\uD398\uC774/i],
  ['upi', /\bupi\b|unified payments interface/i],
  ['ideal', /\bideal\b/i],
  ['pix', /\bpix\b/i],
  ['blik', /\bblik\b/i],
  ['twint', /\btwint\b/i],
  ['gopay', /\bgopay\b|\bgo pay\b/i],
];

export function isIdentitySnapshotReady(snapshot: CheckoutIdentitySnapshot | undefined): boolean {
  return Boolean(snapshot?.cookies?.some((cookie) => {
    const domain = String(cookie.domain || '').toLowerCase();
    return cookie.name && cookie.value && (domain.endsWith('chatgpt.com') || domain.endsWith('openai.com'));
  }));
}

export function isOaicsCheckoutUrl(value: string | undefined): boolean {
  return /https:\/\/(?:www\.)?chatgpt\.com\/checkout\/[^/?#]+\/oaics_[a-z0-9_\-]+/i.test(String(value || ''));
}

export function sessionEmailsMatch(expected: string | undefined, actual: string | undefined): boolean {
  const left = String(expected || '').trim().toLowerCase();
  const right = String(actual || '').trim().toLowerCase();
  return Boolean(left && right && left === right);
}

export function resolveHostedArtifacts(evidence: HostedPageEvidence): HostedResolutionArtifacts {
  const finalUrl = normalizeUrl(String(evidence.finalUrl || ''));
  const pageText = String(evidence.pageText || '').slice(0, 50_000);
  const pageHtml = decodeEscaped(String(evidence.pageHtml || '')).slice(0, 250_000);
  const resourceUrls = (evidence.resourceUrls || []).map((item) => normalizeUrl(item)).filter(Boolean);
  const haystack = [finalUrl, pageHtml, ...resourceUrls].join('\n');
  const authRequired = /chatgpt\.com\/auth\/(?:login|signin)|auth\.openai\.com\//i.test(finalUrl);
  const hostedUrl = uniqueUrls(haystack).find(isHostedCheckoutUrl) || '';
  const checkoutSessionId = firstMatch(haystack, /\bcs_(?:live|test)_[a-zA-Z0-9_\-]+/);
  const oaicsSessionId = firstMatch(haystack, /\boaics_[a-zA-Z0-9_\-]+/);
  const stripePublishableKey = firstMatch(haystack, /\bpk_(?:live|test)_[a-zA-Z0-9_\-]+/);
  const methods = METHOD_PATTERNS.filter(([, pattern]) => pattern.test(pageText)).map(([method]) => method);
  const stripeResourceCount = resourceUrls.filter((url) => /stripe\.com|stripe\.network/i.test(url)).length;

  if (authRequired) {
    return build('identity_required', '短链跳转到登录页，需要对应账号 Cookie/Session', 'unknown');
  }
  if (hostedUrl) {
    return build('resolved_hosted', '已从 Checkout 页面解析 Hosted 长链', checkoutSessionId ? 'stripe' : oaicsSessionId ? 'oaics' : 'unknown');
  }
  if (checkoutSessionId || stripePublishableKey || stripeResourceCount > 0 || isOaicsCheckoutUrl(finalUrl)) {
    return build('checkout_loaded', 'Checkout 页面已加载，但尚未暴露可保存的 Hosted URL', checkoutSessionId ? 'stripe' : oaicsSessionId ? 'oaics' : 'unknown');
  }
  return build('failed', '页面未产生 Hosted URL、Stripe 会话或 Stripe 资源', oaicsSessionId ? 'oaics' : 'unknown');

  function build(
    status: HostedResolutionStatus,
    message: string,
    checkoutSessionType: HostedResolutionArtifacts['checkoutSessionType'],
  ): HostedResolutionArtifacts {
    return {
      status,
      message,
      finalUrl,
      hostedUrl,
      checkoutSessionId: checkoutSessionId || oaicsSessionId,
      checkoutSessionType,
      stripePublishableKey,
      methods,
      stripeResourceCount,
      authRequired,
    };
  }
}

export function identityResolution(
  status: Extract<HostedResolutionStatus, 'identity_required' | 'identity_mismatch'>,
  message: string,
  shortUrl = '',
): HostedResolutionArtifacts {
  return {
    status,
    message,
    finalUrl: shortUrl,
    hostedUrl: '',
    checkoutSessionId: firstMatch(shortUrl, /\boaics_[a-zA-Z0-9_\-]+/),
    checkoutSessionType: isOaicsCheckoutUrl(shortUrl) ? 'oaics' : 'unknown',
    stripePublishableKey: '',
    methods: [],
    stripeResourceCount: 0,
    authRequired: status === 'identity_required',
  };
}

function isHostedCheckoutUrl(value: string): boolean {
  return /^https:\/\/(?:checkout\.stripe\.com|pay\.openai\.com)\/c\/pay\//i.test(value);
}

function uniqueUrls(value: string): string[] {
  const matches = decodeEscaped(value).match(/https?:\/\/[^\s"'<>\\]+/gi) || [];
  return [...new Set(matches.map((item) => normalizeUrl(item)).filter(Boolean))];
}

function normalizeUrl(value: string): string {
  return decodeEscaped(String(value || ''))
    .replace(/&amp;/gi, '&')
    .replace(/[),.;]+$/, '')
    .trim();
}

function decodeEscaped(value: string): string {
  return String(value || '').replace(/\\u0026/gi, '&').replace(/\\\//g, '/');
}

function firstMatch(value: string, pattern: RegExp): string {
  return pattern.exec(String(value || ''))?.[0] || '';
}
