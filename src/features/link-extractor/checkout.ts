import type {
  CheckoutCreationPolicy,
  CheckoutLinkResponse,
  CheckoutNetworkEvidence,
  CheckoutOptions,
  CheckoutPlanName,
  CheckoutRegion,
  CheckoutStagePipelineOptions,
  CheckoutUiMode,
  CheckoutExtractMode,
  CheckoutIdentitySnapshot,
  CheckoutPipelineEndpoints,
  CheckoutRetryMetrics,
} from './types';
import {
  checkoutAmountEvidence,
  checkoutStateFromHtml,
  parseStructuredCheckoutAmount,
  payloadHasInvalidPromotion,
} from './checkout-amount';

const CHECKOUT_URL = 'https://chatgpt.com/backend-api/payments/checkout';
const CHECKOUT_UPDATE_URL = 'https://chatgpt.com/backend-api/payments/checkout/update';
const CHECKOUT_TAXES_URL = 'https://chatgpt.com/backend-api/payments/checkout/taxes';
const SERVER_CHECKOUT_RAW_URL = 'http://64.176.37.149:8788/checkout/raw';
const ACCESS_TOKEN_RE = /"accessToken"\s*:\s*"([^"]+)"/;
const ACCESS_TOKEN_LOOSE_RE = /"accessToken"\s*:\s*"?([A-Za-z0-9_.-]+)/;
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/;
const CHECKOUT_SESSION_RE = /((?:cs_(?:live|test)|oaics)_[A-Za-z0-9_-]+)/;
const PROCESSOR_ENTITY_RE = /(?:\/checkout\/|processor_entity=)([A-Za-z0-9_]+)/;
const CHECKOUT_FETCH_TIMEOUT_MS = 30_000;

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = CHECKOUT_FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) abortFromCaller();
  else init.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException(`Checkout request timed out after ${timeoutMs}ms`, 'TimeoutError')), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', abortFromCaller);
  }
}

const REGION_BILLING: Record<string, { country: string; currency: string }> = {
  US: { country: 'US', currency: 'USD' },
  ID: { country: 'ID', currency: 'IDR' },
  DE: { country: 'DE', currency: 'EUR' },
  JP: { country: 'JP', currency: 'JPY' },
  AE: { country: 'AE', currency: 'AED' },
  AR: { country: 'AR', currency: 'USD' },
  AT: { country: 'AT', currency: 'EUR' },
  AU: { country: 'AU', currency: 'AUD' },
  BE: { country: 'BE', currency: 'EUR' },
  BG: { country: 'BG', currency: 'EUR' },
  BH: { country: 'BH', currency: 'USD' },
  BO: { country: 'BO', currency: 'USD' },
  BR: { country: 'BR', currency: 'BRL' },
  CA: { country: 'CA', currency: 'CAD' },
  CH: { country: 'CH', currency: 'CHF' },
  CL: { country: 'CL', currency: 'CLP' },
  CN: { country: 'CN', currency: 'USD' },
  CO: { country: 'CO', currency: 'COP' },
  CR: { country: 'CR', currency: 'USD' },
  CY: { country: 'CY', currency: 'EUR' },
  CZ: { country: 'CZ', currency: 'CZK' },
  DK: { country: 'DK', currency: 'DKK' },
  DO: { country: 'DO', currency: 'USD' },
  EE: { country: 'EE', currency: 'EUR' },
  EG: { country: 'EG', currency: 'EGP' },
  ES: { country: 'ES', currency: 'EUR' },
  FI: { country: 'FI', currency: 'EUR' },
  FR: { country: 'FR', currency: 'EUR' },
  GB: { country: 'GB', currency: 'GBP' },
  GE: { country: 'GE', currency: 'EUR' },
  GR: { country: 'GR', currency: 'EUR' },
  // Checkout currently validates HK against its supported settlement enum; USD is the accepted fallback.
  HK: { country: 'HK', currency: 'USD' },
  HR: { country: 'HR', currency: 'EUR' },
  HU: { country: 'HU', currency: 'HUF' },
  IE: { country: 'IE', currency: 'EUR' },
  IL: { country: 'IL', currency: 'ILS' },
  IN: { country: 'IN', currency: 'INR' },
  IT: { country: 'IT', currency: 'EUR' },
  KR: { country: 'KR', currency: 'KRW' },
  KW: { country: 'KW', currency: 'USD' },
  LT: { country: 'LT', currency: 'EUR' },
  LU: { country: 'LU', currency: 'EUR' },
  LV: { country: 'LV', currency: 'EUR' },
  MX: { country: 'MX', currency: 'MXN' },
  MY: { country: 'MY', currency: 'MYR' },
  NL: { country: 'NL', currency: 'EUR' },
  NO: { country: 'NO', currency: 'NOK' },
  NZ: { country: 'NZ', currency: 'NZD' },
  PE: { country: 'PE', currency: 'PEN' },
  PH: { country: 'PH', currency: 'PHP' },
  PL: { country: 'PL', currency: 'PLN' },
  PT: { country: 'PT', currency: 'EUR' },
  QA: { country: 'QA', currency: 'USD' },
  RO: { country: 'RO', currency: 'RON' },
  SA: { country: 'SA', currency: 'SAR' },
  SE: { country: 'SE', currency: 'SEK' },
  SG: { country: 'SG', currency: 'SGD' },
  SI: { country: 'SI', currency: 'EUR' },
  SK: { country: 'SK', currency: 'EUR' },
  TH: { country: 'TH', currency: 'THB' },
  TR: { country: 'TR', currency: 'TRY' },
  TW: { country: 'TW', currency: 'TWD' },
  UA: { country: 'UA', currency: 'UAH' },
  VN: { country: 'VN', currency: 'VND' },
  ZA: { country: 'ZA', currency: 'ZAR' },
};

export function listCheckoutRegions(): Array<{ country: string; currency: string }> {
  return Object.values(REGION_BILLING).map((item) => ({ ...item }));
}

