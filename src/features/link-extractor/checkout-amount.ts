import type { CheckoutAmountEvidence } from './types';

type AmountSource = CheckoutAmountEvidence['source'];

const WRAPPER_KEYS = [
  'checkout_session', 'checkoutSession', 'session', 'checkout', 'data', 'result', 'payload', 'response',
  'checkout_state', 'checkoutState', 'checkout_snapshot', 'checkoutSnapshot',
] as const;

const AMOUNT_PATHS = [
  ['checkout_amount_minor'], ['total_summary', 'due'], ['totalSummary', 'due'], ['invoice', 'amount_due'],
  ['invoice', 'amountDue'], ['amount_due'], ['amountDue'], ['amount_total'], ['amountTotal'], ['total', 'total'],
  ['total', 'due'], ['total', 'taxInclusive'], ['total', 'taxInclusiveAmount'],
] as const;

const RECURRING_AMOUNT_PATHS = [
  ['recurring_amount_minor'], ['recurringAmountMinor'], ['recurring', 'amount_due'],
  ['recurring', 'amountDue'], ['subscription', 'recurring_amount'], ['subscription', 'recurringAmount'],
  ['renewal', 'amount_due'], ['renewal', 'amountDue'], ['future_invoice', 'amount_due'],
] as const;

export interface StructuredCheckoutAmount {
  amountMinor: number | null;
  recurringAmountMinor: number | null;
  amountHint: string;
  currency: string;
  path: string;
  recurringPath: string;
  zeroLikely: boolean;
  promoLikely: boolean;
  trialLikely: boolean;
}

export function parseStructuredCheckoutAmount(value: unknown): StructuredCheckoutAmount {
  const found = findAmount(value, '', new Set<unknown>());
  const recurring = findKnownAmount(value, RECURRING_AMOUNT_PATHS, '', new Set<unknown>());
  const currency = findCurrency(value, new Set<unknown>());
  const rawText = safeJsonText(value).toLowerCase();
  const amountMinor = found?.amount ?? null;
  return {
    amountMinor,
    recurringAmountMinor: recurring?.amount ?? null,
    amountHint: amountMinor === null ? '' : String(amountMinor),
    currency,
    path: found?.path || '',
    recurringPath: recurring?.path || '',
    zeroLikely: amountMinor === 0,
    trialLikely: /free_trial|trial_period|trialing|(?:plus|team)-1-month-free|1-month-free|days? free|试用|首月免费/i.test(rawText),
    promoLikely: /promo_campaign|promo|campaign|coupon|discount|introductory|percent_off|amount_off|1-month-free/i.test(rawText),
  };
}

function findKnownAmount(
  value: unknown,
  paths: readonly (readonly string[])[],
  prefix: string,
  visited: Set<unknown>,
): { amount: number; path: string } | null {
  if (!isRecord(value) || visited.has(value)) return null;
  visited.add(value);
  for (const path of paths) {
    const amount = moneyMinorUnits(nestedValue(value, path));
    if (amount !== null) return { amount, path: [prefix, ...path].filter(Boolean).join('.') };
  }
  for (const key of WRAPPER_KEYS) {
    const found = findKnownAmount(value[key], paths, [prefix, key].filter(Boolean).join('.'), visited);
    if (found) return found;
  }
  return null;
}

export function checkoutAmountEvidence(value: unknown, source: AmountSource): CheckoutAmountEvidence {
  const parsed = parseStructuredCheckoutAmount(value);
  return {
    amountMinor: parsed.amountMinor,
    amountHint: parsed.amountHint,
    currency: parsed.currency,
    source: parsed.amountMinor === null ? 'unknown' : source,
    path: parsed.path,
    verification: parsed.amountMinor === null ? 'pending' : parsed.amountMinor === 0 ? 'verified-zero' : 'verified-nonzero',
  };
}

export function payloadHasInvalidPromotion(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(payloadHasInvalidPromotion);
  if (isRecord(value)) return Object.entries(value).some(([key, item]) => {
    if (/^(code|type|reason|detail|message|error)$/i.test(key) && normalizedInvalidPromotion(item)) return true;
    return payloadHasInvalidPromotion(item);
  });
  return normalizedInvalidPromotion(value);
}

export function decodeReactRouterPayload(payload: unknown): unknown {
  if (!Array.isArray(payload)) return null;
  const resolved = new Map<number, unknown>();
  const resolving = new Set<number>();
  const resolve = (reference: unknown): unknown => {
    if (typeof reference !== 'number' || !Number.isInteger(reference)) return reference;
    if (reference < 0 || reference >= payload.length) return null;
    if (resolved.has(reference)) return resolved.get(reference);
    if (resolving.has(reference)) return null;
    resolving.add(reference);
    const value = payload[reference];
    if (Array.isArray(value)) {
      const output: unknown[] = [];
      resolved.set(reference, output);
      output.push(...value.map(resolve));
      resolving.delete(reference);
      return output;
    }
    if (isRecord(value)) {
      const output: Record<string, unknown> = {};
      resolved.set(reference, output);
      for (const [encodedKey, encodedValue] of Object.entries(value)) {
        const key = /^_(\d+)$/.exec(encodedKey);
        if (!key) {
          output[encodedKey] = resolve(encodedValue);
          continue;
        }
        const decodedKey = resolve(Number(key[1]));
        if (decodedKey !== null && decodedKey !== undefined) output[String(decodedKey)] = resolve(encodedValue);
      }
      resolving.delete(reference);
      return output;
    }
    resolved.set(reference, value);
    resolving.delete(reference);
    return value;
  };
  return resolve(0);
}

