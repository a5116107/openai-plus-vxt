export interface SavedPaymentSessionContext {
  chatgptAccountId: string;
  accessToken: string;
}

export interface SavedPaymentMethodSummary {
  id: string;
  type: string;
  card?: {
    brand: string;
    last4: string;
    expMonth: number;
    expYear: number;
  };
  isDefault: boolean;
}

export interface CreatedSetupIntent {
  setupIntentId: string;
  clientSecret: string;
}

export interface SavedPaymentMethodList {
  paymentMethods: SavedPaymentMethodSummary[];
  defaultPaymentMethodId: string;
}

export interface SavedPaymentTransportResult<T> {
  ok: boolean;
  code: string;
  message: string;
  data?: T;
  httpStatus?: number;
  retryable: boolean;
  sideEffect: 'none' | 'unknown' | 'confirmed';
}

export interface SavedPaymentTransport {
  createSetupIntent(
    context: SavedPaymentSessionContext,
    attemptId: string,
  ): Promise<SavedPaymentTransportResult<CreatedSetupIntent>>;
  listPaymentMethods(
    context: SavedPaymentSessionContext,
  ): Promise<SavedPaymentTransportResult<SavedPaymentMethodList>>;
}

export interface SavedPaymentTransportOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

const CREATE_PATH = '/backend-api/payments/payment_method';
const LIST_PATH = '/backend-api/payments/payment_methods';

export function createSavedPaymentTransport(options: SavedPaymentTransportOptions = {}): SavedPaymentTransport {
  const fetchImpl = options.fetchImpl || fetch;
  const baseUrl = String(options.baseUrl || 'https://chatgpt.com').replace(/\/+$/, '');
  const createAttempts = new Map<string, Promise<SavedPaymentTransportResult<CreatedSetupIntent>>>();

  return {
    async createSetupIntent(context, attemptId) {
      const invalid = validateContext(context);
      if (invalid) return invalid;
      const normalizedAttemptId = String(attemptId || '').trim();
      if (!normalizedAttemptId) return failure('ATTEMPT_ID_REQUIRED', 'attempt id is required', false, 'none');
      const attemptKey = `${context.chatgptAccountId}|${normalizedAttemptId}`;
      const existing = createAttempts.get(attemptKey);
      if (existing) return existing;
      const request = (async (): Promise<SavedPaymentTransportResult<CreatedSetupIntent>> => {
        const result = await requestJson(
          fetchImpl,
          `${baseUrl}${CREATE_PATH}`,
          {
            method: 'POST',
            credentials: 'include',
            headers: requestHeaders(context, CREATE_PATH),
            body: JSON.stringify({ account_id: context.chatgptAccountId }),
          },
          true,
        );
        if (!result.ok) return result as SavedPaymentTransportResult<CreatedSetupIntent>;
        const clientSecret = stringField(result.data, 'client_secret');
        const setupIntentId = setupIntentIdFromSecret(clientSecret);
        if (!setupIntentId) {
          return failure('SETUP_INTENT_MALFORMED', 'SetupIntent response is missing a valid client secret', false, 'unknown', result.httpStatus);
        }
        return {
          ok: true,
          code: 'SETUP_INTENT_CREATED',
          message: 'SetupIntent created',
          data: { setupIntentId, clientSecret },
          httpStatus: result.httpStatus,
          retryable: false,
          sideEffect: 'confirmed',
        };
      })();
      createAttempts.set(attemptKey, request);
      return request;
    },

    async listPaymentMethods(context) {
      const invalid = validateContext(context);
      if (invalid) return invalid;
      const url = new URL(`${baseUrl}${LIST_PATH}`);
      url.searchParams.set('account_id', context.chatgptAccountId);
      const result = await requestJson(
        fetchImpl,
        url.toString(),
        {
          method: 'GET',
          credentials: 'include',
          headers: requestHeaders(context, LIST_PATH),
        },
        false,
      );
      if (!result.ok) return result as SavedPaymentTransportResult<SavedPaymentMethodList>;
      const source = isRecord(result.data) ? result.data : {};
      const defaultPaymentMethodId = stringField(source, 'default_payment_method_id');
      const paymentMethods = Array.isArray(source.payment_methods)
        ? source.payment_methods
            .filter(isRecord)
            .map((item) => normalizePaymentMethod(item, defaultPaymentMethodId))
            .filter((item): item is SavedPaymentMethodSummary => Boolean(item))
        : [];
      return {
        ok: true,
        code: 'PAYMENT_METHODS_LISTED',
        message: 'saved payment methods listed',
        data: { paymentMethods, defaultPaymentMethodId },
        httpStatus: result.httpStatus,
        retryable: false,
        sideEffect: 'none',
      };
    },
  };
}