export function billingDetailsForCountry(country: string): { country: string; currency: string } {
  const code = String(country || 'US').trim().toUpperCase();
  return REGION_BILLING[code] || { country: code || 'US', currency: 'USD' };
}

export const DEFAULT_CHECKOUT_OPTIONS: CheckoutOptions = {
  planName: 'chatgptplusplan',
  uiMode: 'hosted',
  region: 'US',
  workspaceName: 'MyTeam',
  seatQuantity: 5,
};

export const DEFAULT_CHECKOUT_EXTRACT_MODE: CheckoutExtractMode = 'local';

export function extractAccessToken(raw: string): string {
  const text = String(raw || '').trim();
  if (!text) {
    throw new Error('请输入包含 accessToken 的 JSON 或字符串');
  }

  const token = extractFromJson(text) || extractFromAccessTokenField(text) || extractFirstJwt(text);
  if (!token) {
    throw new Error('未找到 accessToken');
  }
  if (token.split('.').length !== 3) {
    throw new Error('accessToken 格式不正确');
  }
  return token;
}

export function tryExtractAccessToken(raw: string): string {
  try {
    return extractAccessToken(raw);
  } catch {
    return '';
  }
}

export function normalizeCheckoutOptions(value: unknown): CheckoutOptions {
  const source = isRecord(value) ? value : {};
  return {
    planName: normalizePlanName(source.planName),
    uiMode: normalizeUiMode(source.uiMode),
    region: normalizeRegion(source.region || source.country),
    workspaceName: String(source.workspaceName || source.workspace_name || DEFAULT_CHECKOUT_OPTIONS.workspaceName).trim() ||
      DEFAULT_CHECKOUT_OPTIONS.workspaceName,
    seatQuantity: normalizeSeatQuantity(source.seatQuantity),
  };
}

export function normalizeCheckoutExtractMode(value: unknown): CheckoutExtractMode {
  return value === 'server' ? 'server' : DEFAULT_CHECKOUT_EXTRACT_MODE;
}

export function normalizeCheckoutCreationPolicy(
  value: unknown,
  optionsInput: unknown = DEFAULT_CHECKOUT_OPTIONS,
): CheckoutCreationPolicy {
  const source = isRecord(value) ? value : {};
  const options = normalizeCheckoutOptions(optionsInput);
  const bootstrapCountry = normalizeRegion(source.bootstrapCountry || options.region);
  return {
    transport: source.transport === 'server' ? 'server' : 'browser-direct',
    pipeline: source.pipeline === 'staged' ? 'staged' : 'direct',
    requireZero: Boolean(source.requireZero),
    bootstrapCountry,
    promotionCountry: normalizeRegion(source.promotionCountry || bootstrapCountry),
    providerCountry: normalizeRegion(source.providerCountry || bootstrapCountry),
    requireVerifiedNetwork: Boolean(source.requireVerifiedNetwork),
    ...(String(source.previousSessionId || '').trim()
      ? { previousSessionId: String(source.previousSessionId).trim() }
      : {}),
  };
}

export async function createCheckoutLinkWithPolicy(
  raw: string,
  optionsInput: unknown,
  policyInput?: unknown,
): Promise<CheckoutLinkResponse> {
  const policy = normalizeCheckoutCreationPolicy(policyInput, optionsInput);
  let response: CheckoutLinkResponse;
  if (policy.transport === 'server') {
    response = await createCheckoutLinkFromServer(raw, optionsInput, policy);
  } else if (policy.pipeline === 'staged') {
    const options = normalizeCheckoutOptions(optionsInput);
    response = await runStagedCheckoutPipeline(raw, {
      planName: options.planName,
      uiMode: options.uiMode,
      bootstrapCountry: policy.bootstrapCountry,
      promotionCountry: policy.promotionCountry,
      providerCountry: policy.providerCountry,
      enablePromotionUpdate: true,
      enableProviderTaxes: true,
      requireZero: policy.requireZero,
    });
  } else {
    response = await createCheckoutLinkDirect(raw, optionsInput);
  }
  return enforceCheckoutCreationPolicy(response, policy);
}

export function enforceCheckoutCreationPolicy(
  response: CheckoutLinkResponse,
  policy: CheckoutCreationPolicy,
): CheckoutLinkResponse {
  if (!response.ok) return response;
  if (policy.previousSessionId && response.checkoutSessionId === policy.previousSessionId) {
    return fail('Checkout B 复用了 Checkout A session', {
      errorCode: 'CHECKOUT_NOT_DISTINCT',
      checkoutSessionId: response.checkoutSessionId,
    });
  }
  if (policy.requireZero && response.amountVerification !== 'verified-zero') {
    return fail('Checkout 未通过严格零金额门', {
      errorCode: 'CHECKOUT_NOT_ZERO',
      checkoutSessionId: response.checkoutSessionId,
      amountMinor: response.amountMinor,
      amountCurrency: response.amountCurrency,
      amountVerification: response.amountVerification,
    });
  }
  if (policy.requireVerifiedNetwork && response.networkEvidence?.verified !== true) {
    return fail('Checkout 缺少已验证的 server 网络证据', {
      errorCode: 'NETWORK_EVIDENCE_MISSING',
      checkoutSessionId: response.checkoutSessionId,
      requestId: response.requestId,
      requestedCountry: response.requestedCountry,
      networkEvidence: response.networkEvidence,
    });
  }
  return response;
}

export async function createCheckoutLink(
  raw: string,
  optionsInput: unknown,
): Promise<CheckoutLinkResponse> {
  return createCheckoutLinkDirect(raw, optionsInput);
}

