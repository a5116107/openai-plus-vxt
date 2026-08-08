import { scopedStorageKey } from '../../app/storage-scope';
import { tryExtractAccessToken } from '../link-extractor/checkout';
import { defaultProbeCountries, PROBE_CHANNELS } from './countries';
import {
  buildFactorAnalysis,
  detectEligibilityDrift,
  gateFactorReportByCoverage,
  recommendAdaptiveExperiments,
  wilsonInterval,
} from './analysis';
import {
  buildExperimentCoverage,
  DEFAULT_CONTROLLED_FACTORS,
  DEFAULT_ROUTE_VARIANTS,
  EMPTY_EXPERIMENT_COVERAGE,
  normalizeControlledFactors,
  normalizeExperimentMode,
  normalizeRouteVariants,
  normalizeTrafficAllocation,
} from './experiment';
import { dedupeProbeHits } from './runtime';
import { buildExperimentReadiness } from './readiness';
import {
  createSessionIdentitySnapshot,
  parseStructuredProbeCredentials,
  type StructuredProbeCredential,
} from './session-import';
import { evaluateProbeTreatmentValidity } from './validity';
import { ensureProbeArchiveMigrated, getProbeArchiveRepository } from './archive';
export { buildFreshProbeStageSnapshot, createProbeRunUnits, dedupeProbeHits, getProbeRuntimeProgress } from './runtime';
import type {
  ProbeAccount,
  ProbeArchiveStatus,
  ProbeAccountReportRow,
  ProbeCheckoutSniff,
  ProbeCountryScore,
  ProbeHitDashboardFilter,
  ProbeHitDashboardSummary,
  ProbeHitDatabaseRecord,
  ProbeHitKind,
  ProbeHitRecord,
  ProbeMethodDetectionRecord,
  ProbeCountryMethodRecommendation,
  ProbeFactorReport,
  ProbeExperimentReadiness,
  ProbeNotifyMode,
  ProbeObservation,
  ProbeProxyHealthItem,
  ProbeState,
  ProbeStatsCell,
  ProbeTask,
  ProbeTaskConfig,
  ProbeTaskRuntime,
  ProbeTaskUnitRuntime,
} from './types';

const PROBE_STORAGE_KEY = 'opx.probe.state';
const MAX_HITS = 400;
const MAX_HIT_DB = 2000;
const DEFAULT_MAX_OBSERVATIONS = 3000;
const MAX_DRIFT_ALERTS = 200;

const EMPTY_ARCHIVE_STATUS: ProbeArchiveStatus = {
  available: false,
  degraded: false,
  backend: 'local',
  schemaVersion: 1,
  migratedAt: 0,
  observationCount: 0,
  hitCount: 0,
  runCount: 0,
  retentionDays: 0,
  lastPrunedAt: 0,
  lastError: '',
};

const EMPTY_FACTOR_REPORT: ProbeFactorReport = {
  generatedAt: 0,
  sampleSize: 0,
  resolvedSamples: 0,
  hits: 0,
  errors: 0,
  errorRate: 0,
  overallRate: 0,
  overallConfidenceLow: 0,
  overallConfidenceHigh: 100,
  minSamples: 5,
  rows: [],
  conclusions: [],
  controlledEffects: [],
  confoundingFindings: [],
  powerPlan: { baselineRate: 50, alpha: 0.05, power: 0.8, targets: [], message: '尚无明确资格结果' },
  repeatStability: { repeatedCells: 0, stableCells: 0, variableCells: 0, repeatedObservations: 0, transitions: 0, transitionOpportunities: 0, stabilityPercent: 0, transitionRatePercent: 0, message: '尚无重复账号×国家单元' },
  caveats: [],
  quality: {
    conclusionState: 'insufficient', score: 0, protocolCount: 0, dominantProtocolPercent: 0,
    verifiedAuthPercent: 0, verifiedCheckoutPercent: 0, verifiedBillingPercent: 0,
    resolvedOutcomePercent: 0, errorRate: 0, matrixBalancePercent: 0, minimumDetectableEffectPp: 100,
    epochCount: 0, latestEpochStartedAt: 0, latestEpochSamples: 0, blockers: ['尚无观测样本'],
    rawObservationCount: 0, attributionEligibleSamples: 0, excludedTreatmentSamples: 0, treatmentAppliedPercent: 0,
  },
};

const EMPTY_EXPERIMENT_READINESS: ProbeExperimentReadiness = {
  generatedAt: 0,
  enabledAccountCount: 0,
  usableCredentialCount: 0,
  healthyExitCount: 0,
  healthyActualCountryCount: 0,
  healthyActualIpCount: 0,
  healthyActualAsnCount: 0,
  observationCount: 0,
  attributionEligibleObservationCount: 0,
  invalidTreatmentObservationCount: 0,
  partialTreatmentObservationCount: 0,
  currentRuleEpochId: '',
  currentRuleEpochSamples: 0,
  adaptiveExplorationPercent: 20,
  driftBoostedExplorationPercent: 20,
  items: [],
  blockers: ['尚未加载账号与出口健康数据'],
};

export const DEFAULT_PROBE_TASK_CONFIG: ProbeTaskConfig = {
  name: '多国优惠探测',
  intervalSec: 60,
  concurrency: 1,
  retryCount: 3,
  maxProbeUnitsPerRun: 200,
  maxCheckoutAttemptsPerUnit: 3,
  maxPaymentMethodsPerQualification: 10,
  maxWriteOperationsPerMethod: 2,
  maxConsecutiveQualificationDrifts: 2,
  checkoutUiMode: 'hosted',
  planName: 'chatgptplusplan',
  accountSource: 'enabled',
  entryProxyMode: 'front',
  exitProxyMode: 'follow-country',
  countries: defaultProbeCountries(),
  channels: [...PROBE_CHANNELS],
  pinOnSuccess: true,
  skipAccountAfterHit: true,
  autoSwitchExitByCountry: true,
  notifyMode: 'sound-badge',
  soundEnabled: true,
  preferChromeTlsNote: true,
  autoOpenOnHit: true,
  sniffCheckoutOnHit: true,
  sniffTimeoutMs: 12000,
  saveHitsToDatabase: true,
  excludeUnhealthyExits: true,
  highHitRateOnly: false,
  explorationEnabled: true,
  explorationCountryCount: 2,
  minHitRatePercent: 30,
  minHitAttempts: 3,
  maxHighRateCountries: 12,
  stagedPipelineEnabled: true,
  promotionCountry: 'VN',
  useSelectedAsBootstrapProvider: true,
  bootstrapCountry: '',
  providerCountry: '',
  requireZero: true,
  enablePromotionUpdate: true,
  enableProviderTaxes: false,
  extractFinalPaymentUrl: true,
  stripePublishableKey: '',
  enableStripeConfirm: false,
  paymentCheckoutSessionMode: 'reuse_eligibility_session',
  extractAllDetectedMethods: true,
  forceUnlistedPaymentMethodProbe: false,
  paymentMethod: '',
  idealBank: 'n26',
  detectPaymentMethods: true,
  attachDetectedMethods: true,
  autoApplyDetectedMethods: true,
  factorTrackingEnabled: true,
  driftDetectionEnabled: true,
  factorMinSamples: 5,
  driftMinSamples: 10,
  adaptiveExplorationPercent: 20,
  observationRetentionLimit: DEFAULT_MAX_OBSERVATIONS,
  researchModeEnabled: false,
  experimentMode: 'hybrid',
  exploitTrafficPercent: 60,
  balancedTrafficPercent: 25,
  explorationTrafficPercent: 15,
  controlledFactors: [...DEFAULT_CONTROLLED_FACTORS],
  routeVariants: DEFAULT_ROUTE_VARIANTS.map((item) => ({ ...item })),
  paymentMethodVariants: [],
  seedReplicatesPerCell: 3,
  balancedOrderEnabled: true,
  researchTargetSamplesPerCell: 3,
  researchMinRepeatIntervalMinutes: 240,
  researchMinTotalSamples: 100,
};

const DEFAULT_RUNTIME: ProbeTaskRuntime = {
  status: 'idle',
  runId: '',
  cycleId: '',
  startedAt: 0,
  finishedAt: 0,
  nextRunAt: 0,
  currentAccountId: '',
  currentCountry: '',
  currentUnitId: '',
  currentAttemptId: '',
  totalUnits: 0,
  completedUnits: 0,
  skippedUnits: 0,
  processed: 0,
  hits: 0,
  errors: 0,
  lastMessage: '',
  round: 0,
  unitStates: [],
};

const DEFAULT_STATE: ProbeState = {
  accounts: [],
  rawAccounts: '',
  tasks: [],
  hits: [],
  hitDatabase: [],
  stats: [],
  proxyHealth: [],
  methodDetections: [],
  paymentOperationReceipts: [],
  observations: [],
  factorReport: EMPTY_FACTOR_REPORT,
  driftAlerts: [],
  adaptiveRecommendations: [],
  experimentCoverage: EMPTY_EXPERIMENT_COVERAGE,
  experimentReadiness: EMPTY_EXPERIMENT_READINESS,
  archiveStatus: EMPTY_ARCHIVE_STATUS,
  activeTaskId: '',
  updatedAt: 0,
};

export async function loadProbeState(): Promise<ProbeState> {
  const key = scopedStorageKey(PROBE_STORAGE_KEY);
  const data = await browser.storage.local.get(key);
  const state = normalizeProbeState(data[key]);
  const archiveStatus = await ensureProbeArchiveMigrated({
    observations: state.observations,
    hits: state.hitDatabase,
    tasks: state.tasks,
  });
  return { ...state, archiveStatus };
}

export async function saveProbeState(patch: Partial<ProbeState>): Promise<ProbeState> {
  const current = await loadProbeState();
  const next = normalizeProbeState({
    ...current,
    ...patch,
    accounts: Object.prototype.hasOwnProperty.call(patch, 'accounts') ? patch.accounts || [] : current.accounts,
    tasks: Object.prototype.hasOwnProperty.call(patch, 'tasks') ? patch.tasks || [] : current.tasks,
    hits: Object.prototype.hasOwnProperty.call(patch, 'hits') ? patch.hits || [] : current.hits,
    hitDatabase: Object.prototype.hasOwnProperty.call(patch, 'hitDatabase') ? patch.hitDatabase || [] : current.hitDatabase,
    stats: Object.prototype.hasOwnProperty.call(patch, 'stats') ? patch.stats || [] : current.stats,
    proxyHealth: Object.prototype.hasOwnProperty.call(patch, 'proxyHealth') ? patch.proxyHealth || [] : current.proxyHealth,
    methodDetections: Object.prototype.hasOwnProperty.call(patch, 'methodDetections') ? patch.methodDetections || [] : current.methodDetections,
    observations: Object.prototype.hasOwnProperty.call(patch, 'observations') ? patch.observations || [] : current.observations,
    factorReport: Object.prototype.hasOwnProperty.call(patch, 'factorReport') ? patch.factorReport || EMPTY_FACTOR_REPORT : current.factorReport,
    driftAlerts: Object.prototype.hasOwnProperty.call(patch, 'driftAlerts') ? patch.driftAlerts || [] : current.driftAlerts,
    adaptiveRecommendations: Object.prototype.hasOwnProperty.call(patch, 'adaptiveRecommendations') ? patch.adaptiveRecommendations || [] : current.adaptiveRecommendations,
    archiveStatus: Object.prototype.hasOwnProperty.call(patch, 'archiveStatus') ? patch.archiveStatus || EMPTY_ARCHIVE_STATUS : current.archiveStatus,
    updatedAt: Date.now(),
  });
  await browser.storage.local.set({ [scopedStorageKey(PROBE_STORAGE_KEY)]: next });
  return next;
}

export function normalizeProbeState(value: unknown): ProbeState {
  const source = isRecord(value) ? value : {};
  const accounts = Array.isArray(source.accounts)
    ? source.accounts.map((item) => normalizeAccount(item)).filter((item): item is ProbeAccount => Boolean(item))
    : [];
  const tasks = Array.isArray(source.tasks)
    ? source.tasks.map((item) => normalizeTask(item)).filter((item): item is ProbeTask => Boolean(item))
    : [];
  const hits = Array.isArray(source.hits)
    ? source.hits.map((item) => normalizeHit(item)).filter((item): item is ProbeHitRecord => Boolean(item)).slice(0, MAX_HITS)
    : [];
  const hitDatabase = Array.isArray(source.hitDatabase)
    ? source.hitDatabase.map((item) => normalizeHitDatabaseRecord(item)).filter((item): item is ProbeHitDatabaseRecord => Boolean(item)).slice(0, MAX_HIT_DB)
    : [];
  const stats = Array.isArray(source.stats)
    ? source.stats.map((item) => normalizeStatsCell(item)).filter((item): item is ProbeStatsCell => Boolean(item))
    : [];
  const proxyHealth = Array.isArray(source.proxyHealth)
    ? source.proxyHealth.map((item) => normalizeProxyHealth(item)).filter((item): item is ProbeProxyHealthItem => Boolean(item))
    : [];
  const methodDetections = normalizeMethodDetections(source.methodDetections);
  const paymentOperationReceipts = normalizePaymentOperationReceipts(source.paymentOperationReceipts);
  const observations = Array.isArray(source.observations)
    ? source.observations.map((item) => normalizeObservation(item)).filter((item): item is ProbeObservation => Boolean(item)).slice(0, 10000)
    : [];
  const activeTaskId = String(source.activeTaskId || tasks[0]?.id || '');
  const activeTask = tasks.find((item) => item.id === activeTaskId) || tasks[0];
  const activeConfig = activeTask?.config || DEFAULT_PROBE_TASK_CONFIG;
  const experimentAccounts = selectExperimentAccounts(accounts, activeConfig.accountSource);
  const experimentAccountIds = experimentAccounts.length
    ? experimentAccounts.map((item) => item.id)
    : [...new Set(observations.map((item) => item.accountId).filter(Boolean))];
  const experimentCountries = activeConfig.countries.length
    ? activeConfig.countries
    : [...new Set(observations.map((item) => item.probeCountry).filter(Boolean))];
  const experimentCoverage = buildExperimentCoverage({
    observations,
    accountIds: experimentAccountIds,
    countries: experimentCountries,
    taskId: activeTask?.id || '',
    targetSamplesPerCell: activeConfig.researchTargetSamplesPerCell,
    minRepeatIntervalMinutes: activeConfig.researchMinRepeatIntervalMinutes,
    minTotalSamples: activeConfig.researchMinTotalSamples,
    evidenceArm: 'balanced',
  });
  const driftAlerts = activeConfig.driftDetectionEnabled
    ? detectEligibilityDrift(observations, { minSamples: activeConfig.driftMinSamples })
    : [];
  const rawFactorReport = observations.length
    ? buildFactorAnalysis(observations, activeConfig.factorMinSamples, { driftAlerts })
    : EMPTY_FACTOR_REPORT;
  const factorReport = observations.length
    ? gateFactorReportByCoverage(rawFactorReport, experimentCoverage)
    : rawFactorReport;
  const experimentReadiness = buildExperimentReadiness({
    accounts,
    proxyHealth,
    observations,
    config: activeConfig,
    driftAlerts,
  });
  const adaptiveRecommendations = recommendAdaptiveExperiments(
    factorReport,
    driftAlerts,
    experimentReadiness.driftBoostedExplorationPercent,
    experimentCoverage,
  );
  return {
    accounts,
    rawAccounts: String(source.rawAccounts || ''),
    tasks,
    hits,
    hitDatabase,
    stats,
    proxyHealth,
    methodDetections,
    paymentOperationReceipts,
    observations,
    factorReport,
    driftAlerts,
    adaptiveRecommendations,
    experimentCoverage,
    experimentReadiness,
    archiveStatus: normalizeArchiveStatus(source.archiveStatus),
    activeTaskId,
    updatedAt: Number(source.updatedAt || 0),
  };
}

