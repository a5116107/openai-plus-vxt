import { getPaymentMethodProfile, isAllowedFinalPaymentUrl } from './methods';
import type { StripeConfirmInput, StripeConfirmResult } from './types';

const STRIPE_VERSION =
  '2025-03-31.basil; checkout_server_update_beta=v1; checkout_manual_approval_preview=v1';

function randomId(): string {
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
}

function billingDefaults(country: string): { name: string; line1: string; city: string; postal: string; state: string } {
  const cc = country.toUpperCase();
  if (cc === 'NL') return { name: 'Daan de Vries', line1: 'Damrak 1', city: 'Amsterdam', postal: '1012 LG', state: '' };
  if (cc === 'IN') return { name: 'Rahul Sharma', line1: 'MG Road 1', city: 'Bengaluru', postal: '560001', state: 'KA' };
  if (cc === 'BR') return { name: 'Lucas Silva', line1: 'Avenida Paulista 1000', city: 'Sao Paulo', postal: '01310-100', state: 'SP' };
  if (cc === 'PL') return { name: 'Jan Kowalski', line1: 'Marszalkowska 1', city: 'Warszawa', postal: '00-001', state: '' };
  if (cc === 'CH') return { name: 'Luca Meier', line1: 'Bahnhofstrasse 1', city: 'Zurich', postal: '8001', state: '' };
  if (cc === 'KR') return { name: 'Kim Minjun', line1: 'Teheran-ro 1', city: 'Seoul', postal: '06164', state: '' };
  return { name: 'Checkout User', line1: '1 Main St', city: 'City', postal: '10000', state: '' };
}

function formEncode(data: Record<string, string>): string {
  return Object.entries(data)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

function extractRedirect(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const walk = (value: unknown, depth = 0): string => {
    if (depth > 8 || value == null) return '';
    if (typeof value === 'string') {
      if (/^https?:\/\//i.test(value) && !/stripe\.com\/(?:js|v3|m\.)/i.test(value)) {
        return value;
      }
      return '';
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = walk(item, depth + 1);
        if (found) return found;
      }
      return '';
    }
    if (typeof value === 'object') {
      const rec = value as Record<string, unknown>;
      const nextAction = rec.next_action;
      if (nextAction && typeof nextAction === 'object') {
        const na = nextAction as Record<string, unknown>;
        const r = na.redirect_to_url;
        if (r && typeof r === 'object') {
          const url = String((r as Record<string, unknown>).url || '');
          if (url) return url;
        }
        for (const key of ['hosted_instructions_url', 'url', 'redirect_url', 'hosted_url']) {
          const v = na[key];
          if (typeof v === 'string' && /^https?:/i.test(v)) return v;
        }
      }
      for (const key of Object.keys(rec)) {
        const found = walk(rec[key], depth + 1);
        if (found) return found;
      }
    }
    return '';
  };
  return walk(payload);
}

export async function tryStripeConfirmForMethod(input: StripeConfirmInput): Promise<StripeConfirmResult> {
  const pk = String(input.stripePk || '').trim();
  const cs = String(input.checkoutSessionId || '').trim();
  if (!pk || !cs) {
    return { ok: false, message: '缺少 stripePk 或 checkoutSessionId' };
  }
  if (!cs.startsWith('cs_')) {
    return { ok: false, message: `checkoutSessionId 非法: ${cs.slice(0, 24)}` };
  }

  const profile = getPaymentMethodProfile(input.method);
  const stripeType = profile.stripeType;
  if (!stripeType) {
    return { ok: false, message: `方法 ${input.method} 无 stripeType` };
  }

  const billing = billingDefaults(input.billingCountry || profile.providerCountry);
  const name = input.billingName || billing.name;
  const email = input.billingEmail || 'redacted@example.invalid';
  const browserId = randomId();

  const pmBody: Record<string, string> = {
    type: stripeType,
    'billing_details[name]': name,
    'billing_details[email]': email,
    'billing_details[address][line1]': billing.line1,
    'billing_details[address][city]': billing.city,
    'billing_details[address][postal_code]': billing.postal,
    'billing_details[address][country]': (input.billingCountry || profile.providerCountry).toUpperCase(),
    'client_attribution_metadata[checkout_session_id]': cs,
    key: pk,
  };
  if (billing.state) pmBody['billing_details[address][state]'] = billing.state;
  if (stripeType === 'ideal') {
    pmBody['ideal[bank]'] = input.idealBank || profile.stripeExtras?.['ideal[bank]'] || 'n26';
  }
  if (profile.stripeExtras) {
    for (const [k, v] of Object.entries(profile.stripeExtras)) {
      if (k !== 'ideal[bank]' || !pmBody['ideal[bank]']) pmBody[k] = v;
    }
  }

  let pmId = '';
  try {
    const pmResp = await fetch('https://api.stripe.com/v1/payment_methods', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formEncode(pmBody),
      credentials: 'omit',
    });
    const pmText = await pmResp.text();
    let pmJson: Record<string, unknown> = {};
    try { pmJson = JSON.parse(pmText); } catch { /* ignore */ }
    if (!pmResp.ok) {
      return { ok: false, message: `创建 PM 失败 HTTP ${pmResp.status}: ${pmText.slice(0, 180)}`, raw: pmJson };
    }
    pmId = String(pmJson.id || '');
    if (!pmId.startsWith('pm_')) {
      return { ok: false, message: `PM 响应无 id: ${pmText.slice(0, 180)}`, raw: pmJson };
    }
  } catch (error) {
    return { ok: false, message: `创建 PM 异常: ${String(error)}` };
  }

  const returnUrl = input.returnUrl
    || `https://chatgpt.com/checkout/verify?stripe_session_id=${encodeURIComponent(cs)}`;
  const confirmBody: Record<string, string> = {
    eid: 'NA',
    expected_amount: input.expectedAmount || '0',
    expected_payment_method_type: stripeType,
    payment_method: pmId,
    return_url: returnUrl,
    _stripe_version: STRIPE_VERSION,
    guid: browserId,
    muid: browserId,
    sid: randomId(),
    key: pk,
    'consent[terms_of_service]': 'accepted',
  };

  try {
    const url = `https://api.stripe.com/v1/payment_pages/${cs}/confirm`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formEncode(confirmBody),
      credentials: 'omit',
    });
    const text = await resp.text();
    let json: unknown = {};
    try { json = JSON.parse(text); } catch { json = { text }; }
    if (!resp.ok) {
      return {
        ok: false,
        message: `confirm 失败 HTTP ${resp.status}: ${text.slice(0, 180)}`,
        paymentMethodId: pmId,
        raw: json,
      };
    }
    const redirectUrl = extractRedirect(json);
    if (!redirectUrl || !isAllowedFinalPaymentUrl(input.method, redirectUrl)) {
      return {
        ok: false,
        message: 'confirm 成功但终链不在支付方式白名单',
        paymentMethodId: pmId,
        raw: json,
      };
    }
    return {
      ok: true,
      message: 'confirm 成功并提取终链',
      paymentMethodId: pmId,
      redirectUrl,
      raw: json,
    };
  } catch (error) {
    return { ok: false, message: `confirm 异常: ${String(error)}`, paymentMethodId: pmId };
  }
}