function requestHeaders(
  context: SavedPaymentSessionContext,
  path: string,
): Record<string, string> {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${context.accessToken}`,
    'Content-Type': 'application/json',
    'chatgpt-account-id': context.chatgptAccountId,
    'x-openai-target-path': path,
    'x-openai-target-route': path,
  };
}

async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  write: boolean,
): Promise<SavedPaymentTransportResult<unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    return failure(
      write ? 'SETUP_CREATE_NETWORK_INCONCLUSIVE' : 'PAYMENT_METHOD_LIST_NETWORK',
      sanitizeMessage(error instanceof Error ? error.message : String(error)),
      true,
      write ? 'unknown' : 'none',
    );
  }
  const payload = await parseJson(response);
  if (!response.ok) {
    const message = providerMessage(payload) || `ChatGPT payments HTTP ${response.status}`;
    const credential = response.status === 401 || response.status === 403;
    return failure(
      credential ? 'PAYMENTS_CREDENTIAL_REJECTED' : 'PAYMENTS_HTTP_ERROR',
      message,
      !credential && response.status >= 500,
      write && response.status >= 500 ? 'unknown' : 'none',
      response.status,
    );
  }
  return {
    ok: true,
    code: 'PAYMENTS_RESPONSE_OK',
    message: 'payments response received',
    data: payload,
    httpStatus: response.status,
    retryable: false,
    sideEffect: write ? 'confirmed' : 'none',
  };
}

function validateContext(context: SavedPaymentSessionContext): SavedPaymentTransportResult<never> | null {
  if (!String(context.chatgptAccountId || '').trim()) {
    return failure('ACCOUNT_ID_REQUIRED', 'ChatGPT account id is required', false, 'none');
  }
  if (!String(context.accessToken || '').trim()) {
    return failure('ACCESS_TOKEN_REQUIRED', 'ChatGPT access token is required', false, 'none');
  }
  return null;
}

function normalizePaymentMethod(value: Record<string, unknown>, defaultId: string): SavedPaymentMethodSummary | null {
  const id = stringField(value, 'id');
  if (!id.startsWith('pm_')) return null;
  const type = stringField(value, 'type') || 'unknown';
  const card = isRecord(value.card) ? value.card : null;
  return {
    id,
    type,
    ...(card ? {
      card: {
        brand: stringField(card, 'brand'),
        last4: stringField(card, 'last4'),
        expMonth: numberField(card, 'exp_month'),
        expYear: numberField(card, 'exp_year'),
      },
    } : {}),
    isDefault: id === defaultId,
  };
}

function setupIntentIdFromSecret(value: string): string {
  return /^(seti_[A-Za-z0-9]+)_secret_[A-Za-z0-9]+$/.exec(value)?.[1] || '';
}

function failure<T>(
  code: string,
  message: string,
  retryable: boolean,
  sideEffect: SavedPaymentTransportResult<T>['sideEffect'],
  httpStatus?: number,
): SavedPaymentTransportResult<T> {
  return { ok: false, code, message: sanitizeMessage(message), retryable, sideEffect, httpStatus };
}

async function parseJson(response: Response): Promise<unknown> {
  try { return JSON.parse(await response.text()); } catch { return {}; }
}

function providerMessage(value: unknown): string {
  if (!isRecord(value)) return '';
  if (typeof value.detail === 'string') return sanitizeMessage(value.detail);
  if (typeof value.message === 'string') return sanitizeMessage(value.message);
  if (isRecord(value.error) && typeof value.error.message === 'string') return sanitizeMessage(value.error.message);
  return '';
}

function sanitizeMessage(value: string): string {
  return String(value || '')
    .replace(/seti_[A-Za-z0-9]+_secret_[A-Za-z0-9]+/g, '[SETUP_SECRET]')
    .replace(/pk_(?:live|test)_[A-Za-z0-9_-]+/g, '[PUBLISHABLE_KEY]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [TOKEN]')
    .slice(0, 300);
}

function stringField(value: unknown, key: string): string {
  return isRecord(value) && typeof value[key] === 'string' ? String(value[key]).trim() : '';
}

function numberField(value: unknown, key: string): number {
  return isRecord(value) && Number.isFinite(Number(value[key])) ? Number(value[key]) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
