import {
  createSavedPaymentBridgeResponse,
  isSavedPaymentBridgeRequestEvent,
  sanitizeSavedPaymentMessage,
  type SavedPaymentBridgeRequest,
  type SavedPaymentBridgeResponse,
  type SavedPaymentBridgeResult,
  type SavedPaymentIntentSnapshot,
} from './element-bridge';

interface StripeErrorLike {
  message?: string;
}

interface StripeSetupIntentLike {
  id?: string;
  status?: string;
  payment_method?: string | { id?: string } | null;
}

interface StripeCardElementLike {
  mount(target: string | Element): void;
  unmount(): void;
  on?: (event: 'ready', handler: () => void) => void;
  off?: (event: 'ready', handler: () => void) => void;
  destroy?: () => void;
}

interface StripeElementsLike {
  create(type: 'card', options?: Record<string, unknown>): StripeCardElementLike;
}

interface StripeLike {
  elements(options?: { clientSecret: string }): StripeElementsLike;
  retrieveSetupIntent(clientSecret: string): Promise<{
    setupIntent?: StripeSetupIntentLike;
    error?: StripeErrorLike;
  }>;
  confirmCardSetup(clientSecret: string, options: Record<string, unknown>): Promise<{
    setupIntent?: StripeSetupIntentLike;
    error?: StripeErrorLike;
  }>;
}

interface StripeScriptRetryOptions {
  attempts?: number;
  retryDelayMs?: number;
}

const STRIPE_JS_URL = 'https://js.stripe.com/v3/';

export interface SavedPaymentStripePageControllerOptions {
  loadStripe?: (publishableKey: string) => Promise<StripeLike>;
  resolveTarget?: (selector: string) => Element | null;
}

export interface SavedPaymentStripePageController {
  handle(request: SavedPaymentBridgeRequest): Promise<SavedPaymentBridgeResponse>;
  destroy(): void;
}