function selectExperimentAccounts(
  accounts: ProbeAccount[],
  source: ProbeTaskConfig['accountSource'],
): ProbeAccount[] {
  if (source === 'all') return accounts;
  if (source === 'manual-only') return accounts.filter((item) => item.source === 'manual' && item.enabled);
  return accounts.filter((item) => item.enabled);
}

export function parseProbeAccounts(raw: string, previous: ProbeAccount[] = []): { accounts: ProbeAccount[]; errors: string[] } {
  const prevByEmail = new Map(previous.map((item) => [item.email.toLowerCase(), item]));
  const accounts: ProbeAccount[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  const structured = parseStructuredProbeCredentials(raw);
  const inputs: Array<StructuredProbeCredential | null> = structured.length
    ? structured
    : String(raw || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, index) => {
        const parsed = parseAccountLine(line);
        return parsed ? { ...parsed, lineNumber: index + 1 } : null;
      });

  inputs.forEach((input, index) => {
      const parsed = input && input.tokenRaw ? input : null;
      if (!parsed) {
        errors.push(`第 ${input?.lineNumber || index + 1} 行无法解析，支持 email----token、纯 token 或账号 JSON`);
        return;
      }
      const key = parsed.email.toLowerCase() || parsed.tokenRaw.slice(0, 24);
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      const prev = prevByEmail.get(parsed.email.toLowerCase());
      const now = Date.now();
      accounts.push({
        id: prev?.id || `probe-acc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        chatgptAccountId: parsed.chatgptAccountId || prev?.chatgptAccountId || '',
        email: parsed.email || prev?.email || guessEmailFromToken(parsed.tokenRaw) || `token-${accounts.length + 1}`,
        tokenRaw: parsed.tokenRaw,
        source: prev?.source || 'manual',
        enabled: prev?.enabled ?? true,
        lastHitAt: prev?.lastHitAt || 0,
        lastProbeAt: prev?.lastProbeAt || 0,
        lastProbeCountry: prev?.lastProbeCountry || '',
        tokenUpdatedAt: prev && prev.tokenRaw === parsed.tokenRaw ? prev.tokenUpdatedAt : now,
        identitySnapshot: parsed.sessionToken
          ? createSessionIdentitySnapshot(parsed.sessionToken, prev?.identitySnapshot)
          : prev?.identitySnapshot || createIdentitySnapshot(),
        lastMessage: prev?.lastMessage || '',
        successCount: prev?.successCount || 0,
        failCount: prev?.failCount || 0,
        createdAt: prev?.createdAt || now,
        batchId: prev?.batchId || buildAccountBatchId(prev?.source || 'manual', now),
        serverCredentialStatus: prev && prev.tokenRaw === parsed.tokenRaw ? prev.serverCredentialStatus : 'unchecked',
        credentialCheckedAt: prev && prev.tokenRaw === parsed.tokenRaw ? prev.credentialCheckedAt : 0,
        credentialMessage: prev && prev.tokenRaw === parsed.tokenRaw ? prev.credentialMessage : '',
      });
    });

  return { accounts, errors };
}

export async function upsertProbeAccountFromSession(input: {
  email?: string;
  chatgptAccountId?: string;
  tokenRaw: string;
  source?: 'session' | 'automation';
  identitySnapshot?: ProbeAccount['identitySnapshot'];
}): Promise<{ state: ProbeState; account: ProbeAccount | null; created: boolean; message: string }> {
  const tokenRaw = String(input.tokenRaw || '').trim();
  if (!tokenRaw) {
    const state = await loadProbeState();
    return { state, account: null, created: false, message: 'token 为空，未写入探测池' };
  }
  const email = String(input.email || '').trim() || guessEmailFromToken(tokenRaw) || `session-${Date.now()}`;
  const chatgptAccountId = String(input.chatgptAccountId || '').trim();
  const source = input.source === 'automation' ? 'automation' : 'session';
  const current = await loadProbeState();
  const key = email.toLowerCase();
  const existingIdx = current.accounts.findIndex((item) =>
    Boolean(chatgptAccountId && item.chatgptAccountId === chatgptAccountId)
    || item.email.toLowerCase() === key);
  let created = false;
  let account: ProbeAccount;
  const accounts = [...current.accounts];
  if (existingIdx >= 0) {
    account = {
      ...accounts[existingIdx],
      chatgptAccountId: chatgptAccountId || accounts[existingIdx].chatgptAccountId || '',
      email,
      tokenRaw,
      tokenUpdatedAt: Date.now(),
      source,
      enabled: true,
      serverCredentialStatus: 'unchecked',
      credentialCheckedAt: 0,
      credentialMessage: '',
      identitySnapshot: normalizeIdentitySnapshot(input.identitySnapshot, accounts[existingIdx].identitySnapshot),
      lastMessage: `已从${source === 'automation' ? '注册自动化' : 'session'}同步 token`,
    };
    accounts[existingIdx] = account;
  } else {
    created = true;
    account = {
      id: `probe-acc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      chatgptAccountId,
      email,
      tokenRaw,
      source,
      enabled: true,
      serverCredentialStatus: 'unchecked',
      credentialCheckedAt: 0,
      credentialMessage: '',
      lastHitAt: 0,
      lastProbeAt: 0,
      lastProbeCountry: '',
      tokenUpdatedAt: Date.now(),
      lastMessage: `已从${source === 'automation' ? '注册自动化' : 'session'}导入`,
      successCount: 0,
      failCount: 0,
      createdAt: Date.now(),
      batchId: buildAccountBatchId(source, Date.now()),
      identitySnapshot: normalizeIdentitySnapshot(input.identitySnapshot),
    };
    accounts.unshift(account);
  }
  const line = `${account.email}----${account.tokenRaw}`;
  const rawLines = String(current.rawAccounts || '')
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => !item.toLowerCase().startsWith(`${key}----`));
  rawLines.unshift(line);
  const next = await saveProbeState({
    accounts,
    rawAccounts: rawLines.join('\n'),
  });
  return {
    state: next,
    account,
    created,
    message: created
      ? `已导入探测账号 ${account.email}（来源 ${source}）`
      : `已更新探测账号 ${account.email} token（来源 ${source}）`,
  };
}

export function createProbeTask(configInput?: Partial<ProbeTaskConfig>): ProbeTask {
  const config = normalizeTaskConfig(configInput || DEFAULT_PROBE_TASK_CONFIG);
  const now = Date.now();
  return {
    id: `probe-task-${now}-${Math.random().toString(36).slice(2, 7)}`,
    config,
    runtime: { ...DEFAULT_RUNTIME },
    createdAt: now,
    updatedAt: now,
  };
}

export function normalizeTaskConfig(value: unknown): ProbeTaskConfig {
  const source = isRecord(value) ? value : {};
  const legacyResearchMode = source.researchModeEnabled === undefined
    ? DEFAULT_PROBE_TASK_CONFIG.researchModeEnabled
    : Boolean(source.researchModeEnabled);
  const experimentMode = normalizeExperimentMode(source.experimentMode, legacyResearchMode);
  const traffic = normalizeTrafficAllocation({
    exploit: source.exploitTrafficPercent,
    balanced: source.balancedTrafficPercent,
    explore: source.explorationTrafficPercent,
  });
  const countries = Array.isArray(source.countries)
    ? source.countries.map((item) => String(item || '').trim().toUpperCase()).filter((item) => /^[A-Z]{2}$/.test(item))
    : DEFAULT_PROBE_TASK_CONFIG.countries;
  const channels = Array.isArray(source.channels)
    ? source.channels.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
    : DEFAULT_PROBE_TASK_CONFIG.channels;
  return {
    name: String(source.name || DEFAULT_PROBE_TASK_CONFIG.name).trim() || DEFAULT_PROBE_TASK_CONFIG.name,
    intervalSec: clampInt(source.intervalSec, 15, 3600, DEFAULT_PROBE_TASK_CONFIG.intervalSec),
    concurrency: 1,
    retryCount: clampInt(source.retryCount, 0, 10, DEFAULT_PROBE_TASK_CONFIG.retryCount),
    maxProbeUnitsPerRun: clampInt(source.maxProbeUnitsPerRun, 1, 10000, DEFAULT_PROBE_TASK_CONFIG.maxProbeUnitsPerRun),
    maxCheckoutAttemptsPerUnit: clampInt(source.maxCheckoutAttemptsPerUnit, 1, 20, DEFAULT_PROBE_TASK_CONFIG.maxCheckoutAttemptsPerUnit),
    maxPaymentMethodsPerQualification: clampInt(source.maxPaymentMethodsPerQualification, 1, 20, DEFAULT_PROBE_TASK_CONFIG.maxPaymentMethodsPerQualification),
    maxWriteOperationsPerMethod: clampInt(source.maxWriteOperationsPerMethod, 1, 4, DEFAULT_PROBE_TASK_CONFIG.maxWriteOperationsPerMethod),
    maxConsecutiveQualificationDrifts: clampInt(source.maxConsecutiveQualificationDrifts, 1, 20, DEFAULT_PROBE_TASK_CONFIG.maxConsecutiveQualificationDrifts),
    checkoutUiMode: source.checkoutUiMode === 'custom' || source.checkoutUiMode === 'both' ? source.checkoutUiMode : 'hosted',
    planName: source.planName === 'chatgptteamplan' ? 'chatgptteamplan' : 'chatgptplusplan',
    accountSource: source.accountSource === 'all' || source.accountSource === 'manual-only' ? source.accountSource : 'enabled',
    entryProxyMode: source.entryProxyMode === 'exit1' || source.entryProxyMode === 'none' ? source.entryProxyMode : 'front',
    exitProxyMode: source.exitProxyMode === 'fixed-exit2' || source.exitProxyMode === 'fixed-front' || source.exitProxyMode === 'none'
      ? source.exitProxyMode
      : 'follow-country',
    countries: countries.length ? [...new Set(countries)] : DEFAULT_PROBE_TASK_CONFIG.countries,
    channels: channels.length ? [...new Set(channels)] : [...PROBE_CHANNELS],
    pinOnSuccess: source.pinOnSuccess === undefined ? DEFAULT_PROBE_TASK_CONFIG.pinOnSuccess : Boolean(source.pinOnSuccess),
    skipAccountAfterHit: source.skipAccountAfterHit === undefined ? DEFAULT_PROBE_TASK_CONFIG.skipAccountAfterHit : Boolean(source.skipAccountAfterHit),
    autoSwitchExitByCountry: source.autoSwitchExitByCountry === undefined ? DEFAULT_PROBE_TASK_CONFIG.autoSwitchExitByCountry : Boolean(source.autoSwitchExitByCountry),
    notifyMode: normalizeNotifyMode(source.notifyMode),
    soundEnabled: source.soundEnabled === undefined ? true : Boolean(source.soundEnabled),
    preferChromeTlsNote: source.preferChromeTlsNote === undefined ? true : Boolean(source.preferChromeTlsNote),
    autoOpenOnHit: source.autoOpenOnHit === undefined ? DEFAULT_PROBE_TASK_CONFIG.autoOpenOnHit : Boolean(source.autoOpenOnHit),
    sniffCheckoutOnHit: source.sniffCheckoutOnHit === undefined ? DEFAULT_PROBE_TASK_CONFIG.sniffCheckoutOnHit : Boolean(source.sniffCheckoutOnHit),
    sniffTimeoutMs: clampInt(source.sniffTimeoutMs, 3000, 60000, DEFAULT_PROBE_TASK_CONFIG.sniffTimeoutMs),
    saveHitsToDatabase: source.saveHitsToDatabase === undefined ? DEFAULT_PROBE_TASK_CONFIG.saveHitsToDatabase : Boolean(source.saveHitsToDatabase),
    excludeUnhealthyExits: source.excludeUnhealthyExits === undefined ? DEFAULT_PROBE_TASK_CONFIG.excludeUnhealthyExits : Boolean(source.excludeUnhealthyExits),
    highHitRateOnly: source.highHitRateOnly === undefined ? DEFAULT_PROBE_TASK_CONFIG.highHitRateOnly : Boolean(source.highHitRateOnly),
    explorationEnabled: source.explorationEnabled === undefined ? DEFAULT_PROBE_TASK_CONFIG.explorationEnabled : Boolean(source.explorationEnabled),
    explorationCountryCount: clampInt(source.explorationCountryCount, 0, 50, DEFAULT_PROBE_TASK_CONFIG.explorationCountryCount),
    minHitRatePercent: clampInt(source.minHitRatePercent, 0, 100, DEFAULT_PROBE_TASK_CONFIG.minHitRatePercent),
    minHitAttempts: clampInt(source.minHitAttempts, 1, 1000, DEFAULT_PROBE_TASK_CONFIG.minHitAttempts),
    maxHighRateCountries: clampInt(source.maxHighRateCountries, 0, 200, DEFAULT_PROBE_TASK_CONFIG.maxHighRateCountries),
    stagedPipelineEnabled: source.stagedPipelineEnabled === undefined
      ? DEFAULT_PROBE_TASK_CONFIG.stagedPipelineEnabled
      : Boolean(source.stagedPipelineEnabled),
    promotionCountry: normalizeCountryCode(source.promotionCountry, DEFAULT_PROBE_TASK_CONFIG.promotionCountry),
    useSelectedAsBootstrapProvider: source.useSelectedAsBootstrapProvider === undefined
      ? DEFAULT_PROBE_TASK_CONFIG.useSelectedAsBootstrapProvider
      : Boolean(source.useSelectedAsBootstrapProvider),
    bootstrapCountry: normalizeOptionalCountryCode(source.bootstrapCountry),
    providerCountry: normalizeOptionalCountryCode(source.providerCountry),
    requireZero: source.requireZero === undefined
      ? DEFAULT_PROBE_TASK_CONFIG.requireZero
      : Boolean(source.requireZero),
    enablePromotionUpdate: source.enablePromotionUpdate === undefined
      ? DEFAULT_PROBE_TASK_CONFIG.enablePromotionUpdate
      : Boolean(source.enablePromotionUpdate),
    enableProviderTaxes: source.enableProviderTaxes === undefined
      ? DEFAULT_PROBE_TASK_CONFIG.enableProviderTaxes
      : Boolean(source.enableProviderTaxes),
    extractFinalPaymentUrl: source.extractFinalPaymentUrl === undefined
      ? DEFAULT_PROBE_TASK_CONFIG.extractFinalPaymentUrl
      : Boolean(source.extractFinalPaymentUrl),
    stripePublishableKey: String(source.stripePublishableKey || DEFAULT_PROBE_TASK_CONFIG.stripePublishableKey).trim(),
    enableStripeConfirm: source.enableStripeConfirm === undefined
      ? DEFAULT_PROBE_TASK_CONFIG.enableStripeConfirm
      : Boolean(source.enableStripeConfirm),
    paymentCheckoutSessionMode: source.paymentCheckoutSessionMode === 'independent_checkout'
      ? 'independent_checkout'
      : 'reuse_eligibility_session',
    extractAllDetectedMethods: source.extractAllDetectedMethods === undefined
      ? DEFAULT_PROBE_TASK_CONFIG.extractAllDetectedMethods
      : Boolean(source.extractAllDetectedMethods),
    forceUnlistedPaymentMethodProbe: source.forceUnlistedPaymentMethodProbe === undefined
      ? DEFAULT_PROBE_TASK_CONFIG.forceUnlistedPaymentMethodProbe
      : Boolean(source.forceUnlistedPaymentMethodProbe),
    paymentMethod: String(source.paymentMethod || '').trim().toLowerCase(),
    idealBank: String(source.idealBank || DEFAULT_PROBE_TASK_CONFIG.idealBank).trim() || 'n26',
    detectPaymentMethods: source.detectPaymentMethods === undefined
      ? DEFAULT_PROBE_TASK_CONFIG.detectPaymentMethods
      : Boolean(source.detectPaymentMethods),
    attachDetectedMethods: source.attachDetectedMethods === undefined
      ? DEFAULT_PROBE_TASK_CONFIG.attachDetectedMethods
      : Boolean(source.attachDetectedMethods),
    autoApplyDetectedMethods: source.autoApplyDetectedMethods === undefined
      ? DEFAULT_PROBE_TASK_CONFIG.autoApplyDetectedMethods
      : Boolean(source.autoApplyDetectedMethods),
    factorTrackingEnabled: source.factorTrackingEnabled === undefined
      ? DEFAULT_PROBE_TASK_CONFIG.factorTrackingEnabled
      : Boolean(source.factorTrackingEnabled),
    driftDetectionEnabled: source.driftDetectionEnabled === undefined
      ? DEFAULT_PROBE_TASK_CONFIG.driftDetectionEnabled
      : Boolean(source.driftDetectionEnabled),
    factorMinSamples: clampInt(source.factorMinSamples, 2, 200, DEFAULT_PROBE_TASK_CONFIG.factorMinSamples),
    driftMinSamples: clampInt(source.driftMinSamples, 2, 500, DEFAULT_PROBE_TASK_CONFIG.driftMinSamples),
    adaptiveExplorationPercent: clampInt(source.adaptiveExplorationPercent, 5, 50, DEFAULT_PROBE_TASK_CONFIG.adaptiveExplorationPercent),
    observationRetentionLimit: clampInt(source.observationRetentionLimit, 500, 10000, DEFAULT_PROBE_TASK_CONFIG.observationRetentionLimit),
    researchModeEnabled: experimentMode !== 'discovery',
    experimentMode,
    exploitTrafficPercent: traffic.exploit,
    balancedTrafficPercent: traffic.balanced,
    explorationTrafficPercent: traffic.explore,
    controlledFactors: normalizeControlledFactors(source.controlledFactors),
    routeVariants: normalizeRouteVariants(source.routeVariants),
    paymentMethodVariants: Array.isArray(source.paymentMethodVariants)
      ? [...new Set(source.paymentMethodVariants.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean))].slice(0, 20)
      : [],
    seedReplicatesPerCell: clampInt(source.seedReplicatesPerCell, 1, 20, DEFAULT_PROBE_TASK_CONFIG.seedReplicatesPerCell),
    balancedOrderEnabled: source.balancedOrderEnabled === undefined
      ? DEFAULT_PROBE_TASK_CONFIG.balancedOrderEnabled
      : Boolean(source.balancedOrderEnabled),
    researchTargetSamplesPerCell: clampInt(source.researchTargetSamplesPerCell, 1, 20, DEFAULT_PROBE_TASK_CONFIG.researchTargetSamplesPerCell),
    researchMinRepeatIntervalMinutes: clampInt(source.researchMinRepeatIntervalMinutes, 0, 10080, DEFAULT_PROBE_TASK_CONFIG.researchMinRepeatIntervalMinutes),
    researchMinTotalSamples: clampInt(source.researchMinTotalSamples, 20, 10000, DEFAULT_PROBE_TASK_CONFIG.researchMinTotalSamples),
  };
}

