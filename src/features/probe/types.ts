export type ProbePlanName = 'chatgptplusplan' | 'chatgptteamplan';
export type ProbeAccountSource = 'manual' | 'automation' | 'session';
export type ProbeCredentialStatus = 'healthy' | 'expiring' | 'expired' | 'unknown';
export type ProbeServerCredentialStatus = 'unchecked' | 'valid' | 'invalid' | 'unknown';
export type ProbeLinkVerificationLevel = 'candidate' | 'page' | 'strict-response' | 'strict-page' | 'provider-final' | 'entitlement-verified';
export type ProbeTaskStatus = 'idle' | 'running' | 'paused' | 'stopped' | 'completed' | 'error';
export type ProbeTaskUnitStatus = 'planned' | 'running' | 'hit' | 'miss' | 'error' | 'skipped';
export type ProbeHitKind = 'link' | 'promo' | 'trial' | 'zero' | 'channel' | 'none' | 'error';
export type ProbeNotifyMode = 'sound-badge' | 'sound-badge-pin' | 'silent';
export type ProbeExitProxyMode = 'follow-country' | 'fixed-exit2' | 'fixed-front' | 'none';
export type ProbeEntryProxyMode = 'front' | 'exit1' | 'none';
export type ProbeExperimentMode = 'discovery' | 'attribution' | 'hybrid';
export type ProbeExperimentArm = 'exploit' | 'balanced' | 'explore';
export type ProbeExperimentFactor = 'account' | 'country' | 'route' | 'paymentMethod' | 'seed' | 'time' | 'sequence';
export type ProbePaymentCheckoutSessionMode = 'independent_checkout' | 'reuse_eligibility_session';
export type ProbeQualificationType =
  | 'candidate'
  | 'zero_amount'
  | 'free_trial'
  | 'promo_zero'
  | 'intro_discount_zero'
  | 'deferred_payment'
  | 'nonzero'
  | 'unknown';
export type ProbeQualificationEvidenceSource =
  | 'create-response'
  | 'update-response'
  | 'tax-response'
  | 'checkout-page'
  | 'provider-final'
  | 'entitlement';
export type ProbeQualificationDriftKind = 'amount' | 'currency' | 'identity' | 'payment-method' | 'qualification';
export type ProbePaymentLinkAggregateStatus = 'qualified_payment_link' | 'probe_required';

export interface ProbeQualificationEvidence {
  id: string;
  type: ProbeQualificationType;
  level: ProbeLinkVerificationLevel;
  source: ProbeQualificationEvidenceSource;
  amountMinor: number | null;
  recurringAmountMinor: number | null;
  currency: string;
  sessionId: string;
  identityKey: string;
  method: string;
  methods: string[];
  qualified: boolean;
  observedAt: number;
  redactedPayloadHash: string;
}

export interface ProbeQualificationDriftEvent {
  id: string;
  kind: ProbeQualificationDriftKind;
  before: string;
  after: string;
  sessionId: string;
  detectedAt: number;
  stopRequired: boolean;
}
export type ProbePaymentMethodLinkStatus =
  | 'hosted_ready'
  | 'independent_created'
  | 'reused_eligibility_session'
  | 'method_not_offered'
  | 'identity_required'
  | 'identity_mismatch'
  | 'checkout_loaded'
  | 'qualification_lost'
  | 'checkout_create_failed'
  | 'session_not_distinct'
  | 'runner_failed'
  | 'forced_probe'
  | 'link_ready';

export interface ProbePaymentMethodLink {
  method: string;
  url: string;
  status: ProbePaymentMethodLinkStatus;
  message: string;
  checkoutCountry: string;
  currency: string;
  capabilityScope?: 'global' | 'regional';
  currencyPolicy?: 'checkout' | 'fixed';
  expectedCurrency?: string;
  sessionMode: ProbePaymentCheckoutSessionMode;
  sessionDistinct: boolean;
  /** Source eligibility Checkout had passed the zero-amount qualification gate. */
  sourceQualificationVerified?: boolean;
  /** Method was screened because it was configured but absent from discovery. */
  forcedProbe?: boolean;
  /** The method runner reused the original eligibility Checkout. Always false for an independent Checkout. */
  sourceSessionReused?: boolean;
  /** The target payment method was present in the revalidated method list. */
  methodOffered?: boolean;
  /** Qualification passed on the session required by the selected reuse/independent mode. */
  qualificationPreserved?: boolean;
  qualificationVerified: boolean;
  finalLinkVerified: boolean;
  aggregateStatus?: ProbePaymentLinkAggregateStatus;
  runnerStatus: string;
  runnerCode: string;
  createdAt: number;
}

export interface ProbeRouteVariant {
  id: string;
  authCountry: string;
  checkoutCountry: string;
  billingCountry: string;
}

export interface ProbeCountryOption {
  country: string;
  currency: string;
  label: string;
}

