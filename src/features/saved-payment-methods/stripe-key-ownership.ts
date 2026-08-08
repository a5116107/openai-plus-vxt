import type { StripeKeyOwnershipResult } from './types';

const STRIPE_VERSION = '2025-03-31.basil; checkout_server_update_beta=v1; checkout_manual_approval_preview=v1';

export interface VerifyStripeCheckoutKeyInput {
  publishableKey: string;
  checkoutSessionId: string;
  fetchImpl?: typeof fetch;
}

export interface VerifyStripeSetupIntentKeyInput {
  publishableKey: string;
  clientSecret: string;
  retrieveSetupIntent: (
    publishableKey: string,
    clientSecret: string,
  ) => Promise<{ setupIntent?: { id?: string; status?: string }; error?: { message?: string } }>;
}

export async function verifyStripeCheckoutKeyOwnership(
  input: VerifyStripeCheckoutKeyInput,
): Promise<StripeKeyOwnershipResult> {
  const publishableKey = String(input.publishableKey || '').trim();
  const checkoutSessionId = String(input.checkoutSessionId || '').trim();
  const keyFingerprint = fingerprintKey(publishableKey);
  const base = { targetId: checkoutSessionId, keyFingerprint };

  if (!/^pk_(?:live|test)_[A-Za-z0-9_-]+$/.test(publishableKey)) {
    return { ...base, status: 'rejected', code: 'INVALID_PUBLISHABLE_KEY', message: 'publishable key format is invalid' };
  }
  if (!/^cs_(?:live|test)_[A-Za-z0-9_-]+$/.test(checkoutSessionId)) {
    return { ...base, status: 'rejected', code: 'INVALID_CHECKOUT_SESSION', message: 'checkout session format is invalid' };
  }
  if (stripeMode(publishableKey) !== stripeMode(checkoutSessionId)) {
    return { ...base, status: 'rejected', code: 'MODE_MISMATCH', message: 'publishable key and checkout session modes differ' };
  }

  const body = new URLSearchParams({
    browser_locale: 'en-US',
    browser_timezone: 'UTC',
    'elements_session_client[elements_init_source]': 'custom_checkout',
    'elements_session_client[referrer_host]': 'chatgpt.com',
    key: publishableKey,
    _stripe_version: STRIPE_VERSION,
  });
  let response: Response;
  try {
    response = await (input.fetchImpl || fetch)(
      `https://api.stripe.com/v1/payment_pages/${encodeURIComponent(checkoutSessionId)}/init`,
      {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        credentials: 'omit',
      },
    );
  } catch (error) {
    return {
      ...base,
      status: 'inconclusive',
      code: 'NETWORK_INCONCLUSIVE',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const payload = await parseJsonResponse(response);
  if (!response.ok || hasStripeError(payload)) {
    return {
      ...base,
      status: 'rejected',
      code: 'STRIPE_REJECTED',
      message: stripeErrorMessage(payload) || `Stripe HTTP ${response.status}`,
      httpStatus: response.status,
    };
  }
  if (!isCheckoutInitPayload(payload)) {
    return {
      ...base,
      status: 'inconclusive',
      code: 'RESPONSE_INCONCLUSIVE',
      message: 'Stripe response lacks Checkout init evidence',
      httpStatus: response.status,
    };
  }
  return {
    ...base,
    status: 'verified',
    code: 'OWNERSHIP_VERIFIED',
    message: 'publishable key can initialize the expected Checkout session',
    httpStatus: response.status,
  };
}

export async function verifyStripeSetupIntentKeyOwnership(
  input: VerifyStripeSetupIntentKeyInput,
): Promise<StripeKeyOwnershipResult> {
  const publishableKey = String(input.publishableKey || '').trim();
  const clientSecret = String(input.clientSecret || '').trim();
  const setupIntentId = setupIntentIdFromSecret(clientSecret);
  const keyFingerprint = fingerprintKey(publishableKey);
  const base = { targetId: setupIntentId, keyFingerprint };
  if (!/^pk_(?:live|test)_[A-Za-z0-9_-]+$/.test(publishableKey)) {
    return { ...base, status: 'rejected', code: 'INVALID_PUBLISHABLE_KEY', message: 'publishable key format is invalid' };
  }
  if (!setupIntentId) {
    return { ...base, status: 'rejected', code: 'INVALID_CHECKOUT_SESSION', message: 'SetupIntent client secret format is invalid' };
  }
  let result: Awaited<ReturnType<VerifyStripeSetupIntentKeyInput['retrieveSetupIntent']>>;
  try {
    result = await input.retrieveSetupIntent(publishableKey, clientSecret);
  } catch (error) {
    return {
      ...base,
      status: 'inconclusive',
      code: 'NETWORK_INCONCLUSIVE',
      message: sanitizeOwnershipMessage(error instanceof Error ? error.message : String(error)),
    };
  }
  if (result.error || !result.setupIntent) {
    return {
      ...base,
      status: 'rejected',
      code: 'STRIPE_REJECTED',
      message: sanitizeOwnershipMessage(result.error?.message || 'Stripe did not return the SetupIntent'),
    };
  }
  if (String(result.setupIntent.id || '') !== setupIntentId) {
    return {
      ...base,
      status: 'inconclusive',
      code: 'RESPONSE_INCONCLUSIVE',
      message: 'Stripe returned a different SetupIntent',
    };
  }
  return {
    ...base,
    status: 'verified',
    code: 'OWNERSHIP_VERIFIED',
    message: 'publishable key can retrieve the expected SetupIntent',
  };
}

function stripeMode(value: string): 'live' | 'test' | 'unknown' {
  if (/^(?:pk|cs)_live_/.test(value)) return 'live';
  if (/^(?:pk|cs)_test_/.test(value)) return 'test';
  return 'unknown';
}

function fingerprintKey(value: string): string {
  if (!value) return '';
  return `${value.slice(0, 7)}...${value.slice(-6)}`;
}

function setupIntentIdFromSecret(value: string): string {
  return /^(seti_[A-Za-z0-9]+)_secret_[A-Za-z0-9]+$/.exec(value)?.[1] || '';
}

function sanitizeOwnershipMessage(value: string): string {
  return String(value || '')
    .replace(/seti_[A-Za-z0-9]+_secret_[A-Za-z0-9]+/g, '[SETUP_SECRET]')
    .replace(/pk_(?:live|test)_[A-Za-z0-9_-]+/g, '[PUBLISHABLE_KEY]')
    .slice(0, 240);
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  try {
    return JSON.parse(await response.text());
  } catch {
    return null;
  }
}

function isCheckoutInitPayload(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return [
    'payment_method_types',
    'elements_options',
    'total_summary',
    'amount_total',
    'currency',
    'mode',
    'payment_page',
    'session',
  ].some((key) => key in value);
}

function hasStripeError(value: unknown): boolean {
  return isRecord(value) && isRecord(value.error);
}

function stripeErrorMessage(value: unknown): string {
  if (!isRecord(value) || !isRecord(value.error)) return '';
  return typeof value.error.message === 'string' ? value.error.message.slice(0, 240) : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
