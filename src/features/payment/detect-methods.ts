import type { PaymentMethodId } from './types';

const STRIPE_VERSION =
  '2025-03-31.basil; checkout_server_update_beta=v1; checkout_manual_approval_preview=v1';

export const IGNORED_PAYMENT_METHOD_TYPES = new Set(['card', 'link']);

export interface DetectPaymentMethodsInput {
  checkoutSessionId: string;
  stripePk: string;
  /** Optional raw checkout/init payload to scan first. */
  raw?: unknown;
  requireZero?: boolean;
}

export interface DetectPaymentMethodsResult {
  ok: boolean;
  message: string;
  amountHint: string;
  zeroLikely: boolean;
  methods: string[];
  interestingMethods: PaymentMethodId[];
  raw?: unknown;
  source: 'stripe_init' | 'raw_payload' | 'none';
}

function formEncode(data: Record<string, string>): string {
  return Object.entries(data)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

function firstValueByKey(payload: unknown, key: string, depth = 0): unknown {
  if (payload == null || depth > 10) return undefined;
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = firstValueByKey(item, key, depth + 1);
      if (found !== undefined && found !== null && found !== '' && !(Array.isArray(found) && !found.length)) {
        return found;
      }
    }
    return undefined;
  }
  if (typeof payload === 'object') {
    const rec = payload as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(rec, key)) {
      return rec[key];
    }
    for (const value of Object.values(rec)) {
      const found = firstValueByKey(value, key, depth + 1);
      if (found !== undefined && found !== null && found !== '' && !(Array.isArray(found) && !found.length)) {
        return found;
      }
    }
  }
  return undefined;
}

function amountFromPayload(payload: unknown): { amountHint: string; zeroLikely: boolean } {
  const due = firstValueByKey(payload, 'due');
  const amountDue = firstValueByKey(payload, 'amount_due');
  const amountTotal = firstValueByKey(payload, 'amount_total');
  const unit = firstValueByKey(payload, 'unit_amount');
  const candidates = [due, amountDue, amountTotal, unit]
    .map((item) => (item == null ? '' : String(item)))
    .filter(Boolean);
  const amountHint = candidates[0] || '';
  const num = Number(amountHint);
  const zeroLikely = amountHint !== '' && Number.isFinite(num) && num === 0;
  return { amountHint, zeroLikely };
}

function normalizeMethods(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const method = String(item || '').trim().toLowerCase();
    if (!method) continue;
    if (!out.includes(method)) out.push(method);
  }
  return out;
}

function toInteresting(methods: string[]): PaymentMethodId[] {
  const map: Record<string, PaymentMethodId> = {
    ideal: 'ideal',
    upi: 'upi',
    pix: 'pix',
    blik: 'blik',
    twint: 'twint',
    kakao_pay: 'kakao',
    kakaopay: 'kakao',
    paypal: 'paypal',
    momo: 'momo',
    gopay: 'gopay',
  };
  const out: PaymentMethodId[] = [];
  for (const method of methods) {
    if (IGNORED_PAYMENT_METHOD_TYPES.has(method)) continue;
    const mapped = map[method];
    if (mapped && !out.includes(mapped)) out.push(mapped);
    // keep unknown local methods as-is only if matches known ids
  }
  return out;
}

export function extractPaymentMethodTypesFromPayload(raw: unknown): DetectPaymentMethodsResult {
  const methods = normalizeMethods(firstValueByKey(raw, 'payment_method_types'));
  const amount = amountFromPayload(raw);
  if (!methods.length) {
    return {
      ok: false,
      message: 'payload 中无 payment_method_types',
      amountHint: amount.amountHint,
      zeroLikely: amount.zeroLikely,
      methods: [],
      interestingMethods: [],
      raw,
      source: 'none',
    };
  }
  const filtered = methods.filter((item) => !IGNORED_PAYMENT_METHOD_TYPES.has(item));
  return {
    ok: true,
    message: `检测到 ${filtered.length} 种方式：${filtered.join(',') || '(仅 card/paypal/link)'}`,
    amountHint: amount.amountHint,
    zeroLikely: amount.zeroLikely,
    methods: filtered,
    interestingMethods: toInteresting(methods),
    raw,
    source: 'raw_payload',
  };
}

export async function detectPaymentMethodsViaStripeInit(
  input: DetectPaymentMethodsInput,
): Promise<DetectPaymentMethodsResult> {
  const cs = String(input.checkoutSessionId || '').trim();
  const pk = String(input.stripePk || '').trim();
  if (!cs.startsWith('cs_')) {
    return {
      ok: false,
      message: '缺少有效 checkoutSessionId',
      amountHint: '',
      zeroLikely: false,
      methods: [],
      interestingMethods: [],
      source: 'none',
    };
  }

  // Prefer already-present payload.
  if (input.raw) {
    const fromRaw = extractPaymentMethodTypesFromPayload(input.raw);
    if (fromRaw.ok) {
      if (input.requireZero && !fromRaw.zeroLikely && fromRaw.amountHint && Number(fromRaw.amountHint) !== 0) {
        return {
          ...fromRaw,
          ok: false,
          message: `requireZero：amount=${fromRaw.amountHint}，跳过方式探测`,
        };
      }
      return fromRaw;
    }
  }

  if (!pk) {
    return {
      ok: false,
      message: '未配置 stripePublishableKey，无法 Stripe init 探测',
      amountHint: '',
      zeroLikely: false,
      methods: [],
      interestingMethods: [],
      source: 'none',
    };
  }

  const stripeJsId = `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
  const body = formEncode({
    browser_locale: 'en-US',
    browser_timezone: 'UTC',
    'elements_session_client[client_betas][0]': 'custom_checkout_server_updates_1',
    'elements_session_client[client_betas][1]': 'custom_checkout_manual_approval_1',
    'elements_session_client[elements_init_source]': 'custom_checkout',
    'elements_session_client[referrer_host]': 'chatgpt.com',
    'elements_session_client[stripe_js_id]': stripeJsId,
    'elements_session_client[locale]': 'en',
    'elements_session_client[is_aggregation_expected]': 'false',
    'elements_options_client[saved_payment_method][enable_save]': 'never',
    'elements_options_client[saved_payment_method][enable_redisplay]': 'never',
    key: pk,
    _stripe_version: STRIPE_VERSION,
  });

  try {
    const resp = await fetch(`https://api.stripe.com/v1/payment_pages/${cs}/init`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      credentials: 'omit',
    });
    const text = await resp.text();
    let json: unknown = {};
    try { json = JSON.parse(text); } catch { json = { text }; }
    if (!resp.ok) {
      return {
        ok: false,
        message: `Stripe init HTTP ${resp.status}: ${text.slice(0, 160)}`,
        amountHint: '',
        zeroLikely: false,
        methods: [],
        interestingMethods: [],
        raw: json,
        source: 'stripe_init',
      };
    }
    const detected = extractPaymentMethodTypesFromPayload(json);
    if (input.requireZero && !detected.zeroLikely && detected.amountHint && Number(detected.amountHint) !== 0) {
      return {
        ...detected,
        ok: false,
        message: `requireZero：amount=${detected.amountHint}`,
        source: 'stripe_init',
      };
    }
    return {
      ...detected,
      ok: detected.methods.length > 0 || detected.ok,
      message: detected.ok ? `Stripe init · ${detected.message}` : detected.message,
      source: 'stripe_init',
      raw: json,
    };
  } catch (error) {
    return {
      ok: false,
      message: `Stripe init 异常：${String(error)}`,
      amountHint: '',
      zeroLikely: false,
      methods: [],
      interestingMethods: [],
      source: 'none',
    };
  }
}