export async function createCheckoutLinkDirect(
  raw: string,
  optionsInput: unknown,
  requestContext: { identitySnapshot?: CheckoutIdentitySnapshot; endpoints?: CheckoutPipelineEndpoints } = {},
): Promise<CheckoutLinkResponse> {
  let token: string;
  let checkoutOptions: CheckoutOptions;
  let payload: Record<string, unknown>;
  try {
    token = extractAccessToken(raw);
    checkoutOptions = normalizeCheckoutOptions(optionsInput);
    payload = buildCheckoutPayload(checkoutOptions);
  } catch (error) {
    return fail(errorMessage(error));
  }

  let response: Response;
  try {
    response = await fetchWithTimeout(requestContext.endpoints?.create || CHECKOUT_URL, {
      method: 'POST',
      headers: buildCheckoutHeaders(token, requestContext.identitySnapshot, {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Referer: 'https://chatgpt.com/',
        'x-openai-target-path': '/backend-api/payments/checkout',
        'x-openai-target-route': '/backend-api/payments/checkout',
      }),
      body: JSON.stringify(payload),
      credentials: 'include',
    });
  } catch (error) {
    return fail(`ChatGPT checkout 请求失败：${String(error)}`);
  }

  const text = await response.text();
  const data = parseJsonResponse(text);
  if (!response.ok) {
    const tokenAuthStatus = classifyTokenAuthFailure(response.status, text);
    return fail(`ChatGPT checkout HTTP ${response.status}：${extractResponseError(data, text)}`, {
      raw: data,
      httpStatus: response.status,
      cloudflareLikely: isCloudflareResponse(response.status, data, text),
      errorCode: extractErrorCode(data),
      tokenAuthStatus,
      credentialInvalid: tokenAuthStatus === 'invalid_jwt' || tokenAuthStatus === 'token_rejected',
    });
  }

  if (!isRecord(data)) {
    return fail('ChatGPT checkout 响应不是 JSON 对象');
  }

  const result = extractCheckoutResult(data, checkoutOptions);
  const link = selectOutputLink(result, checkoutOptions.uiMode);
  if (!link) {
    return fail(`未找到订阅链接，响应字段：${Object.keys(data).slice(0, 12).join(', ') || '空'}`);
  }
  const amountMeta = parseStructuredCheckoutAmount(data);
  const amountEvidence = checkoutAmountEvidence(data, 'create-response');

  return {
    ok: true,
    message: checkoutOptions.uiMode === 'hosted' ? '长链接生成成功' : '短链接生成成功',
    url: link,
    link,
    longUrl: result.providerUrl,
    shortUrl: result.canonicalUrl,
    providerUrl: result.providerUrl,
    canonicalUrl: result.canonicalUrl,
    uiMode: checkoutOptions.uiMode,
    raw: data,
    source: 'chatgpt_checkout',
    planName: checkoutOptions.planName,
    billingDetails: {
      country: result.billingDetails.country,
      currency: result.billingDetails.currency,
    },
    responseKeys: Object.keys(data).slice(0, 20),
    checkoutSessionId: result.checkoutSessionId,
    processorEntity: result.processorEntity,
    amountHint: amountMeta.amountHint,
    amountMinor: amountEvidence.amountMinor,
    amountCurrency: amountEvidence.currency || result.billingDetails.currency,
    amountSource: amountEvidence.source,
    amountPath: amountEvidence.path,
    amountVerification: amountEvidence.verification,
    zeroLikely: amountMeta.zeroLikely,
    promoLikely: amountMeta.promoLikely,
    trialLikely: amountMeta.trialLikely,
    stageTrace: [`bootstrap:${checkoutOptions.region}`],
  };
}

export async function createCheckoutLinkFromServer(
  raw: string,
  optionsInput: unknown = DEFAULT_CHECKOUT_OPTIONS,
  creationPolicyInput?: unknown,
): Promise<CheckoutLinkResponse> {
  let token: string;
  let checkoutOptions: CheckoutOptions;
  let billingDetails: { country: string; currency: string };
  try {
    token = extractAccessToken(raw);
    checkoutOptions = normalizeCheckoutOptions(optionsInput);
    billingDetails = billingDetailsForRegion(checkoutOptions.region);
  } catch (error) {
    return fail(errorMessage(error));
  }

  const creationPolicy = normalizeCheckoutCreationPolicy(creationPolicyInput, checkoutOptions);
  let response: Response;
  try {
    response = await fetchWithTimeout(SERVER_CHECKOUT_RAW_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        token,
        country: billingDetails.country,
        currency: billingDetails.currency,
        pipeline: creationPolicy.pipeline,
        requireZero: creationPolicy.requireZero,
        bootstrapCountry: creationPolicy.bootstrapCountry,
        promotionCountry: creationPolicy.promotionCountry,
        providerCountry: creationPolicy.providerCountry,
      }),
      cache: 'no-store',
    });
  } catch (error) {
    return fail(`服务器 API 请求失败：${String(error)}`);
  }

  const text = await response.text();
  const data = parseJsonResponse(text);
  if (!response.ok) {
    return fail(`服务器 API HTTP ${response.status}：${extractResponseError(data, text)}`);
  }

  if (!isRecord(data)) {
    return fail('服务器 API 响应不是 JSON 对象');
  }

  const result = extractCheckoutResult(data, checkoutOptions);
  const fallbackLink = selectOutputLink(result, checkoutOptions.uiMode);
  const link = selectServerOutputLink(data) || fallbackLink;
  if (!link) {
    return fail(`服务器 API 未返回订阅链接，响应字段：${Object.keys(data).slice(0, 12).join(', ') || '空'}`);
  }

  const networkEvidence = parseServerNetworkEvidence(data);
  const amountEvidence = checkoutAmountEvidence(data, 'create-response');
  return {
    ok: true,
    message: '服务器 API 生成成功',
    url: link,
    link,
    longUrl: stringValue(data.longUrl) || stringValue(data.long_url) || stringValue(data.providerUrl) || stringValue(data.provider_url) || result.providerUrl,
    shortUrl: stringValue(data.shortUrl) || stringValue(data.short_url) || stringValue(data.canonicalUrl) || stringValue(data.canonical_url) || result.canonicalUrl,
    providerUrl: stringValue(data.providerUrl) || stringValue(data.provider_url) || stringValue(data.stripe_hosted_url) || stringValue(data.checkout_url) || result.providerUrl,
    canonicalUrl: stringValue(data.canonicalUrl) || stringValue(data.canonical_url) || result.canonicalUrl,
    raw: data,
    source: 'checkout_server_api',
    planName: checkoutOptions.planName,
    billingDetails,
    responseKeys: Object.keys(data).slice(0, 20),
    checkoutSessionId: result.checkoutSessionId,
    processorEntity: result.processorEntity,
    amountMinor: amountEvidence.amountMinor,
    amountCurrency: amountEvidence.currency || billingDetails.currency,
    amountSource: amountEvidence.source,
    amountPath: amountEvidence.path,
    amountVerification: amountEvidence.verification,
    requestId: stringValue(data.requestId) || stringValue(data.request_id),
    requestedCountry: billingDetails.country,
    ...(networkEvidence ? { networkEvidence } : {}),
  };
}