export function createSavedPaymentStripePageController(
  options: SavedPaymentStripePageControllerOptions = {},
): SavedPaymentStripePageController {
  const loadStripe = options.loadStripe || loadStripeJs;
  const resolveTarget = options.resolveTarget || ((selector) => document.querySelector(selector));
  const confirmedAttempts = new Set<string>();
  let activeAttemptId = '';
  let activeAccountDigest = '';
  let activeClientSecret = '';
  let stripe: StripeLike | null = null;
  let cardElement: StripeCardElementLike | null = null;
  let stripeHostFrame: HTMLIFrameElement | null = null;

  const cleanupElement = () => {
    try { cardElement?.unmount(); } catch { /* already detached */ }
    try { cardElement?.destroy?.(); } catch { /* provider cleanup is best effort */ }
    cardElement = null;
    stripe = null;
    activeClientSecret = '';
    stripeHostFrame?.remove();
    stripeHostFrame = null;
  };

  const bindAttempt = (request: SavedPaymentBridgeRequest): boolean => {
    if (
      activeAttemptId &&
      (activeAttemptId !== request.attemptId || activeAccountDigest !== request.accountDigest)
    ) {
      cleanupElement();
      activeAttemptId = '';
      activeAccountDigest = '';
      return false;
    }
    if (!activeAttemptId && request.command !== 'unmount') {
      activeAttemptId = request.attemptId;
      activeAccountDigest = request.accountDigest;
    }
    return true;
  };

  const handle = async (request: SavedPaymentBridgeRequest): Promise<SavedPaymentBridgeResponse> => {
    if (!bindAttempt(request)) {
      return createSavedPaymentBridgeResponse(
        request,
        failure('BRIDGE_CONTEXT_MISMATCH', 'active payment attempt context does not match', 'none'),
      );
    }
    let result: SavedPaymentBridgeResult<unknown>;
    try {
      if (request.command === 'retrieve-setup-intent') {
        result = await retrieve(request);
      } else if (request.command === 'mount-card') {
        result = await mount(request);
      } else if (request.command === 'confirm-card-setup') {
        result = await confirm(request);
      } else {
        cleanupElement();
        activeAttemptId = '';
        activeAccountDigest = '';
        result = success('ELEMENT_UNMOUNTED', 'card element unmounted', { unmounted: true }, 'none');
      }
    } catch (error) {
      result = failure(
        request.command === 'confirm-card-setup' ? 'CONFIRM_NETWORK_INCONCLUSIVE' : 'STRIPE_BRIDGE_ERROR',
        error instanceof Error ? error.message : String(error),
        request.command === 'confirm-card-setup' ? 'unknown' : 'none',
      );
    }
    return createSavedPaymentBridgeResponse(request, result);
  };

  const retrieve = async (request: SavedPaymentBridgeRequest): Promise<SavedPaymentBridgeResult<SavedPaymentIntentSnapshot>> => {
    const publishableKey = String(request.payload.publishableKey || '');
    const clientSecret = String(request.payload.clientSecret || '');
    const client = stripe && clientSecret === activeClientSecret
      ? stripe
      : await loadStripe(publishableKey);
    const response = await client.retrieveSetupIntent(clientSecret);
    if (response.error || !response.setupIntent) {
      return failure('SETUP_INTENT_RETRIEVE_FAILED', response.error?.message || 'SetupIntent was not returned', 'none');
    }
    return success('SETUP_INTENT_RETRIEVED', 'SetupIntent retrieved', intentSnapshot(response.setupIntent), 'none');
  };

  const mount = async (request: SavedPaymentBridgeRequest): Promise<SavedPaymentBridgeResult<{ ready: boolean }>> => {
    cleanupElement();
    const publishableKey = String(request.payload.publishableKey || '');
    const clientSecret = String(request.payload.clientSecret || '');
    const targetSelector = String(request.payload.targetSelector || '');
    const target = resolveTarget(targetSelector);
    if (!target) return failure('ELEMENT_TARGET_MISSING', 'card element mount target was not found', 'none');
    const runtime = options.loadStripe
      ? { stripe: await loadStripe(publishableKey), mountTarget: target }
      : await createIsolatedStripeRuntime(target, publishableKey);
    stripe = runtime.stripe;
    stripeHostFrame = 'hostFrame' in runtime ? runtime.hostFrame : null;
    const elements = stripe.elements();
    cardElement = elements.create('card', {
      hidePostalCode: true,
      disableLink: true,
    });
    const elementReady = waitForElementReady(cardElement);
    cardElement.mount(runtime.mountTarget);
    await elementReady;
    activeClientSecret = clientSecret;
    return success('CARD_ELEMENT_READY', 'card element mounted', { ready: true }, 'none');
  };

  const confirm = async (request: SavedPaymentBridgeRequest): Promise<SavedPaymentBridgeResult<SavedPaymentIntentSnapshot>> => {
    const clientSecret = String(request.payload.clientSecret || '');
    if (!stripe || !cardElement || clientSecret !== activeClientSecret) {
      return failure('CARD_ELEMENT_NOT_READY', 'card element is not ready for this attempt', 'none');
    }
    if (confirmedAttempts.has(request.attemptId)) {
      return failure('CONFIRM_ALREADY_SUBMITTED', 'confirm was already submitted for this attempt', 'none');
    }
    confirmedAttempts.add(request.attemptId);
    const response = await stripe.confirmCardSetup(clientSecret, {
      payment_method: {
        card: cardElement,
        billing_details: { name: String(request.payload.billingName || '').trim() },
      },
    });
    if (response.error || !response.setupIntent) {
      return failure('CONFIRM_REJECTED', response.error?.message || 'Stripe rejected card setup', 'none');
    }
    return success('CONFIRM_COMPLETED', 'card setup confirmation returned', intentSnapshot(response.setupIntent), 'confirmed');
  };

  return {
    handle,
    destroy() {
      cleanupElement();
      activeAttemptId = '';
      activeAccountDigest = '';
    },
  };
}

export function installSavedPaymentStripePageBridge(windowImpl: Window = window): () => void {
  const controller = createSavedPaymentStripePageController();
  const expectedOrigin = windowImpl.location.origin;
  const listener = (event: MessageEvent<unknown>) => {
    if (!isSavedPaymentBridgeRequestEvent(event, expectedOrigin, windowImpl)) return;
    void controller.handle(event.data).then((response) => {
      windowImpl.postMessage(response, expectedOrigin);
    });
  };
  windowImpl.addEventListener('message', listener);
  return () => {
    windowImpl.removeEventListener('message', listener);
    controller.destroy();
  };
}

