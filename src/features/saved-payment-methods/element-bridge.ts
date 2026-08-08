export const SAVED_PAYMENT_BRIDGE_VERSION = 'opx-saved-payment-v1';
export const SAVED_PAYMENT_BRIDGE_REQUEST = 'opx:saved-payment:request';
export const SAVED_PAYMENT_BRIDGE_RESPONSE = 'opx:saved-payment:response';

export type SavedPaymentBridgeCommand =
  | 'retrieve-setup-intent'
  | 'mount-card'
  | 'confirm-card-setup'
  | 'unmount';

export interface SavedPaymentIntentSnapshot {
  id: string;
  status: string;
  paymentMethodId: string;
}

export interface SavedPaymentBridgeResult<T> {
  ok: boolean;
  code: string;
  message: string;
  data?: T;
  sideEffect: 'none' | 'unknown' | 'confirmed';
}

export interface SavedPaymentBridgeRequest {
  type: typeof SAVED_PAYMENT_BRIDGE_REQUEST;
  version: typeof SAVED_PAYMENT_BRIDGE_VERSION;
  command: SavedPaymentBridgeCommand;
  requestId: string;
  attemptId: string;
  accountDigest: string;
  payload: Record<string, unknown>;
}

export interface SavedPaymentBridgeResponse {
  type: typeof SAVED_PAYMENT_BRIDGE_RESPONSE;
  version: typeof SAVED_PAYMENT_BRIDGE_VERSION;
  command: SavedPaymentBridgeCommand;
  requestId: string;
  attemptId: string;
  accountDigest: string;
  result: SavedPaymentBridgeResult<Record<string, unknown>>;
}

export interface SavedPaymentElementBridge {
  retrieveSetupIntent(input: {
    publishableKey: string;
    clientSecret: string;
  }): Promise<SavedPaymentBridgeResult<SavedPaymentIntentSnapshot>>;
  mountCard(input: {
    publishableKey: string;
    clientSecret: string;
    targetSelector: string;
  }): Promise<SavedPaymentBridgeResult<{ ready: boolean }>>;
  confirmCardSetup(input: {
    clientSecret: string;
    billingName: string;
    setAsDefault: boolean;
  }): Promise<SavedPaymentBridgeResult<SavedPaymentIntentSnapshot>>;
  unmount(): Promise<SavedPaymentBridgeResult<{ unmounted: boolean }>>;
  dispose(): void;
}

interface WindowBridgeOptions {
  attemptId: string;
  accountDigest: string;
  expectedOrigin?: string;
  timeoutMs?: number;
  windowImpl?: Window;
}