export function parseServerNetworkEvidence(data: unknown): CheckoutNetworkEvidence | undefined {
  if (!isRecord(data)) return undefined;
  const source = [data.networkEvidence, data.network_evidence, data.trace, data.network]
    .find((value) => isRecord(value));
  if (!isRecord(source)) return undefined;
  const ip = stringValue(source.ip);
  const country = stringValue(source.country).toUpperCase();
  if (!ip || !country) return undefined;
  return {
    plane: 'server-checkout',
    requestId: stringValue(source.requestId) || stringValue(source.request_id) ||
      stringValue(data.requestId) || stringValue(data.request_id),
    ip,
    country,
    colo: stringValue(source.colo),
    asn: stringValue(source.asn),
    verified: source.verified === true,
    capturedAt: Number(source.capturedAt || source.captured_at || Date.now()),
  };
}

function buildCheckoutPayload(options: CheckoutOptions): Record<string, unknown> {
  const isPlus = options.planName === 'chatgptplusplan';
  const billingDetails = billingDetailsForRegion(options.region);

  const payload: Record<string, unknown> = {
    entry_point: isPlus ? 'all_plans_pricing_modal' : 'team_workspace_purchase_modal',
    plan_name: options.planName,
    billing_details: billingDetails,
    cancel_url: 'https://chatgpt.com/#pricing',
    checkout_ui_mode: options.uiMode,
    promo_campaign: {
      promo_campaign_id: isPlus ? 'plus-1-month-free' : 'team-1-month-free',
      is_coupon_from_query_param: false,
    },
  };
  if (!isPlus) {
    payload.team_plan_data = {
      workspace_name: options.workspaceName,
      price_interval: 'month',
      seat_quantity: options.seatQuantity,
    };
  }
  return payload;
}

function normalizePlanName(value: unknown): CheckoutPlanName {
  return value === 'chatgptplusplan' || value === 'chatgptteamplan'
    ? value
    : DEFAULT_CHECKOUT_OPTIONS.planName;
}

function normalizeUiMode(value: unknown): CheckoutUiMode {
  return value === 'custom' || value === 'hosted'
    ? value
    : DEFAULT_CHECKOUT_OPTIONS.uiMode;
}

function normalizeRegion(value: unknown): CheckoutRegion {
  const region = String(value || DEFAULT_CHECKOUT_OPTIONS.region).trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(region)) {
    return DEFAULT_CHECKOUT_OPTIONS.region;
  }
  return region;
}

function normalizeSeatQuantity(value: unknown): number {
  const quantity = Number(value || DEFAULT_CHECKOUT_OPTIONS.seatQuantity);
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error('team_plan_data.seat_quantity 必须是大于 0 的整数');
  }
  return quantity;
}

function billingDetailsForRegion(region: CheckoutRegion): { country: string; currency: string } {
  return billingDetailsForCountry(region);
}

function extractFromJson(text: string): string {
  try {
    return findAccessToken(JSON.parse(text));
  } catch {
    return '';
  }
}

function findAccessToken(value: unknown, depth = 0): string {
  if (!isRecord(value) || depth > 4) {
    return '';
  }
  if (typeof value.accessToken === 'string') {
    return value.accessToken.trim();
  }
  for (const item of Object.values(value)) {
    const found = findAccessToken(item, depth + 1);
    if (found) {
      return found;
    }
  }
  return '';
}