export interface ProbeAccount {
  id: string;
  /** Stable ChatGPT account id from /api/auth/session; distinct from the local probe id. */
  chatgptAccountId?: string;
  email: string;
  /** Raw access token or JSON containing accessToken. */
  tokenRaw: string;
  source: ProbeAccountSource;
  enabled: boolean;
  lastHitAt: number;
  lastProbeAt: number;
  lastProbeCountry: string;
  tokenUpdatedAt: number;
  authEvidence?: ProbeStageExitSnapshot;
  lastMessage: string;
  successCount: number;
  failCount: number;
  createdAt: number;
  batchId: string;
  /** Latest server-side credential check; local JWT expiry alone is not authoritative. */
  serverCredentialStatus?: ProbeServerCredentialStatus;
  credentialCheckedAt?: number;
  credentialMessage?: string;
  identitySnapshot: CheckoutIdentitySnapshot;
}

export interface ProbeTaskConfig {
  name: string;
  intervalSec: number;
  concurrency: number;
  retryCount: number;
  /** Hard cap for scheduled account/route units in one run. */
  maxProbeUnitsPerRun: number;
  /** Hard cap for Checkout attempts in one unit, including the first attempt. */
  maxCheckoutAttemptsPerUnit: number;
  /** Hard cap for native payment methods evaluated for one qualified Checkout. */
  maxPaymentMethodsPerQualification: number;
  /** confirm + approve writes allowed for one method attempt. */
  maxWriteOperationsPerMethod: number;
  /** Consecutive qualification drifts that stop the current account unit. */
  maxConsecutiveQualificationDrifts: number;
  checkoutUiMode: ProbeCheckoutUiMode;
  planName: ProbePlanName;
  accountSource: 'all' | 'enabled' | 'manual-only';
  entryProxyMode: ProbeEntryProxyMode;
  exitProxyMode: ProbeExitProxyMode;
  countries: string[];
  channels: string[];
  pinOnSuccess: boolean;
  skipAccountAfterHit: boolean;
  autoSwitchExitByCountry: boolean;
  notifyMode: ProbeNotifyMode;
  soundEnabled: boolean;
  preferChromeTlsNote: boolean;
  /** Open checkout link in a tab when hit. */
  autoOpenOnHit: boolean;
  /** After open, sniff page text for 0 amount / trial. */
  sniffCheckoutOnHit: boolean;
  sniffTimeoutMs: number;
  /** Persist hit links into local hit database + dashboard. */
  saveHitsToDatabase: boolean;
  /** Exclude countries whose latest proxy health is fail/skip. */
  excludeUnhealthyExits: boolean;
  /** Prioritize countries with high historical hit rate. */
  highHitRateOnly: boolean;
  /** Keep a rotating exploration sample when high-hit prioritization is enabled. */
  explorationEnabled: boolean;
  /** Number of unknown/low-sample countries retained in each round. */
  explorationCountryCount: number;
  /** Minimum hit rate percent (0-100) when highHitRateOnly enabled. */
  minHitRatePercent: number;
  /** Minimum attempts required before a country can qualify as high-rate. */
  minHitAttempts: number;
  /** Max countries kept after high-rate filtering (0 = unlimited). */
  maxHighRateCountries: number;
  /** UPL-aligned staged checkout pipeline. */
  stagedPipelineEnabled: boolean;
  /** Promotion/update country (UPL middle stage, often VN). */
  promotionCountry: string;
  /** When true, use selected probe country as bootstrap+provider, promotionCountry as middle. */
  useSelectedAsBootstrapProvider: boolean;
  /** Optional fixed bootstrap country when not using selected. */
  bootstrapCountry: string;
  /** Optional fixed provider country when not using selected. */
  providerCountry: string;
  /** Reject non-zero amount hits (UPL REQUIRE_ZERO). */
  requireZero: boolean;
  /** After create, call checkout/update on promotion stage. */
  enablePromotionUpdate: boolean;
  /** After promotion, call checkout/taxes on provider stage (best-effort). */
  enableProviderTaxes: boolean;
  /** After hit, try extract method-specific final payment URL. */
  extractFinalPaymentUrl: boolean;
  /** Optional Stripe publishable key for confirm-based final URL (pk_live/pk_test). */
  stripePublishableKey: string;
  /** When true and stripe pk present, attempt payment_pages confirm. */
  enableStripeConfirm: boolean;
  /** Create a fresh Checkout per payment method, or reuse the eligibility Checkout for comparison. */
  paymentCheckoutSessionMode: ProbePaymentCheckoutSessionMode;
  /** Run every detected native payment method instead of only the first method. */
  extractAllDetectedMethods: boolean;
  /** Screen configured methods even when Stripe init did not expose them. */
  forceUnlistedPaymentMethodProbe: boolean;
  /** Preferred payment method for confirm/extract (empty = from channels). */
  paymentMethod: string;
  /** iDEAL bank code when confirming ideal. */
  idealBank: string;
  /** After checkout, detect Stripe payment_method_types (UPL detect). */
  detectPaymentMethods: boolean;
  /** Attach detected methods onto hit tags/channels. */
  attachDetectedMethods: boolean;
  /** Prefer country-detected supported methods when extracting final URL. */
  autoApplyDetectedMethods: boolean;
  /** Persist one observation for every account x country evaluation. */
  factorTrackingEnabled: boolean;
  /** Rebuild recent-vs-baseline drift alerts after every observation. */
  driftDetectionEnabled: boolean;
  /** Minimum samples per comparison group before drawing a conclusion. */
  factorMinSamples: number;
  /** Minimum samples per recent/baseline side before raising drift. */
  driftMinSamples: number;
  /** Target fraction reserved for unknown, low-sample, or drifting groups. */
  adaptiveExplorationPercent: number;
  /** Browser-local cap for detailed observations. */
  observationRetentionLimit: number;
  /** Run a balanced account x exit experiment instead of an early-stop production sweep. */
  researchModeEnabled: boolean;
  /** Explicit scheduling policy. Legacy researchModeEnabled maps to attribution. */
  experimentMode: ProbeExperimentMode;
  exploitTrafficPercent: number;
  balancedTrafficPercent: number;
  explorationTrafficPercent: number;
  controlledFactors: ProbeExperimentFactor[];
  routeVariants: ProbeRouteVariant[];
  paymentMethodVariants: string[];
  seedReplicatesPerCell: number;
  /** Rotate each account's country order with a deterministic Latin-square offset. */
  balancedOrderEnabled: boolean;
  /** Required observations for every account x country matrix cell. */
  researchTargetSamplesPerCell: number;
  /** Minimum interval between repeated observations of the same matrix cell. */
  researchMinRepeatIntervalMinutes: number;
  /** Minimum total balanced observations before causal evidence can be promoted. */
  researchMinTotalSamples: number;
}