interface PendingRequest {
  command: SavedPaymentBridgeCommand;
  resolve: (result: SavedPaymentBridgeResult<Record<string, unknown>>) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

export function createWindowSavedPaymentElementBridge(
  options: WindowBridgeOptions,
): SavedPaymentElementBridge {
  const windowImpl = options.windowImpl || window;
  const expectedOrigin = options.expectedOrigin || windowImpl.location.origin;
  const timeoutMs = Math.max(1_000, options.timeoutMs || 20_000);
  const attemptId = normalizeIdentifier(options.attemptId);
  const accountDigest = String(options.accountDigest || '').toLowerCase();
  const pending = new Map<string, PendingRequest>();
  let disposed = false;

  const onMessage = (event: MessageEvent<unknown>) => {
    if (!isSavedPaymentBridgeResponseEvent(event, expectedOrigin, windowImpl)) return;
    const response = event.data;
    if (response.attemptId !== attemptId || response.accountDigest !== accountDigest) return;
    const request = pending.get(response.requestId);
    if (!request || request.command !== response.command) return;
    pending.delete(response.requestId);
    clearTimeout(request.timeoutId);
    request.resolve(sanitizeBridgeResult(response.result));
  };
  windowImpl.addEventListener('message', onMessage);

  const send = <T>(
    command: SavedPaymentBridgeCommand,
    payload: Record<string, unknown>,
  ): Promise<SavedPaymentBridgeResult<T>> => {
    if (disposed) {
      return Promise.resolve(failure('BRIDGE_DISPOSED', 'payment bridge is disposed', 'none'));
    }
    if (!attemptId || !isAccountDigest(accountDigest)) {
      return Promise.resolve(failure('BRIDGE_CONTEXT_INVALID', 'payment bridge context is invalid', 'none'));
    }
    const requestId = createRequestId();
    const request: SavedPaymentBridgeRequest = {
      type: SAVED_PAYMENT_BRIDGE_REQUEST,
      version: SAVED_PAYMENT_BRIDGE_VERSION,
      command,
      requestId,
      attemptId,
      accountDigest,
      payload,
    };
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        pending.delete(requestId);
        resolve(failure(
          command === 'confirm-card-setup' ? 'CONFIRM_TIMEOUT_INCONCLUSIVE' : 'BRIDGE_TIMEOUT',
          'payment bridge response timed out',
          command === 'confirm-card-setup' ? 'unknown' : 'none',
        ));
      }, timeoutMs);
      pending.set(requestId, {
        command,
        timeoutId,
        resolve: resolve as PendingRequest['resolve'],
      });
      windowImpl.postMessage(request, expectedOrigin);
    });
  };

  return {
    retrieveSetupIntent: (input) => send('retrieve-setup-intent', input),
    mountCard: (input) => send('mount-card', input),
    confirmCardSetup: (input) => send('confirm-card-setup', input),
    unmount: () => send('unmount', {}),
    dispose() {
      if (disposed) return;
      disposed = true;
      windowImpl.removeEventListener('message', onMessage);
      for (const request of pending.values()) {
        clearTimeout(request.timeoutId);
        request.resolve(failure('BRIDGE_DISPOSED', 'payment bridge was disposed', 'none'));
      }
      pending.clear();
    },
  };
}

export function isSavedPaymentBridgeRequestEvent(
  event: MessageEvent<unknown>,
  expectedOrigin: string,
  expectedSource: Window,
): event is MessageEvent<SavedPaymentBridgeRequest> {
  if (event.source !== expectedSource || event.origin !== expectedOrigin) return false;
  if (!isRecord(event.data)) return false;
  const value = event.data;
  if (
    value.type !== SAVED_PAYMENT_BRIDGE_REQUEST ||
    value.version !== SAVED_PAYMENT_BRIDGE_VERSION ||
    !isBridgeCommand(value.command) ||
    !isIdentifier(value.requestId) ||
    !isIdentifier(value.attemptId) ||
    !isAccountDigest(value.accountDigest) ||
    !isRecord(value.payload)
  ) return false;
  return isCommandPayload(value.command, value.payload);
}

export function isSavedPaymentBridgeResponseEvent(
  event: MessageEvent<unknown>,
  expectedOrigin: string,
  expectedSource: Window,
): event is MessageEvent<SavedPaymentBridgeResponse> {
  if (event.source !== expectedSource || event.origin !== expectedOrigin) return false;
  if (!isRecord(event.data)) return false;
  const value = event.data;
  return value.type === SAVED_PAYMENT_BRIDGE_RESPONSE &&
    value.version === SAVED_PAYMENT_BRIDGE_VERSION &&
    isBridgeCommand(value.command) &&
    isIdentifier(value.requestId) &&
    isIdentifier(value.attemptId) &&
    isAccountDigest(value.accountDigest) &&
    isBridgeResult(value.result);
}

export function createSavedPaymentBridgeResponse(
  request: SavedPaymentBridgeRequest,
  result: SavedPaymentBridgeResult<unknown>,
): SavedPaymentBridgeResponse {
  return {
    type: SAVED_PAYMENT_BRIDGE_RESPONSE,
    version: SAVED_PAYMENT_BRIDGE_VERSION,
    command: request.command,
    requestId: request.requestId,
    attemptId: request.attemptId,
    accountDigest: request.accountDigest,
    result: sanitizeBridgeResult(result),
  };
}

export async function digestSavedPaymentAccountId(accountId: string): Promise<string> {
  const bytes = new TextEncoder().encode(String(accountId || '').trim());
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
}

