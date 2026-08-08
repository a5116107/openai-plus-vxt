import { getPaymentMethodProfile, matchMethodByUrl, preferredMethodsFromChannels, PAYMENT_METHOD_IDS } from './methods';
import type {
  PaymentExtractOptions,
  PaymentFinalUrlMatch,
  PaymentFinalUrlResult,
  PaymentMethodId,
} from './types';
import { tryStripeConfirmForMethod } from './stripe-confirm';

const URL_RE = /https?:\/\/[^\s"'<>\\]+/gi;

export function extractUrlsFromText(text: string): string[] {
  const raw = String(text || '');
  const found = raw.match(URL_RE) || [];
  return [...new Set(found.map((item) => item.replace(/[),.;\]]+$/g, '')))];
}

function collectFromUnknown(value: unknown, acc: string[] = [], depth = 0): string[] {
  if (depth > 8 || value == null) return acc;
  if (typeof value === 'string') {
    for (const url of extractUrlsFromText(value)) acc.push(url);
    return acc;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectFromUnknown(item, acc, depth + 1);
    return acc;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    // next_action shortcuts
    const nextAction = record.next_action;
    if (nextAction && typeof nextAction === 'object') {
      const na = nextAction as Record<string, unknown>;
      const redirect = na.redirect_to_url;
      if (redirect && typeof redirect === 'object') {
        const url = String((redirect as Record<string, unknown>).url || '').trim();
        if (url) acc.push(url);
      }
      for (const key of ['hosted_instructions_url', 'url', 'redirect_url', 'redirect_to_url', 'hosted_url']) {
        const v = na[key];
        if (typeof v === 'string' && /^https?:/i.test(v)) acc.push(v);
      }
    }
    for (const key of Object.keys(record)) {
      collectFromUnknown(record[key], acc, depth + 1);
    }
  }
  return acc;
}

function scoreMatch(method: PaymentMethodId | 'unknown', preferred: PaymentMethodId[]): number {
  if (method === 'unknown') return 0;
  const idx = preferred.indexOf(method);
  if (idx >= 0) return 100 - idx;
  return 10;
}

export function extractPaymentFinalUrls(options: PaymentExtractOptions): PaymentFinalUrlResult {
  const preferred = options.preferredMethods?.length
    ? options.preferredMethods
    : preferredMethodsFromChannels(PAYMENT_METHOD_IDS);
  const urls = new Set<string>();
  for (const url of options.existingUrls || []) {
    if (url) urls.add(String(url));
  }
  for (const url of extractUrlsFromText(options.pageText || '')) urls.add(url);
  for (const url of collectFromUnknown(options.raw)) urls.add(url);

  const matches: PaymentFinalUrlMatch[] = [];
  for (const url of urls) {
    const method = matchMethodByUrl(url);
    // Keep only payment-like or preferred hosted
    const isInteresting = method !== 'unknown';
    if (!isInteresting) continue;

    let confidence: PaymentFinalUrlMatch['confidence'] = 'low';
    let source: PaymentFinalUrlMatch['source'] = 'pattern';
    if (method !== 'hosted') {
      confidence = 'high';
      source = options.pageText ? 'sniff' : 'pattern';
    } else if (method === 'hosted') {
      confidence = 'medium';
      source = 'pattern';
    }
    // next_action urls already collected; mark high if looks method-specific
    matches.push({
      method,
      url,
      source,
      confidence,
    });
  }

  matches.sort((a, b) => {
    const sa = scoreMatch(a.method, preferred) + (a.confidence === 'high' ? 20 : a.confidence === 'medium' ? 10 : 0);
    const sb = scoreMatch(b.method, preferred) + (b.confidence === 'high' ? 20 : b.confidence === 'medium' ? 10 : 0);
    return sb - sa;
  });

  const best = matches[0];
  return {
    ok: Boolean(best),
    message: best
      ? `提取到 ${matches.length} 条候选 · best=${best.method} · ${best.url.slice(0, 120)}`
      : '未提取到支付终链',
    matches: matches.slice(0, 20),
    best,
  };
}

export async function extractPaymentFinalUrlsWithOptionalConfirm(
  options: PaymentExtractOptions,
): Promise<PaymentFinalUrlResult> {
  const base = extractPaymentFinalUrls(options);
  if (!options.enableStripeConfirm || !options.stripePk || !options.checkoutSessionId) {
    return base;
  }

  const methods = (options.preferredMethods || []).filter((id) => id !== 'hosted' && id !== 'paypal');
  const tryOrder = methods.length ? methods : (['ideal', 'upi', 'pix'] as PaymentMethodId[]);
  for (const method of tryOrder) {
    const profile = getPaymentMethodProfile(method);
    if (!profile.stripeType) continue;
    const confirmed = await tryStripeConfirmForMethod({
      stripePk: options.stripePk,
      checkoutSessionId: options.checkoutSessionId,
      method,
      billingCountry: options.billingCountry || profile.providerCountry,
      idealBank: options.idealBank || profile.stripeExtras?.['ideal[bank]'] || 'n26',
    });
    if (confirmed.ok && confirmed.redirectUrl) {
      const match: PaymentFinalUrlMatch = {
        method,
        url: confirmed.redirectUrl,
        source: 'stripe_confirm',
        confidence: 'high',
      };
      return {
        ok: true,
        message: `Stripe confirm 成功 · ${method} · ${confirmed.message}`,
        matches: [match, ...base.matches].slice(0, 20),
        best: match,
      };
    }
  }
  return {
    ...base,
    message: base.ok
      ? `${base.message} · Stripe confirm 未命中`
      : `未提取到支付终链 · Stripe confirm 未命中`,
  };
}