export type ProbeProxyHealthStatus = 'unknown' | 'ok' | 'fail' | 'skip';

export interface ProbeProxyHealthItem {
  country: string;
  status: ProbeProxyHealthStatus;
  latencyMs: number;
  endpointSummary: string;
  message: string;
  checkedAt: number;
  actualIp?: string;
  actualCountry?: string;
  colo?: string;
  asn?: string;
  asOrganization?: string;
  ipVersion?: 'IPv4' | 'IPv6' | '';
  networkType?: 'residential' | 'hosting' | 'unknown';
}

export interface ProbeStatsCell {
  country: string;
  channel: string;
  attempts: number;
  hits: number;
  errors: number;
  lastHitAt: number;
  lastMessage: string;
}

export interface ProbeCountryScore {
  country: string;
  attempts: number;
  hits: number;
  errors: number;
  rate: number;
  confidenceLow: number;
  confidenceHigh: number;
  health: ProbeProxyHealthStatus;
  qualified: boolean;
  lastHitAt: number;
  selected: boolean;
}

export interface ProbeCheckoutSniff {
  checked: boolean;
  ok: boolean;
  amountText: string;
  trialText: string;
  zeroLikely: boolean;
  trialLikely: boolean;
  pageUrl: string;
  message: string;
  checkedAt: number;
}


export interface ProbeHitRecord {
  id: string;
  taskId: string;
  accountId: string;
  email: string;
  country: string;
  currency: string;
  planName: ProbePlanName;
  ok: boolean;
  hitKind: ProbeHitKind;
  message: string;
  link: string;
  longUrl: string;
  shortUrl: string;
  channels: string[];
  amountHint: string;
  promoHint: string;
  createdAt: number;
  rawKeys: string[];
  tabId?: number;
  sniff?: ProbeCheckoutSniff;
  /** Stable database id in local hit DB. */
  dbId?: string;
  savedToDb?: boolean;
  tags?: string[];
  note?: string;
  finalPaymentUrl?: string;
  paymentMethod?: string;
  finalUrlSource?: string;
  detectedMethods?: string[];
  paymentRunnerStatus?: string;
  paymentRunnerStage?: string;
  paymentRunnerCode?: string;
  paymentCheckoutSessionMode?: ProbePaymentCheckoutSessionMode;
  paymentCheckoutStatus?: ProbePaymentMethodLinkStatus | '';
  paymentCheckoutSessionDistinct?: boolean;
  paymentMethodLinks?: ProbePaymentMethodLink[];
  qualificationVerified?: boolean;
  qualificationType?: ProbeQualificationType;
  qualificationEvidenceLevel?: ProbeLinkVerificationLevel;
  qualificationLedger?: ProbeQualificationEvidence[];
  qualificationDriftEvents?: ProbeQualificationDriftEvent[];
  submittedPaymentMethod?: string;
  paymentRunnerConfirmSubmitted?: boolean;
  paymentRunnerConfirmSucceeded?: boolean;
  paymentRunnerApproveSubmitted?: boolean;
  paymentRunnerApproveSucceeded?: boolean;
  finalLinkVerified?: boolean;
  checkoutCreated?: boolean;
  qualificationGateVersion?: string;
  linkVerificationLevel?: ProbeLinkVerificationLevel;
  linkUsable?: boolean;
  retryOrdinal?: number;
  checkoutUiMode?: ProbeCheckoutUiMode;
  checkoutVariants?: CheckoutVariantResult[];
  checkoutRetryMetrics?: CheckoutRetryMetrics;
  hostedResolutionStatus?: HostedResolutionStatus;
  hostedResolutionMessage?: string;
  identitySnapshotReady?: boolean;
  resolvedCheckoutSessionType?: 'oaics' | 'stripe' | 'unknown';
  hostedResolutionMethods?: string[];
  stripeResourceCount?: number;
  stripePublishableKeyFound?: boolean;
  stripePublishableKeyVerified?: boolean;
  stripeKeyOwnershipStatus?: 'not_checked' | 'verified' | 'rejected' | 'inconclusive';
  stripeKeyOwnershipCode?: string;
}


