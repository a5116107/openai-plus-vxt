import { getPaymentMethodAdapter } from './runner-adapters';
import type {
  PaymentApproveState,
  PaymentConfirmState,
  PaymentFinalState,
  PaymentMethodToken,
  PaymentPollState,
  PaymentQualificationSnapshot,
  PaymentRunnerContext,
  PaymentRunnerTransport,
  PaymentStepResult,
} from './runner-types';

const STRIPE_VERSION = '2025-03-31.basil; checkout_server_update_beta=v1; checkout_manual_approval_preview=v1';

export interface NativePaymentTransportOptions {
  fetchImpl?: typeof fetch;
  pollAttempts?: number;
  pollDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export function createNativePaymentTransport(options: NativePaymentTransportOptions = {}): PaymentRunnerTransport {
  const fetchImpl = options.fetchImpl || fetch;
  const sleep = options.sleep || ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollAttempts = Math.max(1, Math.min(12, options.pollAttempts || 6));
  const pollDelayMs = Math.max(0, options.pollDelayMs ?? 1200);

  const init = async (context: PaymentRunnerContext, checkpoint: string): Promise<PaymentStepResult<unknown>> => {
    const body = formEncode({
      browser_locale: 'en-US',
      browser_timezone: 'UTC',
      'elements_session_client[client_betas][0]': 'custom_checkout_server_updates_1',
      'elements_session_client[client_betas][1]': 'custom_checkout_manual_approval_1',
      'elements_session_client[elements_init_source]': 'custom_checkout',
      'elements_session_client[referrer_host]': 'chatgpt.com',
      'elements_session_client[stripe_js_id]': randomId(),
      'elements_session_client[locale]': 'en',
      'elements_session_client[is_aggregation_expected]': 'false',
      key: context.stripePublishableKey,
      _stripe_version: STRIPE_VERSION,
    });
    return requestJson(fetchImpl, `https://api.stripe.com/v1/payment_pages/${context.checkoutSessionId}/init`, {
      method: 'POST', headers: formHeaders(), body, credentials: 'omit',
    }, `STRIPE_INIT_${checkpoint.toUpperCase()}`);
  };

  return {
    screen: (context) => init(context, 'screen'),
    revalidate: (context, checkpoint) => init(context, checkpoint),

    async createPaymentMethod(context, snapshot) {
      if (!snapshot.gate.passed) return gateClosed<PaymentMethodToken>();
      const adapter = getPaymentMethodAdapter(context.method);
      if (!adapter.stripeType) return failure('METHOD_TYPE_MISSING', 'method-unavailable', false);
      const billing = billingProfile(context.billingCountry);
      const body: Record<string, string> = {
        type: adapter.stripeType,
        'billing_details[name]': billing.name,
        'billing_details[email]': context.billingEmail || 'redacted@example.invalid',
        'billing_details[address][line1]': billing.line1,
        'billing_details[address][city]': billing.city,
        'billing_details[address][postal_code]': billing.postal,
        'billing_details[address][country]': context.billingCountry.toUpperCase(),
        'client_attribution_metadata[checkout_session_id]': context.checkoutSessionId,
        key: context.stripePublishableKey,
      };
      if (billing.state) body['billing_details[address][state]'] = billing.state;
      if (context.method === 'ideal') body['ideal[bank]'] = 'n26';
      const response = await requestJson<Record<string, unknown>>(
        fetchImpl,
        'https://api.stripe.com/v1/payment_methods',
        { method: 'POST', headers: formHeaders(), body: formEncode(body), credentials: 'omit' },
        'CREATE_PM',
      );
      if (!response.ok) return withoutData<PaymentMethodToken>(response);
      const id = String(response.data?.id || '');
      return id.startsWith('pm_')
        ? { ok: true, data: { id, payload: response.data }, code: 'PM_CREATED', message: 'payment method created', sideEffect: 'confirmed' }
        : failure('PM_ID_MISSING', 'protocol', false);
    },

    async confirm(context, snapshot, paymentMethod) {
      if (!snapshot.gate.passed) return gateClosed<PaymentConfirmState>();
      const adapter = getPaymentMethodAdapter(context.method);
      const body = formEncode({
        eid: 'NA',
        expected_amount: '0',
        expected_payment_method_type: adapter.stripeType || context.method,
        payment_method: paymentMethod.id,
        return_url: context.returnUrl || `https://chatgpt.com/checkout/verify?stripe_session_id=${encodeURIComponent(context.checkoutSessionId)}`,
        _stripe_version: STRIPE_VERSION,
        guid: randomId(), muid: randomId(), sid: randomId(),
        key: context.stripePublishableKey,
        'consent[terms_of_service]': 'accepted',
      });
      const result = await requestJson<unknown>(
        fetchImpl,
        `https://api.stripe.com/v1/payment_pages/${context.checkoutSessionId}/confirm`,
        { method: 'POST', headers: formHeaders(), body, credentials: 'omit' },
        'CONFIRM',
        true,
      );
      if (!result.ok) return result as PaymentStepResult<PaymentConfirmState>;
      const failed = paymentFailure(result.data);
      if (failed) return { ...failure('CONFIRM_PROVIDER_DECLINED', 'provider-decline', false), data: { payload: result.data, requiresApproval: false }, sideEffect: 'confirmed' };
      const submission = findRecordByKey(result.data, 'submission_attempt');
      const redirectUrl = actionUrls(result.data)[0];
      return {
        ok: true,
        data: { payload: result.data, requiresApproval: submission?.state === 'requires_approval', redirectUrl },
        code: 'CONFIRM_ACCEPTED',
        message: submission?.state === 'requires_approval' ? 'confirm requires approval' : 'confirm accepted',
        sideEffect: 'confirmed',
      };
    },

    async approve(context, confirm) {
      const result = await requestJson<Record<string, unknown>>(
        fetchImpl,
        'https://chatgpt.com/backend-api/payments/checkout/approve',
        {
          method: 'POST',
          headers: {
            Accept: 'application/json', Authorization: `Bearer ${context.accessToken}`, 'Content-Type': 'application/json',
            'x-openai-target-path': '/backend-api/payments/checkout/approve',
            'x-openai-target-route': '/backend-api/payments/checkout/approve',
          },
          body: JSON.stringify({ checkout_session_id: context.checkoutSessionId, processor_entity: context.processorEntity }),
          credentials: 'omit',
        },
        'APPROVE',
        true,
      );
      if (!result.ok) return withoutData<PaymentApproveState>(result);
      const approved = result.data?.result === 'approved';
      return approved
        ? { ok: true, data: { payload: result.data, approved: true }, code: 'APPROVED', message: 'checkout approved', sideEffect: 'confirmed' }
        : { ...failure('APPROVE_RESULT_UNKNOWN', 'side-effect-unknown', false), data: { payload: result.data, approved: false }, sideEffect: 'unknown' };
    },

    async poll(context, confirm, approve) {
      let lastPayload: unknown = confirm.payload;
      for (let attempt = 1; attempt <= pollAttempts; attempt += 1) {
        if (attempt > 1 && pollDelayMs) await sleep(pollDelayMs);
        const params = new URLSearchParams({
          key: context.stripePublishableKey,
          _stripe_version: STRIPE_VERSION,
          'elements_session_client[client_betas][0]': 'custom_checkout_server_updates_1',
          'elements_session_client[client_betas][1]': 'custom_checkout_manual_approval_1',
        });
        const result = await requestJson<unknown>(
          fetchImpl,
          `https://api.stripe.com/v1/payment_pages/${context.checkoutSessionId}?${params}`,
          { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'omit' },
          'POLL',
        );
        if (!result.ok) {
          if (attempt === pollAttempts) return result as PaymentStepResult<PaymentPollState>;
          continue;
        }
        lastPayload = result.data;
        if (paymentFailure(lastPayload)) return failure('POLL_PROVIDER_DECLINED', 'provider-decline', false);
        const redirectUrl = actionUrls(lastPayload)[0] || confirm.redirectUrl;
        if (redirectUrl) {
          return { ok: true, data: { payload: lastPayload, redirectUrl }, code: 'POLL_REDIRECT_READY', message: 'redirect ready' };
        }
      }
      return {
        ok: false,
        data: { payload: lastPayload },
        code: 'POLL_TIMEOUT',
        message: approve?.approved ? 'approved checkout has no redirect yet' : 'checkout has no redirect yet',
        errorClass: 'side-effect-unknown',
        retryable: true,
        sideEffect: 'unknown',
      };
    },

    async finalize(context, poll) {
      const adapter = getPaymentMethodAdapter(context.method);
      const candidates = [poll.redirectUrl || '', ...actionUrls(poll.payload)].filter(Boolean);
      for (const candidate of candidates) {
        if (adapter.acceptsFinalUrl(candidate)) {
          return { ok: true, data: { url: candidate, payload: poll.payload }, code: 'FINAL_URL_VERIFIED', message: 'final URL verified' };
        }
        if (!adapter.acceptsIntermediateUrl(candidate)) continue;
        try {
          const response = await fetchImpl(candidate, { method: 'GET', redirect: 'follow', credentials: 'omit' });
          if (adapter.acceptsFinalUrl(response.url)) {
            return { ok: true, data: { url: response.url }, code: 'FINAL_REDIRECT_RESOLVED', message: 'intermediate redirect resolved' };
          }
          const text = await response.text();
          for (const url of text.match(/https:\/\/[^\s"'<>\\]+/g) || []) {
            if (adapter.acceptsFinalUrl(url)) {
              return { ok: true, data: { url }, code: 'FINAL_BODY_URL_RESOLVED', message: 'final URL resolved from redirect body' };
            }
          }
        } catch (error) {
          return { ok: false, code: 'FINAL_REDIRECT_NETWORK', message: String(error), errorClass: 'network', retryable: true };
        }
      }
      return failure('FINAL_URL_NOT_FOUND', 'invalid-final-url', false);
    },
  };
}

function formHeaders(): Record<string, string> {
  return { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' };
}

function formEncode(data: Record<string, string>): string {
  return new URLSearchParams(data).toString();
}

function randomId(): string {
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 12)}`;
}

function failure<T>(code: string, errorClass: NonNullable<PaymentStepResult<T>['errorClass']>, retryable: boolean): PaymentStepResult<T> {
  return { ok: false, code, message: code.toLowerCase(), errorClass, retryable, sideEffect: 'none' };
}

function gateClosed<T>(): PaymentStepResult<T> {
  return failure('STRICT_GATE_REQUIRED', 'qualification', false);
}

function withoutData<T>(result: PaymentStepResult<unknown>): PaymentStepResult<T> {
  const { data: _data, ...rest } = result;
  return rest;
}

async function requestJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  code: string,
  write = false,
): Promise<PaymentStepResult<T>> {
  try {
    const response = await fetchImpl(url, init);
    const text = await response.text();
    let data: unknown = {};
    try { data = JSON.parse(text); } catch { data = { text: text.slice(0, 500) }; }
    if (!response.ok) {
      const errorClass = response.status === 401 || response.status === 403
        ? 'credential'
        : response.status === 429
          ? 'rate-limit'
          : response.status >= 500
            ? 'network'
            : 'protocol';
      return {
        ok: false,
        data: data as T,
        code: `${code}_HTTP_${response.status}`,
        message: `${code} HTTP ${response.status}`,
        errorClass,
        retryable: response.status === 429 || response.status >= 500,
        sideEffect: write && response.status >= 500 ? 'unknown' : 'none',
      };
    }
    return { ok: true, data: data as T, code: `${code}_OK`, message: `${code} ok`, sideEffect: write ? 'confirmed' : 'none' };
  } catch (error) {
    return {
      ok: false,
      code: `${code}_NETWORK`,
      message: String(error),
      errorClass: write ? 'side-effect-unknown' : 'network',
      retryable: true,
      sideEffect: write ? 'unknown' : 'none',
    };
  }
}

function findRecordByKey(value: unknown, key: string, depth = 0): Record<string, unknown> | null {
  if (depth > 8 || value == null) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRecordByKey(item, key, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record[key] && typeof record[key] === 'object' && !Array.isArray(record[key])) return record[key] as Record<string, unknown>;
  for (const item of Object.values(record)) {
    const found = findRecordByKey(item, key, depth + 1);
    if (found) return found;
  }
  return null;
}

function paymentFailure(payload: unknown): boolean {
  const submission = findRecordByKey(payload, 'submission_attempt');
  if (submission?.state === 'failed') return true;
  const text = JSON.stringify(payload || {}).toLowerCase();
  return /setup_attempt_failed|generic_decline|last_payment_error|last_setup_error/.test(text);
}

function actionUrls(payload: unknown): string[] {
  const out = new Set<string>();
  const visit = (value: unknown, depth = 0, actionContext = false) => {
    if (depth > 9 || value == null) return;
    if (typeof value === 'string') {
      if (actionContext && /^https:\/\//i.test(value)) out.add(value);
      const ba = value.match(/https:\/\/[^\s"'<>]*paypal\.com\/agreements\/approve\?[^\s"'<>]+/i)?.[0];
      if (ba) out.add(ba);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1, actionContext));
      return;
    }
    if (typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const trusted = actionContext || ['next_action', 'redirect_to_url', 'hosted_instructions_url', 'redirect_url', 'hosted_url'].includes(key);
      visit(item, depth + 1, trusted);
    }
  };
  visit(payload);
  return [...out];
}

function billingProfile(country: string): { name: string; line1: string; city: string; postal: string; state: string } {
  const cc = country.toUpperCase();
  const profiles: Record<string, { name: string; line1: string; city: string; postal: string; state: string }> = {
    NL: { name: 'Daan de Vries', line1: 'Damrak 1', city: 'Amsterdam', postal: '1012 LG', state: '' },
    IN: { name: 'Rahul Sharma', line1: 'MG Road 1', city: 'Bengaluru', postal: '560001', state: 'KA' },
    BR: { name: 'Lucas Silva', line1: 'Avenida Paulista 1000', city: 'Sao Paulo', postal: '01310-100', state: 'SP' },
    PL: { name: 'Jan Kowalski', line1: 'Marszalkowska 1', city: 'Warszawa', postal: '00-001', state: '' },
    CH: { name: 'Luca Meier', line1: 'Bahnhofstrasse 1', city: 'Zurich', postal: '8001', state: '' },
    KR: { name: 'Kim Minjun', line1: 'Teheran-ro 1', city: 'Seoul', postal: '06164', state: '' },
    VN: { name: 'Nguyen Minh', line1: '1 Nguyen Hue', city: 'Ho Chi Minh City', postal: '700000', state: '' },
    ID: { name: 'Budi Santoso', line1: '1 Sudirman', city: 'Jakarta', postal: '10220', state: 'DKI Jakarta' },
  };
  return profiles[cc] || { name: 'Checkout User', line1: '1 Main St', city: 'City', postal: '10000', state: '' };
}
