export type CheckoutPlanName = 'chatgptteamplan' | 'chatgptplusplan';

export type CheckoutUiMode = 'custom' | 'hosted';

export type ProbeCheckoutUiMode = CheckoutUiMode | 'both';

export type CheckoutRegion = string;

export type CheckoutExtractMode = 'local' | 'server';

export interface CheckoutCreationPolicy {
  transport: 'browser-direct' | 'server';
  pipeline: 'direct' | 'staged';
  requireZero: boolean;
  bootstrapCountry: string;
  promotionCountry: string;
  providerCountry: string;
  requireVerifiedNetwork: boolean;
  previousSessionId?: string;
}

export interface CheckoutNetworkEvidence {
  plane: 'server-checkout';
  requestId: string;
  ip: string;
  country: string;
  colo: string;
  asn: string;
  verified: boolean;
  capturedAt: number;
}

export interface CheckoutOptions {
  planName: CheckoutPlanName;
  uiMode: CheckoutUiMode;
  region: CheckoutRegion;
  workspaceName: string;
  seatQuantity: number;
}

export interface LinkExtractorState {
  checkoutOptions: CheckoutOptions;
  checkoutExtractMode: CheckoutExtractMode;
  updatedAt: number;
}

export interface CheckoutLinkMessage {
  type: 'opx:create-checkout-link';
  raw: string;
  options: Partial<CheckoutOptions>;
  extractMode?: CheckoutExtractMode;
  creationPolicy?: Partial<CheckoutCreationPolicy>;
}

export interface CheckoutLinkResponse {
  ok: boolean;
  message: string;
  url?: string;
  link?: string;
  longUrl?: string;
  shortUrl?: string;
  providerUrl?: string;
  canonicalUrl?: string;
  uiMode?: CheckoutUiMode;
  raw?: unknown;
  source?: string;
  httpStatus?: number;
  errorCode?: string;
  cloudflareLikely?: boolean;
  /** 401 token 失效细分：invalid_jwt=JWT 签名/过期；token_rejected=会话上下文拒绝；cloudflare=CF 拦截；unknown=其他 */
  tokenAuthStatus?: 'invalid_jwt' | 'token_rejected' | 'cloudflare' | 'unknown';
  /** 服务端明确拒绝凭据（token 失效），应停止该账号后续探测 */
  credentialInvalid?: boolean;
  planName?: CheckoutPlanName;
  billingDetails?: {
    country: string;
    currency: string;
  };
  responseKeys?: string[];
  checkoutSessionId?: string;
  processorEntity?: string;
  amountHint?: string;
  amountMinor?: number | null;
  amountCurrency?: string;
  amountSource?: CheckoutAmountEvidence['source'];
  amountPath?: string;
  amountVerification?: CheckoutAmountEvidence['verification'];
  zeroLikely?: boolean;
  promoLikely?: boolean;
  trialLikely?: boolean;
  stageTrace?: string[];
  retryMetrics?: CheckoutRetryMetrics;
  checkoutVariants?: CheckoutVariantResult[];
  requestId?: string;
  requestedCountry?: string;
  networkEvidence?: CheckoutNetworkEvidence;
}

export type CheckoutPipelineStage = 'bootstrap' | 'promotion' | 'provider';

export interface CheckoutPipelineEndpoints {
  create?: string;
  update?: string;
  taxes?: string;
  page?: string;
}

export interface CheckoutRetryEvent {
  stage: 'checkout' | 'update' | 'full-flow' | 'cloudflare';
  country: string;
  attempt: number;
  reason: string;
  rotateExit: boolean;
}

export interface CheckoutStagePipelineOptions {
  planName?: CheckoutPlanName;
  uiMode?: CheckoutUiMode;
  bootstrapCountry: string;
  promotionCountry: string;
  providerCountry: string;
  enablePromotionUpdate?: boolean;
  enableProviderTaxes?: boolean;
  requireZero?: boolean;
  identitySnapshot?: CheckoutIdentitySnapshot;
  checkoutAttempts?: number;
  updateAttempts?: number;
  fullFlowAttempts?: number;
  cfSameIdentityAttempts?: number;
  endpoints?: CheckoutPipelineEndpoints;
  /** Optional hooks so caller can switch proxy between stages. */
  onBeforeStage?: (stage: CheckoutPipelineStage, country: string) => Promise<void> | void;
  onRetry?: (event: CheckoutRetryEvent) => Promise<void> | void;
}

export interface ChatGptSessionMessage {
  type: 'opx:fetch-chatgpt-session';
  tabId?: number;
}

export interface CheckoutCookieSnapshot {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string;
  expirationDate?: number;
  storeId?: string;
  firstPartyDomain?: string;
}

export interface CheckoutIdentitySnapshot {
  deviceId: string;
  sessionId: string;
  cookies: CheckoutCookieSnapshot[];
  capturedAt: number;
}

export interface CheckoutRetryMetrics {
  checkoutAttempts: number;
  updateAttempts: number;
  fullFlowAttempts: number;
  cfRetryCount: number;
  cfExitRotations: number;
  invalidPromotionRebuilds: number;
  pageFallbackAttempts: number;
}

export interface CheckoutAmountEvidence {
  amountMinor: number | null;
  amountHint: string;
  currency: string;
  source: 'create-response' | 'update-response' | 'tax-response' | 'checkout-page' | 'unknown';
  path: string;
  verification: 'verified-zero' | 'verified-nonzero' | 'pending';
}

export interface CheckoutVariantResult {
  uiMode: CheckoutUiMode;
  ok: boolean;
  message: string;
  link: string;
  longUrl: string;
  shortUrl: string;
  checkoutSessionId: string;
  processorEntity: string;
  amount: CheckoutAmountEvidence;
  retryMetrics: CheckoutRetryMetrics;
}

export interface ChatGptSessionInfo {
  email: string;
  planType: string;
  accessToken: string;
  sessionToken: string;
  accountId: string;
  userId: string;
  expiresAt: string;
  fetchedAt: number;
  identitySnapshot?: CheckoutIdentitySnapshot;
}

export interface ChatGptSessionResponse {
  ok: boolean;
  message: string;
  session?: ChatGptSessionInfo;
}