export interface ProbeTaskRuntime {
  status: ProbeTaskStatus;
  runId: string;
  cycleId: string;
  startedAt: number;
  finishedAt: number;
  nextRunAt: number;
  currentAccountId: string;
  currentCountry: string;
  currentUnitId: string;
  currentAttemptId: string;
  totalUnits: number;
  completedUnits: number;
  skippedUnits: number;
  processed: number;
  hits: number;
  errors: number;
  lastMessage: string;
  round: number;
  unitStates: ProbeTaskUnitRuntime[];
}

export interface ProbeTaskUnitRuntime {
  unitId: string;
  runId: string;
  cycleId: string;
  attemptId: string;
  accountId: string;
  email: string;
  country: string;
  status: ProbeTaskUnitStatus;
  attempt: number;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  hitKind: ProbeHitKind | 'none';
  errorClass: string;
  message: string;
}

export interface ProbeTask {
  id: string;
  config: ProbeTaskConfig;
  runtime: ProbeTaskRuntime;
  createdAt: number;
  updatedAt: number;
}

export interface ProbeHitDatabaseRecord extends ProbeHitRecord {
  dbId: string;
  savedAt: number;
  sourceTaskName: string;
  archived: boolean;
}

export interface ProbeHitDashboardFilter {
  country: string;
  hitKind: string;
  email: string;
  onlyWithLink: boolean;
  onlyUsableLinks: boolean;
  query: string;
}

export interface ProbeHitDashboardSummary {
  total: number;
  withLink: number;
  usableLinks: number;
  qualified: number;
  zero: number;
  trial: number;
  promo: number;
  countries: number;
  latestAt: number;
}

export type ProbeArchiveEntity = 'observations' | 'hits' | 'runs';

export interface ProbeArchiveStatus {
  available: boolean;
  degraded: boolean;
  backend: 'indexeddb' | 'local';
  schemaVersion: number;
  migratedAt: number;
  observationCount: number;
  hitCount: number;
  runCount: number;
  retentionDays: number;
  lastPrunedAt: number;
  lastError: string;
}

export interface ProbeRunArchiveRecord {
  archiveId: string;
  taskId: string;
  taskName: string;
  runId: string;
  cycleId: string;
  status: ProbeTaskStatus;
  startedAt: number;
  finishedAt: number;
  totalUnits: number;
  completedUnits: number;
  skippedUnits: number;
  processed: number;
  hits: number;
  errors: number;
  message: string;
  units: ProbeTaskUnitRuntime[];
  updatedAt: number;
}

export interface ProbeArchiveQuery {
  entity: ProbeArchiveEntity;
  page?: number;
  pageSize?: number;
  query?: string;
  country?: string;
  outcome?: string;
}

export interface ProbeArchivePage {
  entity: ProbeArchiveEntity;
  page: number;
  pageSize: number;
  total: number;
  records: Array<ProbeObservation | ProbeHitDatabaseRecord | ProbeRunArchiveRecord>;
  status: ProbeArchiveStatus;
}

export interface ProbeAccountReportRow {
  accountId: string;
  email: string;
  source: ProbeAccountSource;
  enabled: boolean;
  credentialStatus: ProbeCredentialStatus;
  tokenExpiresAt: number;
  tokenUpdatedAt: number;
  lastProbeAt: number;
  lastProbeCountry: string;
  successRate: number;
  successCount: number;
  failCount: number;
  hitCount: number;
  linkCount: number;
  zeroCount: number;
  trialCount: number;
  promoCount: number;
  countries: string[];
  bestKind: ProbeHitKind | 'none';
  lastHitAt: number;
  lastMessage: string;
  topLink: string;
  tags: string[];
}