function extractFromAccessTokenField(text: string): string {
  const quoted = ACCESS_TOKEN_RE.exec(text);
  if (quoted?.[1]) {
    return quoted[1].trim();
  }

  const loose = ACCESS_TOKEN_LOOSE_RE.exec(text);
  if (!loose?.[1]) {
    return '';
  }
  const value = loose[1].trim().replace(/[",}\]\s]+$/, '');
  const jwt = JWT_RE.exec(value);
  return jwt?.[0]?.trim() || value;
}

function extractFirstJwt(text: string): string {
  return JWT_RE.exec(text)?.[0]?.trim() || '';
}

function parseJsonResponse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function findProviderUrl(data: Record<string, unknown>): string {
  for (const key of ['url', 'stripe_hosted_url', 'checkout_url']) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function extractCheckoutResult(
  data: Record<string, unknown>,
  options: CheckoutOptions,
): {
  providerUrl: string;
  canonicalUrl: string;
  billingDetails: { country: string; currency: string };
  checkoutSessionId: string;
  processorEntity: string;
} {
  const providerUrl = findProviderUrl(data);
  const billingDetails = billingDetailsForRegion(options.region);
  const sessionId = findCheckoutSession(data, providerUrl);
  const processorEntity = findProcessorEntity(data, providerUrl, billingDetails.country);
  const canonicalUrl = sessionId && processorEntity
    ? `https://chatgpt.com/checkout/${processorEntity}/${sessionId}`
    : '';

  return {
    providerUrl,
    canonicalUrl,
    billingDetails,
    checkoutSessionId: sessionId,
    processorEntity,
  };
}

function selectOutputLink(
  result: { providerUrl: string; canonicalUrl: string },
  uiMode: CheckoutUiMode,
): string {
  if (uiMode === 'hosted') {
    return result.providerUrl || result.canonicalUrl;
  }
  return result.canonicalUrl || result.providerUrl;
}

function selectServerOutputLink(data: Record<string, unknown>): string {
  for (const key of [
    'link',
    'url',
    'checkout_url',
    'stripe_hosted_url',
    'providerUrl',
    'provider_url',
    'longUrl',
    'long_url',
    'shortUrl',
    'short_url',
    'canonicalUrl',
    'canonical_url',
  ]) {
    const value = stringValue(data[key]);
    if (value) {
      return value;
    }
  }

  const nested = data.data;
  if (isRecord(nested)) {
    return selectServerOutputLink(nested);
  }
  return '';
}

function findCheckoutSession(data: Record<string, unknown>, providerUrl: string): string {
  const direct = stringValue(data.checkout_session_id) || stringValue(data.session_id);
  if (direct) {
    return direct;
  }
  return extractCheckoutSession([
    providerUrl,
    stringValue(data.success_url),
    stringValue(data.cancel_url),
    stringValue(data.return_url),
    stringValue(data.client_secret),
  ].join(' '));
}

function findProcessorEntity(
  data: Record<string, unknown>,
  providerUrl: string,
  billingCountry: string,
): string {
  const direct = stringValue(data.processor_entity);
  if (direct) {
    return direct;
  }
  const text = [
    providerUrl,
    stringValue(data.success_url),
    stringValue(data.cancel_url),
    stringValue(data.return_url),
  ].join(' ');
  const match = PROCESSOR_ENTITY_RE.exec(text);
  if (match?.[1]) {
    return match[1];
  }
  return billingCountry === 'US' ? 'openai_llc' : 'openai_ie';
}

function extractCheckoutSession(value: string): string {
  const raw = String(value || '');
  const match = CHECKOUT_SESSION_RE.exec(raw);
  if (match?.[1]) {
    return match[1];
  }
  try {
    return CHECKOUT_SESSION_RE.exec(decodeURIComponent(raw))?.[1] || '';
  } catch {
    return '';
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function extractResponseError(data: unknown, text: string): string {
  let message = '';
  if (isRecord(data)) {
    if (typeof data.detail === 'string') {
      message = shorten(data.detail);
    }
    if (typeof data.error === 'string') {
      message = shorten(data.error);
    }
    if (isRecord(data.error)) {
      if (typeof data.error.detail === 'string') {
        message = shorten(data.error.detail);
      }
      if (typeof data.error.message === 'string') {
        message = shorten(data.error.message);
      }
    }
  }
  if (!message) {
    message = shorten(text || '请求失败');
  }
  return normalizeCheckoutError(message);
}

function normalizeCheckoutError(message: string): string {
  if (/user is already paid/i.test(message)) {
    return '此账号没有试用资格';
  }
  return explainStripeCurrencyError(message);
}

function explainStripeCurrencyError(message: string): string {
  if (!/cannot combine currencies on a single customer/i.test(message)) {
    return message;
  }

  return [
    'Stripe 限制：同一 customer 不能混用不同币种。',
    '这个账号当前已有 USD 订阅/会话，切到日本会请求 JPY，因此被 Stripe 拒绝。',
    '请改用没有现有订阅的账号，或者切回美国区域后再生成。',
  ].join(' ');
}

function fail(message: string, details: Partial<CheckoutLinkResponse> = {}): CheckoutLinkResponse {
  return { ok: false, message, ...details };
}

export function cookieHeaderFromSnapshot(identity: CheckoutIdentitySnapshot | undefined): string {
  if (!identity?.cookies?.length) return '';
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const cookie of identity.cookies) {
    const name = String(cookie.name || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    parts.push(`${name}=${String(cookie.value ?? '')}`);
  }
  return parts.join('; ');
}

/**
 * 细分 401/403 凭据失败原因：
 * - invalid_jwt：JWT 签名无效/已过期（api.openai.com 错误码）
 * - token_rejected：会话上下文拒绝 Bearer（chatgpt.com unauthorized_unknown / Could not parse）
 * - cloudflare：CF 挑战/拦截页面（网络层，非 token 失效，不应标记账号过期）
 * - unknown：其他
 */
export function classifyTokenAuthFailure(status: number, bodyText: string): 'invalid_jwt' | 'token_rejected' | 'cloudflare' | 'unknown' {
  const text = String(bodyText || '');
  if (status !== 401 && status !== 403 && status !== 429 && status !== 502 && status !== 503) return 'unknown';
  if (isCloudflareResponse(status, text, text)) return 'cloudflare';
  if (/invalid_jwt/i.test(text)) return 'invalid_jwt';
  if (/Could not parse your authentication token|unauthorized_unknown|"detail"\s*:\s*"Unauthorized"/i.test(text)) return 'token_rejected';
  return status === 401 ? 'token_rejected' : 'unknown';
}

function buildCheckoutHeaders(
  token: string,
  identity: CheckoutIdentitySnapshot | undefined,
  extras: Record<string, string> = {},
): Record<string, string> {
  const cookie = cookieHeaderFromSnapshot(identity);
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(identity?.deviceId ? { 'oai-device-id': identity.deviceId } : {}),
    ...(identity?.sessionId ? { 'oai-session-id': identity.sessionId } : {}),
    ...(cookie ? { Cookie: cookie } : {}),
    ...extras,
  };
}

function extractErrorCode(value: unknown): string {
  if (!isRecord(value)) return '';
  for (const key of ['code', 'type', 'reason']) {
    if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
  }
  for (const key of ['error', 'detail', 'data']) {
    const nested = extractErrorCode(value[key]);
    if (nested) return nested;
  }
  return '';
}

function isCloudflareResponse(status: number, data: unknown, text: string): boolean {
  if (![401, 403, 429, 502, 503].includes(status)) return false;
  return /cloudflare|cf-ray|challenge|just a moment|attention required|captcha/i.test(`${safeJsonText(data)} ${text}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shorten(text: string, limit = 600): string {
  return String(text || '').replace(/\s+/g, ' ').slice(0, limit);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object');
}

export async function updateCheckoutPromotion(
  token: string,
  input: {
    checkoutSessionId: string;
    processorEntity: string;
    planName?: CheckoutPlanName;
    bootstrapCountry: string;
    promotionCountry: string;
    referer?: string;
    identitySnapshot?: CheckoutIdentitySnapshot;
    endpoint?: string;
  },
): Promise<{ ok: boolean; message: string; raw?: unknown; httpStatus?: number; cloudflareLikely?: boolean; invalidPromotion?: boolean; tokenAuthStatus?: 'invalid_jwt' | 'token_rejected' | 'cloudflare' | 'unknown'; credentialInvalid?: boolean }> {
  const promoId = input.planName === 'chatgptteamplan' ? 'team-1-month-free' : 'plus-1-month-free';
  const body = {
    checkout_session_id: input.checkoutSessionId,
    processor_entity: input.processorEntity || processorEntityForCountry(input.bootstrapCountry),
    plan_name: input.planName || 'chatgptplusplan',
    price_interval: 'month',
    seat_quantity: 1,
    promo_campaign: {
      promo_campaign_id: promoId,
      is_coupon_from_query_param: false,
    },
  };
  const referer = input.referer
    || (input.checkoutSessionId
      ? `https://chatgpt.com/checkout/${body.processor_entity}/${input.checkoutSessionId}`
      : 'https://chatgpt.com/');
  try {
    const response = await fetchWithTimeout(input.endpoint || CHECKOUT_UPDATE_URL, {
      method: 'POST',
      headers: buildCheckoutHeaders(token, input.identitySnapshot, {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Referer: referer,
        'x-openai-target-path': '/backend-api/payments/checkout/update',
        'x-openai-target-route': '/backend-api/payments/checkout/update',
      }),
      body: JSON.stringify(body),
      credentials: 'include',
    });
    const text = await response.text();
    const data = parseJsonResponse(text);
    if (!response.ok) {
      const tokenAuthStatus = classifyTokenAuthFailure(response.status, text);
      return {
        ok: false,
        message: `checkout/update HTTP ${response.status}：${extractResponseError(data, text)}`,
        raw: data,
        httpStatus: response.status,
        cloudflareLikely: isCloudflareResponse(response.status, data, text),
        invalidPromotion: payloadHasInvalidPromotion(data) || payloadHasInvalidPromotion(text),
        tokenAuthStatus,
        credentialInvalid: tokenAuthStatus === 'invalid_jwt' || tokenAuthStatus === 'token_rejected',
      };
    }
    if (payloadHasInvalidPromotion(data)) {
      return { ok: false, message: 'checkout/update returned invalid_promotion', raw: data, invalidPromotion: true };
    }
    if (isRecord(data) && data.success === false) {
      return { ok: false, message: `checkout/update rejected：${extractResponseError(data, text)}`, raw: data };
    }
    return { ok: true, message: `promotion(${input.promotionCountry}) checkout/update 成功`, raw: data };
  } catch (error) {
    return { ok: false, message: `checkout/update 请求失败：${String(error)}` };
  }
}

export async function updateCheckoutTaxes(
  token: string,
  input: {
    checkoutSessionId: string;
    processorEntity: string;
    bootstrapCountry: string;
    providerCountry: string;
    email?: string;
    name?: string;
    referer?: string;
    identitySnapshot?: CheckoutIdentitySnapshot;
    endpoint?: string;
  },
): Promise<{ ok: boolean; message: string; raw?: unknown; tokenAuthStatus?: 'invalid_jwt' | 'token_rejected' | 'cloudflare' | 'unknown'; credentialInvalid?: boolean }> {
  const billing = billingDetailsForCountry(input.providerCountry);
  const body = {
    checkout_session_id: input.checkoutSessionId,
    checkout_email: input.email || 'redacted@example.invalid',
    billing_country: input.providerCountry,
    billing_name: input.name || 'Checkout User',
    currency: billing.currency,
    tax_id: null,
    processor_entity: input.processorEntity || processorEntityForCountry(input.bootstrapCountry),
    billing_address: {
      line1: '1 Example Street',
      city: 'Example City',
      country: input.providerCountry,
      postal_code: '00000',
      state: '',
    },
  };
  const referer = input.referer
    || (input.checkoutSessionId
      ? `https://chatgpt.com/checkout/${body.processor_entity}/${input.checkoutSessionId}`
      : 'https://chatgpt.com/');
  try {
    const response = await fetchWithTimeout(input.endpoint || CHECKOUT_TAXES_URL, {
      method: 'POST',
      headers: buildCheckoutHeaders(token, input.identitySnapshot, {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Referer: referer,
        'x-openai-target-path': '/backend-api/payments/checkout/taxes',
        'x-openai-target-route': '/backend-api/payments/checkout/taxes',
      }),
      body: JSON.stringify(body),
      credentials: 'include',
    });
    const text = await response.text();
    const data = parseJsonResponse(text);
    if (!response.ok) {
      const tokenAuthStatus = classifyTokenAuthFailure(response.status, text);
      return {
        ok: false,
        message: `checkout/taxes HTTP ${response.status}：${extractResponseError(data, text)}`,
        raw: data,
        tokenAuthStatus,
        credentialInvalid: tokenAuthStatus === 'invalid_jwt' || tokenAuthStatus === 'token_rejected',
      };
    }
    return { ok: true, message: `provider(${input.providerCountry}) checkout/taxes 成功`, raw: data };
  } catch (error) {
    return { ok: false, message: `checkout/taxes 请求失败：${String(error)}` };
  }
}

/**
 * UPL-aligned P0 pipeline:
 * bootstrap create(country A) -> promotion update(country B) -> provider taxes(country C)
 * Final link still comes from create/hosted extraction; stages enrich promo/zero confidence.
 */
export async function runStagedCheckoutPipeline(
  raw: string,
  optionsInput: CheckoutStagePipelineOptions,
): Promise<CheckoutLinkResponse> {
  const token = extractAccessToken(raw);
  const bootstrapCountry = normalizeRegion(optionsInput.bootstrapCountry);
  const promotionCountry = normalizeRegion(optionsInput.promotionCountry || 'VN');
  const providerCountry = normalizeRegion(optionsInput.providerCountry || bootstrapCountry);
  const enablePromotionUpdate = optionsInput.enablePromotionUpdate !== false;
  const enableProviderTaxes = Boolean(optionsInput.enableProviderTaxes);
  const requireZero = Boolean(optionsInput.requireZero);
  const stageTrace: string[] = [];
  const metrics = emptyRetryMetrics();
  const checkoutAttempts = clampAttempts(optionsInput.checkoutAttempts, 3);
  const updateAttempts = clampAttempts(optionsInput.updateAttempts, 3);
  const fullFlowAttempts = clampAttempts(optionsInput.fullFlowAttempts, 2);
  const cfSameIdentityAttempts = clampAttempts(optionsInput.cfSameIdentityAttempts, 2);
  let lastCreated: CheckoutLinkResponse | null = null;

  for (let fullAttempt = 1; fullAttempt <= fullFlowAttempts; fullAttempt += 1) {
    metrics.fullFlowAttempts = fullAttempt;
    stageTrace.push(`full-flow:${fullAttempt}:start`);
    let created: CheckoutLinkResponse | null = null;
    let consecutiveCf = 0;
    for (let checkoutAttempt = 1; checkoutAttempt <= checkoutAttempts; checkoutAttempt += 1) {
      metrics.checkoutAttempts += 1;
      if (optionsInput.onBeforeStage) await optionsInput.onBeforeStage('bootstrap', bootstrapCountry);
      created = await createCheckoutLinkDirect(token, {
        planName: optionsInput.planName || 'chatgptplusplan',
        uiMode: optionsInput.uiMode || 'hosted',
        region: bootstrapCountry,
      }, {
        identitySnapshot: optionsInput.identitySnapshot,
        endpoints: optionsInput.endpoints,
      });
      stageTrace.push(`bootstrap:${bootstrapCountry}:attempt-${checkoutAttempt}:${created.ok ? 'ok' : 'fail'}`);
      if (created.ok) break;
      lastCreated = created;
      if (!isRetryableCheckoutFailure(created) || checkoutAttempt >= checkoutAttempts) {
        return { ...created, stageTrace, retryMetrics: metrics };
      }
      consecutiveCf = created.cloudflareLikely ? consecutiveCf + 1 : 0;
      const rotateExit = registerRetryMetrics(metrics, created.cloudflareLikely, consecutiveCf, cfSameIdentityAttempts);
      await optionsInput.onRetry?.({
        stage: created.cloudflareLikely ? 'cloudflare' : 'checkout',
        country: bootstrapCountry,
        attempt: checkoutAttempt + 1,
        reason: created.message,
        rotateExit,
      });
    }
    if (!created?.ok) return { ...(created || fail('checkout 重试耗尽')), stageTrace, retryMetrics: metrics };
    lastCreated = created;

    const checkoutSessionId = created.checkoutSessionId || '';
    const processorEntity = created.processorEntity || processorEntityForCountry(bootstrapCountry);
    let rebuildFullFlow = false;
    if (enablePromotionUpdate && checkoutSessionId) {
      consecutiveCf = 0;
      for (let updateAttempt = 1; updateAttempt <= updateAttempts; updateAttempt += 1) {
        metrics.updateAttempts += 1;
        if (optionsInput.onBeforeStage) await optionsInput.onBeforeStage('promotion', promotionCountry);
        const updated = await updateCheckoutPromotion(token, {
          checkoutSessionId,
          processorEntity,
          planName: optionsInput.planName || 'chatgptplusplan',
          bootstrapCountry,
          promotionCountry,
          referer: created.canonicalUrl || created.link,
          identitySnapshot: optionsInput.identitySnapshot,
          endpoint: optionsInput.endpoints?.update,
        });
        stageTrace.push(`promotion:${promotionCountry}:attempt-${updateAttempt}:${updated.ok ? 'ok' : updated.invalidPromotion ? 'invalid-promotion' : 'fail'}`);
        if (updated.invalidPromotion) {
          metrics.invalidPromotionRebuilds += 1;
          rebuildFullFlow = true;
          created.message = `${created.message} · invalid_promotion，丢弃 checkout ${checkoutSessionId}`;
          break;
        }
        if (updated.ok) {
          mergeAmountMeta(created, updated.raw, 'update-response');
          created.message = `${created.message} · ${updated.message}`;
          break;
        }
        created.message = `${created.message} · ${updated.message}`;
        if (!isRetryableMutationFailure(updated) || updateAttempt >= updateAttempts) break;
        consecutiveCf = updated.cloudflareLikely ? consecutiveCf + 1 : 0;
        const rotateExit = registerRetryMetrics(metrics, updated.cloudflareLikely, consecutiveCf, cfSameIdentityAttempts);
        await optionsInput.onRetry?.({
          stage: updated.cloudflareLikely ? 'cloudflare' : 'update',
          country: promotionCountry,
          attempt: updateAttempt + 1,
          reason: updated.message,
          rotateExit,
        });
      }
    } else if (enablePromotionUpdate) {
      stageTrace.push(`promotion:${promotionCountry}:skip:no-session`);
    }

    if (rebuildFullFlow) {
      stageTrace.push(`full-flow:${fullAttempt}:discard:${checkoutSessionId || 'unknown'}`);
      if (fullAttempt >= fullFlowAttempts) {
        return { ...created, ok: false, message: `${created.message} · 完整流程重建次数耗尽`, stageTrace, retryMetrics: metrics };
      }
      await optionsInput.onRetry?.({
        stage: 'full-flow',
        country: bootstrapCountry,
        attempt: fullAttempt + 1,
        reason: 'invalid_promotion',
        rotateExit: true,
      });
      continue;
    }

    if (enableProviderTaxes && checkoutSessionId) {
      if (optionsInput.onBeforeStage) await optionsInput.onBeforeStage('provider', providerCountry);
      const taxed = await updateCheckoutTaxes(token, {
        checkoutSessionId,
        processorEntity,
        bootstrapCountry,
        providerCountry,
        referer: created.canonicalUrl || created.link,
        identitySnapshot: optionsInput.identitySnapshot,
        endpoint: optionsInput.endpoints?.taxes,
      });
      stageTrace.push(`provider:${providerCountry}:${taxed.ok ? 'ok' : 'fail'}`);
      if (taxed.ok) mergeAmountMeta(created, taxed.raw, 'tax-response');
      created.message = `${created.message} · ${taxed.message}`;
    }

    if (created.amountMinor === null || created.amountMinor === undefined) {
      metrics.pageFallbackAttempts += 1;
      const pageEvidence = await fetchCheckoutPageAmount(created, optionsInput.identitySnapshot, optionsInput.endpoints?.page);
      stageTrace.push(`amount-page:${pageEvidence.ok ? 'ok' : 'fail'}:${pageEvidence.message}`);
      if (pageEvidence.ok) mergeAmountMeta(created, pageEvidence.state, 'checkout-page');
    }

    if (requireZero && created.amountMinor !== 0) {
      return {
        ...created,
        ok: false,
        message: `requireZero 未通过：amount=${created.amountHint || 'unknown'} · ${created.message}`,
        stageTrace,
        retryMetrics: metrics,
      };
    }

    return {
      ...created,
      stageTrace,
      retryMetrics: metrics,
      message: `三阶段完成(${bootstrapCountry}/${promotionCountry}/${providerCountry}) · ${created.message}`,
    };
  }
  return { ...(lastCreated || fail('完整 checkout 流程未返回结果')), ok: false, stageTrace, retryMetrics: metrics };
}

function processorEntityForCountry(country: string): string {
  return String(country || '').toUpperCase() === 'US' ? 'openai_llc' : 'openai_ie';
}

function emptyRetryMetrics(): CheckoutRetryMetrics {
  return { checkoutAttempts: 0, updateAttempts: 0, fullFlowAttempts: 0, cfRetryCount: 0, cfExitRotations: 0, invalidPromotionRebuilds: 0, pageFallbackAttempts: 0 };
}

function clampAttempts(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(1, Math.min(10, parsed)) : fallback;
}

function registerRetryMetrics(metrics: CheckoutRetryMetrics, cloudflare: boolean | undefined, consecutiveCf: number, threshold: number): boolean {
  if (!cloudflare) return true;
  metrics.cfRetryCount += 1;
  const rotate = consecutiveCf >= threshold;
  if (rotate) metrics.cfExitRotations += 1;
  return rotate;
}

function isRetryableCheckoutFailure(response: CheckoutLinkResponse): boolean {
  if (response.cloudflareLikely) return true;
  if (response.httpStatus && [408, 425, 429, 500, 502, 503, 504].includes(response.httpStatus)) return true;
  return /network|failed to fetch|timeout|timed out|temporar|连接|请求失败/i.test(response.message || '');
}

function isRetryableMutationFailure(response: { httpStatus?: number; cloudflareLikely?: boolean; message: string }): boolean {
  if (response.cloudflareLikely) return true;
  if (response.httpStatus && [408, 425, 429, 500, 502, 503, 504].includes(response.httpStatus)) return true;
  return /network|failed to fetch|timeout|timed out|temporar|连接|请求失败/i.test(response.message || '');
}

function mergeAmountMeta(response: CheckoutLinkResponse, value: unknown, source: NonNullable<CheckoutLinkResponse['amountSource']>): void {
  const meta = parseStructuredCheckoutAmount(value);
  response.promoLikely = Boolean(response.promoLikely || meta.promoLikely);
  response.trialLikely = Boolean(response.trialLikely || meta.trialLikely);
  if (meta.amountMinor === null) return;
  response.amountMinor = meta.amountMinor;
  response.amountHint = meta.amountHint;
  response.amountCurrency = meta.currency || response.amountCurrency || response.billingDetails?.currency || '';
  response.amountSource = source;
  response.amountPath = meta.path;
  response.amountVerification = meta.amountMinor === 0 ? 'verified-zero' : 'verified-nonzero';
  response.zeroLikely = meta.amountMinor === 0;
}

async function fetchCheckoutPageAmount(
  created: CheckoutLinkResponse,
  identity: CheckoutIdentitySnapshot | undefined,
  endpoint?: string,
): Promise<{ ok: boolean; message: string; state?: Record<string, unknown> }> {
  const url = endpoint || created.canonicalUrl || created.shortUrl || created.link || created.url || '';
  if (!url) return { ok: false, message: 'no-url' };
  try {
    const response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: buildCheckoutHeaders('', identity, { Accept: 'text/html,application/xhtml+xml', Referer: 'https://chatgpt.com/' }),
      credentials: 'include',
    });
    const html = await response.text();
    if (!response.ok) return { ok: false, message: `HTTP-${response.status}` };
    const state = checkoutStateFromHtml(html);
    return Object.keys(state).length ? { ok: true, message: 'react-router', state } : { ok: false, message: 'state-not-found' };
  } catch (error) {
    return { ok: false, message: shorten(errorMessage(error), 120) };
  }
}

function safeJsonText(value: unknown): string {
  try {
    return JSON.stringify(value || {});
  } catch {
    return '';
  }
}