export async function appendProbeHit(hit: ProbeHitRecord): Promise<ProbeState> {
  const current = await loadProbeState();
  return saveProbeState({
    hits: [hit, ...current.hits].slice(0, MAX_HITS),
  });
}

function normalizeTask(value: unknown): ProbeTask | null {
  if (!isRecord(value)) return null;
  const id = String(value.id || '').trim();
  if (!id) return null;
  return {
    id,
    config: normalizeTaskConfig(value.config),
    runtime: normalizeRuntime(value.runtime),
    createdAt: Number(value.createdAt || Date.now()),
    updatedAt: Number(value.updatedAt || Date.now()),
  };
}

function normalizeRuntime(value: unknown): ProbeTaskRuntime {
  const source = isRecord(value) ? value : {};
  const status = String(source.status || 'idle');
  return {
    status: (['idle', 'running', 'paused', 'stopped', 'completed', 'error'].includes(status)
      ? status
      : 'idle') as ProbeTaskRuntime['status'],
    runId: String(source.runId || ''),
    cycleId: String(source.cycleId || ''),
    startedAt: Number(source.startedAt || 0),
    finishedAt: Number(source.finishedAt || 0),
    nextRunAt: Number(source.nextRunAt || 0),
    currentAccountId: String(source.currentAccountId || ''),
    currentCountry: String(source.currentCountry || ''),
    currentUnitId: String(source.currentUnitId || ''),
    currentAttemptId: String(source.currentAttemptId || ''),
    totalUnits: Math.max(0, Number(source.totalUnits || 0)),
    completedUnits: Math.max(0, Number(source.completedUnits || source.processed || 0)),
    skippedUnits: Math.max(0, Number(source.skippedUnits || 0)),
    processed: Number(source.processed || 0),
    hits: Number(source.hits || 0),
    errors: Number(source.errors || 0),
    lastMessage: String(source.lastMessage || ''),
    round: Number(source.round || 0),
    unitStates: Array.isArray(source.unitStates)
      ? source.unitStates.map((item) => normalizeTaskUnitRuntime(item)).filter((item): item is ProbeTaskUnitRuntime => Boolean(item)).slice(0, 5000)
      : [],
  };
}

function normalizeTaskUnitRuntime(value: unknown): ProbeTaskUnitRuntime | null {
  if (!isRecord(value)) return null;
  const unitId = String(value.unitId || '').trim();
  if (!unitId) return null;
  const status = String(value.status || 'planned');
  return {
    unitId,
    runId: String(value.runId || ''),
    cycleId: String(value.cycleId || ''),
    attemptId: String(value.attemptId || ''),
    accountId: String(value.accountId || ''),
    email: String(value.email || ''),
    country: String(value.country || '').trim().toUpperCase(),
    status: (['planned', 'running', 'hit', 'miss', 'error', 'skipped'].includes(status) ? status : 'planned') as ProbeTaskUnitRuntime['status'],
    attempt: Math.max(0, Number(value.attempt || 0)),
    startedAt: Math.max(0, Number(value.startedAt || 0)),
    finishedAt: Math.max(0, Number(value.finishedAt || 0)),
    durationMs: Math.max(0, Number(value.durationMs || 0)),
    hitKind: String(value.hitKind || 'none') as ProbeTaskUnitRuntime['hitKind'],
    errorClass: String(value.errorClass || ''),
    message: String(value.message || ''),
  };
}

function normalizeAccount(value: unknown): ProbeAccount | null {
  if (!isRecord(value)) return null;
  const tokenRaw = String(value.tokenRaw || '').trim();
  if (!tokenRaw) return null;
  return {
    id: String(value.id || `probe-acc-${Date.now()}`),
    chatgptAccountId: String(value.chatgptAccountId || value.chatgpt_account_id || '').trim(),
    email: String(value.email || '').trim(),
    tokenRaw,
    source: value.source === 'automation' || value.source === 'session' ? value.source : 'manual',
    enabled: value.enabled === undefined ? true : Boolean(value.enabled),
    lastHitAt: Number(value.lastHitAt || 0),
    lastProbeAt: Number(value.lastProbeAt || 0),
    lastProbeCountry: String(value.lastProbeCountry || '').trim().toUpperCase(),
    tokenUpdatedAt: Number(value.tokenUpdatedAt || value.createdAt || 0),
    authEvidence: isRecord(value.authEvidence) ? normalizeStageExit(value.authEvidence) : undefined,
    lastMessage: String(value.lastMessage || ''),
    successCount: Number(value.successCount || 0),
    failCount: Number(value.failCount || 0),
    createdAt: Number(value.createdAt || Date.now()),
    batchId: String(value.batchId || buildAccountBatchId(
      value.source === 'automation' || value.source === 'session' ? value.source : 'manual',
      Number(value.createdAt || Date.now()),
    )),
    serverCredentialStatus: value.serverCredentialStatus === 'valid' || value.serverCredentialStatus === 'invalid' || value.serverCredentialStatus === 'unknown'
      ? value.serverCredentialStatus
      : 'unchecked',
    credentialCheckedAt: Math.max(0, Number(value.credentialCheckedAt || 0)),
    credentialMessage: String(value.credentialMessage || ''),
    identitySnapshot: normalizeIdentitySnapshot(value.identitySnapshot),
  };
}

function createIdentitySnapshot(): ProbeAccount['identitySnapshot'] {
  return {
    deviceId: createIdentityId(),
    sessionId: createIdentityId(),
    cookies: [],
    capturedAt: Date.now(),
  };
}

function normalizeIdentitySnapshot(
  value: unknown,
  fallback?: ProbeAccount['identitySnapshot'],
): ProbeAccount['identitySnapshot'] {
  if (!isRecord(value)) return fallback || createIdentitySnapshot();
  const cookies = Array.isArray(value.cookies) ? value.cookies.filter(isRecord).map((cookie) => ({
    name: String(cookie.name || ''),
    value: String(cookie.value || ''),
    domain: String(cookie.domain || ''),
    path: String(cookie.path || '/'),
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    sameSite: String(cookie.sameSite || '') || undefined,
    expirationDate: Number(cookie.expirationDate || 0) || undefined,
    storeId: String(cookie.storeId || '') || undefined,
    firstPartyDomain: String(cookie.firstPartyDomain || ''),
  })).filter((cookie) => cookie.name && cookie.domain).slice(0, 200) : [];
  return {
    deviceId: String(value.deviceId || fallback?.deviceId || createIdentityId()),
    sessionId: String(value.sessionId || fallback?.sessionId || createIdentityId()),
    cookies,
    capturedAt: Math.max(0, Number(value.capturedAt || Date.now())),
  };
}

function createIdentityId(): string {
  try { return crypto.randomUUID(); } catch { return `${Date.now()}-${Math.random().toString(36).slice(2, 14)}`; }
}

function normalizeCheckoutRetryMetrics(value: unknown): NonNullable<ProbeHitRecord['checkoutRetryMetrics']> {
  const source = isRecord(value) ? value : {};
  return {
    checkoutAttempts: Math.max(0, Number(source.checkoutAttempts || 0)),
    updateAttempts: Math.max(0, Number(source.updateAttempts || 0)),
    fullFlowAttempts: Math.max(0, Number(source.fullFlowAttempts || 0)),
    cfRetryCount: Math.max(0, Number(source.cfRetryCount || 0)),
    cfExitRotations: Math.max(0, Number(source.cfExitRotations || 0)),
    invalidPromotionRebuilds: Math.max(0, Number(source.invalidPromotionRebuilds || 0)),
    pageFallbackAttempts: Math.max(0, Number(source.pageFallbackAttempts || 0)),
  };
}