export interface ProbeMethodDetectionRecord {
  id: string;
  country: string;
  currency: string;
  accountId: string;
  email: string;
  methods: string[];
  interestingMethods: string[];
  amountHint: string;
  zeroLikely: boolean;
  source: string;
  message: string;
  checkoutSessionId: string;
  detectedAt: number;
  taskId: string;
}

export interface ProbeCountryMethodRecommendation {
  country: string;
  methods: string[];
  interestingMethods: string[];
  samples: number;
  zeroSamples: number;
  lastDetectedAt: number;
  recommendedPaymentMethod: string;
  note: string;
}

export type ProbeObservationOutcome = 'hit' | 'miss' | 'error';
export type ProbeExperimentValidityStatus = 'valid' | 'partial' | 'invalid';
export type ProbeFactorDimension =
  | 'account'
  | 'accountBatch'
  | 'accountSource'
  | 'probeCountry'
  | 'authCountry'
  | 'checkoutCountry'
  | 'billingCountry'
  | 'authIp'
  | 'checkoutIp'
  | 'billingIp'
  | 'authAsn'
  | 'checkoutAsn'
  | 'billingAsn'
  | 'paymentMethod'
  | 'plan'
  | 'currency'
  | 'clientVersion'
  | 'accountAge'
  | 'tokenAge'
  | 'tokenExpiryHorizon'
  | 'emailDomain'
  | 'browserProfile'
  | 'deviceCohort'
  | 'localeExitAlignment'
  | 'timeZoneExitAlignment'
  | 'sequencePosition'
  | 'scheduleBlock'
  | 'configuredRetries'
  | 'checkoutIpVersion'
  | 'localHour'
  | 'weekday'
  | 'routeSignature'
  | 'accountByCountry'
  | 'accountByCheckoutIp'
  | 'countryByPaymentMethod'
  | 'experimentMode'
  | 'experimentArm'
  | 'routeVariant'
  | 'plannedPaymentMethod'
  | 'submittedPaymentMethod'
  | 'qualificationGate'
  | 'linkVerificationLevel'
  | 'seedOrdinal'
  | 'designCell'
  | 'checkoutSubnet'
  | 'checkoutNetworkType'
  | 'checkoutSchema'
  | 'offerSet'
  | 'upstreamProtocol'
  | 'ruleEpoch'
  | 'campaign'
  | 'product'
  | 'checkoutMode'
  | 'retryOrdinal'
  | 'cooldownBucket';

export interface ProbeStageExitSnapshot {
  cycleId: string;
  configuredCountry: string;
  country: string;
  ip: string;
  asn: string;
  colo: string;
  latencyMs: number;
  checkedAt: number;
  endpointSummary: string;
  source: string;
  verified: boolean;
  message: string;
}

export interface ProbeObservation {
  id: string;
  observedAt: number;
  taskId: string;
  runId: string;
  cycleId: string;
  unitId: string;
  attemptId: string;
  round: number;
  sequence: number;
  researchMode: boolean;
  experimentMode: ProbeExperimentMode;
  experimentArm: ProbeExperimentArm;
  designCellKey: string;
  routeVariantId: string;
  plannedAuthCountry: string;
  plannedCheckoutCountry: string;
  plannedBillingCountry: string;
  plannedPaymentMethod: string;
  plannedSeedOrdinal: number;
  scheduleBlock: number;
  scheduleCellAttempt: number;
  accountId: string;
  accountBatchId: string;
  accountSource: ProbeAccountSource;
  accountAgeHours: number;
  tokenAgeHours: number;
  tokenExpiryHorizonHours: number;
  emailDomainCohort: string;
  browserProfileCohort: string;
  deviceCohort: string;
  probeCountry: string;
  bootstrapCountry: string;
  promotionCountry: string;
  providerCountry: string;
  channels: string[];
  planName: ProbePlanName;
  paymentMethod: string;
  currency: string;
  campaignId: string;
  productId: string;
  checkoutMode: string;
  outcome: ProbeObservationOutcome;
  hitKind: ProbeHitKind;
  amountHint: string;
  promoHint: string;
  detectedMethods: string[];
  paymentRunnerStatus: string;
  paymentRunnerStage: string;
  paymentRunnerCode: string;
  paymentCheckoutSessionMode: ProbePaymentCheckoutSessionMode;
  paymentCheckoutStatus: ProbePaymentMethodLinkStatus | '';
  paymentCheckoutSessionDistinct: boolean;
  paymentMethodLinkCount: number;
  qualificationVerified: boolean;
  qualificationType?: ProbeQualificationType;
  qualificationEvidenceLevel?: ProbeLinkVerificationLevel;
  qualificationDriftCount?: number;
  submittedPaymentMethod: string;
  paymentRunnerConfirmSubmitted: boolean;
  paymentRunnerConfirmSucceeded: boolean;
  paymentRunnerApproveSubmitted: boolean;
  paymentRunnerApproveSucceeded: boolean;
  finalLinkVerified: boolean;
  checkoutCreated: boolean;
  qualificationGateVersion: string;
  linkVerificationLevel: ProbeLinkVerificationLevel;
  linkUsable: boolean;
  credentialStatus: ProbeServerCredentialStatus;
  actualAuthCountry: string;
  actualCheckoutCountry: string;
  actualBillingCountry: string;
  countryTreatmentApplied: boolean;
  routeTreatmentApplied: boolean;
  paymentMethodTreatmentApplied: boolean;
  experimentValidityStatus: ProbeExperimentValidityStatus;
  experimentValidForAttribution: boolean;
  experimentValidityReasons: string[];
  errorClass: string;
  durationMs: number;
  configuredRetries: number;
  retryOrdinal: number;
  checkoutUiMode: ProbeCheckoutUiMode;
  checkoutAttempts: number;
  updateAttempts: number;
  fullFlowAttempts: number;
  cfRetryCount: number;
  cfExitRotations: number;
  invalidPromotionRebuilds: number;
  pageFallbackAttempts: number;
  cooldownElapsedMinutes: number;
  stagedPipelineEnabled: boolean;
  entryProxyMode: ProbeEntryProxyMode;
  exitProxyMode: ProbeExitProxyMode;
  frontProxySummary: string;
  auth: ProbeStageExitSnapshot;
  checkout: ProbeStageExitSnapshot;
  billing: ProbeStageExitSnapshot;
  bootstrapSeedSummary: string;
  promotionSeedSummary: string;
  providerSeedSummary: string;
  extensionVersion: string;
  browserFamily: string;
  locale: string;
  timeZone: string;
  localeExitAlignment: 'match' | 'mismatch' | 'unknown';
  timeZoneExitAlignment: 'match' | 'mismatch' | 'unknown';
  checkoutSubnet: string;
  checkoutNetworkType: 'residential' | 'hosting' | 'unknown';
  checkoutSchemaFingerprint: string;
  offerSetFingerprint: string;
  upstreamProtocolFingerprint: string;
  ruleEpochId: string;
}