export function checkoutStateFromHtml(html: string): Record<string, unknown> {
  const chunks: string[] = [];
  const enqueuePattern = /window\.__reactRouterContext\.streamController\.enqueue\(("(?:\\.|[^"\\])*")\)/gs;
  for (const match of String(html || '').matchAll(enqueuePattern)) {
    const chunk = parseJsonString(match[1]);
    if (chunk === null) continue;
    chunks.push(chunk);
    const state = stateFromSerialized(chunk);
    if (state) return state;
  }
  if (chunks.length > 1) {
    const state = stateFromSerialized(chunks.join(''));
    if (state) return state;
  }
  const jsonScriptPattern = /<script\b[^>]*\btype=(['"])application\/json\1[^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of String(html || '').matchAll(jsonScriptPattern)) {
    const state = stateFromSerialized(decodeHtmlEntities(match[2]).trim());
    if (state) return state;
  }
  return {};
}

function stateFromSerialized(serialized: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(serialized) as unknown;
    return findCheckoutState(Array.isArray(parsed) ? decodeReactRouterPayload(parsed) : parsed);
  } catch {
    return null;
  }
}

function findCheckoutState(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const state = findCheckoutState(item);
      if (state) return state;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const key of ['checkout_state', 'checkoutState']) {
    if (isRecord(value[key])) return value[key] as Record<string, unknown>;
  }
  for (const item of Object.values(value)) {
    const state = findCheckoutState(item);
    if (state) return state;
  }
  const amount = parseStructuredCheckoutAmount(value);
  if (amount.amountMinor !== null && ['total', 'total_summary', 'totalSummary', 'lineItems', 'line_items'].some((key) => key in value)) {
    return value;
  }
  return null;
}

function findAmount(value: unknown, prefix: string, visited: Set<unknown>): { amount: number; path: string } | null {
  if (!isRecord(value) || visited.has(value)) return null;
  visited.add(value);
  for (const path of AMOUNT_PATHS) {
    const amount = moneyMinorUnits(nestedValue(value, path));
    if (amount !== null) return { amount, path: [prefix, ...path].filter(Boolean).join('.') };
  }
  const lineItems = Array.isArray(value.lineItems) ? value.lineItems : Array.isArray(value.line_items) ? value.line_items : [];
  let lineTotal = 0;
  let lineFound = false;
  for (const item of lineItems) {
    if (!isRecord(item)) continue;
    for (const key of ['total', 'subtotal', 'unitAmount', 'unit_amount']) {
      const amount = moneyMinorUnits(item[key]);
      if (amount !== null) {
        lineTotal += amount;
        lineFound = true;
        break;
      }
    }
  }
  if (lineFound) return { amount: lineTotal, path: `${prefix ? `${prefix}.` : ''}lineItems.sum` };
  for (const key of WRAPPER_KEYS) {
    const found = findAmount(value[key], [prefix, key].filter(Boolean).join('.'), visited);
    if (found) return found;
  }
  return null;
}

function findCurrency(value: unknown, visited: Set<unknown>): string {
  if (!isRecord(value) || visited.has(value)) return '';
  visited.add(value);
  for (const key of ['currency', 'currency_code', 'currencyCode']) {
    const currency = typeof value[key] === 'string' ? value[key].trim().toUpperCase() : '';
    if (/^[A-Z]{3}$/.test(currency)) return currency;
  }
  for (const key of [...WRAPPER_KEYS, 'total', 'total_summary', 'totalSummary']) {
    const found = findCurrency(value[key], visited);
    if (found) return found;
  }
  return '';
}

function moneyMinorUnits(value: unknown): number | null {
  if (typeof value === 'boolean') return null;
  if (isRecord(value)) {
    for (const key of ['minorUnitsAmount', 'minor_units_amount', 'amount']) {
      if (value[key] !== undefined && value[key] !== null) return moneyMinorUnits(value[key]);
    }
  }
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function nestedValue(value: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function normalizedInvalidPromotion(value: unknown): boolean {
  return typeof value === 'string' && /(?:^|[^a-z])invalid[_ -]?promotion(?:$|[^a-z])/i.test(value.trim());
}

function parseJsonString(value: string): string | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function safeJsonText(value: unknown): string {
  try { return JSON.stringify(value || {}); } catch { return ''; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