function normalizeCheckoutVariants(value: unknown): NonNullable<ProbeHitRecord['checkoutVariants']> {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((variant) => {
    const amount = isRecord(variant.amount) ? variant.amount : {};
    return {
      uiMode: (variant.uiMode === 'custom' ? 'custom' : 'hosted') as NonNullable<ProbeHitRecord['checkoutVariants']>[number]['uiMode'],
      ok: Boolean(variant.ok),
      message: String(variant.message || ''),
      link: String(variant.link || ''),
      longUrl: String(variant.longUrl || ''),
      shortUrl: String(variant.shortUrl || ''),
      checkoutSessionId: String(variant.checkoutSessionId || ''),
      processorEntity: String(variant.processorEntity || ''),
      amount: {
        amountMinor: amount.amountMinor === null || amount.amountMinor === undefined ? null : Number(amount.amountMinor),
        amountHint: String(amount.amountHint || ''),
        currency: String(amount.currency || ''),
        source: ['create-response', 'update-response', 'tax-response', 'checkout-page'].includes(String(amount.source || ''))
          ? amount.source as NonNullable<ProbeHitRecord['checkoutVariants']>[number]['amount']['source']
          : 'unknown',
        path: String(amount.path || ''),
        verification: (amount.verification === 'verified-zero' || amount.verification === 'verified-nonzero'
          ? amount.verification
          : 'pending') as NonNullable<ProbeHitRecord['checkoutVariants']>[number]['amount']['verification'],
      },
      retryMetrics: normalizeCheckoutRetryMetrics(variant.retryMetrics),
    };
  }).slice(0, 2);
}

function normalizeHit(value: unknown): ProbeHitRecord | null {
  if (!isRecord(value)) return null;
  return {
    id: String(value.id || `hit-${Date.now()}`),
    taskId: String(value.taskId || ''),
    accountId: String(value.accountId || ''),
    email: String(value.email || ''),
    country: String(value.country || ''),
    currency: String(value.currency || ''),
    planName: value.planName === 'chatgptteamplan' ? 'chatgptteamplan' : 'chatgptplusplan',
    ok: Boolean(value.ok),
    hitKind: (String(value.hitKind || 'none') as ProbeHitRecord['hitKind']),
    message: String(value.message || ''),
    link: String(value.link || ''),
    longUrl: String(value.longUrl || ''),
    shortUrl: String(value.shortUrl || ''),
    channels: Array.isArray(value.channels) ? value.channels.map((item) => String(item)) : [],
    amountHint: String(value.amountHint || ''),
    promoHint: String(value.promoHint || ''),
    createdAt: Number(value.createdAt || Date.now()),
    rawKeys: Array.isArray(value.rawKeys) ? value.rawKeys.map((item) => String(item)) : [],
    tabId: Number(value.tabId || 0) || undefined,
    sniff: normalizeSniff(value.sniff),
    dbId: String(value.dbId || '') || undefined,
    savedToDb: Boolean(value.savedToDb),
    tags: Array.isArray(value.tags) ? value.tags.map((item) => String(item)) : [],
    note: String(value.note || ''),
    finalPaymentUrl: String(value.finalPaymentUrl || ''),
    paymentMethod: String(value.paymentMethod || ''),
    finalUrlSource: String(value.finalUrlSource || ''),
    detectedMethods: Array.isArray(value.detectedMethods) ? value.detectedMethods.map((item) => String(item)) : [],
    paymentRunnerStatus: String(value.paymentRunnerStatus || ''),
    paymentRunnerStage: String(value.paymentRunnerStage || ''),
    paymentRunnerCode: String(value.paymentRunnerCode || ''),
    paymentCheckoutSessionMode: value.paymentCheckoutSessionMode === 'reuse_eligibility_session'
      ? 'reuse_eligibility_session'
      : 'independent_checkout',
    paymentCheckoutStatus: String(value.paymentCheckoutStatus || '') as ProbeHitRecord['paymentCheckoutStatus'],
    paymentCheckoutSessionDistinct: Boolean(value.paymentCheckoutSessionDistinct),
    paymentMethodLinks: Array.isArray(value.paymentMethodLinks)
      ? value.paymentMethodLinks.filter(isRecord).map((item) => ({
          method: String(item.method || ''),
          url: String(item.url || ''),
          status: String(item.status || 'runner_failed') as NonNullable<ProbeHitRecord['paymentMethodLinks']>[number]['status'],
          message: String(item.message || ''),
          checkoutCountry: String(item.checkoutCountry || '').toUpperCase(),
          currency: String(item.currency || '').toLowerCase(),
          capabilityScope: (item.capabilityScope === 'global' ? 'global' : item.capabilityScope === 'regional' ? 'regional' : undefined) as NonNullable<ProbeHitRecord['paymentMethodLinks']>[number]['capabilityScope'],
          currencyPolicy: (item.currencyPolicy === 'checkout' ? 'checkout' : item.currencyPolicy === 'fixed' ? 'fixed' : undefined) as NonNullable<ProbeHitRecord['paymentMethodLinks']>[number]['currencyPolicy'],
          expectedCurrency: String(item.expectedCurrency || '').toLowerCase(),
          sessionMode: (item.sessionMode === 'reuse_eligibility_session'
            ? 'reuse_eligibility_session'
            : 'independent_checkout') as NonNullable<ProbeHitRecord['paymentMethodLinks']>[number]['sessionMode'],
          sessionDistinct: Boolean(item.sessionDistinct),
          sourceQualificationVerified: item.sourceQualificationVerified === undefined
            ? undefined
            : Boolean(item.sourceQualificationVerified),
          forcedProbe: item.forcedProbe === undefined ? undefined : Boolean(item.forcedProbe),
          sourceSessionReused: item.sourceSessionReused === undefined
            ? undefined
            : Boolean(item.sourceSessionReused),
          methodOffered: item.methodOffered === undefined ? undefined : Boolean(item.methodOffered),
          qualificationPreserved: item.qualificationPreserved === undefined
            ? undefined
            : Boolean(item.qualificationPreserved),
          qualificationVerified: Boolean(item.qualificationVerified),
          finalLinkVerified: Boolean(item.finalLinkVerified),
          aggregateStatus: item.aggregateStatus === 'qualified_payment_link'
            ? 'qualified_payment_link'
            : 'probe_required' as NonNullable<ProbeHitRecord['paymentMethodLinks']>[number]['aggregateStatus'],
          runnerStatus: String(item.runnerStatus || ''),
          runnerCode: String(item.runnerCode || ''),
          createdAt: Number(item.createdAt || Date.now()),
        })).slice(0, 20)
      : [],
    qualificationVerified: Boolean(value.qualificationVerified),
    qualificationType: normalizeQualificationType(value.qualificationType),
    qualificationEvidenceLevel: normalizeLinkVerificationLevel(value.qualificationEvidenceLevel),
    qualificationLedger: normalizeQualificationLedger(value.qualificationLedger),
    qualificationDriftEvents: normalizeQualificationDriftEvents(value.qualificationDriftEvents),
    submittedPaymentMethod: String(value.submittedPaymentMethod || ''),
    paymentRunnerConfirmSubmitted: Boolean(value.paymentRunnerConfirmSubmitted),
    paymentRunnerConfirmSucceeded: Boolean(value.paymentRunnerConfirmSucceeded),
    paymentRunnerApproveSubmitted: Boolean(value.paymentRunnerApproveSubmitted),
    paymentRunnerApproveSucceeded: Boolean(value.paymentRunnerApproveSucceeded),
    finalLinkVerified: Boolean(value.finalLinkVerified),
    checkoutCreated: Boolean(value.checkoutCreated),
    qualificationGateVersion: String(value.qualificationGateVersion || ''),
    linkVerificationLevel: normalizeLinkVerificationLevel(value.linkVerificationLevel),
    linkUsable: Boolean(value.linkUsable),
    retryOrdinal: Math.max(1, Number(value.retryOrdinal || 1)),
    checkoutUiMode: value.checkoutUiMode === 'custom' || value.checkoutUiMode === 'both' ? value.checkoutUiMode : 'hosted',
    checkoutVariants: normalizeCheckoutVariants(value.checkoutVariants),
    checkoutRetryMetrics: normalizeCheckoutRetryMetrics(value.checkoutRetryMetrics),
    hostedResolutionStatus: normalizeHostedResolutionStatus(value.hostedResolutionStatus),
    hostedResolutionMessage: String(value.hostedResolutionMessage || ''),
    identitySnapshotReady: Boolean(value.identitySnapshotReady),
    resolvedCheckoutSessionType: value.resolvedCheckoutSessionType === 'oaics' || value.resolvedCheckoutSessionType === 'stripe'
      ? value.resolvedCheckoutSessionType
      : 'unknown',
    hostedResolutionMethods: Array.isArray(value.hostedResolutionMethods)
      ? [...new Set(value.hostedResolutionMethods.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean))].slice(0, 30)
      : [],
    stripeResourceCount: Math.max(0, Number(value.stripeResourceCount || 0)),
    stripePublishableKeyFound: Boolean(value.stripePublishableKeyFound),
    stripePublishableKeyVerified: Boolean(value.stripePublishableKeyVerified),
    stripeKeyOwnershipStatus: value.stripeKeyOwnershipStatus === 'verified'
      || value.stripeKeyOwnershipStatus === 'rejected'
      || value.stripeKeyOwnershipStatus === 'inconclusive'
      ? value.stripeKeyOwnershipStatus
      : 'not_checked',
    stripeKeyOwnershipCode: String(value.stripeKeyOwnershipCode || ''),
  };
}

function normalizeHostedResolutionStatus(value: unknown): ProbeHitRecord['hostedResolutionStatus'] {
  const status = String(value || 'not_required');
  return status === 'identity_required'
    || status === 'identity_mismatch'
    || status === 'resolved_hosted'
    || status === 'checkout_loaded'
    || status === 'failed'
    ? status
    : 'not_required';
}

function parseAccountLine(line: string): { email: string; tokenRaw: string } | null {
  if (line.includes('----')) {
    const parts = line.split('----').map((part) => part.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const email = parts[0].includes('@') ? parts[0] : '';
      const tokenRaw = parts[0].includes('@') ? parts.slice(1).join('----') : line;
      const token = tryExtractAccessToken(tokenRaw) || tokenRaw;
      if (!tryExtractAccessToken(token) && !token.includes('.')) {
        return null;
      }
      return { email, tokenRaw: token };
    }
  }
  const token = tryExtractAccessToken(line);
  if (!token) return null;
  return { email: guessEmailFromToken(token), tokenRaw: token };
}

function guessEmailFromToken(tokenRaw: string): string {
  try {
    const token = tryExtractAccessToken(tokenRaw) || tokenRaw;
    const payload = token.split('.')[1];
    if (!payload) return '';
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return String(json.email || json.user_email || json.preferred_username || '').trim();
  } catch {
    return '';
  }
}

function normalizeNotifyMode(value: unknown): ProbeNotifyMode {
  const mode = String(value || 'sound-badge');
  if (mode === 'sound-badge-pin' || mode === 'silent' || mode === 'sound-badge') {
    return mode;
  }
  return 'sound-badge';
}


const MAX_METHOD_DETECTIONS = 1000;
const MAX_PAYMENT_OPERATION_RECEIPTS = 200;

function normalizePaymentOperationReceipts(value: unknown): ProbeState['paymentOperationReceipts'] {
  if (!Array.isArray(value)) return [];
  const methods = new Set(['hosted', 'paypal', 'momo', 'gopay', 'ideal', 'upi', 'pix', 'blik', 'twint', 'kakao']);
  const stages = new Set(['screen', 'revalidate', 'createPM', 'confirm', 'approve', 'poll', 'finalize']);
  const statuses = new Set([
    'running', 'link_ready', 'not_qualified', 'method_unavailable', 'credential_terminal',
    'network_inconclusive', 'protocol_incompatible', 'side_effect_inconclusive',
    'invalid_final_url', 'stopped',
  ]);
  return value.filter(isRecord).map((item) => {
    const confirm = isRecord(item.confirm) ? item.confirm : null;
    const approve = isRecord(item.approve) ? item.approve : null;
    return {
      version: 1 as const,
      operationKey: String(item.operationKey || ''),
      checkoutSessionId: String(item.checkoutSessionId || ''),
      method: (methods.has(String(item.method)) ? item.method : 'hosted') as ProbeState['paymentOperationReceipts'][number]['method'],
      stage: (stages.has(String(item.stage)) ? item.stage : 'screen') as ProbeState['paymentOperationReceipts'][number]['stage'],
      status: (statuses.has(String(item.status)) ? item.status : 'running') as ProbeState['paymentOperationReceipts'][number]['status'],
      code: String(item.code || ''),
      updatedAt: Math.max(0, Number(item.updatedAt || 0)),
      confirmSubmitted: Boolean(item.confirmSubmitted),
      approveSubmitted: Boolean(item.approveSubmitted),
      sideEffect: (item.sideEffect === 'confirmed' || item.sideEffect === 'unknown'
        ? item.sideEffect
        : 'none') as ProbeState['paymentOperationReceipts'][number]['sideEffect'],
      paymentMethodId: String(item.paymentMethodId || '') || undefined,
      gate: normalizePaymentCheckpointGate(item.gate),
      confirm: confirm ? {
        requiresApproval: Boolean(confirm.requiresApproval),
        redirectUrl: String(confirm.redirectUrl || '') || undefined,
      } : undefined,
      approve: approve ? { approved: Boolean(approve.approved) } : undefined,
      finalUrl: String(item.finalUrl || '') || undefined,
    };
  }).filter((item) => item.operationKey && item.checkoutSessionId).slice(0, MAX_PAYMENT_OPERATION_RECEIPTS);
}

function normalizePaymentCheckpointGate(value: unknown): ProbeState['paymentOperationReceipts'][number]['gate'] {
  if (!isRecord(value)) return undefined;
  const amount = value.amount === null || value.amount === undefined ? null : Number(value.amount);
  const mode = value.mode === 'subscription' || value.mode === 'payment' ? value.mode : '';
  const reasons = (Array.isArray(value.reasons) ? value.reasons.map((item) => String(item)).filter(Boolean) : []) as unknown as NonNullable<ProbeState['paymentOperationReceipts'][number]['gate']>['reasons'];
  return {
    passed: Boolean(value.passed),
    amount: Number.isFinite(amount) ? amount : null,
    mode,
    currency: String(value.currency || '').toLowerCase(),
    methods: Array.isArray(value.methods) ? value.methods.map((item) => String(item).toLowerCase()).filter(Boolean) : [],
    reasons,
    checkedAt: Math.max(0, Number(value.checkedAt || 0)),
  };
}