export interface ProbeFactorRow {
  dimension: ProbeFactorDimension;
  value: string;
  attempts: number;
  resolved: number;
  hits: number;
  errors: number;
  rate: number;
  confidenceLow: number;
  confidenceHigh: number;
  liftPercentPoints: number;
  confidence: 'insufficient' | 'low' | 'medium' | 'high';
  lastObservedAt: number;
}

export interface ProbeFactorConclusion {
  factor: 'account' | 'country' | 'exit' | 'interaction' | 'time' | 'unexplained';
  evidence: 'insufficient' | 'weak' | 'moderate' | 'strong';
  score: number;
  message: string;
  dimensions: ProbeFactorDimension[];
}

export type ProbeControlledFactor = 'account' | 'country' | 'exit-ip' | 'exit-asn' | 'route' | 'payment-method' | 'seed' | 'time' | 'sequence' | 'retry';

export interface ProbeControlledEffect {
  id: string;
  factor: ProbeControlledFactor;
  treatmentDimension: ProbeFactorDimension;
  controlDimensions: ProbeFactorDimension[];
  levelA: string;
  levelB: string;
  matchedStrata: number;
  matchedSamples: number;
  effectPercentPoints: number;
  directionConsistencyPercent: number;
  zScore: number;
  evidence: 'insufficient' | 'weak' | 'moderate' | 'strong';
  generalizable: boolean;
  message: string;
}

export interface ProbeConfoundingFinding {
  id: string;
  dimensionA: ProbeFactorDimension;
  dimensionB: ProbeFactorDimension;
  relationship: 'one-to-one' | 'a-determines-b' | 'b-determines-a';
  dependencyPercent: number;
  samples: number;
  level: 'info' | 'warning' | 'critical';
  message: string;
}

export interface ProbePowerTarget {
  effectPercentPoints: number;
  requiredPerGroup: number;
  requiredTotal: number;
  currentResolved: number;
  progressPercent: number;
  remainingSamples: number;
}

export interface ProbePowerPlan {
  baselineRate: number;
  alpha: number;
  power: number;
  targets: ProbePowerTarget[];
  message: string;
}

export interface ProbeRepeatStability {
  repeatedCells: number;
  stableCells: number;
  variableCells: number;
  repeatedObservations: number;
  transitions: number;
  transitionOpportunities: number;
  stabilityPercent: number;
  transitionRatePercent: number;
  message: string;
}

export interface ProbeFactorReport {
  generatedAt: number;
  sampleSize: number;
  resolvedSamples: number;
  hits: number;
  errors: number;
  errorRate: number;
  overallRate: number;
  overallConfidenceLow: number;
  overallConfidenceHigh: number;
  minSamples: number;
  rows: ProbeFactorRow[];
  conclusions: ProbeFactorConclusion[];
  controlledEffects: ProbeControlledEffect[];
  confoundingFindings: ProbeConfoundingFinding[];
  powerPlan: ProbePowerPlan;
  repeatStability: ProbeRepeatStability;
  caveats: string[];
  quality: ProbeEvidenceQuality;
}