function intentSnapshot(value: StripeSetupIntentLike): SavedPaymentIntentSnapshot {
  const paymentMethodId = typeof value.payment_method === 'string'
    ? value.payment_method
    : String(value.payment_method?.id || '');
  return {
    id: String(value.id || ''),
    status: String(value.status || ''),
    paymentMethodId: /^pm_[A-Za-z0-9]+$/.test(paymentMethodId) ? paymentMethodId : '',
  };
}

async function loadStripeJs(publishableKey: string): Promise<StripeLike> {
  return loadStripeJsInDocument(publishableKey, document, window);
}

export async function loadStripeJsInDocument(
  publishableKey: string,
  documentImpl: Document,
  windowImpl: Window,
  options: StripeScriptRetryOptions = {},
): Promise<StripeLike> {
  const scope = windowImpl as typeof windowImpl & { Stripe?: (key: string) => StripeLike };
  const attempts = Math.max(1, Math.min(3, Math.trunc(options.attempts ?? 3)));
  const retryDelayMs = Math.max(0, Math.min(2_000, Math.trunc(options.retryDelayMs ?? 250)));
  let lastError: unknown;
  for (let attempt = 1; !scope.Stripe && attempt <= attempts; attempt += 1) {
    try {
      await loadScript(STRIPE_JS_URL, documentImpl);
    } catch (error) {
      lastError = error;
      if (attempt < attempts && retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }
  if (!scope.Stripe && lastError) throw lastError;
  if (!scope.Stripe) throw new Error('Stripe.js did not initialize');
  return scope.Stripe(publishableKey);
}

async function createIsolatedStripeRuntime(target: Element, publishableKey: string): Promise<{
  stripe: StripeLike;
  mountTarget: Element;
  hostFrame: HTMLIFrameElement;
}> {
  const hostFrame = document.createElement('iframe');
  hostFrame.title = 'Saved card secure input host';
  hostFrame.style.cssText = 'display:block;width:100%;height:54px;border:0;background:transparent';
  const loaded = new Promise<void>((resolve, reject) => {
    hostFrame.addEventListener('load', () => resolve(), { once: true });
    hostFrame.addEventListener('error', () => reject(new Error('Stripe host iframe failed to load')), { once: true });
  });
  hostFrame.srcdoc = '<!doctype html><html><head></head><body style="margin:0"><div id="opx-stripe-card" style="min-height:44px"></div></body></html>';
  target.replaceChildren(hostFrame);
  await loaded;
  const hostDocument = hostFrame.contentDocument;
  const hostWindow = hostFrame.contentWindow;
  const mountTarget = hostDocument?.querySelector('#opx-stripe-card');
  if (!hostDocument || !hostWindow || !mountTarget) throw new Error('Stripe host iframe did not initialize');
  const stripe = await loadStripeJsInDocument(publishableKey, hostDocument, hostWindow);
  return { stripe, mountTarget, hostFrame };
}

function loadScript(src: string, documentImpl: Document): Promise<void> {
  const existing = documentImpl.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
  if (existing?.dataset.opxLoaded === 'true') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = existing || documentImpl.createElement('script');
    const onLoad = () => {
      script.dataset.opxLoaded = 'true';
      resolve();
    };
    script.addEventListener('load', onLoad, { once: true });
    script.addEventListener('error', () => {
      script.remove();
      reject(new Error('Stripe.js failed to load'));
    }, { once: true });
    if (!existing) {
      script.src = src;
      script.async = true;
      (documentImpl.head || documentImpl.documentElement).appendChild(script);
    }
  });
}

function waitForElementReady(element: StripeCardElementLike, timeoutMs = 15_000): Promise<void> {
  if (typeof element.on !== 'function') return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const onReady = () => {
      if (timeoutId) clearTimeout(timeoutId);
      element.off?.('ready', onReady);
      resolve();
    };
    timeoutId = setTimeout(() => {
      element.off?.('ready', onReady);
      reject(new Error('Stripe Card Element ready event timed out'));
    }, timeoutMs);
    element.on?.('ready', onReady);
  });
}

function success<T>(
  code: string,
  message: string,
  data: T,
  sideEffect: SavedPaymentBridgeResult<T>['sideEffect'],
): SavedPaymentBridgeResult<T> {
  return { ok: true, code, message, data, sideEffect };
}

function failure<T>(
  code: string,
  message: string,
  sideEffect: SavedPaymentBridgeResult<T>['sideEffect'],
): SavedPaymentBridgeResult<T> {
  return { ok: false, code, message: sanitizeSavedPaymentMessage(message), sideEffect };
}