function normalizeMethodDetections(value: unknown): ProbeMethodDetectionRecord[] {
  if (!Array.isArray(value)) return [];
  const out: ProbeMethodDetectionRecord[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const id = String(row.id || '').trim();
    const country = String(row.country || '').trim().toUpperCase();
    if (!id || !/^[A-Z]{2}$/.test(country)) continue;
    const methods = Array.isArray(row.methods) ? row.methods.map((m) => String(m || '').toLowerCase()).filter(Boolean) : [];
    const interestingMethods = Array.isArray(row.interestingMethods)
      ? row.interestingMethods.map((m) => String(m || '').toLowerCase()).filter(Boolean)
      : [];
    out.push({
      id,
      country,
      currency: String(row.currency || ''),
      accountId: String(row.accountId || ''),
      email: String(row.email || ''),
      methods: [...new Set(methods)],
      interestingMethods: [...new Set(interestingMethods)],
      amountHint: String(row.amountHint || ''),
      zeroLikely: Boolean(row.zeroLikely),
      source: String(row.source || ''),
      message: String(row.message || ''),
      checkoutSessionId: String(row.checkoutSessionId || ''),
      detectedAt: Number(row.detectedAt || 0) || 0,
      taskId: String(row.taskId || ''),
    });
  }
  return out.slice(0, MAX_METHOD_DETECTIONS);
}

export async function appendMethodDetection(detection: ProbeMethodDetectionRecord): Promise<ProbeState> {
  const current = await loadProbeState();
  const next = [detection, ...(current.methodDetections || [])].slice(0, MAX_METHOD_DETECTIONS);
  return saveProbeState({ methodDetections: next });
}

export async function clearMethodDetections(): Promise<ProbeState> {
  return saveProbeState({ methodDetections: [] });
}