export interface ProbeEvidenceQuality {
  conclusionState: 'insufficient' | 'correlation' | 'stable-association' | 'drifting';
  score: number;
  protocolCount: number;
  dominantProtocolPercent: number;
  verifiedAuthPercent: number;
  verifiedCheckoutPercent: number;
  verifiedBillingPercent: number;
  resolvedOutcomePercent: number;
  errorRate: number;
  matrixBalancePercent: number;
  minimumDetectableEffectPp: number;
  epochCount: number;
  latestEpochStartedAt: number;
  latestEpochSamples: number;
  rawObservationCount: number;
  attributionEligibleSamples: number;
  excludedTreatmentSamples: number;
  treatmentAppliedPercent: number;
  blockers: string[];
}

export type ProbeDriftKind = 'eligibility-rate' | 'error-rate' | 'price' | 'payment-method' | 'protocol-schema' | 'offer-set';

export interface ProbeDriftAlert {
  id: string;
  kind: ProbeDriftKind;
  level: 'info' | 'warning' | 'critical';
  dimension: ProbeFactorDimension | 'global';
  value: string;
  baselineSamples: number;
  recentSamples: number;
  baselineValue: number;
  recentValue: number;
  delta: number;
  zScore: number;
  detectedAt: number;
  message: string;
}

export interface ProbeAdaptiveRecommendation {
  id: string;
  priority: 'normal' | 'high' | 'urgent';
  dimension: ProbeFactorDimension | 'global';
  value: string;
  currentSamples: number;
  targetSamples: number;
  reason: string;
}

export type ProbeExperimentCellStatus = 'missing' | 'ready' | 'cooldown' | 'complete';

export interface ProbeExperimentCell {
  accountId: string;
  country: string;
  samples: number;
  targetSamples: number;
  firstObservedAt: number;
  lastObservedAt: number;
  nextEligibleAt: number;
  spanMinutes: number;
  status: ProbeExperimentCellStatus;
}

export interface ProbeExperimentCoverage {
  generatedAt: number;
  taskId: string;
  accountCount: number;
  exitCountryCount: number;
  totalCells: number;
  coveredCells: number;
  completedCells: number;
  missingCells: number;
  coveragePercent: number;
  completionPercent: number;
  targetSamplesPerCell: number;
  minRepeatIntervalMinutes: number;
  minTotalSamples: number;
  matrixSampleSize: number;
  sameAccountMultiExitCount: number;
  sameExitMultiAccountCount: number;
  repeatedCellCount: number;
  crossTimeCellCount: number;
  evidenceReady: boolean;
  armCounts: Record<ProbeExperimentArm, number>;
  routeVariantCount: number;
  paymentMethodCount: number;
  seedOrdinalCount: number;
  designCellCount: number;
  blockers: string[];
  cells: ProbeExperimentCell[];
}

export type ProbeIdentifiabilityFactor = 'account' | 'country' | 'exit-ip' | 'exit-asn' | 'time-randomness' | 'route' | 'payment-method';
export type ProbeIdentifiabilityStatus = 'blocked' | 'ready' | 'observing' | 'identifiable';

export interface ProbeIdentifiabilityItem {
  factor: ProbeIdentifiabilityFactor;
  status: ProbeIdentifiabilityStatus;
  levels: number;
  matchedStrata: number;
  samples: number;
  message: string;
}

export interface ProbeExperimentReadiness {
  generatedAt: number;
  enabledAccountCount: number;
  usableCredentialCount: number;
  healthyExitCount: number;
  healthyActualCountryCount: number;
  healthyActualIpCount: number;
  healthyActualAsnCount: number;
  observationCount: number;
  attributionEligibleObservationCount: number;
  invalidTreatmentObservationCount: number;
  partialTreatmentObservationCount: number;
  currentRuleEpochId: string;
  currentRuleEpochSamples: number;
  adaptiveExplorationPercent: number;
  driftBoostedExplorationPercent: number;
  items: ProbeIdentifiabilityItem[];
  blockers: string[];
}

export interface ProbeState {
  accounts: ProbeAccount[];
  rawAccounts: string;
  tasks: ProbeTask[];
  hits: ProbeHitRecord[];
  /** Durable hit link database for dashboard. */
  hitDatabase: ProbeHitDatabaseRecord[];
  stats: ProbeStatsCell[];
  proxyHealth: ProbeProxyHealthItem[];
  methodDetections: ProbeMethodDetectionRecord[];
  paymentOperationReceipts: PaymentRunnerCheckpoint[];
  observations: ProbeObservation[];
  factorReport: ProbeFactorReport;
  driftAlerts: ProbeDriftAlert[];
  adaptiveRecommendations: ProbeAdaptiveRecommendation[];
  experimentCoverage: ProbeExperimentCoverage;
  experimentReadiness: ProbeExperimentReadiness;
  archiveStatus: ProbeArchiveStatus;
  activeTaskId: string;
  updatedAt: number;
}