export function sanitizeSavedPaymentMessage(value: unknown): string {
  return String(value || '')
    .replace(/seti_[A-Za-z0-9]+_secret_[A-Za-z0-9]+/g, '[SETUP_SECRET]')
    .replace(/pk_(?:live|test)_[A-Za-z0-9_-]+/g, '[PUBLISHABLE_KEY]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [TOKEN]')
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, '[CARD_DATA]')
    .slice(0, 300);
}

function isCommandPayload(command: SavedPaymentBridgeCommand, payload: Record<string, unknown>): boolean {
  if (command === 'unmount') return true;
  if (command === 'retrieve-setup-intent') {
    return isPublishableKey(payload.publishableKey) && isSetupSecret(payload.clientSecret);
  }
  if (command === 'mount-card') {
    return isPublishableKey(payload.publishableKey) &&
      isSetupSecret(payload.clientSecret) &&
      typeof payload.targetSelector === 'string' &&
      payload.targetSelector.length > 0 &&
      payload.targetSelector.length <= 240;
  }
  return isSetupSecret(payload.clientSecret) &&
    typeof payload.billingName === 'string' &&
    payload.billingName.length <= 200 &&
    typeof payload.setAsDefault === 'boolean';
}

function isBridgeCommand(value: unknown): value is SavedPaymentBridgeCommand {
  return value === 'retrieve-setup-intent' ||
    value === 'mount-card' ||
    value === 'confirm-card-setup' ||
    value === 'unmount';
}

function isBridgeResult(value: unknown): value is SavedPaymentBridgeResult<Record<string, unknown>> {
  return isRecord(value) && typeof value.ok === 'boolean' && typeof value.code === 'string' &&
    typeof value.message === 'string' &&
    (value.sideEffect === 'none' || value.sideEffect === 'unknown' || value.sideEffect === 'confirmed');
}

function sanitizeBridgeResult<T>(value: SavedPaymentBridgeResult<T>): SavedPaymentBridgeResult<Record<string, unknown>> {
  const data = isRecord(value.data) ? sanitizeBridgeData(value.data) : undefined;
  return {
    ok: Boolean(value.ok),
    code: String(value.code || 'BRIDGE_ERROR').slice(0, 80),
    message: sanitizeSavedPaymentMessage(value.message),
    ...(data ? { data } : {}),
    sideEffect: value.sideEffect === 'unknown' || value.sideEffect === 'confirmed' ? value.sideEffect : 'none',
  };
}

function sanitizeBridgeData(value: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  if (typeof value.id === 'string' && /^seti_[A-Za-z0-9]+$/.test(value.id)) output.id = value.id;
  if (typeof value.status === 'string') output.status = value.status.slice(0, 80);
  if (typeof value.paymentMethodId === 'string' && /^pm_[A-Za-z0-9]+$/.test(value.paymentMethodId)) {
    output.paymentMethodId = value.paymentMethodId;
  }
  if (typeof value.ready === 'boolean') output.ready = value.ready;
  if (typeof value.unmounted === 'boolean') output.unmounted = value.unmounted;
  return output;
}

function failure<T>(
  code: string,
  message: string,
  sideEffect: SavedPaymentBridgeResult<T>['sideEffect'],
): SavedPaymentBridgeResult<T> {
  return { ok: false, code, message: sanitizeSavedPaymentMessage(message), sideEffect };
}

function createRequestId(): string {
  return `spm-${Date.now().toString(36)}-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function normalizeIdentifier(value: string): string {
  const normalized = String(value || '').trim();
  return isIdentifier(normalized) ? normalized : '';
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(value);
}

function isAccountDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isPublishableKey(value: unknown): value is string {
  return typeof value === 'string' && /^pk_(?:live|test)_[A-Za-z0-9_-]+$/.test(value);
}

function isSetupSecret(value: unknown): value is string {
  return typeof value === 'string' && /^seti_[A-Za-z0-9]+_secret_[A-Za-z0-9]+$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