export function buildCountryMethodRecommendations(
  detections: ProbeMethodDetectionRecord[],
): ProbeCountryMethodRecommendation[] {
  const map = new Map<string, ProbeMethodDetectionRecord[]>();
  for (const item of detections || []) {
    if (!item?.country) continue;
    const list = map.get(item.country) || [];
    list.push(item);
    map.set(item.country, list);
  }
  const rows: ProbeCountryMethodRecommendation[] = [];
  for (const [country, list] of map.entries()) {
    const methodCount = new Map<string, number>();
    const interestingCount = new Map<string, number>();
    let zeroSamples = 0;
    let lastDetectedAt = 0;
    for (const item of list) {
      if (item.zeroLikely) zeroSamples += 1;
      lastDetectedAt = Math.max(lastDetectedAt, item.detectedAt || 0);
      for (const method of item.methods || []) {
        methodCount.set(method, (methodCount.get(method) || 0) + 1);
      }
      for (const method of item.interestingMethods || []) {
        interestingCount.set(method, (interestingCount.get(method) || 0) + 1);
      }
    }
    const methods = [...methodCount.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
    const interestingMethods = [...interestingCount.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
    const recommendedPaymentMethod = interestingMethods[0] || methods[0] || '';
    rows.push({
      country,
      methods,
      interestingMethods,
      samples: list.length,
      zeroSamples,
      lastDetectedAt,
      recommendedPaymentMethod,
      note: recommendedPaymentMethod
        ? `推荐 ${recommendedPaymentMethod}（基于 ${list.length} 次探测到的支持方式）`
        : '尚无可用方式',
    });
  }
  return rows.sort((a, b) => b.samples - a.samples || a.country.localeCompare(b.country));
}

export function recommendMethodsForCountry(
  detections: ProbeMethodDetectionRecord[],
  country: string,
): ProbeCountryMethodRecommendation | null {
  const code = String(country || '').toUpperCase();
  return buildCountryMethodRecommendations(detections).find((item) => item.country === code) || null;
}

export function exportMethodDetectionsCsv(detections: ProbeMethodDetectionRecord[]): string {
  const header = ['detectedAt','country','currency','email','methods','interestingMethods','amountHint','zeroLikely','source','checkoutSessionId','message'];
  const lines = [header.join(',')];
  for (const item of detections || []) {
    const row = [
      new Date(item.detectedAt || 0).toISOString(),
      item.country,
      item.currency,
      item.email,
      (item.methods || []).join('|'),
      (item.interestingMethods || []).join('|'),
      item.amountHint,
      item.zeroLikely ? '1' : '0',
      item.source,
      item.checkoutSessionId,
      String(item.message || '').replace(/[\r\n,]/g, ' '),
    ];
    lines.push(row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
  }
  return lines.join('\n');
}

export function exportCountryMethodRecommendationsCsv(
  rows: ProbeCountryMethodRecommendation[],
): string {
  const header = ['country','recommendedPaymentMethod','methods','interestingMethods','samples','zeroSamples','lastDetectedAt','note'];
  const lines = [header.join(',')];
  for (const item of rows || []) {
    const row = [
      item.country,
      item.recommendedPaymentMethod,
      (item.methods || []).join('|'),
      (item.interestingMethods || []).join('|'),
      item.samples,
      item.zeroSamples,
      item.lastDetectedAt ? new Date(item.lastDetectedAt).toISOString() : '',
      item.note,
    ];
    lines.push(row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
  }
  return lines.join('\n');
}

function normalizeCountryCode(value: unknown, fallback = ''): string {
  const code = String(value || '').trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(code)) return code;
  return String(fallback || '').trim().toUpperCase();
}

function normalizeOptionalCountryCode(value: unknown): string {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : '';
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(num)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object');
}

function buildAccountBatchId(source: ProbeAccount['source'], timestamp: number): string {
  const date = new Date(timestamp || Date.now()).toISOString().slice(0, 10);
  return `${source}-${date}`;
}

function normalizeStageExit(value: unknown): ProbeObservation['auth'] {
  const source = isRecord(value) ? value : {};
  return {
    cycleId: String(source.cycleId || ''),
    configuredCountry: String(source.configuredCountry || source.country || '').trim().toUpperCase(),
    country: String(source.country || '').trim().toUpperCase(),
    ip: String(source.ip || '').trim(),
    asn: String(source.asn || '').trim().toUpperCase(),
    colo: String(source.colo || '').trim(),
    latencyMs: Math.max(0, Number(source.latencyMs || 0)),
    checkedAt: Math.max(0, Number(source.checkedAt || 0)),
    endpointSummary: String(source.endpointSummary || '').trim(),
    source: String(source.source || '').trim(),
    verified: Boolean(source.verified),
    message: String(source.message || ''),
  };
}

function normalizeObservation(value: unknown): ProbeObservation | null {
  if (!isRecord(value)) return null;
  const id = String(value.id || '').trim();
  const accountId = String(value.accountId || '').trim();
  const probeCountry = String(value.probeCountry || '').trim().toUpperCase();
  if (!id || !accountId || !probeCountry) return null;
  const outcome = String(value.outcome || 'miss');
  const normalizedOutcome = (['hit', 'miss', 'error'].includes(outcome) ? outcome : 'miss') as ProbeObservation['outcome'];
  const auth = normalizeStageExit(value.auth);
  const checkout = normalizeStageExit(value.checkout);
  const billing = normalizeStageExit(value.billing);
  const credentialStatus = value.credentialStatus === 'valid' || value.credentialStatus === 'invalid' || value.credentialStatus === 'unknown'
    ? value.credentialStatus
    : 'unchecked';
  const plannedAuthCountry = String(value.plannedAuthCountry || '').trim().toUpperCase();
  const plannedCheckoutCountry = String(value.plannedCheckoutCountry || probeCountry).trim().toUpperCase();
  const plannedBillingCountry = String(value.plannedBillingCountry || probeCountry).trim().toUpperCase();
  const plannedPaymentMethod = String(value.plannedPaymentMethod || value.paymentMethod || '').trim().toLowerCase();
  const submittedPaymentMethod = String(value.submittedPaymentMethod || '').trim().toLowerCase();
  const treatmentValidity = evaluateProbeTreatmentValidity({
    plannedAuthCountry,
    plannedCheckoutCountry,
    plannedBillingCountry,
    plannedPaymentMethod,
    submittedPaymentMethod,
    credentialStatus,
    outcome: normalizedOutcome,
    auth,
    checkout,
    billing,
  });
  return {
    id,
    observedAt: Number(value.observedAt || Date.now()),
    taskId: String(value.taskId || ''),
    runId: String(value.runId || ''),
    cycleId: String(value.cycleId || ''),
    unitId: String(value.unitId || ''),
    attemptId: String(value.attemptId || ''),
    round: Number(value.round || 0),
    sequence: Number(value.sequence || 0),
    researchMode: Boolean(value.researchMode),
    experimentMode: normalizeExperimentMode(value.experimentMode, Boolean(value.researchMode)),
    experimentArm: value.experimentArm === 'explore' || value.experimentArm === 'balanced'
      ? value.experimentArm
      : Boolean(value.researchMode) ? 'balanced' : 'exploit',
    designCellKey: String(value.designCellKey || `${accountId}|${probeCountry}|legacy|auto|1`),
    routeVariantId: String(value.routeVariantId || 'legacy'),
    plannedAuthCountry,
    plannedCheckoutCountry,
    plannedBillingCountry,
    plannedPaymentMethod,
    plannedSeedOrdinal: Math.max(1, Number(value.plannedSeedOrdinal || 1)),
    scheduleBlock: Number(value.scheduleBlock || 0),
    scheduleCellAttempt: Number(value.scheduleCellAttempt || 0),
    accountId,
    accountBatchId: String(value.accountBatchId || 'unknown'),
    accountSource: value.accountSource === 'automation' || value.accountSource === 'session' ? value.accountSource : 'manual',
    accountAgeHours: Number(value.accountAgeHours || 0),
    tokenAgeHours: Number(value.tokenAgeHours || 0),
    tokenExpiryHorizonHours: Number(value.tokenExpiryHorizonHours || 0),
    emailDomainCohort: String(value.emailDomainCohort || 'unknown').trim().toLowerCase(),
    browserProfileCohort: String(value.browserProfileCohort || 'default'),
    deviceCohort: String(value.deviceCohort || value.browserFamily || 'unknown'),
    probeCountry,
    bootstrapCountry: String(value.bootstrapCountry || probeCountry).trim().toUpperCase(),
    promotionCountry: String(value.promotionCountry || '').trim().toUpperCase(),
    providerCountry: String(value.providerCountry || probeCountry).trim().toUpperCase(),
    channels: Array.isArray(value.channels) ? value.channels.map((item) => String(item)) : [],
    planName: value.planName === 'chatgptteamplan' ? 'chatgptteamplan' : 'chatgptplusplan',
    paymentMethod: String(value.paymentMethod || '').trim().toLowerCase(),
    currency: String(value.currency || '').trim().toUpperCase(),
    campaignId: String(value.campaignId || ''),
    productId: String(value.productId || value.planName || ''),
    checkoutMode: String(value.checkoutMode || (value.stagedPipelineEnabled ? 'staged' : 'direct')),
    outcome: normalizedOutcome,
    hitKind: String(value.hitKind || 'none') as ProbeObservation['hitKind'],
    amountHint: String(value.amountHint || ''),
    promoHint: String(value.promoHint || ''),
    detectedMethods: Array.isArray(value.detectedMethods) ? value.detectedMethods.map((item) => String(item)) : [],
    paymentRunnerStatus: String(value.paymentRunnerStatus || ''),
    paymentRunnerStage: String(value.paymentRunnerStage || ''),
    paymentRunnerCode: String(value.paymentRunnerCode || ''),
    paymentCheckoutSessionMode: value.paymentCheckoutSessionMode === 'reuse_eligibility_session'
      ? 'reuse_eligibility_session'
      : 'independent_checkout',
    paymentCheckoutStatus: String(value.paymentCheckoutStatus || '') as ProbeObservation['paymentCheckoutStatus'],
    paymentCheckoutSessionDistinct: Boolean(value.paymentCheckoutSessionDistinct),
    paymentMethodLinkCount: Math.max(0, Number(value.paymentMethodLinkCount || 0)),
    qualificationVerified: Boolean(value.qualificationVerified),
    qualificationType: normalizeQualificationType(value.qualificationType),
    qualificationEvidenceLevel: normalizeLinkVerificationLevel(value.qualificationEvidenceLevel),
    qualificationDriftCount: Math.max(0, Number(value.qualificationDriftCount || 0)),
    submittedPaymentMethod,
    paymentRunnerConfirmSubmitted: Boolean(value.paymentRunnerConfirmSubmitted),
    paymentRunnerConfirmSucceeded: Boolean(value.paymentRunnerConfirmSucceeded),
    paymentRunnerApproveSubmitted: Boolean(value.paymentRunnerApproveSubmitted),
    paymentRunnerApproveSucceeded: Boolean(value.paymentRunnerApproveSucceeded),
    finalLinkVerified: Boolean(value.finalLinkVerified),
    checkoutCreated: Boolean(value.checkoutCreated || value.link || value.longUrl || value.shortUrl),
    qualificationGateVersion: String(value.qualificationGateVersion || ''),
    linkVerificationLevel: normalizeLinkVerificationLevel(value.linkVerificationLevel),
    linkUsable: Boolean(value.linkUsable),
    credentialStatus,
    ...treatmentValidity,
    errorClass: String(value.errorClass || ''),
    durationMs: Number(value.durationMs || 0),
    configuredRetries: Number(value.configuredRetries || 0),
    retryOrdinal: Math.max(1, Number(value.retryOrdinal || 1)),
    checkoutUiMode: value.checkoutUiMode === 'custom' || value.checkoutUiMode === 'both' ? value.checkoutUiMode : 'hosted',
    checkoutAttempts: Math.max(0, Number(value.checkoutAttempts || 0)),
    updateAttempts: Math.max(0, Number(value.updateAttempts || 0)),
    fullFlowAttempts: Math.max(0, Number(value.fullFlowAttempts || 0)),
    cfRetryCount: Math.max(0, Number(value.cfRetryCount || 0)),
    cfExitRotations: Math.max(0, Number(value.cfExitRotations || 0)),
    invalidPromotionRebuilds: Math.max(0, Number(value.invalidPromotionRebuilds || 0)),
    pageFallbackAttempts: Math.max(0, Number(value.pageFallbackAttempts || 0)),
    cooldownElapsedMinutes: Math.max(0, Number(value.cooldownElapsedMinutes || 0)),
    stagedPipelineEnabled: Boolean(value.stagedPipelineEnabled),
    entryProxyMode: value.entryProxyMode === 'exit1' || value.entryProxyMode === 'none' ? value.entryProxyMode : 'front',
    exitProxyMode: value.exitProxyMode === 'fixed-exit2' || value.exitProxyMode === 'fixed-front' || value.exitProxyMode === 'none'
      ? value.exitProxyMode
      : 'follow-country',
    frontProxySummary: String(value.frontProxySummary || ''),
    auth,
    checkout,
    billing,
    bootstrapSeedSummary: String(value.bootstrapSeedSummary || ''),
    promotionSeedSummary: String(value.promotionSeedSummary || ''),
    providerSeedSummary: String(value.providerSeedSummary || ''),
    extensionVersion: String(value.extensionVersion || ''),
    browserFamily: String(value.browserFamily || ''),
    locale: String(value.locale || ''),
    timeZone: String(value.timeZone || 'UTC'),
    localeExitAlignment: normalizeAlignment(value.localeExitAlignment),
    timeZoneExitAlignment: normalizeAlignment(value.timeZoneExitAlignment),
    checkoutSubnet: String(value.checkoutSubnet || ipSubnet(normalizeStageExit(value.checkout).ip)),
    checkoutNetworkType: value.checkoutNetworkType === 'residential' || value.checkoutNetworkType === 'hosting'
      ? value.checkoutNetworkType
      : 'unknown',
    checkoutSchemaFingerprint: String(value.checkoutSchemaFingerprint || ''),
    offerSetFingerprint: String(value.offerSetFingerprint || ''),
    upstreamProtocolFingerprint: String(value.upstreamProtocolFingerprint || ''),
    ruleEpochId: String(value.ruleEpochId || value.upstreamProtocolFingerprint || ''),
  };
}

function normalizeAlignment(value: unknown): 'match' | 'mismatch' | 'unknown' {
  return value === 'match' || value === 'mismatch' ? value : 'unknown';
}

function ipSubnet(value: string): string {
  const text = String(value || '').trim();
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(text)) return `${text.split('.').slice(0, 3).join('.')}.0/24`;
  if (text.includes(':')) return `${text.split(':').slice(0, 4).join(':')}::/64`;
  return '';
}


export async function recordProbeAttempt(input: {
  country: string;
  channels: string[];
  ok: boolean;
  hit: boolean;
  message: string;
}): Promise<ProbeState> {
  const current = await loadProbeState();
  const channels = input.channels.length ? input.channels : ['hosted'];
  const now = Date.now();
  let stats = [...current.stats];
  for (const channel of channels) {
    const idx = stats.findIndex((item) => item.country === input.country && item.channel === channel);
    if (idx >= 0) {
      const prev = stats[idx];
      stats[idx] = {
        ...prev,
        attempts: prev.attempts + 1,
        hits: prev.hits + (input.hit ? 1 : 0),
        errors: prev.errors + (input.ok ? 0 : 1),
        lastHitAt: input.hit ? now : prev.lastHitAt,
        lastMessage: input.message,
      };
    } else {
      stats.push({
        country: input.country,
        channel,
        attempts: 1,
        hits: input.hit ? 1 : 0,
        errors: input.ok ? 0 : 1,
        lastHitAt: input.hit ? now : 0,
        lastMessage: input.message,
      });
    }
  }
  // keep compact
  stats = stats
    .sort((a, b) => (b.hits - a.hits) || (b.attempts - a.attempts) || a.country.localeCompare(b.country))
    .slice(0, 500);
  return saveProbeState({ stats });
}

export async function appendProbeObservation(
  observationInput: ProbeObservation,
  configInput?: Partial<Pick<ProbeTaskConfig,
    'factorMinSamples' | 'driftMinSamples' | 'driftDetectionEnabled' | 'adaptiveExplorationPercent' | 'observationRetentionLimit'>>,
): Promise<ProbeState> {
  const observation = normalizeObservation(observationInput);
  if (!observation) return loadProbeState();
  const current = await loadProbeState();
  const activeConfig = current.tasks.find((item) => item.id === observation.taskId)?.config
    || current.tasks.find((item) => item.id === current.activeTaskId)?.config
    || DEFAULT_PROBE_TASK_CONFIG;
  const config = {
    factorMinSamples: configInput?.factorMinSamples ?? activeConfig.factorMinSamples,
    driftMinSamples: configInput?.driftMinSamples ?? activeConfig.driftMinSamples,
    driftDetectionEnabled: configInput?.driftDetectionEnabled ?? activeConfig.driftDetectionEnabled,
    adaptiveExplorationPercent: configInput?.adaptiveExplorationPercent ?? activeConfig.adaptiveExplorationPercent,
    observationRetentionLimit: configInput?.observationRetentionLimit ?? activeConfig.observationRetentionLimit,
  };
  const limit = clampInt(config.observationRetentionLimit, 500, 10000, DEFAULT_MAX_OBSERVATIONS);
  const observations = [observation, ...current.observations.filter((item) => item.id !== observation.id)].slice(0, limit);
  const driftAlerts = config.driftDetectionEnabled
    ? detectEligibilityDrift(observations, { minSamples: clampInt(config.driftMinSamples, 2, 500, 10) }).slice(0, MAX_DRIFT_ALERTS)
    : [];
  const factorReport = buildFactorAnalysis(observations, clampInt(config.factorMinSamples, 2, 200, 5), { driftAlerts });
  const adaptiveRecommendations = recommendAdaptiveExperiments(
    factorReport,
    driftAlerts,
    clampInt(config.adaptiveExplorationPercent, 5, 50, 20),
  );
  const archiveStatus = await getProbeArchiveRepository().upsertObservations([observation]);
  return saveProbeState({ observations, factorReport, driftAlerts, adaptiveRecommendations, archiveStatus });
}

export async function importProbeObservations(
  values: unknown[],
  mode: 'merge' | 'replace' = 'merge',
): Promise<{ state: ProbeState; imported: number; rejected: number; duplicates: number }> {
  const current = await loadProbeState();
  const normalized: ProbeObservation[] = [];
  let rejected = 0;
  let duplicates = 0;
  const incomingIds = new Set<string>();
  for (const value of values) {
    const observation = normalizeObservation(value);
    if (!observation) {
      rejected += 1;
      continue;
    }
    if (incomingIds.has(observation.id)) {
      duplicates += 1;
      continue;
    }
    incomingIds.add(observation.id);
    normalized.push(observation);
  }
  const existingIds = new Set(current.observations.map((item) => item.id));
  if (mode === 'merge') {
    duplicates += normalized.filter((item) => existingIds.has(item.id)).length;
  }
  const activeConfig = current.tasks.find((item) => item.id === current.activeTaskId)?.config
    || current.tasks[0]?.config
    || DEFAULT_PROBE_TASK_CONFIG;
  const limit = clampInt(activeConfig.observationRetentionLimit, 500, 10000, DEFAULT_MAX_OBSERVATIONS);
  const merged = mode === 'replace'
    ? normalized
    : [...normalized, ...current.observations.filter((item) => !incomingIds.has(item.id))];
  const observations = merged
    .sort((a, b) => b.observedAt - a.observedAt)
    .slice(0, limit);
  if (mode === 'replace') await getProbeArchiveRepository().clear('observations');
  const archiveStatus = await getProbeArchiveRepository().upsertObservations(normalized);
  const state = await saveProbeState({ observations, archiveStatus });
  return { state, imported: normalized.length, rejected, duplicates };
}

export async function clearProbeFactorData(): Promise<ProbeState> {
  const archiveStatus = await getProbeArchiveRepository().clear('observations');
  return saveProbeState({
    observations: [],
    factorReport: EMPTY_FACTOR_REPORT,
    driftAlerts: [],
    adaptiveRecommendations: [],
    archiveStatus,
  });
}

export async function saveProxyHealth(items: ProbeProxyHealthItem[]): Promise<ProbeState> {
  const current = await loadProbeState();
  const map = new Map(current.proxyHealth.map((item) => [item.country, item]));
  for (const item of items) {
    map.set(item.country, item);
  }
  const proxyHealth = [...map.values()].sort((a, b) => a.country.localeCompare(b.country));
  return saveProbeState({ proxyHealth });
}

function normalizeStatsCell(value: unknown): ProbeStatsCell | null {
  if (!isRecord(value)) return null;
  const country = String(value.country || '').trim().toUpperCase();
  const channel = String(value.channel || '').trim().toLowerCase();
  if (!country || !channel) return null;
  return {
    country,
    channel,
    attempts: Number(value.attempts || 0),
    hits: Number(value.hits || 0),
    errors: Number(value.errors || 0),
    lastHitAt: Number(value.lastHitAt || 0),
    lastMessage: String(value.lastMessage || ''),
  };
}

function normalizeProxyHealth(value: unknown): ProbeProxyHealthItem | null {
  if (!isRecord(value)) return null;
  const country = String(value.country || '').trim().toUpperCase();
  if (!country) return null;
  const status = String(value.status || 'unknown');
  return {
    country,
    status: (['unknown', 'ok', 'fail', 'skip'].includes(status) ? status : 'unknown') as ProbeProxyHealthItem['status'],
    latencyMs: Number(value.latencyMs || 0),
    endpointSummary: String(value.endpointSummary || ''),
    message: String(value.message || ''),
    checkedAt: Number(value.checkedAt || 0),
    actualIp: String(value.actualIp || ''),
    actualCountry: String(value.actualCountry || '').trim().toUpperCase(),
    colo: String(value.colo || ''),
    asn: String(value.asn || '').toUpperCase(),
    asOrganization: String(value.asOrganization || ''),
    ipVersion: value.ipVersion === 'IPv4' || value.ipVersion === 'IPv6' ? value.ipVersion : '',
    networkType: value.networkType === 'residential' || value.networkType === 'hosting' ? value.networkType : 'unknown',
  };
}

function normalizeSniff(value: unknown): ProbeCheckoutSniff | undefined {
  if (!isRecord(value)) return undefined;
  return {
    checked: Boolean(value.checked),
    ok: Boolean(value.ok),
    amountText: String(value.amountText || ''),
    trialText: String(value.trialText || ''),
    zeroLikely: Boolean(value.zeroLikely),
    trialLikely: Boolean(value.trialLikely),
    pageUrl: String(value.pageUrl || ''),
    message: String(value.message || ''),
    checkedAt: Number(value.checkedAt || 0),
  };
}


export async function saveHitToDatabase(hit: ProbeHitRecord, taskName = ''): Promise<ProbeState> {
  const current = await loadProbeState();
  const enriched = enrichHitClassification(hit);
  const dbId = enriched.dbId || `hitdb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const record: ProbeHitDatabaseRecord = {
    ...enriched,
    dbId,
    savedAt: Date.now(),
    sourceTaskName: taskName || enriched.taskId || '',
    archived: false,
    savedToDb: true,
  };
  // de-dupe by link+email+country
  const nextDb = [
    record,
    ...current.hitDatabase.filter((item) => !(item.link && record.link && item.link === record.link && item.email === record.email && item.country === record.country)),
  ].slice(0, MAX_HIT_DB);
  const archiveStatus = await getProbeArchiveRepository().upsertHits([record]);
  return saveProbeState({ hitDatabase: nextDb, archiveStatus });
}

export async function appendProbeHitAndMaybePersist(
  hit: ProbeHitRecord,
  options: { saveToDb: boolean; taskName?: string },
): Promise<{ state: ProbeState; hit: ProbeHitRecord }> {
  let nextHit = enrichHitClassification(hit);
  let state = await appendProbeHit(nextHit);
  if (options.saveToDb && nextHit.link) {
    for (const persistentHit of expandCheckoutVariantsForPersistence(nextHit)) {
      state = await saveHitToDatabase(persistentHit, options.taskName || '');
    }
    nextHit = { ...nextHit, savedToDb: true, dbId: state.hitDatabase[0]?.dbId || nextHit.dbId };
    state = await saveProbeState({
      hits: state.hits.map((item) => item.id === nextHit.id ? { ...item, savedToDb: true, dbId: nextHit.dbId, tags: nextHit.tags, note: nextHit.note, hitKind: nextHit.hitKind } : item),
    });
  }
  return { state, hit: nextHit };
}

export function expandCheckoutVariantsForPersistence(hit: ProbeHitRecord): ProbeHitRecord[] {
  const variants = (hit.checkoutVariants || []).filter((item) => item.ok && item.link);
  if (variants.length <= 1) return [hit];
  return variants.map((variant) => {
    const variantQualified = variant.amount.verification === 'verified-zero'
      || (hit.qualificationVerified && variant.amount.verification !== 'verified-nonzero');
    return {
      ...hit,
      id: `${hit.id}-${variant.uiMode}`,
      link: variant.link,
      longUrl: variant.longUrl,
      shortUrl: variant.shortUrl,
      message: `${hit.message} · ${variant.uiMode} 独立保存`,
      amountHint: variant.amount.amountHint || hit.amountHint,
      currency: variant.amount.currency || hit.currency,
      qualificationVerified: variantQualified,
      linkUsable: variantQualified,
      checkoutUiMode: variant.uiMode,
      checkoutVariants: [variant],
      checkoutRetryMetrics: variant.retryMetrics,
      tags: [...new Set([...(hit.tags || []), `checkout-${variant.uiMode}`])],
    };
  });
}

export function queryHitDatabase(
  records: ProbeHitDatabaseRecord[],
  filter: Partial<ProbeHitDashboardFilter> = {},
): { records: ProbeHitDatabaseRecord[]; summary: ProbeHitDashboardSummary } {
  const country = String(filter.country || '').trim().toUpperCase();
  const hitKind = String(filter.hitKind || '').trim().toLowerCase();
  const email = String(filter.email || '').trim().toLowerCase();
  const query = String(filter.query || '').trim().toLowerCase();
  const onlyWithLink = Boolean(filter.onlyWithLink);
  const onlyUsableLinks = Boolean(filter.onlyUsableLinks);
  const filtered = records.filter((item) => {
    if (item.archived) return false;
    if (country && item.country !== country) return false;
    if (hitKind && item.hitKind !== hitKind) return false;
    if (email && !item.email.toLowerCase().includes(email)) return false;
    if (onlyWithLink && !item.link) return false;
    if (onlyUsableLinks && !item.linkUsable) return false;
    if (query) {
      const bag = `${item.email} ${item.country} ${item.link} ${item.message} ${item.amountHint} ${item.promoHint}`.toLowerCase();
      if (!bag.includes(query)) return false;
    }
    return true;
  });
  const summary: ProbeHitDashboardSummary = {
    total: filtered.length,
    withLink: filtered.filter((item) => Boolean(item.link)).length,
    usableLinks: filtered.filter((item) => Boolean(item.link && item.linkUsable)).length,
    qualified: filtered.filter((item) => item.qualificationVerified).length,
    zero: filtered.filter((item) => item.hitKind === 'zero').length,
    trial: filtered.filter((item) => item.hitKind === 'trial').length,
    promo: filtered.filter((item) => item.hitKind === 'promo').length,
    countries: new Set(filtered.map((item) => item.country)).size,
    latestAt: filtered.reduce((max, item) => Math.max(max, item.createdAt || item.savedAt || 0), 0),
  };
  return { records: filtered, summary };
}

export async function deleteHitDatabaseRecord(dbId: string): Promise<ProbeState> {
  const current = await loadProbeState();
  const archiveStatus = await getProbeArchiveRepository().deleteHit(dbId);
  return saveProbeState({
    hitDatabase: current.hitDatabase.filter((item) => item.dbId !== dbId),
    archiveStatus,
  });
}

function normalizeArchiveStatus(value: unknown): ProbeArchiveStatus {
  if (!isRecord(value)) return { ...EMPTY_ARCHIVE_STATUS };
  return {
    available: Boolean(value.available),
    degraded: Boolean(value.degraded),
    backend: value.backend === 'indexeddb' ? 'indexeddb' : 'local',
    schemaVersion: Math.max(1, Number(value.schemaVersion || 1)),
    migratedAt: Number(value.migratedAt || 0),
    observationCount: Math.max(0, Number(value.observationCount || 0)),
    hitCount: Math.max(0, Number(value.hitCount || 0)),
    runCount: Math.max(0, Number(value.runCount || 0)),
    retentionDays: Math.max(0, Number(value.retentionDays || 0)),
    lastPrunedAt: Math.max(0, Number(value.lastPrunedAt || 0)),
    lastError: String(value.lastError || '').slice(0, 500),
  };
}

export async function clearHitDatabase(): Promise<ProbeState> {
  const archiveStatus = await getProbeArchiveRepository().clear('hits');
  return saveProbeState({ hitDatabase: [], archiveStatus });
}

export function exportHitDatabaseCsv(records: ProbeHitDatabaseRecord[]): string {
  const header = ['savedAt', 'createdAt', 'email', 'country', 'currency', 'hitKind', 'checkoutUiMode', 'checkoutVariants', 'checkoutAttempts', 'updateAttempts', 'fullFlowAttempts', 'cfRetryCount', 'cfExitRotations', 'invalidPromotionRebuilds', 'pageFallbackAttempts', 'checkoutCreated', 'qualificationVerified', 'qualificationGateVersion', 'hostedResolutionStatus', 'hostedResolutionMessage', 'identitySnapshotReady', 'resolvedCheckoutSessionType', 'hostedResolutionMethods', 'stripeResourceCount', 'stripePublishableKeyFound', 'stripePublishableKeyVerified', 'stripeKeyOwnershipStatus', 'stripeKeyOwnershipCode', 'submittedPaymentMethod', 'finalLinkVerified', 'linkVerificationLevel', 'linkUsable', 'paymentCheckoutSessionMode', 'paymentCheckoutStatus', 'paymentCheckoutSessionDistinct', 'paymentMethodLinks', 'amountHint', 'promoHint', 'channels', 'link', 'longUrl', 'shortUrl', 'message', 'task', 'dbId'];
  const lines = [header.join(',')];
  for (const item of records) {
    const row = [
      formatCsvDate(item.savedAt || item.createdAt),
      formatCsvDate(item.createdAt),
      item.email,
      item.country,
      item.currency,
      item.hitKind,
      item.checkoutUiMode || 'hosted',
      (item.checkoutVariants || []).map((variant) => `${variant.uiMode}|${variant.ok}|${variant.amount.verification}|${variant.link}`).join(';'),
      item.checkoutRetryMetrics?.checkoutAttempts || 0,
      item.checkoutRetryMetrics?.updateAttempts || 0,
      item.checkoutRetryMetrics?.fullFlowAttempts || 0,
      item.checkoutRetryMetrics?.cfRetryCount || 0,
      item.checkoutRetryMetrics?.cfExitRotations || 0,
      item.checkoutRetryMetrics?.invalidPromotionRebuilds || 0,
      item.checkoutRetryMetrics?.pageFallbackAttempts || 0,
      item.checkoutCreated,
      item.qualificationVerified,
      item.qualificationGateVersion,
      item.hostedResolutionStatus || 'not_required',
      item.hostedResolutionMessage || '',
      Boolean(item.identitySnapshotReady),
      item.resolvedCheckoutSessionType || 'unknown',
      (item.hostedResolutionMethods || []).join('|'),
      item.stripeResourceCount || 0,
      Boolean(item.stripePublishableKeyFound),
      Boolean(item.stripePublishableKeyVerified),
      item.stripeKeyOwnershipStatus || 'not_checked',
      item.stripeKeyOwnershipCode || '',
      item.submittedPaymentMethod,
      item.finalLinkVerified,
      item.linkVerificationLevel,
      item.linkUsable,
      item.paymentCheckoutSessionMode || '',
      item.paymentCheckoutStatus || '',
      item.paymentCheckoutSessionDistinct,
      (item.paymentMethodLinks || []).map((link) => [
        link.method,
        link.status,
        `forced=${Boolean(link.forcedProbe)}`,
        `sourceQualified=${Boolean(link.sourceQualificationVerified)}`,
        `reused=${Boolean(link.sourceSessionReused)}`,
        `offered=${Boolean(link.methodOffered)}`,
        `preserved=${Boolean(link.qualificationPreserved)}`,
        `scope=${link.capabilityScope || ''}`,
        `currencyPolicy=${link.currencyPolicy || ''}`,
        `expectedCurrency=${link.expectedCurrency || ''}`,
        link.url,
      ].join('|')).join(';'),
      item.amountHint,
      item.promoHint,
      (item.channels || []).join('|'),
      item.link,
      item.longUrl,
      item.shortUrl,
      item.message,
      item.sourceTaskName,
      item.dbId,
    ].map(csvEscape);
    lines.push(row.join(','));
  }
  return lines.join('\n');
}

export function rankProbeCountries(input: {
  selectedCountries?: string[];
  stats: ProbeStatsCell[];
  proxyHealth?: ProbeProxyHealthItem[];
  config: Pick<ProbeTaskConfig, 'minHitRatePercent' | 'minHitAttempts' | 'maxHighRateCountries' | 'excludeUnhealthyExits' | 'highHitRateOnly'>;
}): ProbeCountryScore[] {
  const selectedSet = new Set((input.selectedCountries || []).map((item) => item.toUpperCase()).filter(Boolean));
  const healthMap = new Map((input.proxyHealth || []).map((item) => [item.country, item.status]));
  const byCountry = new Map<string, { attempts: number; hits: number; errors: number; lastHitAt: number }>();
  for (const cell of input.stats || []) {
    const country = String(cell.country || '').toUpperCase();
    if (!country) continue;
    const prev = byCountry.get(country) || { attempts: 0, hits: 0, errors: 0, lastHitAt: 0 };
    // One evaluation may be attributed to multiple channels. Max avoids
    // inflating country sample size when the same result exposes several methods.
    prev.attempts = Math.max(prev.attempts, Number(cell.attempts || 0));
    prev.hits = Math.max(prev.hits, Number(cell.hits || 0));
    prev.errors = Math.max(prev.errors, Number(cell.errors || 0));
    prev.lastHitAt = Math.max(prev.lastHitAt, Number(cell.lastHitAt || 0));
    byCountry.set(country, prev);
  }
  const countries = selectedSet.size
    ? [...selectedSet]
    : [...byCountry.keys()];
  const minRate = input.config.minHitRatePercent;
  const minAttempts = input.config.minHitAttempts;
  const rows: ProbeCountryScore[] = countries.map((country) => {
    const stat = byCountry.get(country) || { attempts: 0, hits: 0, errors: 0, lastHitAt: 0 };
    const rate = stat.attempts > 0 ? (stat.hits / stat.attempts) * 100 : 0;
    const confidence = wilsonInterval(stat.hits, stat.attempts);
    const health = (healthMap.get(country) || 'unknown') as ProbeCountryScore['health'];
    const unhealthy = health === 'fail' || health === 'skip';
    const qualified = stat.attempts >= minAttempts
      && rate >= minRate
      && (!input.config.excludeUnhealthyExits || !unhealthy || !healthMap.size);
    return {
      country,
      attempts: stat.attempts,
      hits: stat.hits,
      errors: stat.errors,
      rate: Math.round(rate * 10) / 10,
      confidenceLow: confidence.low,
      confidenceHigh: confidence.high,
      health,
      qualified,
      lastHitAt: stat.lastHitAt,
      selected: selectedSet.has(country),
    };
  }).sort((a, b) => {
    if (a.qualified !== b.qualified) return a.qualified ? -1 : 1;
    if (b.confidenceLow !== a.confidenceLow) return b.confidenceLow - a.confidenceLow;
    if (b.rate !== a.rate) return b.rate - a.rate;
    if (b.hits !== a.hits) return b.hits - a.hits;
    if (b.attempts !== a.attempts) return b.attempts - a.attempts;
    return a.country.localeCompare(b.country);
  });
  if (input.config.maxHighRateCountries > 0) {
    // keep full ranking for display; consumers can slice qualified list
  }
  return rows;
}

export function recommendHighHitCountries(input: {
  selectedCountries: string[];
  stats: ProbeStatsCell[];
  proxyHealth?: ProbeProxyHealthItem[];
  config: ProbeTaskConfig;
}): string[] {
  const ranked = rankProbeCountries(input);
  const qualified = ranked.filter((item) => item.qualified).map((item) => item.country);
  if (!qualified.length) {
    // fallback: top by hits among selected/all with any attempts
    return ranked.filter((item) => item.attempts > 0).slice(0, Math.max(1, input.config.maxHighRateCountries || 12)).map((item) => item.country);
  }
  return input.config.maxHighRateCountries > 0
    ? qualified.slice(0, input.config.maxHighRateCountries)
    : qualified;
}

export function selectCountriesForProbe(input: {
  selectedCountries: string[];
  stats: ProbeStatsCell[];
  proxyHealth: ProbeProxyHealthItem[];
  config: ProbeTaskConfig;
  round?: number;
}): {
  countries: string[];
  excludedUnhealthy: string[];
  excludedLowRate: string[];
  experimentalCountries: string[];
  note: string;
} {
  let countries = [...new Set(input.selectedCountries.map((item) => item.toUpperCase()).filter(Boolean))];
  const excludedUnhealthy: string[] = [];
  const excludedLowRate: string[] = [];
  const experimentalCountries: string[] = [];

  if (input.config.excludeUnhealthyExits && input.proxyHealth.length) {
    const healthMap = new Map(input.proxyHealth.map((item) => [item.country, item.status]));
    const next: string[] = [];
    for (const country of countries) {
      const status = healthMap.get(country);
      if (status === 'fail' || status === 'skip') {
        excludedUnhealthy.push(country);
      } else {
        next.push(country);
      }
    }
    countries = next;
  }

  if (input.config.highHitRateOnly) {
    const minRate = input.config.minHitRatePercent;
    const minAttempts = input.config.minHitAttempts;
    const byCountry = new Map<string, { attempts: number; hits: number }>();
    for (const cell of input.stats) {
      const prev = byCountry.get(cell.country) || { attempts: 0, hits: 0 };
      prev.attempts = Math.max(prev.attempts, cell.attempts);
      prev.hits = Math.max(prev.hits, cell.hits);
      byCountry.set(cell.country, prev);
    }
    const scored = countries.map((country) => {
      const stat = byCountry.get(country) || { attempts: 0, hits: 0 };
      const rate = stat.attempts > 0 ? (stat.hits / stat.attempts) * 100 : -1;
      const confidence = wilsonInterval(stat.hits, stat.attempts);
      return { country, attempts: stat.attempts, hits: stat.hits, rate, confidenceLow: confidence.low };
    });
    const qualified = scored
      .filter((item) => item.attempts >= minAttempts && item.rate >= minRate)
      .sort((a, b) => (b.confidenceLow - a.confidenceLow) || (b.rate - a.rate) || (b.hits - a.hits) || a.country.localeCompare(b.country));
    const limited = input.config.maxHighRateCountries > 0
      ? qualified.slice(0, input.config.maxHighRateCountries)
      : qualified;
    const keep = new Set(limited.map((item) => item.country));
    const adaptiveCount = input.config.factorTrackingEnabled
      ? Math.ceil(scored.length * input.config.adaptiveExplorationPercent / 100)
      : 0;
    const explorationCount = Math.max(input.config.explorationCountryCount, adaptiveCount);
    if (input.config.explorationEnabled && explorationCount > 0) {
      const candidates = scored
        .filter((item) => !keep.has(item.country))
        .sort((a, b) => (a.attempts - b.attempts) || (b.rate - a.rate) || a.country.localeCompare(b.country));
      if (candidates.length) {
        const offset = Math.max(0, Number(input.round || 0)) % candidates.length;
        const rotated = [...candidates.slice(offset), ...candidates.slice(0, offset)];
        experimentalCountries.push(
          ...rotated
            .slice(0, Math.min(explorationCount, rotated.length))
            .map((item) => item.country),
        );
      }
    }
    countries = [
      ...limited.map((item) => item.country),
      ...experimentalCountries,
    ];
    const activeCountries = new Set(countries);
    for (const item of scored) {
      if (!activeCountries.has(item.country)) excludedLowRate.push(item.country);
    }
  }

  const noteParts = [
    `有效国家 ${countries.length}`,
    excludedUnhealthy.length ? `健康剔除 ${excludedUnhealthy.length}` : '',
    excludedLowRate.length ? `本轮暂缓 ${excludedLowRate.length}` : '',
    experimentalCountries.length ? `实验保留 ${experimentalCountries.length}` : '',
  ].filter(Boolean);
  return {
    countries,
    excludedUnhealthy,
    excludedLowRate,
    experimentalCountries,
    note: noteParts.join(' · '),
  };
}

export function buildHitTags(hit: Pick<ProbeHitRecord, 'hitKind' | 'amountHint' | 'promoHint' | 'channels' | 'sniff' | 'link' | 'message'>): string[] {
  const tags = new Set<string>();
  const kind = String(hit.hitKind || '').toLowerCase();
  if (kind && kind !== 'none' && kind !== 'error') tags.add(kind);
  const bag = `${hit.amountHint || ''} ${hit.promoHint || ''} ${hit.message || ''} ${hit.sniff?.message || ''} ${hit.sniff?.trialText || ''}`.toLowerCase();
  if (hit.sniff?.zeroLikely || kind === 'zero' || /(?:^|[^\d])0(?:[.,]00)?(?:[^\d]|$)/.test(hit.amountHint || '') || /amount\s*=\s*0\b/.test(bag)) {
    tags.add('zero');
    tags.add('资格优');
  }
  if (hit.sniff?.trialLikely || kind === 'trial' || /trial|free_trial|1-month-free|试用|首月/.test(bag)) {
    tags.add('trial');
    tags.add('试用');
  }
  if (kind === 'promo' || /promo|coupon|campaign|discount|1-month-free/.test(bag)) {
    tags.add('promo');
    tags.add('优惠');
  }
  if (hit.link) tags.add('有链接');
  for (const channel of hit.channels || []) {
    if (channel) tags.add(`通道:${channel}`);
  }
  if (hit.sniff?.checked) tags.add(hit.sniff.ok ? '页面已验' : '页面验失败');
  return [...tags];
}

export function enrichHitClassification<T extends ProbeHitRecord>(hit: T): T {
  const tags = buildHitTags(hit);
  let hitKind = hit.hitKind;
  if (tags.includes('zero')) hitKind = 'zero';
  else if (tags.includes('trial') && hitKind !== 'zero') hitKind = 'trial';
  else if (tags.includes('promo') && hitKind !== 'zero' && hitKind !== 'trial') hitKind = 'promo';
  const noteParts = [
    hit.note || '',
    tags.includes('zero') ? '0元/零金额资格' : '',
    tags.includes('trial') ? (hit.sniff?.trialText || hit.promoHint || '试用资格') : '',
    tags.includes('promo') && !tags.includes('trial') ? (hit.promoHint || '优惠活动') : '',
  ].filter(Boolean);
  return {
    ...hit,
    hitKind,
    tags: [...new Set([...(hit.tags || []), ...tags])],
    note: noteParts.join(' · '),
  };
}

export function buildAccountEligibilityReport(state: ProbeState): ProbeAccountReportRow[] {
  const hits = dedupeProbeHits([...(state.hitDatabase || []), ...(state.hits || [])]);
  const byAccount = new Map<string, ProbeHitRecord[]>();
  for (const hit of hits) {
    if (!hit?.ok && hit?.hitKind === 'error') continue;
    const key = hit.accountId || hit.email || hit.id;
    if (!key) continue;
    const list = byAccount.get(key) || [];
    list.push(hit);
    byAccount.set(key, list);
  }
  const rows: ProbeAccountReportRow[] = state.accounts.map((account) => {
    const list = (byAccount.get(account.id) || byAccount.get(account.email) || [])
      .slice()
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const countries = [...new Set(list.map((item) => item.country).filter(Boolean))];
    const tags = [...new Set(list.flatMap((item) => item.tags || buildHitTags(item)))];
    const best = pickBestHitKind(list.map((item) => item.hitKind));
    const top = list.find((item) => item.link) || list[0];
    const tokenExpiresAt = readAccessTokenExpiration(account.tokenRaw);
    const credentialStatus = classifyCredentialStatus(tokenExpiresAt);
    const attempts = account.successCount + account.failCount;
    return {
      accountId: account.id,
      email: account.email,
      source: account.source,
      enabled: account.enabled,
      credentialStatus,
      tokenExpiresAt,
      tokenUpdatedAt: account.tokenUpdatedAt,
      lastProbeAt: account.lastProbeAt,
      lastProbeCountry: account.lastProbeCountry,
      successRate: attempts ? Math.round((account.successCount / attempts) * 1000) / 10 : 0,
      successCount: account.successCount,
      failCount: account.failCount,
      hitCount: list.length,
      linkCount: list.filter((item) => Boolean(item.link)).length,
      zeroCount: list.filter((item) => item.hitKind === 'zero' || (item.tags || []).includes('zero')).length,
      trialCount: list.filter((item) => item.hitKind === 'trial' || (item.tags || []).includes('trial')).length,
      promoCount: list.filter((item) => item.hitKind === 'promo' || (item.tags || []).includes('promo')).length,
      countries,
      bestKind: best,
      lastHitAt: account.lastHitAt || top?.createdAt || 0,
      lastMessage: account.lastMessage || top?.message || '',
      topLink: top?.link || '',
      tags,
    };
  }).sort((a, b) => {
    if (b.zeroCount !== a.zeroCount) return b.zeroCount - a.zeroCount;
    if (b.trialCount !== a.trialCount) return b.trialCount - a.trialCount;
    if (b.linkCount !== a.linkCount) return b.linkCount - a.linkCount;
    if (b.hitCount !== a.hitCount) return b.hitCount - a.hitCount;
    return a.email.localeCompare(b.email);
  });
  // also include orphan hits without account row
  for (const [key, list] of byAccount.entries()) {
    if (rows.some((row) => row.accountId === key || row.email === key)) continue;
    const sorted = list.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const top = sorted.find((item) => item.link) || sorted[0];
    rows.push({
      accountId: key,
      email: top?.email || key,
      source: 'manual',
      enabled: true,
      credentialStatus: 'unknown',
      tokenExpiresAt: 0,
      tokenUpdatedAt: 0,
      lastProbeAt: top?.createdAt || 0,
      lastProbeCountry: top?.country || '',
      successRate: 100,
      successCount: sorted.length,
      failCount: 0,
      hitCount: sorted.length,
      linkCount: sorted.filter((item) => Boolean(item.link)).length,
      zeroCount: sorted.filter((item) => item.hitKind === 'zero').length,
      trialCount: sorted.filter((item) => item.hitKind === 'trial').length,
      promoCount: sorted.filter((item) => item.hitKind === 'promo').length,
      countries: [...new Set(sorted.map((item) => item.country).filter(Boolean))],
      bestKind: pickBestHitKind(sorted.map((item) => item.hitKind)),
      lastHitAt: top?.createdAt || 0,
      lastMessage: top?.message || '',
      topLink: top?.link || '',
      tags: [...new Set(sorted.flatMap((item) => item.tags || buildHitTags(item)))],
    });
  }
  return rows;
}

function normalizeLinkVerificationLevel(value: unknown): NonNullable<ProbeHitRecord['linkVerificationLevel']> {
  const level = String(value || 'candidate');
  if (level === 'page'
    || level === 'strict-response'
    || level === 'strict-page'
    || level === 'provider-final'
    || level === 'entitlement-verified') return level;
  return 'candidate';
}

function normalizeQualificationType(value: unknown): ProbeHitRecord['qualificationType'] {
  const type = String(value || 'unknown');
  return ['candidate', 'zero_amount', 'free_trial', 'promo_zero', 'intro_discount_zero', 'deferred_payment', 'nonzero', 'unknown'].includes(type)
    ? type as NonNullable<ProbeHitRecord['qualificationType']>
    : 'unknown';
}

function normalizeQualificationLedger(value: unknown): NonNullable<ProbeHitRecord['qualificationLedger']> {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item) => ({
    id: String(item.id || ''),
    type: normalizeQualificationType(item.type) || 'unknown',
    level: normalizeLinkVerificationLevel(item.level),
    source: normalizeQualificationEvidenceSource(item.source),
    amountMinor: item.amountMinor === null || item.amountMinor === undefined ? null : Number(item.amountMinor),
    recurringAmountMinor: item.recurringAmountMinor === null || item.recurringAmountMinor === undefined
      ? null
      : Number(item.recurringAmountMinor),
    currency: String(item.currency || '').toUpperCase(),
    sessionId: String(item.sessionId || ''),
    identityKey: String(item.identityKey || ''),
    method: String(item.method || '').toLowerCase(),
    methods: Array.isArray(item.methods) ? item.methods.map((method) => String(method).toLowerCase()).filter(Boolean) : [],
    qualified: Boolean(item.qualified),
    observedAt: Math.max(0, Number(item.observedAt || 0)),
    redactedPayloadHash: String(item.redactedPayloadHash || ''),
  })).filter((item) => item.id).slice(-20);
}

function normalizeQualificationEvidenceSource(value: unknown): NonNullable<ProbeHitRecord['qualificationLedger']>[number]['source'] {
  const source = String(value || 'create-response');
  return ['create-response', 'update-response', 'tax-response', 'checkout-page', 'provider-final', 'entitlement'].includes(source)
    ? source as NonNullable<ProbeHitRecord['qualificationLedger']>[number]['source']
    : 'create-response';
}

function normalizeQualificationDriftEvents(value: unknown): NonNullable<ProbeHitRecord['qualificationDriftEvents']> {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item) => ({
    id: String(item.id || ''),
    kind: normalizeQualificationDriftKind(item.kind),
    before: String(item.before || ''),
    after: String(item.after || ''),
    sessionId: String(item.sessionId || ''),
    detectedAt: Math.max(0, Number(item.detectedAt || 0)),
    stopRequired: Boolean(item.stopRequired),
  })).filter((item) => item.id).slice(-40);
}

function normalizeQualificationDriftKind(value: unknown): NonNullable<ProbeHitRecord['qualificationDriftEvents']>[number]['kind'] {
  const kind = String(value || 'qualification');
  return ['amount', 'currency', 'identity', 'payment-method', 'qualification'].includes(kind)
    ? kind as NonNullable<ProbeHitRecord['qualificationDriftEvents']>[number]['kind']
    : 'qualification';
}

function readAccessTokenExpiration(tokenRaw: string): number {
  try {
    const token = tryExtractAccessToken(tokenRaw) || tokenRaw;
    const payload = token.split('.')[1];
    if (!payload) return 0;
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=');
    const decoded = JSON.parse(atob(padded)) as { exp?: number };
    return Number(decoded.exp || 0) * 1000;
  } catch {
    return 0;
  }
}

function classifyCredentialStatus(expiresAt: number): ProbeAccountReportRow['credentialStatus'] {
  if (!expiresAt) return 'unknown';
  if (expiresAt <= Date.now()) return 'expired';
  if (expiresAt <= Date.now() + 24 * 60 * 60 * 1000) return 'expiring';
  return 'healthy';
}

function pickBestHitKind(kinds: Array<ProbeHitKind | string>): ProbeHitKind | 'none' {
  const set = new Set(kinds.map((item) => String(item || '').toLowerCase()));
  if (set.has('zero')) return 'zero';
  if (set.has('trial')) return 'trial';
  if (set.has('promo')) return 'promo';
  if (set.has('channel')) return 'channel';
  if (set.has('link')) return 'link';
  if (set.has('error')) return 'error';
  return 'none';
}

export function exportAccountReportCsv(rows: ProbeAccountReportRow[]): string {
  const header = ['email', 'source', 'enabled', 'credentialStatus', 'tokenExpiresAt', 'tokenUpdatedAt', 'lastProbeAt', 'lastProbeCountry', 'successRate', 'successCount', 'failCount', 'hitCount', 'linkCount', 'zeroCount', 'trialCount', 'promoCount', 'bestKind', 'countries', 'tags', 'lastHitAt', 'lastMessage', 'topLink', 'accountId'];
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push([
      row.email,
      row.source,
      row.enabled ? '1' : '0',
      row.credentialStatus,
      formatCsvDate(row.tokenExpiresAt),
      formatCsvDate(row.tokenUpdatedAt),
      formatCsvDate(row.lastProbeAt),
      row.lastProbeCountry,
      row.successRate,
      row.successCount,
      row.failCount,
      row.hitCount,
      row.linkCount,
      row.zeroCount,
      row.trialCount,
      row.promoCount,
      row.bestKind,
      row.countries.join('|'),
      row.tags.join('|'),
      row.lastHitAt ? new Date(row.lastHitAt).toISOString() : '',
      row.lastMessage,
      row.topLink,
      row.accountId,
    ].map(csvEscape).join(','));
  }
  return lines.join('\n');
}

function normalizeHitDatabaseRecord(value: unknown): ProbeHitDatabaseRecord | null {
  const hit = normalizeHit(value);
  if (!hit || !isRecord(value)) return null;
  const dbId = String(value.dbId || hit.dbId || '').trim();
  if (!dbId) return null;
  return {
    ...hit,
    dbId,
    savedAt: Number(value.savedAt || hit.createdAt || Date.now()),
    sourceTaskName: String(value.sourceTaskName || ''),
    archived: Boolean(value.archived),
    savedToDb: true,
  };
}

function formatCsvDate(value: number): string {
  if (!value) return '';
  try {
    return new Date(value).toISOString();
  } catch {
    return String(value);
  }
}

function csvEscape(value: unknown): string {
  const text = String(value ?? '');
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}