export interface ProbeSaveAccountsMessage {
  type: 'opx:probe-save-accounts';
  rawAccounts: string;
}

export interface ProbeUpsertTaskMessage {
  type: 'opx:probe-upsert-task';
  task: Partial<ProbeTask> & { config: ProbeTaskConfig; id?: string };
}

export interface ProbeDeleteTaskMessage {
  type: 'opx:probe-delete-task';
  taskId: string;
}

export interface ProbeControlMessage {
  type: 'opx:probe-control';
  action: 'start' | 'stop' | 'run-once' | 'refresh' | 'health-check' | 'export-hitdb';
  taskId?: string;
}

export interface ProbeClearHitsMessage {
  type: 'opx:probe-clear-hits';
  scope?: 'runtime' | 'database' | 'all';
}

export interface ProbeHitDbQueryMessage {
  type: 'opx:probe-hitdb-query';
  filter?: Partial<ProbeHitDashboardFilter>;
}

export interface ProbeHitDbDeleteMessage {
  type: 'opx:probe-hitdb-delete';
  dbId: string;
}

export interface ProbeHitDbExportMessage {
  type: 'opx:probe-hitdb-export';
  filter?: Partial<ProbeHitDashboardFilter>;
}

export interface ProbeArchiveQueryMessage {
  type: 'opx:probe-archive-query';
  query: ProbeArchiveQuery;
}

export interface ProbeArchiveExportMessage {
  type: 'opx:probe-archive-export';
  query: Omit<ProbeArchiveQuery, 'page' | 'pageSize'>;
}

export interface ProbeArchiveClearMessage {
  type: 'opx:probe-archive-clear';
  entity: ProbeArchiveEntity | 'all';
}

export interface ProbeArchivePruneMessage {
  type: 'opx:probe-archive-prune';
  retentionDays: number;
}

export interface ProbeArchiveResponse {
  ok: boolean;
  message: string;
  page?: ProbeArchivePage;
  status?: ProbeArchiveStatus;
  exportText?: string;
}


export interface ProbeMethodsQueryMessage {
  type: 'opx:probe-methods-query';
}

export interface ProbeMethodsExportMessage {
  type: 'opx:probe-methods-export';
}

export interface ProbeMethodsClearMessage {
  type: 'opx:probe-methods-clear';
}

export interface ProbeMethodsResponse {
  ok: boolean;
  message: string;
  detections?: ProbeMethodDetectionRecord[];
  recommendations?: ProbeCountryMethodRecommendation[];
  csv?: string;
  recommendationsCsv?: string;
  state?: ProbeState;
}

export interface ProbeAccountReportMessage {
  type: 'opx:probe-account-report';
}

export interface ProbeAccountActionMessage {
  type: 'opx:probe-account-action';
  action: 'enable' | 'disable' | 'delete';
  accountIds: string[];
}

export interface ProbeFactorQueryMessage {
  type: 'opx:probe-factor-query';
}

export interface ProbeFactorExportMessage {
  type: 'opx:probe-factor-export';
  format?: 'json' | 'csv';
}

export interface ProbeFactorClearMessage {
  type: 'opx:probe-factor-clear';
}

export interface ProbeFactorImportMessage {
  type: 'opx:probe-factor-import';
  text: string;
  format?: 'auto' | 'json' | 'csv';
  mode?: 'merge' | 'replace';
}

export interface ProbeFactorResponse {
  ok: boolean;
  message: string;
  state?: ProbeState;
  report?: ProbeFactorReport;
  alerts?: ProbeDriftAlert[];
  recommendations?: ProbeAdaptiveRecommendation[];
  exportText?: string;
  imported?: number;
  rejected?: number;
  duplicates?: number;
}

export interface ProbeHitDbResponse {
  ok: boolean;
  message: string;
  state?: ProbeState;
  records?: ProbeHitDatabaseRecord[];
  summary?: ProbeHitDashboardSummary;
  exportText?: string;
  report?: ProbeAccountReportRow[];
}

export interface ProbeStateMessage {
  type: 'opx:probe-get-state';
}

export interface ProbeHealthCheckMessage {
  type: 'opx:probe-health-check';
  countries?: string[];
}

export interface ProbeResponse {
  ok: boolean;
  message: string;
  state?: ProbeState;
}
import type { CheckoutIdentitySnapshot, CheckoutRetryMetrics, CheckoutVariantResult, ProbeCheckoutUiMode } from '../link-extractor/types';
import type { PaymentRunnerCheckpoint } from '../payment/runner-types';
import type { HostedResolutionStatus } from './hosted-resolution';
