import { classifyTokenAuthFailure, cookieHeaderFromSnapshot, createCheckoutLinkDirect, runStagedCheckoutPipeline, tryExtractAccessToken } from '../link-extractor/checkout';
import { parseStructuredCheckoutAmount } from '../link-extractor/checkout-amount';
import { extractPaymentFinalUrls } from '../payment/final-url';
import { detectPaymentMethodsViaStripeInit } from '../payment/detect-methods';
import { preferredMethodsFromChannels, isAllowedFinalPaymentUrl, resolvePaymentCapability } from '../payment/methods';
import { getPaymentMethodAdapter } from '../payment/runner-adapters';
import { runNativePaymentRunner } from '../payment/native-runner';
import { createNativePaymentTransport } from '../payment/native-transport';
import type { PaymentMethodId } from '../payment/types';
import { verifyStripeCheckoutKeyOwnership } from '../saved-payment-methods/stripe-key-ownership';

type StageSeedRef = { method: string; stage: 'bootstrap' | 'promotion' | 'provider'; rawLine: string; endpointSummary: string };
const lastStageSeed: Partial<Record<'bootstrap' | 'promotion' | 'provider', StageSeedRef>> = {};
type ProbeStageTraceRef = {
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
};
const activeProbeStageTrace: Partial<Record<'bootstrap' | 'promotion' | 'provider' | 'checkout', ProbeStageTraceRef>> = {};
let activeProbeCycleId = '';
import { applyProxyStage, stageLabel, verifyCurrentExit } from '../proxy/service';
import { formatProxyEndpoint, isProxyEndpointReady, loadProxySettings, parseProxyConnectionString, pickMethodStageProxy, resolveCountryExit, saveProxySettings } from '../proxy/state';
import { recordSeedResult, seedKey } from '../proxy/seed-health';
import type { ProxyEndpoint, ProxyStage } from '../proxy/types';
import { exportFactorAnalysisCsv } from './analysis';
import { listProbeCountries, PROBE_CHANNELS } from './countries';
import { buildProbeExperimentSchedule, normalizeExperimentMode, type ProbeScheduleEntry } from './experiment';
import { buildFreshProbeStageSnapshot, createProbeRunUnits } from './runtime';
import { parseSessionAccessTokenResponse, type SessionAccessTokenResult } from './session-credential';
import { createSessionIdentitySnapshot } from './session-import';
import { evaluateProbeTreatmentValidity } from './validity';
import { buildPaymentLinkEvidence, selectPaymentProbeCandidates } from './payment-evidence';
import {
  appendQualificationEvidence,
  classifyCheckoutQualification,
  qualificationLinkAggregateStatus,
} from './qualification';
import { buildPaymentOperationIdempotencyKey } from './execution-policy';
import {
  identityResolution,
  isIdentitySnapshotReady,
  isOaicsCheckoutUrl,
  resolveHostedArtifacts,
  sessionEmailsMatch,
  type HostedPageEvidence,
  type HostedResolutionArtifacts,
} from './hosted-resolution';
import {
  appendMethodDetection,
  appendProbeObservation,
  appendProbeHitAndMaybePersist,
  buildAccountEligibilityReport,
  buildCountryMethodRecommendations,
  clearHitDatabase,
  clearMethodDetections,
  clearProbeFactorData,
  createProbeTask,
  deleteHitDatabaseRecord,
  enrichHitClassification,
  exportAccountReportCsv,
  exportCountryMethodRecommendationsCsv,
  exportHitDatabaseCsv,
  exportMethodDetectionsCsv,
  importProbeObservations,
  loadProbeState,
  normalizeTaskConfig,
  parseProbeAccounts,
  queryHitDatabase,
  recommendMethodsForCountry,
  recordProbeAttempt,
  saveProbeState,
  saveProxyHealth,
  selectCountriesForProbe,
  upsertProbeAccountFromSession,
} from './state';
import { classifyFailureLevel, logRun } from '../run-log/service';
import type {
  ProbeAccount,
  ProbeAccountReportRow,
  ProbeCheckoutSniff,
  ProbeHitKind,
  ProbeHitDashboardFilter,
  ProbeHitDbResponse,
  ProbeHitRecord,
  ProbePaymentMethodLink,
  ProbeFactorResponse,
  ProbeExperimentMode,
  ProbeObservation,
  ProbeProxyHealthItem,
  ProbeResponse,
  ProbeState,
  ProbeTask,
  ProbeTaskConfig,
  ProbeTaskUnitRuntime,
} from './types';

const ALARM_PREFIX = 'opx-probe-task:';
let runningTaskId = '';
let stopRequested = false;

function accountLogLabel(account: ProbeAccount, index?: number): string {
  const n = typeof index === 'number' && index >= 0 ? index + 1 : 0;
  const email = String(account.email || '').trim();
  if (n > 0 && email) return `账号#${n} ${email}`;
  if (n > 0) return `账号#${n}`;
  return email || account.id || '账号';
}

function progressLabel(processed: number, total: number): string {
  return `${processed}/${total}`;
}

async function restoreProbeAccountIdentity(account: ProbeAccount): Promise<void> {
  const snapshot = account.identitySnapshot;
  if (!snapshot?.cookies?.length) return;
  const current = new Map<string, Browser.cookies.Cookie>();
  for (const domain of ['chatgpt.com', 'openai.com']) {
    let cookies: Browser.cookies.Cookie[] = [];
    try { cookies = await browser.cookies.getAll({ domain }); } catch { cookies = []; }
    for (const cookie of cookies) current.set(cookieIdentity(cookie), cookie);
  }
  for (const cookie of current.values()) {
    await browser.cookies.remove({
      url: cookieSnapshotUrl(cookie),
      name: cookie.name,
      storeId: cookie.storeId,
    }).catch(() => undefined);
  }
  for (const cookie of snapshot.cookies) {
    const details: Record<string, unknown> = {
      url: cookieSnapshotUrl(cookie),
      name: cookie.name,
      value: cookie.value,
      path: cookie.path || '/',
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
    };
    if (cookie.domain) details.domain = cookie.domain;
    if (cookie.expirationDate) details.expirationDate = cookie.expirationDate;
    if (cookie.storeId) details.storeId = cookie.storeId;
    if (cookie.sameSite && cookie.sameSite !== 'unspecified') details.sameSite = cookie.sameSite;
    const attempts = cookie.firstPartyDomain !== undefined
      ? [{ ...details, firstPartyDomain: cookie.firstPartyDomain }, details]
      : [details];
    let restored = false;
    let lastError: unknown;
    for (const attempt of attempts) {
      try {
        await browser.cookies.set(attempt as any);
        restored = true;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!restored) throw lastError instanceof Error ? lastError : new Error('cookie restore failed');
  }
}

/**
 * cookie -> /api/auth/session 刷新 accessToken（组合认证）。
 * 方向：cookie 会话 -> 新 AT（与参考项目 gopay/_build_chatgpt_session 一致）。
 * 纯 AT 无法换取 session；本函数只在账号有 cookie 快照时生效。
 * 失败返回 null（不抛错、不阻塞 AT-only 探测路径）。
 */
async function refreshAccessTokenFromCookie(account: ProbeAccount): Promise<{
  ok: boolean;
  accessToken: string;
  sessionToken: string;
  refreshToken: string;
  userEmail: string;
  expiresAt: number;
  reason?: SessionAccessTokenResult['reason'];
  message: string;
} | null> {
  const snapshot = account.identitySnapshot;
  if (!snapshot?.cookies?.length) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const explicitCookie = cookieHeaderFromSnapshot(snapshot);
    const headers: Record<string, string> = { Accept: 'application/json', Referer: 'https://chatgpt.com/' };
    if (explicitCookie) headers.Cookie = explicitCookie;
    const response = await fetch('https://chatgpt.com/api/auth/session', {
      method: 'GET',
      headers,
      cache: 'no-store',
      credentials: 'include',
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    return parseSessionAccessTokenResponse(data);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function cookieIdentity(cookie: Pick<Browser.cookies.Cookie, 'storeId' | 'domain' | 'path' | 'name'>): string {
  return `${cookie.storeId}|${cookie.domain}|${cookie.path}|${cookie.name}`;
}

function cookieSnapshotUrl(cookie: { domain: string; path: string; secure: boolean }): string {
  const domain = String(cookie.domain || 'chatgpt.com').replace(/^\./, '');
  const path = String(cookie.path || '/').startsWith('/') ? String(cookie.path || '/') : `/${cookie.path}`;
  return `${cookie.secure ? 'https' : 'http'}://${domain}${path}`;
}

export async function getProbeStateResponse(): Promise<ProbeResponse> {
  const state = await loadProbeState();
  return { ok: true, message: 'ok', state };
}

export async function saveProbeAccounts(rawAccounts: string): Promise<ProbeResponse> {
  const current = await loadProbeState();
  const parsed = parseProbeAccounts(rawAccounts, current.accounts);
  if (!parsed.accounts.length && rawAccounts.trim()) {
    return { ok: false, message: parsed.errors.join('；') || '没有可用账号', state: current };
  }
  const state = await saveProbeState({
    rawAccounts,
    accounts: parsed.accounts,
  });
  return {
    ok: true,
    message: `已保存探测账号 ${parsed.accounts.length} 个${parsed.errors.length ? `，${parsed.errors.length} 行解析失败` : ''}`,
    state,
  };
}

export async function importSessionToProbePool(input: {
  email?: string;
  chatgptAccountId?: string;
  tokenRaw: string;
  source?: 'session' | 'automation';
  identitySnapshot?: ProbeAccount['identitySnapshot'];
}): Promise<ProbeResponse & { accountId?: string; created?: boolean }> {
  let result = await upsertProbeAccountFromSession(input);
  if (result.account) {
    const proxy = await loadProxySettings();
    const evidence = proxy.automationRouting?.evidence?.auth;
    if (evidence?.verified) {
      const authEvidence: ProbeObservation['auth'] = {
        cycleId: evidence.cycleId,
        configuredCountry: evidence.country,
        country: evidence.country,
        ip: evidence.ip,
        asn: String(evidence.asn || ''),
        colo: evidence.colo,
        latencyMs: Number(evidence.latencyMs || 0),
        checkedAt: evidence.checkedAt,
        endpointSummary: sanitizeEndpointSummary(evidence.endpointSummary),
        source: `automation-handoff:${evidence.source}`,
        verified: true,
        message: evidence.message,
      };
      const accountId = result.account.id;
      const state = await saveProbeState({
        accounts: result.state.accounts.map((account) => account.id === accountId ? { ...account, authEvidence } : account),
      });
      result = { ...result, state, account: state.accounts.find((account) => account.id === accountId) || result.account };
    }
  }
  return {
    ok: Boolean(result.account),
    message: result.message,
    state: result.state,
    accountId: result.account?.id,
    created: result.created,
  };
}

export async function upsertProbeTask(input: { id?: string; config: ProbeTaskConfig }): Promise<ProbeResponse> {
  const current = await loadProbeState();
  const config = normalizeTaskConfig(input.config);
  let tasks = [...current.tasks];
  let task: ProbeTask;
  if (input.id) {
    const index = tasks.findIndex((item) => item.id === input.id);
    if (index < 0) {
      return { ok: false, message: '任务不存在', state: current };
    }
    task = {
      ...tasks[index],
      config,
      updatedAt: Date.now(),
    };
    tasks[index] = task;
  } else {
    task = createProbeTask(config);
    tasks = [task, ...tasks];
  }
  const state = await saveProbeState({
    tasks,
    activeTaskId: task.id,
  });
  return { ok: true, message: input.id ? '任务已更新' : '任务已创建', state };
}

export async function deleteProbeTask(taskId: string): Promise<ProbeResponse> {
  const current = await loadProbeState();
  const tasks = current.tasks.filter((task) => task.id !== taskId);
  await clearProbeAlarm(taskId);
  const state = await saveProbeState({
    tasks,
    activeTaskId: tasks[0]?.id || '',
  });
  return { ok: true, message: '任务已删除', state };
}

export async function clearProbeHits(scope: 'runtime' | 'database' | 'all' = 'all'): Promise<ProbeResponse> {
  let state = await loadProbeState();
  if (scope === 'runtime' || scope === 'all') {
    state = await saveProbeState({ hits: [] });
  }
  if (scope === 'database' || scope === 'all') {
    state = await clearHitDatabase();
  }
  return {
    ok: true,
    message: scope === 'runtime' ? '运行命中已清空' : scope === 'database' ? '命中数据库已清空' : '运行命中与数据库已清空',
    state,
  };
}

export async function queryProbeHitDatabase(filter: Partial<ProbeHitDashboardFilter> = {}): Promise<ProbeHitDbResponse> {
  const state = await loadProbeState();
  const result = queryHitDatabase(state.hitDatabase, filter);
  return {
    ok: true,
    message: `命中库 ${result.summary.total} 条`,
    state,
    records: result.records,
    summary: result.summary,
  };
}

export async function deleteProbeHitDatabaseRecord(dbId: string): Promise<ProbeHitDbResponse> {
  const state = await deleteHitDatabaseRecord(dbId);
  const result = queryHitDatabase(state.hitDatabase, {});
  return {
    ok: true,
    message: '已删除命中库记录',
    state,
    records: result.records,
    summary: result.summary,
  };
}

export async function exportProbeHitDatabase(filter: Partial<ProbeHitDashboardFilter> = {}): Promise<ProbeHitDbResponse> {
  const state = await loadProbeState();
  const result = queryHitDatabase(state.hitDatabase, filter);
  return {
    ok: true,
    message: `已导出 ${result.records.length} 条`,
    state,
    records: result.records,
    summary: result.summary,
    exportText: exportHitDatabaseCsv(result.records),
  };
}

export async function getProbeAccountReport(): Promise<ProbeResponse & { report?: ProbeAccountReportRow[]; exportText?: string }> {
  const state = await loadProbeState();
  const report = buildAccountEligibilityReport(state);
  return {
    ok: true,
    message: `账号资格报表 ${report.length} 行`,
    state,
    report,
    exportText: exportAccountReportCsv(report),
  };
}

export async function applyProbeAccountAction(
  action: 'enable' | 'disable' | 'delete',
  accountIds: string[],
): Promise<ProbeResponse & { report?: ProbeAccountReportRow[] }> {
  const selected = new Set((accountIds || []).map((item) => String(item || '').trim()).filter(Boolean));
  const current = await loadProbeState();
  if (!selected.size) return { ok: false, message: '请先选择账号', state: current, report: buildAccountEligibilityReport(current) };
  let accounts = current.accounts;
  if (action === 'delete') {
    accounts = accounts.filter((account) => !selected.has(account.id));
  } else {
    const enabled = action === 'enable';
    accounts = accounts.map((account) => selected.has(account.id) ? { ...account, enabled } : account);
  }
  const rawAccounts = accounts.map((account) => `${account.email}----${account.tokenRaw}`).join('\n');
  const state = await saveProbeState({ accounts, rawAccounts });
  return {
    ok: true,
    message: `${action === 'enable' ? '启用' : action === 'disable' ? '停用' : '删除'}账号 ${selected.size} 个`,
    state,
    report: buildAccountEligibilityReport(state),
  };
}

export async function queryProbeFactorAnalysis(): Promise<ProbeFactorResponse> {
  const state = await loadProbeState();
  return {
    ok: true,
    message: `观测 ${state.observations.length} 条 · 漂移告警 ${state.driftAlerts.length} 条`,
    state,
    report: state.factorReport,
    alerts: state.driftAlerts,
    recommendations: state.adaptiveRecommendations,
  };
}

export async function exportProbeFactorAnalysis(format: 'json' | 'csv' = 'json'): Promise<ProbeFactorResponse> {
  const state = await loadProbeState();
  const exportText = format === 'csv'
    ? exportFactorAnalysisCsv(state.factorReport, state.experimentCoverage, state.observations)
    : JSON.stringify({
        schemaVersion: 3,
        exportedAt: new Date().toISOString(),
        observations: state.observations,
        factorReport: state.factorReport,
        experimentCoverage: state.experimentCoverage,
        experimentReadiness: state.experimentReadiness,
        driftAlerts: state.driftAlerts,
        adaptiveRecommendations: state.adaptiveRecommendations,
      }, null, 2);
  return {
    ok: true,
    message: `已导出资格因素 ${format.toUpperCase()} · ${state.observations.length} 条观测`,
    state,
    report: state.factorReport,
    alerts: state.driftAlerts,
    recommendations: state.adaptiveRecommendations,
    exportText,
  };
}

export async function clearProbeFactorAnalysis(): Promise<ProbeFactorResponse> {
  const state = await clearProbeFactorData();
  return {
    ok: true,
    message: '已清空资格因素观测、结论和漂移告警',
    state,
    report: state.factorReport,
    alerts: state.driftAlerts,
    recommendations: state.adaptiveRecommendations,
  };
}

export async function importProbeFactorObservations(
  text: string,
  format: 'auto' | 'json' | 'csv' = 'auto',
  mode: 'merge' | 'replace' = 'merge',
): Promise<ProbeFactorResponse> {
  try {
    const values = parseObservationImport(text, format);
    if (!values.length) {
      return { ok: false, message: '导入内容中没有观测记录', imported: 0, rejected: 0, duplicates: 0 };
    }
    const result = await importProbeObservations(values, mode);
    return {
      ok: result.imported > 0,
      message: `已${mode === 'replace' ? '替换' : '合并'}观测 ${result.imported} 条 · 拒绝 ${result.rejected} · 重复 ${result.duplicates}`,
      state: result.state,
      report: result.state.factorReport,
      alerts: result.state.driftAlerts,
      recommendations: result.state.adaptiveRecommendations,
      imported: result.imported,
      rejected: result.rejected,
      duplicates: result.duplicates,
    };
  } catch (error) {
    return {
      ok: false,
      message: `观测导入失败：${error instanceof Error ? error.message : String(error)}`,
      imported: 0,
      rejected: 0,
      duplicates: 0,
    };
  }
}

function parseObservationImport(text: string, requested: 'auto' | 'json' | 'csv'): unknown[] {
  const content = String(text || '').trim();
  if (!content) return [];
  const format = requested === 'auto' ? (/^[\[{]/.test(content) ? 'json' : 'csv') : requested;
  if (format === 'json') {
    const parsed = JSON.parse(content) as unknown;
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { observations?: unknown[] }).observations)) {
      return (parsed as { observations: unknown[] }).observations;
    }
    throw new Error('JSON 需要是观测数组或包含 observations 数组');
  }
  return parseCsvObjects(content).map(csvObservation);
}

function parseCsvObjects(content: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (char === '"') {
      if (quoted && content[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && content[index + 1] === '\n') index += 1;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  const headers = (rows.shift() || []).map((value) => value.trim());
  if (!headers.includes('accountId') || !headers.includes('probeCountry')) {
    throw new Error('CSV 至少需要 accountId、probeCountry 列');
  }
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index]?.trim() || ''])));
}

function csvObservation(row: Record<string, string>, index: number): unknown {
  const stage = (prefix: 'auth' | 'checkout' | 'billing') => ({
    configuredCountry: row[`${prefix}ConfiguredCountry`] || row[`${prefix}Country`] || '',
    country: row[`${prefix}Country`] || '',
    ip: row[`${prefix}Ip`] || '',
    asn: row[`${prefix}Asn`] || '',
    colo: row[`${prefix}Colo`] || '',
    latencyMs: Number(row[`${prefix}LatencyMs`] || 0),
    checkedAt: row[`${prefix}CheckedAt`] ? parseTimestamp(row[`${prefix}CheckedAt`]) : 0,
    cycleId: row[`${prefix}CycleId`] || '',
    endpointSummary: row[`${prefix}Endpoint`] || '',
    source: row[`${prefix}Source`] || 'import',
    verified: parseBoolean(row[`${prefix}Verified`]),
    message: row[`${prefix}Message`] || '',
  });
  return {
    ...row,
    id: row.id || `import-${Date.now()}-${index + 1}`,
    observedAt: parseTimestamp(row.observedAt),
    runId: row.runId || '',
    cycleId: row.cycleId || '',
    unitId: row.unitId || '',
    attemptId: row.attemptId || '',
    round: Number(row.round || 0),
    sequence: Number(row.sequence || index + 1),
    researchMode: parseBoolean(row.researchMode),
    experimentMode: row.experimentMode || '',
    experimentArm: row.experimentArm || '',
    designCellKey: row.designCellKey || '',
    routeVariantId: row.routeVariantId || '',
    plannedAuthCountry: row.plannedAuthCountry || '',
    plannedCheckoutCountry: row.plannedCheckoutCountry || '',
    plannedBillingCountry: row.plannedBillingCountry || '',
    plannedPaymentMethod: row.plannedPaymentMethod || '',
    plannedSeedOrdinal: Number(row.plannedSeedOrdinal || 1),
    scheduleBlock: Number(row.scheduleBlock || 0),
    scheduleCellAttempt: Number(row.scheduleCellAttempt || 0),
    accountAgeHours: Number(row.accountAgeHours || 0),
    tokenAgeHours: Number(row.tokenAgeHours || 0),
    tokenExpiryHorizonHours: Number(row.tokenExpiryHorizonHours || 0),
    channels: String(row.channels || '').split(/[|;+]/).map((item) => item.trim()).filter(Boolean),
    detectedMethods: String(row.detectedMethods || '').split(/[|;+]/).map((item) => item.trim()).filter(Boolean),
    paymentCheckoutSessionMode: row.paymentCheckoutSessionMode === 'reuse_eligibility_session'
      ? 'reuse_eligibility_session'
      : 'independent_checkout',
    paymentCheckoutStatus: (row.paymentCheckoutStatus || '') as ProbeObservation['paymentCheckoutStatus'],
    paymentCheckoutSessionDistinct: parseBoolean(row.paymentCheckoutSessionDistinct),
    paymentMethodLinkCount: Number(row.paymentMethodLinkCount || 0),
    qualificationVerified: parseBoolean(row.qualificationVerified),
    paymentRunnerConfirmSubmitted: parseBoolean(row.paymentRunnerConfirmSubmitted),
    paymentRunnerConfirmSucceeded: parseBoolean(row.paymentRunnerConfirmSucceeded),
    paymentRunnerApproveSubmitted: parseBoolean(row.paymentRunnerApproveSubmitted),
    paymentRunnerApproveSucceeded: parseBoolean(row.paymentRunnerApproveSucceeded),
    finalLinkVerified: parseBoolean(row.finalLinkVerified),
    checkoutCreated: parseBoolean(row.checkoutCreated),
    qualificationGateVersion: row.qualificationGateVersion || '',
    linkVerificationLevel: row.linkVerificationLevel || 'candidate',
    linkUsable: parseBoolean(row.linkUsable),
    credentialStatus: row.credentialStatus || 'unchecked',
    configuredRetries: Number(row.configuredRetries || 0),
    retryOrdinal: Number(row.retryOrdinal || 1),
    cooldownElapsedMinutes: Number(row.cooldownElapsedMinutes || 0),
    stagedPipelineEnabled: parseBoolean(row.stagedPipelineEnabled),
    auth: stage('auth'),
    checkout: stage('checkout'),
    billing: stage('billing'),
  };
}

function parseTimestamp(value: string): number {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return number;
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function parseBoolean(value: string): boolean {
  return /^(?:1|true|yes|y|是)$/i.test(String(value || '').trim());
}


export async function queryProbeMethodDetections(): Promise<{
  ok: boolean;
  message: string;
  detections: import('./types').ProbeMethodDetectionRecord[];
  recommendations: import('./types').ProbeCountryMethodRecommendation[];
  state: ProbeState;
}> {
  const state = await loadProbeState();
  const detections = state.methodDetections || [];
  const recommendations = buildCountryMethodRecommendations(detections);
  return {
    ok: true,
    message: `方式探测 ${detections.length} 条 · 国家聚合 ${recommendations.length}`,
    detections,
    recommendations,
    state,
  };
}

export async function exportProbeMethodDetections(): Promise<{
  ok: boolean;
  message: string;
  csv: string;
  recommendationsCsv: string;
  state: ProbeState;
}> {
  const state = await loadProbeState();
  const detections = state.methodDetections || [];
  const recommendations = buildCountryMethodRecommendations(detections);
  return {
    ok: true,
    message: `已导出方式探测 ${detections.length} 条`,
    csv: exportMethodDetectionsCsv(detections),
    recommendationsCsv: exportCountryMethodRecommendationsCsv(recommendations),
    state,
  };
}

export async function clearProbeMethodDetections(): Promise<ProbeResponse> {
  const state = await clearMethodDetections();
  return { ok: true, message: '已清空方式探测结果', state };
}

export async function ensureSmartProbeBootstrap(input?: {
  runHealthCheck?: boolean;
  startScheduled?: boolean;
  runOnce?: boolean;
}): Promise<ProbeResponse> {
  const runHealthCheck = input?.runHealthCheck !== false;
  const startScheduled = Boolean(input?.startScheduled);
  const runOnce = input?.runOnce !== false && !startScheduled;

  let state = await loadProbeState();
  let task = state.tasks.find((item) => item.id === state.activeTaskId) || state.tasks[0] || null;
  if (!task) {
    const created = await upsertProbeTask({
      config: normalizeTaskConfig({
        name: '智能撞资格',
        intervalSec: 90,
        concurrency: 1,
        retryCount: 2,
        planName: 'chatgptplusplan',
        accountSource: 'enabled',
        entryProxyMode: 'front',
        exitProxyMode: 'follow-country',
        countries: listProbeCountries().map((item) => item.country).slice(0, 12),
        channels: [...PROBE_CHANNELS],
        pinOnSuccess: true,
        skipAccountAfterHit: true,
        autoSwitchExitByCountry: true,
        notifyMode: 'sound-badge',
        soundEnabled: true,
        preferChromeTlsNote: true,
        autoOpenOnHit: true,
        sniffCheckoutOnHit: true,
        saveHitsToDatabase: true,
        excludeUnhealthyExits: true,
        highHitRateOnly: false,
        stagedPipelineEnabled: true,
        requireZero: true,
        detectPaymentMethods: true,
        attachDetectedMethods: true,
        autoApplyDetectedMethods: true,
        extractFinalPaymentUrl: true,
        enableStripeConfirm: true,
        useSelectedAsBootstrapProvider: true,
        enablePromotionUpdate: true,
        promotionCountry: 'VN',
      }),
    });
    state = created.state || state;
    task = state.tasks.find((item) => item.id === state.activeTaskId) || state.tasks[0] || null;
  }

  if (!task) {
    return { ok: false, message: '无法创建智能探测任务', state };
  }

  const smartConfig = normalizeTaskConfig({
    ...task.config,
    excludeUnhealthyExits: true,
    autoSwitchExitByCountry: true,
    exitProxyMode: 'follow-country',
    stagedPipelineEnabled: true,
    requireZero: true,
    detectPaymentMethods: true,
    attachDetectedMethods: true,
    autoApplyDetectedMethods: true,
    extractFinalPaymentUrl: true,
    enableStripeConfirm: Boolean(task.config.stripePublishableKey),
    saveHitsToDatabase: true,
    factorTrackingEnabled: true,
    driftDetectionEnabled: true,
    experimentMode: 'hybrid',
    researchModeEnabled: true,
    explorationEnabled: true,
  });
  const updated = await upsertProbeTask({ id: task.id, config: smartConfig });
  state = updated.state || state;
  task = state.tasks.find((item) => item.id === task!.id) || task;

  if (!state.accounts.length) {
    await logRun('warn', '智能开跑：探测池暂无账号，请先注册同步或导入 token', {
      stage: 'task',
      code: 'SMART_NO_ACCOUNT',
      taskId: task.id,
      action: '先跑注册自动化或导入 email----token',
    });
    return { ok: false, message: '探测池没有账号。请先完成注册（自动同步）或手动导入 token', state };
  }

  let countries = task.config.countries.length
    ? task.config.countries
    : listProbeCountries().map((item) => item.country).slice(0, 12);
  if (!task.config.countries.length && countries.length) {
    const patched = await upsertProbeTask({
      id: task.id,
      config: normalizeTaskConfig({ ...task.config, countries }),
    });
    state = patched.state || state;
    task = state.tasks.find((item) => item.id === task!.id) || task;
  }

  if (runHealthCheck && countries.length) {
    state = await runProxyHealthCheck(countries);
    await logRun('info', `智能开跑：健康检查完成 ${state.proxyHealth.filter((i) => i.status === 'ok').length}/${state.proxyHealth.length}`, {
      stage: 'proxy',
      code: 'SMART_HEALTH',
      taskId: task.id,
    });
  }

  if (startScheduled) {
    return controlProbe('start', task.id);
  }
  if (runOnce) {
    state = await runProbeTask(task.id, false);
    const runtime = state.tasks.find((item) => item.id === task!.id)?.runtime;
    return {
      ok: true,
      message: runtime?.lastMessage || '智能开跑已执行一轮',
      state,
    };
  }
  return { ok: true, message: '智能探测任务已就绪', state };
}

export async function controlProbe(
  action: 'start' | 'stop' | 'run-once' | 'refresh' | 'health-check' | 'export-hitdb',
  taskId?: string,
): Promise<ProbeResponse> {
  if (action === 'refresh') {
    return getProbeStateResponse();
  }
  if (action === 'health-check') {
    const current = await loadProbeState();
    const task = current.tasks.find((item) => item.id === (taskId || current.activeTaskId)) || current.tasks[0];
    const countries = task?.config.countries?.length ? task.config.countries : listProbeCountries().map((item) => item.country);
    const state = await runProxyHealthCheck(countries);
    const okCount = state.proxyHealth.filter((item) => item.status === 'ok').length;
    return {
      ok: true,
      message: `代理健康检查完成：${okCount}/${state.proxyHealth.length} 可用`,
      state,
    };
  }
  if (action === 'export-hitdb') {
    return exportProbeHitDatabase({});
  }
  const current = await loadProbeState();
  const id = taskId || current.activeTaskId || current.tasks[0]?.id || '';
  if (!id) {
    return { ok: false, message: '没有可操作的探测任务，请先创建', state: current };
  }
  if (action === 'stop') {
    stopRequested = true;
    await clearProbeAlarm(id);
    const state = await updateTaskRuntime(id, {
      status: 'stopped',
      finishedAt: Date.now(),
      lastMessage: '已停止探测',
      nextRunAt: 0,
    });
    runningTaskId = '';
    await logRun('warn', '探测已停止', {
      stage: 'task',
      code: 'STOP',
      taskId: id,
      action: '任务已停止',
    });
    return { ok: true, message: '探测已停止', state };
  }
  if (action === 'run-once') {
    const state = await runProbeTask(id, false);
    return { ok: true, message: state.tasks.find((task) => task.id === id)?.runtime.lastMessage || '已执行一轮', state };
  }
  // start scheduled
  stopRequested = false;
  await ensureAlarm(id, current.tasks.find((task) => task.id === id)?.config.intervalSec || 60);
  const started = await updateTaskRuntime(id, {
    status: 'running',
    startedAt: Date.now(),
    finishedAt: 0,
    lastMessage: '已启动定时探测',
    nextRunAt: Date.now() + (current.tasks.find((task) => task.id === id)?.config.intervalSec || 60) * 1000,
  });
  // kick first round in background
  await logRun('info', '定时探测已启动', {
    stage: 'task',
    code: 'SCHEDULE_START',
    taskId: id,
  });
  void runProbeTask(id, true);
  return { ok: true, message: '定时探测已启动', state: started };
}

export async function handleProbeAlarm(alarmName: string): Promise<void> {
  if (!alarmName.startsWith(ALARM_PREFIX)) return;
  const taskId = alarmName.slice(ALARM_PREFIX.length);
  await runProbeTask(taskId, true);
}

export async function runProbeTask(taskId: string, reschedule: boolean): Promise<ProbeState> {
  if (runningTaskId && runningTaskId !== taskId) {
    await logRun('warn', `其他任务运行中：${runningTaskId}`, {
      stage: 'task',
      code: 'BUSY',
      taskId,
      action: '等待当前任务结束后再启动',
    });
    return updateTaskRuntime(taskId, {
      lastMessage: `其他任务运行中：${runningTaskId}`,
    });
  }
  runningTaskId = taskId;
  stopRequested = false;
  let state = await loadProbeState();
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) {
    runningTaskId = '';
    await logRun('error', '任务不存在', { stage: 'task', code: 'TASK_MISSING', taskId, action: '重新创建探测任务' });
    return state;
  }

  let accounts = selectAccounts(state.accounts, task.config.accountSource);
  const selectedCountries = task.config.countries.length ? task.config.countries : listProbeCountries().map((item) => item.country);
  const experimentMode: ProbeExperimentMode = normalizeExperimentMode(task.config.experimentMode, task.config.researchModeEnabled);
  const planningConfig = experimentMode === 'discovery' ? task.config : { ...task.config, highHitRateOnly: false };
  const countryPlan = selectCountriesForProbe({
    selectedCountries,
    stats: state.stats,
    proxyHealth: state.proxyHealth,
    config: planningConfig,
    round: task.runtime.round,
  });
  const countries = countryPlan.countries;
  const exploitPlan = selectCountriesForProbe({
    selectedCountries,
    stats: state.stats,
    proxyHealth: state.proxyHealth,
    config: { ...task.config, highHitRateOnly: true, explorationEnabled: false },
    round: task.runtime.round,
  });
  const preferredCountries = experimentMode === 'hybrid'
    ? exploitPlan.countries
    : exploitPlan.countries.length
      ? exploitPlan.countries
      : countries.filter((country) => !countryPlan.experimentalCountries.includes(country));
  if (!accounts.length) {
    runningTaskId = '';
    await logRun('error', '没有可用探测账号，请先导入 email----accessToken', {
      stage: 'task',
      code: 'NO_ACCOUNT',
      taskId,
      action: '导入账号后重试',
    });
    return updateTaskRuntime(taskId, {
      status: 'error',
      lastMessage: '没有可用探测账号，请先导入 email----accessToken',
      finishedAt: Date.now(),
    });
  }
  if (!countries.length) {
    runningTaskId = '';
    const noCountryMessage = countryPlan.excludedUnhealthy.length >= selectedCountries.length
      ? '健康检查已剔除全部出口国家'
      : task.config.highHitRateOnly && countryPlan.excludedLowRate.length > 0
        ? '没有达到命中率阈值的出口国家'
        : '没有选择出口国家';
    await logRun('error', noCountryMessage, {
      stage: 'task',
      code: 'NO_COUNTRY',
      taskId,
      action: countryPlan.excludedUnhealthy.length >= selectedCountries.length
        ? '检查代理出口或关闭“剔除不健康出口”后重试'
        : '调整国家选择或高命中率阈值后重试',
    });
    return updateTaskRuntime(taskId, {
      status: 'error',
      lastMessage: noCountryMessage,
      finishedAt: Date.now(),
    });
  }

  const credentialPreflight = await preflightProbeAccounts(task, accounts, countries[0]);
  state = credentialPreflight.state;
  accounts = selectAccounts(state.accounts, task.config.accountSource);
  if (!accounts.length) {
    runningTaskId = '';
    await logRun('error', '服务端凭证预检后没有可用账号', {
      stage: 'account',
      code: 'CREDENTIAL_PREFLIGHT_EMPTY',
      taskId,
      action: '同步新的 accessToken 后重试',
    });
    return updateTaskRuntime(taskId, {
      status: 'error',
      lastMessage: `凭证预检剔除 ${credentialPreflight.invalidCount} 个失效账号，没有可用账号`,
      finishedAt: Date.now(),
    });
  }

  const roundNo = task.runtime.round + 1;
  const supportedPaymentMethodsByCountry = Object.fromEntries(
    buildCountryMethodRecommendations(state.methodDetections || []).map((item) => [item.country, item.methods]),
  );
  const boostedExplore = Math.max(
    task.config.explorationTrafficPercent,
    state.experimentReadiness?.driftBoostedExplorationPercent || 0,
  );
  const explorationDelta = Math.max(0, boostedExplore - task.config.explorationTrafficPercent);
  const schedule: ProbeScheduleEntry[] = buildProbeExperimentSchedule({
    mode: experimentMode,
    accounts,
    countries,
    preferredCountries,
    observations: state.observations,
    taskId: task.id,
    round: roundNo,
    targetSamplesPerCell: task.config.researchTargetSamplesPerCell,
    minRepeatIntervalMinutes: task.config.researchMinRepeatIntervalMinutes,
    balancedOrderEnabled: task.config.balancedOrderEnabled,
    traffic: {
      exploit: Math.max(0, task.config.exploitTrafficPercent - explorationDelta),
      balanced: task.config.balancedTrafficPercent,
      explore: boostedExplore,
    },
    controlledFactors: task.config.controlledFactors,
    routeVariants: task.config.routeVariants,
    paymentMethodVariants: task.config.paymentMethodVariants.length
      ? task.config.paymentMethodVariants
      : task.config.paymentMethod ? [task.config.paymentMethod] : [],
    supportedPaymentMethodsByCountry,
    seedReplicatesPerCell: task.config.seedReplicatesPerCell,
  }).slice(0, task.config.maxProbeUnitsPerRun);
  const totalPairs = schedule.length;
  if (!schedule.length) {
    const coverage = state.experimentCoverage;
    const complete = Boolean(experimentMode === 'attribution' && coverage?.totalCells && coverage.completedCells >= coverage.totalCells);
    const message = complete
      ? `平衡实验目标已完成：${coverage.completedCells}/${coverage.totalCells} 单元`
      : '本轮没有到期的实验组合，等待跨时段重复间隔';
    if (reschedule && !stopRequested) await ensureAlarm(taskId, task.config.intervalSec);
    else await clearProbeAlarm(taskId);
    runningTaskId = '';
    await logRun('info', message, { stage: 'task', code: complete ? 'MATRIX_COMPLETE' : 'MATRIX_COOLDOWN', taskId });
    return updateTaskRuntime(taskId, {
      status: reschedule ? 'running' : 'completed',
      finishedAt: complete ? Date.now() : 0,
      nextRunAt: reschedule ? Date.now() + task.config.intervalSec * 1000 : 0,
      lastMessage: message,
      runId: '',
      cycleId: '',
      currentUnitId: '',
      currentAttemptId: '',
      totalUnits: 0,
      completedUnits: 0,
      skippedUnits: 0,
      processed: 0,
      hits: 0,
      errors: 0,
      unitStates: [],
    });
  }
  const runStartedAt = Date.now();
  const runId = `probe-run-${runStartedAt}-${Math.random().toString(36).slice(2, 8)}`;
  const unitStates = createProbeRunUnits(runId, schedule.map((entry) => ({
    accountId: entry.account.id,
    email: entry.account.email,
    country: entry.country,
  })));
  state = await updateTaskRuntime(taskId, {
    status: 'running',
    runId,
    cycleId: '',
    startedAt: runStartedAt,
    finishedAt: 0,
    round: roundNo,
    lastMessage: `开始第 ${roundNo} 轮：${experimentMode} 计划 ${schedule.length} 个实验单元（${countryPlan.note}）`,
    currentUnitId: '',
    currentAttemptId: '',
    totalUnits: totalPairs,
    completedUnits: 0,
    skippedUnits: 0,
    processed: 0,
    hits: 0,
    errors: 0,
    unitStates,
  });
  await logRun('info', `开始第 ${roundNo} 轮：账号 ${accounts.length} × 国家 ${countries.length}`, {
    stage: 'task',
    code: 'ROUND_START',
    taskId,
    progress: progressLabel(0, totalPairs),
    meta: {
      accounts: accounts.length,
      countries: countries.length,
      note: countryPlan.note || '',
      reschedule: Boolean(reschedule),
    },
  });

  let processed = 0;
  let completedUnits = 0;
  let skippedUnits = 0;
  let hits = 0;
  let errors = 0;

  // Extension proxy is process-wide; keep effective concurrency at 1 for correct country switching.
  const queueSize = Math.max(1, Math.min(task.config.concurrency, 1));
  void queueSize;
  const skippedAccounts = new Set<string>();
  for (let scheduleIndex = 0; scheduleIndex < schedule.length; scheduleIndex += 1) {
    const scheduleEntry = schedule[scheduleIndex];
    const { account, accountIndex, country } = scheduleEntry;
    const executionTask = materializeScheduleTask(task, scheduleEntry, experimentMode);
    const unit = unitStates[scheduleIndex];
    if (stopRequested) break;
    if (skippedAccounts.has(account.id)) {
      completedUnits += 1;
      skippedUnits += 1;
      patchUnitRuntime(unitStates, unit.unitId, {
        status: 'skipped',
        finishedAt: Date.now(),
        message: '同账号已命中，本轮剩余国家跳过',
      });
      await updateTaskRuntime(taskId, { completedUnits, skippedUnits, unitStates });
      continue;
    }
    if (experimentMode === 'discovery' && task.config.skipAccountAfterHit && account.lastHitAt > 0 && Date.now() - account.lastHitAt < task.config.intervalSec * 1000) {
      await logRun('debug', '跳过近期已命中账号', {
        stage: 'account',
        code: 'SKIP_RECENT_HIT',
        taskId,
        accountId: account.id,
        email: account.email,
        accountLabel: accountLogLabel(account, accountIndex),
      });
      skippedAccounts.add(account.id);
      completedUnits += 1;
      skippedUnits += 1;
      patchUnitRuntime(unitStates, unit.unitId, {
        status: 'skipped',
        finishedAt: Date.now(),
        message: '近期已命中，本轮跳过',
      });
      await updateTaskRuntime(taskId, { completedUnits, skippedUnits, unitStates });
      continue;
    }
    const label = accountLogLabel(account, accountIndex);
      const unitStartedAt = Date.now();
      activeProbeCycleId = unit.cycleId;
      patchUnitRuntime(unitStates, unit.unitId, { status: 'running', attempt: 1, startedAt: unitStartedAt });
      state = await updateTaskRuntime(taskId, {
        cycleId: unit.cycleId,
        currentAccountId: account.id,
        currentCountry: country,
        currentUnitId: unit.unitId,
        currentAttemptId: unit.attemptId,
        unitStates,
        lastMessage: `探测 ${account.email || account.id} @ ${country}`,
      });
      await logRun('info', `开始探测 ${label} @ ${country}`, {
        stage: 'account',
        code: 'PROBE_START',
        taskId,
        accountId: account.id,
        email: account.email,
        accountLabel: label,
        country,
        progress: progressLabel(processed, totalPairs),
      });
      resetActiveProbeStageTrace();
      const observationStartedAt = Date.now();
      const result = await probeAccountCountry(executionTask, account, country, accountIndex, scheduleEntry.seedOrdinal);
      processed += 1;
      let evaluatedHit = result.hit;
      const isCheckoutCandidate = evaluatedHit.ok && evaluatedHit.hitKind !== 'none' && evaluatedHit.hitKind !== 'error';
      if (isCheckoutCandidate && task.config.autoOpenOnHit && evaluatedHit.link && !evaluatedHit.tabId) {
        evaluatedHit = await openAndSniffCheckoutHit(executionTask, evaluatedHit);
      }
      const observedCheckoutCountry = activeProbeStageTrace.promotion?.country
        || activeProbeStageTrace.bootstrap?.country
        || activeProbeStageTrace.checkout?.country
        || evaluatedHit.country
        || country;
      evaluatedHit = { ...evaluatedHit, country: observedCheckoutCountry };
      const isHit = isQualifiedProbeHit(executionTask, evaluatedHit);
      const resultErrorClass = evaluatedHit.ok ? '' : classifyObservationError(evaluatedHit.message);
      const resolvedMiss = resultErrorClass === 'price-not-qualified' || resultErrorClass === 'eligibility-miss';
      await recordProbeAttempt({
        country: observedCheckoutCountry,
        channels: evaluatedHit.channels.length ? evaluatedHit.channels : (isHit ? ['hosted'] : task.config.channels.slice(0, 1)),
        ok: evaluatedHit.ok || resolvedMiss,
        hit: isHit,
        message: evaluatedHit.message,
      });
      if (task.config.factorTrackingEnabled !== false) {
        const observation = await buildProbeObservation({
          task: executionTask,
          scheduleEntry,
          account,
          country,
          hit: evaluatedHit,
          round: roundNo,
          sequence: processed,
          scheduleBlock: scheduleEntry.block,
          scheduleCellAttempt: scheduleEntry.cellAttempt,
          runId,
          cycleId: unit.cycleId,
          unitId: unit.unitId,
          attemptId: unit.attemptId,
          observationStartedAt,
          durationMs: Date.now() - observationStartedAt,
        });
        await appendProbeObservation(observation, task.config);
      }
      if (isHit) {
        hits += 1;
        let hit = evaluatedHit;
        const persisted = await appendProbeHitAndMaybePersist(hit, {
          saveToDb: task.config.saveHitsToDatabase !== false,
          taskName: task.config.name,
        });
        hit = persisted.hit;
        await markAccountHit(account.id, country, hit.message, true);
        await notifyProbeHit(task, hit);
        await logRun('success', hit.message || '命中优惠/试用链接', {
          stage: 'hit',
          code: String(hit.hitKind || 'HIT').toUpperCase(),
          taskId,
          accountId: account.id,
          email: account.email,
          accountLabel: label,
          country,
          progress: progressLabel(processed, totalPairs),
          meta: {
            hitKind: hit.hitKind,
            amount: hit.amountHint || '',
            methods: (hit.detectedMethods || []).join('|'),
            finalUrl: Boolean(hit.finalPaymentUrl),
            link: hit.link ? 'yes' : 'no',
          },
        });
        if (experimentMode === 'discovery' && task.config.skipAccountAfterHit) {
          skippedAccounts.add(account.id);
        }
      } else if ((!evaluatedHit.ok || evaluatedHit.hitKind === 'error') && !resolvedMiss) {
        errors += 1;
        await markAccountHit(account.id, country, evaluatedHit.message, false);
        const classified = classifyFailureLevel(evaluatedHit.message || '');
        await logRun(classified.level, evaluatedHit.message || '探测失败', {
          stage: 'account',
          code: classified.level === 'warn' ? 'RETRYABLE' : 'TERMINAL',
          taskId,
          accountId: account.id,
          email: account.email,
          accountLabel: label,
          country,
          progress: progressLabel(processed, totalPairs),
          action: classified.action,
        });
      } else {
        await logRun('info', evaluatedHit.message || '未命中资格门', {
          stage: 'account',
          code: 'MISS',
          taskId,
          accountId: account.id,
          email: account.email,
          accountLabel: label,
          country,
          progress: progressLabel(processed, totalPairs),
        });
      }
      completedUnits += 1;
      const unitStatus = isHit ? 'hit' : resolvedMiss ? 'miss' : (!result.hit.ok || result.hit.hitKind === 'error') ? 'error' : 'miss';
      patchUnitRuntime(unitStates, unit.unitId, {
        status: unitStatus,
        finishedAt: Date.now(),
        durationMs: Date.now() - unitStartedAt,
        hitKind: result.hit.hitKind,
        errorClass: unitStatus === 'error' ? resultErrorClass : '',
        message: result.hit.message,
      });
      state = await updateTaskRuntime(taskId, {
        completedUnits,
        skippedUnits,
        processed,
        hits,
        errors,
        unitStates,
        lastMessage: result.hit.message,
      });
      await delay(250);
  }

  const nextRunAt = reschedule && !stopRequested
    ? Date.now() + task.config.intervalSec * 1000
    : 0;
  if (reschedule && !stopRequested) {
    await ensureAlarm(taskId, task.config.intervalSec);
  } else {
    await clearProbeAlarm(taskId);
  }

  runningTaskId = '';
  const planSuffix = countryPlan.note ? `（${countryPlan.note}）` : '';
  const doneMessage = stopRequested
    ? `已停止：处理 ${processed}，命中 ${hits}，错误 ${errors}${planSuffix}`
    : `本轮完成：处理 ${processed}，命中 ${hits}，错误 ${errors}${planSuffix}`;
  await logRun(stopRequested ? 'warn' : 'success', doneMessage, {
    stage: 'done',
    code: stopRequested ? 'STOPPED' : 'ROUND_DONE',
    taskId,
    progress: progressLabel(completedUnits, totalPairs),
    action: stopRequested ? '任务已停止' : undefined,
    meta: { processed, hits, errors, round: roundNo },
  });
  return updateTaskRuntime(taskId, {
    status: stopRequested ? 'stopped' : reschedule ? 'running' : 'completed',
    finishedAt: Date.now(),
    nextRunAt,
    currentAccountId: '',
    currentCountry: '',
    currentUnitId: '',
    currentAttemptId: '',
    cycleId: '',
    totalUnits: totalPairs,
    completedUnits,
    skippedUnits,
    processed,
    hits,
    errors,
    lastMessage: doneMessage,
    unitStates,
  });
}

function patchUnitRuntime(
  units: ProbeTaskUnitRuntime[],
  unitId: string,
  patch: Partial<ProbeTaskUnitRuntime>,
): void {
  const index = units.findIndex((item) => item.unitId === unitId);
  if (index < 0) return;
  units[index] = { ...units[index], ...patch };
}

function materializeScheduleTask(
  task: ProbeTask,
  entry: ProbeScheduleEntry,
  experimentMode: ProbeExperimentMode,
): ProbeTask {
  const routeControlled = task.config.controlledFactors.includes('route');
  return {
    ...task,
    config: {
      ...task.config,
      experimentMode,
      researchModeEnabled: experimentMode !== 'discovery',
      stagedPipelineEnabled: task.config.stagedPipelineEnabled || routeControlled,
      useSelectedAsBootstrapProvider: routeControlled ? false : task.config.useSelectedAsBootstrapProvider,
      bootstrapCountry: routeControlled ? entry.authCountry : task.config.bootstrapCountry,
      promotionCountry: routeControlled ? entry.checkoutCountry : task.config.promotionCountry,
      providerCountry: routeControlled ? entry.billingCountry : task.config.providerCountry,
      paymentMethod: task.config.controlledFactors.includes('paymentMethod')
        ? entry.paymentMethod
        : entry.paymentMethod || task.config.paymentMethod,
    },
  };
}

async function probeAccountCountry(
  task: ProbeTask,
  account: ProbeAccount,
  country: string,
  accountIndex = -1,
  seedOrdinal = 1,
): Promise<{ hit: ProbeHitRecord }> {
  const label = accountLogLabel(account, accountIndex);
  let token = tryExtractAccessToken(account.tokenRaw);

  try {
    await restoreProbeAccountIdentity(account);
  } catch (error) {
    return {
      hit: buildHit(task, account, country, {
        ok: false,
        hitKind: 'error',
        message: `账号身份快照恢复失败：${error instanceof Error ? error.message : String(error)}`,
      }),
    };
  }

  // 组合认证：有 cookie 快照时用 /api/auth/session 刷新 AT，刷新成功则回写账号并用于本轮探测
  try {
    const refreshed = await refreshAccessTokenFromCookie(account);
    if (refreshed?.ok && refreshed.accessToken) {
      token = refreshed.accessToken;
      const current = await loadProbeState();
      const updated = current.accounts.map((item) => item.id === account.id
        ? {
            ...item,
            tokenRaw: refreshed.accessToken,
            tokenUpdatedAt: Date.now(),
            serverCredentialStatus: 'valid' as const,
            credentialCheckedAt: Date.now(),
            credentialMessage: 'cookie 会话刷新 accessToken 成功',
            identitySnapshot: refreshed.sessionToken
              ? createSessionIdentitySnapshot(refreshed.sessionToken, item.identitySnapshot)
              : item.identitySnapshot,
          }
        : item);
      await saveProbeState({ accounts: updated });
      await logRun('info', 'cookie 会话已刷新 accessToken', {
        stage: 'account',
        code: 'SESSION_TOKEN_REFRESHED',
        taskId: task.id,
        accountId: account.id,
        email: account.email,
        accountLabel: label,
        country,
      });
    } else if (refreshed && !refreshed.ok) {
      const current = await loadProbeState();
      await saveProbeState({
        accounts: current.accounts.map((item) => item.id === account.id
          ? {
              ...item,
              serverCredentialStatus: 'invalid' as const,
              credentialCheckedAt: Date.now(),
              credentialMessage: refreshed.message,
            }
          : item),
      });
      await logRun('warn', refreshed.message, {
        stage: 'account',
        code: 'SESSION_REFRESH_REJECTED',
        taskId: task.id,
        accountId: account.id,
        email: account.email,
        accountLabel: label,
        country,
        action: '更新 Session Token 或重新同步网页登录会话',
      });
    }
  } catch {
    // 刷新失败不阻塞：继续 AT-only 探测路径
  }

  if (!token) {
    await logRun('error', '账号 token 无效', {
      stage: 'account',
      code: 'TOKEN_INVALID',
      taskId: task.id,
      accountId: account.id,
      email: account.email,
      accountLabel: label,
      country,
      action: '更新 accessToken 或 Session Token 后重试',
    });
    return {
      hit: buildHit(task, account, country, {
        ok: false,
        hitKind: 'error',
        message: '账号 token 无效',
      }),
    };
  }

  try {
    await withProbeOperationTimeout(applyProbeProxy(task, country, 'checkout'), 20_000, '代理切换');
  } catch (error) {
    const message = `代理切换失败：${error instanceof Error ? error.message : String(error)}`;
    await logRun('error', message, {
      stage: 'proxy',
      code: 'PROXY_APPLY_TIMEOUT',
      taskId: task.id,
      accountId: account.id,
      email: account.email,
      accountLabel: label,
      country,
      action: '检查 Firefox 代理权限、前置端口或切换备用出口',
    });
    return {
      hit: buildHit(task, account, country, { ok: false, hitKind: 'error', message }),
    };
  }
  await logRun('debug', `已切换出口代理 @ ${country}`, {
    stage: 'proxy',
    code: 'PROXY_APPLIED',
    taskId: task.id,
    accountId: account.id,
    email: account.email,
    accountLabel: label,
    country,
  });

  let lastMessage = '探测失败';
  let lastResponse: Awaited<ReturnType<typeof createCheckoutLinkDirect>> | null = null;
  const checkoutAttemptLimit = Math.min(
    Math.max(1, task.config.retryCount + 1),
    task.config.maxCheckoutAttemptsPerUnit,
  );
  const retries = task.config.stagedPipelineEnabled ? 0 : checkoutAttemptLimit - 1;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (stopRequested) {
      await logRun('warn', '探测已停止', {
        stage: 'account',
        code: 'STOP',
        taskId: task.id,
        accountId: account.id,
        email: account.email,
        accountLabel: label,
        country,
        action: '任务已停止',
      });
      return {
        hit: buildHit(task, account, country, {
          ok: false,
          hitKind: 'error',
          message: '探测已停止',
        }),
      };
    }
    try {
      if (task.config.stagedPipelineEnabled) {
        await logRun('info', '进入三阶段 checkout', {
          stage: 'checkout',
          code: 'STAGED_START',
          taskId: task.id,
          accountId: account.id,
          email: account.email,
          accountLabel: label,
          country,
          progress: `attempt ${attempt + 1}/${retries + 1}`,
        });
      }
      const response = await runCheckoutModesForCountry(task, token, country, account, accountIndex, seedOrdinal);
      lastResponse = response;
      if (!response.ok && (response.credentialInvalid || response.tokenAuthStatus === 'invalid_jwt' || response.tokenAuthStatus === 'token_rejected')) {
        await markAccountCredentialInvalid(account.id, `${label} ${country}：${response.tokenAuthStatus || 'credential_invalid'}，accessToken 已被服务端拒绝`);
        await logRun('warn', `${label} ${country}：token 被服务端拒绝（${response.tokenAuthStatus || 'credential_invalid'}），本轮剔除该账号`, {
          stage: 'account',
          code: 'CREDENTIAL_INVALID_LIVE',
          taskId: task.id,
          accountId: account.id,
          email: account.email,
          accountLabel: label,
          country,
          action: '重新同步登录会话后重试',
        });
        break;
      }
      if (response.stageTrace?.length) {
        await logRun('info', `阶段轨迹 ${response.stageTrace.join(' > ')}`, {
          stage: 'checkout',
          code: 'STAGE_TRACE',
          taskId: task.id,
          accountId: account.id,
          email: account.email,
          accountLabel: label,
          country,
          meta: { trace: response.stageTrace.join('>') },
        });
      }
      if (!response.ok
        && task.config.requireZero
        && task.config.sniffCheckoutOnHit
        && (response.link || response.url)
        && /requirezero.*amount=unknown/i.test(response.message || '')) {
        const candidate = appendCheckoutQualification(buildHit(task, account, country, {
          ok: true,
          hitKind: 'link',
          message: `严格门候选待页面复核 · ${response.message}`,
          link: response.link || response.url || '',
          longUrl: response.longUrl || response.providerUrl || '',
          shortUrl: response.shortUrl || response.canonicalUrl || '',
          channels: ['hosted'],
          amountHint: response.amountHint || '',
           promoHint: response.promoLikely ? 'promo' : '',
           rawKeys: response.responseKeys || [],
           checkoutUiMode: task.config.checkoutUiMode,
           checkoutVariants: response.checkoutVariants || [],
           checkoutRetryMetrics: response.retryMetrics,
        }), response, account);
        const verified = await openAndSniffCheckoutHit(task, candidate);
        const strictQualified = Boolean(verified.sniff?.zeroLikely || verified.sniff?.trialLikely);
        const zeroQualified = Boolean(verified.sniff?.zeroLikely);
        if (strictQualified && (!task.config.requireZero || zeroQualified)) {
          const strictHit: ProbeHitRecord = {
            ...verified,
            ok: true,
            hitKind: verified.sniff?.zeroLikely ? 'zero' : 'trial',
            qualificationVerified: true,
            checkoutCreated: true,
            qualificationGateVersion: 'strict-zero-page-v2',
            linkVerificationLevel: 'strict-page',
            linkUsable: Boolean(verified.link && verified.sniff?.ok),
            finalLinkVerified: false,
           retryOrdinal: attempt + 1,
           checkoutUiMode: task.config.checkoutUiMode,
           checkoutVariants: response.checkoutVariants || [],
           checkoutRetryMetrics: response.retryMetrics,
            message: `${verified.message} · 严格页面资格门通过`,
            tags: [...new Set([...(verified.tags || []), 'strict-page-verified'])],
          };
          await recordStageSeedsOutcome(true, strictHit.message);
          return { hit: await maybeEnrichFinalUrl(task, strictHit, response, account, accountIndex, seedOrdinal) };
        }
        if (verified.tabId) await browser.tabs.remove(verified.tabId).catch(() => undefined);
        response.message = `${response.message} · 页面复核未发现明确零元/试用`;
      }
      if (response.ok && (response.link || response.url)) {
        const classified = classifyCheckoutHit(response, task.config.channels);
        if (task.config.requireZero) {
          const zero = Boolean(response.zeroLikely)
            || classified.hitKind === 'zero'
            || isZeroAmountValue(classified.amountHint || response.amountHint || '');
          if (!zero) {
            lastMessage = `requireZero 未通过：amount=${classified.amountHint || response.amountHint || 'unknown'} · ${classified.message || response.message}`;
            lastResponse = {
              ...response,
              ok: false,
              message: lastMessage,
            };
            const fail = classifyFailureLevel(lastMessage);
            await logRun(fail.level, lastMessage, {
              stage: 'checkout',
              code: 'REQUIRE_ZERO',
              taskId: task.id,
              accountId: account.id,
              email: account.email,
              accountLabel: label,
              country,
              progress: `attempt ${attempt + 1}/${retries + 1}`,
              action: fail.action,
            });
            await recordStageSeedsOutcome(false, lastMessage);
            if (attempt < retries) {
              await logRun('warn', `准备重试 (${attempt + 1}/${retries})`, {
                stage: 'retry',
                code: 'RETRY',
                taskId: task.id,
                accountId: account.id,
                email: account.email,
                accountLabel: label,
                country,
                action: '可换出口/国家继续撞资格',
              });
              await delay(800 * (attempt + 1));
            }
            continue;
          }
        }

        const baseHit = appendCheckoutQualification(buildHit(task, account, country, {
          ok: true,
          hitKind: task.config.requireZero
            && (classified.hitKind === 'link' || classified.hitKind === 'channel')
            ? 'zero'
            : classified.hitKind,
          message: [classified.message, response.stageTrace?.length ? `stages=${response.stageTrace.join('>')}` : ''].filter(Boolean).join(' · '),
          link: response.link || response.url || '',
          longUrl: response.longUrl || response.providerUrl || '',
          shortUrl: response.shortUrl || response.canonicalUrl || '',
          channels: classified.channels,
          amountHint: classified.amountHint || response.amountHint || '',
          promoHint: classified.promoHint || (response.promoLikely ? 'promo' : ''),
          rawKeys: response.responseKeys || [],
          checkoutCreated: true,
          qualificationVerified: task.config.requireZero,
          qualificationGateVersion: task.config.requireZero ? 'strict-zero-response-v2' : 'checkout-created-v1',
          linkVerificationLevel: task.config.requireZero ? 'strict-response' : 'candidate',
          linkUsable: Boolean(task.config.requireZero && (response.link || response.url)),
          retryOrdinal: attempt + 1,
        }), response, account);
        await recordStageSeedsOutcome(true, baseHit.message || 'hit');
        return {
          hit: await maybeEnrichFinalUrl(task, baseHit, response, account, accountIndex, seedOrdinal),
        };
      }
      lastMessage = response.message || '未返回链接';
      const fail = classifyFailureLevel(lastMessage);
      await logRun(fail.level, lastMessage, {
        stage: 'checkout',
        code: 'NO_LINK',
        taskId: task.id,
        accountId: account.id,
        email: account.email,
        accountLabel: label,
        country,
        progress: `attempt ${attempt + 1}/${retries + 1}`,
        action: fail.action,
      });
    } catch (error) {
      lastMessage = error instanceof Error ? error.message : String(error);
      const fail = classifyFailureLevel(lastMessage);
      await logRun(fail.level, lastMessage, {
        stage: 'checkout',
        code: 'EXCEPTION',
        taskId: task.id,
        accountId: account.id,
        email: account.email,
        accountLabel: label,
        country,
        progress: `attempt ${attempt + 1}/${retries + 1}`,
        action: fail.action,
      });
    }
    await recordStageSeedsOutcome(false, lastMessage);
    if (attempt < retries) {
      await logRun('warn', `准备重试 (${attempt + 1}/${retries})`, {
        stage: 'retry',
        code: 'RETRY',
        taskId: task.id,
        accountId: account.id,
        email: account.email,
        accountLabel: label,
        country,
        action: '可重试；检查代理连通',
      });
      await delay(800 * (attempt + 1));
    }
  }

  return {
    hit: buildHit(task, account, country, {
      ok: false,
      hitKind: 'error',
      message: lastMessage,
      link: lastResponse?.link || lastResponse?.url || '',
      longUrl: lastResponse?.longUrl || lastResponse?.providerUrl || '',
      shortUrl: lastResponse?.shortUrl || lastResponse?.canonicalUrl || '',
      amountHint: lastResponse?.amountHint || '',
      rawKeys: lastResponse?.responseKeys || [],
      checkoutCreated: Boolean(lastResponse?.link || lastResponse?.url),
      qualificationVerified: false,
      qualificationGateVersion: task.config.requireZero ? 'strict-zero-rejected-v2' : 'checkout-response-error-v1',
      linkVerificationLevel: 'candidate',
      linkUsable: false,
      retryOrdinal: retries + 1,
      checkoutUiMode: task.config.checkoutUiMode,
      checkoutVariants: lastResponse?.checkoutVariants || [],
      checkoutRetryMetrics: lastResponse?.retryMetrics,
    }),
  };
}

function classifyCheckoutHit(
  response: Awaited<ReturnType<typeof createCheckoutLinkDirect>>,
  wantedChannels: string[],
): {
  hitKind: ProbeHitKind;
  message: string;
  channels: string[];
  amountHint: string;
  promoHint: string;
} {
  const rawText = safeJson(response.raw).toLowerCase();
  const link = String(response.link || response.url || '');
  const channels: string[] = [];
  for (const channel of wantedChannels) {
    if (rawText.includes(channel.toLowerCase()) || link.toLowerCase().includes(channel.toLowerCase())) {
      channels.push(channel);
    }
  }
  // hosted link itself counts as hosted channel
  if (link && wantedChannels.includes('hosted') && !channels.includes('hosted')) {
    channels.push('hosted');
  }

  const structuredAmount = parseStructuredCheckoutAmount(response.raw);
  const amountHint = response.amountHint || structuredAmount.amountHint;
  const zeroByAmount = response.amountMinor === 0 || structuredAmount.amountMinor === 0;
  const trialLike = /free_trial|trial_period|trialing|plus-1-month-free|team-1-month-free|1-month-free|month free|days? free|免费试用|首月免费|试用/i.test(rawText);
  const promoLike = /promo_campaign|promo|campaign|coupon|discount|introductory|percent_off|amount_off/i.test(rawText);
  const zero = zeroByAmount;

  let hitKind: ProbeHitKind = 'link';
  if (zero) hitKind = 'zero';
  else if (trialLike) hitKind = 'trial';
  else if (promoLike) hitKind = 'promo';
  else if (channels.length) hitKind = 'channel';
  else if (response.ok && link) hitKind = 'link';

  const country = response.billingDetails?.country || '';
  const currency = response.billingDetails?.currency || '';
  const promoHint = /plus-1-month-free|team-1-month-free|1-month-free/i.test(rawText)
    ? '1-month-free'
    : (trialLike ? 'trial' : (promoLike ? 'promo' : ''));
  const message = [
    `命中 ${country}/${currency}`,
    hitKind,
    amountHint ? `amount=${amountHint}` : '',
    promoHint ? `promo=${promoHint}` : '',
    channels.length ? `channels=${channels.join(',')}` : '',
    link ? '已提取链接' : '',
  ].filter(Boolean).join(' · ');

  return {
    hitKind,
    message,
    channels,
    amountHint,
    promoHint,
  };
}

function resolveStagedCountries(task: ProbeTask, selectedCountry: string): {
  bootstrapCountry: string;
  promotionCountry: string;
  providerCountry: string;
} {
  const selected = String(selectedCountry || '').trim().toUpperCase();
  const promotion = String(task.config.promotionCountry || 'VN').trim().toUpperCase() || 'VN';
  if (task.config.useSelectedAsBootstrapProvider !== false) {
    return {
      bootstrapCountry: selected,
      promotionCountry: promotion,
      providerCountry: selected,
    };
  }
  const bootstrap = String(task.config.bootstrapCountry || selected).trim().toUpperCase() || selected;
  const provider = String(task.config.providerCountry || bootstrap).trim().toUpperCase() || bootstrap;
  return {
    bootstrapCountry: bootstrap,
    promotionCountry: promotion,
    providerCountry: provider,
  };
}

export function isQualifiedProbeHit(task: Pick<ProbeTask, 'config'>, hit: ProbeHitRecord): boolean {
  const candidate = hit.ok && hit.hitKind !== 'none' && hit.hitKind !== 'error' && Boolean(hit.link);
  if (!candidate) return false;
  return task.config.requireZero ? Boolean(hit.qualificationVerified) : true;
}

function resetActiveProbeStageTrace(): void {
  delete activeProbeStageTrace.bootstrap;
  delete activeProbeStageTrace.promotion;
  delete activeProbeStageTrace.provider;
  delete activeProbeStageTrace.checkout;
}

async function rememberProbeStageTrace(
  stage: 'bootstrap' | 'promotion' | 'provider' | 'checkout',
  country: string,
  endpointSummary: string,
  source: string,
): Promise<void> {
  const trace = await verifyCurrentExit();
  activeProbeStageTrace[stage] = {
    cycleId: activeProbeCycleId,
    configuredCountry: String(country || '').trim().toUpperCase(),
    country: trace.country || String(country || '').trim().toUpperCase(),
    ip: trace.ip,
    asn: trace.asn,
    colo: trace.colo,
    latencyMs: trace.latencyMs,
    checkedAt: trace.checkedAt,
    endpointSummary: sanitizeEndpointSummary(endpointSummary),
    source,
    verified: trace.verified,
    message: trace.message,
  };
}

async function buildProbeObservation(input: {
  task: ProbeTask;
  scheduleEntry: ProbeScheduleEntry;
  account: ProbeAccount;
  country: string;
  hit: ProbeHitRecord;
  round: number;
  sequence: number;
  scheduleBlock: number;
  scheduleCellAttempt: number;
  runId: string;
  cycleId: string;
  unitId: string;
  attemptId: string;
  observationStartedAt: number;
  durationMs: number;
}): Promise<ProbeObservation> {
  const now = Date.now();
  const proxy = await loadProxySettings();
  const probeState = await loadProbeState();
  const stages = resolveStagedCountries(input.task, input.country);
  const checkoutRef = activeProbeStageTrace.promotion || activeProbeStageTrace.bootstrap || activeProbeStageTrace.checkout;
  const billingRef = activeProbeStageTrace.provider;
  const auth = buildFreshProbeStageSnapshot(input.account.authEvidence, '', 0);
  const checkout = buildFreshProbeStageSnapshot(checkoutRef, stages.bootstrapCountry, input.observationStartedAt);
  const billing = buildFreshProbeStageSnapshot(billingRef, stages.providerCountry, input.observationStartedAt);
  const browserFamily = typeof navigator !== 'undefined' && /firefox/i.test(navigator.userAgent) ? 'firefox' : 'chromium';
  const locale = (() => {
    try { return browser.i18n.getUILanguage(); } catch { return typeof navigator !== 'undefined' ? navigator.language : ''; }
  })();
  const timeZone = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
  })();
  const isHit = isQualifiedProbeHit(input.task, input.hit);
  const errorClass = input.hit.ok ? '' : classifyObservationError(input.hit.message);
  const resolvedMiss = errorClass === 'price-not-qualified' || errorClass === 'eligibility-miss';
  const manifestVersion = browser.runtime.getManifest().version;
  const tokenExpiresAt = accessTokenExpiresAt(input.account.tokenRaw);
  const emailDomainCohort = String(input.account.email.split('@')[1] || 'unknown').trim().toLowerCase();
  const actualCheckoutCountry = checkout.country || stages.bootstrapCountry || input.country;
  const localeCountry = localeRegion(locale);
  const timeZoneCountry = timeZoneRegion(timeZone);
  const checkoutHealth = probeState.proxyHealth
    .filter((item) => item.status === 'ok' && (item.actualIp === checkout.ip || item.country === actualCheckoutCountry))
    .sort((a, b) => b.checkedAt - a.checkedAt)[0];
  const schemaSource = (input.hit.rawKeys || []).length
    ? [...input.hit.rawKeys].sort()
    : [input.hit.hitKind, input.hit.paymentRunnerStage || 'no-runner', input.hit.finalUrlSource || 'no-final-url'];
  const checkoutSchemaFingerprint = `schema-${stableFingerprint(schemaSource.join('|'))}`;
  const offerSetFingerprint = `offers-${stableFingerprint([
    ...(input.hit.detectedMethods || []).map((item) => item.toLowerCase()).sort(),
    input.hit.currency || '', input.hit.amountHint || '', input.hit.promoHint || '',
  ].join('|'))}`;
  const upstreamProtocolFingerprint = `protocol-${stableFingerprint([
    checkoutSchemaFingerprint,
    input.task.config.planName,
    input.task.config.stagedPipelineEnabled ? 'staged' : 'direct',
    input.hit.paymentRunnerCode || 'runner-none',
  ].join('|'))}`;
  const previousCell = probeState.observations
    .filter((item) => item.accountId === input.account.id && item.probeCountry === input.country)
    .sort((a, b) => b.observedAt - a.observedAt)[0];
  const credentialStatus = input.account.serverCredentialStatus || 'unchecked';
  const treatmentValidity = evaluateProbeTreatmentValidity({
    plannedAuthCountry: input.scheduleEntry.authCountry,
    plannedCheckoutCountry: input.scheduleEntry.checkoutCountry,
    plannedBillingCountry: input.scheduleEntry.billingCountry,
    plannedPaymentMethod: input.scheduleEntry.paymentMethod,
    submittedPaymentMethod: input.hit.submittedPaymentMethod || '',
    credentialStatus,
    outcome: isHit ? 'hit' : input.hit.ok || resolvedMiss ? 'miss' : 'error',
    auth,
    checkout,
    billing,
  });
  return {
    id: `obs-${now}-${Math.random().toString(36).slice(2, 8)}`,
    observedAt: now,
    taskId: input.task.id,
    runId: input.runId,
    cycleId: input.cycleId,
    unitId: input.unitId,
    attemptId: input.attemptId,
    round: input.round,
    sequence: input.sequence,
    researchMode: input.task.config.researchModeEnabled,
    experimentMode: input.task.config.experimentMode,
    experimentArm: input.scheduleEntry.arm,
    designCellKey: input.scheduleEntry.designCellKey,
    routeVariantId: input.scheduleEntry.routeVariantId,
    plannedAuthCountry: input.scheduleEntry.authCountry,
    plannedCheckoutCountry: input.scheduleEntry.checkoutCountry,
    plannedBillingCountry: input.scheduleEntry.billingCountry,
    plannedPaymentMethod: input.scheduleEntry.paymentMethod,
    plannedSeedOrdinal: input.scheduleEntry.seedOrdinal,
    scheduleBlock: input.scheduleBlock,
    scheduleCellAttempt: input.scheduleCellAttempt,
    accountId: input.account.id,
    accountBatchId: input.account.batchId || `${input.account.source}-unknown`,
    accountSource: input.account.source,
    accountAgeHours: Math.max(0, Math.round(((now - (input.account.createdAt || now)) / 3600000) * 10) / 10),
    tokenAgeHours: Math.max(0, Math.round(((now - (input.account.tokenUpdatedAt || now)) / 3600000) * 10) / 10),
    tokenExpiryHorizonHours: tokenExpiresAt ? Math.round(((tokenExpiresAt - now) / 3600000) * 10) / 10 : 0,
    emailDomainCohort,
    browserProfileCohort: `${browser.extension.inIncognitoContext ? 'private' : 'regular'}:${browserFamily}`,
    deviceCohort: deviceCohort(),
    probeCountry: input.country,
    bootstrapCountry: stages.bootstrapCountry,
    promotionCountry: stages.promotionCountry,
    providerCountry: stages.providerCountry,
    channels: input.hit.channels || [],
    planName: input.task.config.planName,
    paymentMethod: input.hit.paymentMethod || resolveTaskPaymentMethod(input.task),
    currency: input.hit.currency || '',
    campaignId: tagValue(input.hit.tags || [], 'campaign'),
    productId: input.task.config.planName,
    checkoutMode: input.task.config.stagedPipelineEnabled ? 'staged' : 'direct',
    outcome: isHit ? 'hit' : input.hit.ok || resolvedMiss ? 'miss' : 'error',
    hitKind: input.hit.hitKind,
    amountHint: input.hit.amountHint || '',
    promoHint: input.hit.promoHint || '',
    detectedMethods: input.hit.detectedMethods || [],
    paymentRunnerStatus: input.hit.paymentRunnerStatus || '',
    paymentRunnerStage: input.hit.paymentRunnerStage || '',
    paymentRunnerCode: input.hit.paymentRunnerCode || '',
    paymentCheckoutSessionMode: input.hit.paymentCheckoutSessionMode || 'independent_checkout',
    paymentCheckoutStatus: input.hit.paymentCheckoutStatus || '',
    paymentCheckoutSessionDistinct: Boolean(input.hit.paymentCheckoutSessionDistinct),
    paymentMethodLinkCount: (input.hit.paymentMethodLinks || [])
      .filter((item) => item.method !== 'hosted' && item.finalLinkVerified && item.url).length,
    qualificationVerified: Boolean(input.hit.qualificationVerified),
    qualificationType: input.hit.qualificationType || 'unknown',
    qualificationEvidenceLevel: input.hit.qualificationEvidenceLevel || 'candidate',
    qualificationDriftCount: input.hit.qualificationDriftEvents?.length || 0,
    submittedPaymentMethod: input.hit.submittedPaymentMethod || '',
    paymentRunnerConfirmSubmitted: Boolean(input.hit.paymentRunnerConfirmSubmitted),
    paymentRunnerConfirmSucceeded: Boolean(input.hit.paymentRunnerConfirmSucceeded),
    paymentRunnerApproveSubmitted: Boolean(input.hit.paymentRunnerApproveSubmitted),
    paymentRunnerApproveSucceeded: Boolean(input.hit.paymentRunnerApproveSucceeded),
    finalLinkVerified: Boolean(input.hit.finalLinkVerified),
    checkoutCreated: Boolean(input.hit.checkoutCreated || input.hit.link || input.hit.longUrl || input.hit.shortUrl),
    qualificationGateVersion: input.hit.qualificationGateVersion || '',
    linkVerificationLevel: input.hit.linkVerificationLevel || 'candidate',
    linkUsable: Boolean(input.hit.linkUsable),
    credentialStatus,
    ...treatmentValidity,
    errorClass,
    durationMs: input.durationMs,
    configuredRetries: input.task.config.retryCount,
    retryOrdinal: Math.max(1, input.hit.retryOrdinal || 1),
    checkoutUiMode: input.hit.checkoutUiMode || input.task.config.checkoutUiMode,
    checkoutAttempts: input.hit.checkoutRetryMetrics?.checkoutAttempts || 0,
    updateAttempts: input.hit.checkoutRetryMetrics?.updateAttempts || 0,
    fullFlowAttempts: input.hit.checkoutRetryMetrics?.fullFlowAttempts || 0,
    cfRetryCount: input.hit.checkoutRetryMetrics?.cfRetryCount || 0,
    cfExitRotations: input.hit.checkoutRetryMetrics?.cfExitRotations || 0,
    invalidPromotionRebuilds: input.hit.checkoutRetryMetrics?.invalidPromotionRebuilds || 0,
    pageFallbackAttempts: input.hit.checkoutRetryMetrics?.pageFallbackAttempts || 0,
    cooldownElapsedMinutes: previousCell ? Math.max(0, Math.round((now - previousCell.observedAt) / 6000) / 10) : 0,
    stagedPipelineEnabled: input.task.config.stagedPipelineEnabled,
    entryProxyMode: input.task.config.entryProxyMode,
    exitProxyMode: input.task.config.exitProxyMode,
    frontProxySummary: sanitizeEndpointSummary(formatProxyEndpoint(proxy.front)),
    auth,
    checkout,
    billing,
    bootstrapSeedSummary: activeProbeStageTrace.bootstrap?.endpointSummary || '',
    promotionSeedSummary: activeProbeStageTrace.promotion?.endpointSummary || '',
    providerSeedSummary: activeProbeStageTrace.provider?.endpointSummary || '',
    extensionVersion: manifestVersion,
    browserFamily,
    locale,
    timeZone,
    localeExitAlignment: alignment(localeCountry, actualCheckoutCountry),
    timeZoneExitAlignment: alignment(timeZoneCountry, actualCheckoutCountry),
    checkoutSubnet: subnetOf(checkout.ip),
    checkoutNetworkType: checkoutHealth?.networkType || 'unknown',
    checkoutSchemaFingerprint,
    offerSetFingerprint,
    upstreamProtocolFingerprint,
    ruleEpochId: `epoch-${upstreamProtocolFingerprint}`,
  };
}

function accessTokenExpiresAt(raw: string): number {
  const token = tryExtractAccessToken(raw) || String(raw || '').trim();
  try {
    const segment = token.split('.')[1];
    if (!segment) return 0;
    const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
    const payload = JSON.parse(atob(padded)) as { exp?: number };
    return Number(payload.exp || 0) * 1000;
  } catch {
    return 0;
  }
}

function localeRegion(locale: string): string {
  const match = String(locale || '').replace('_', '-').match(/-([A-Za-z]{2})(?:-|$)/);
  return match ? match[1].toUpperCase() : '';
}

function timeZoneRegion(timeZone: string): string {
  const value = String(timeZone || '');
  const exact: Record<string, string> = {
    'Asia/Shanghai': 'CN', 'Asia/Hong_Kong': 'HK', 'Asia/Tokyo': 'JP', 'Asia/Seoul': 'KR',
    'Asia/Kolkata': 'IN', 'Asia/Bangkok': 'TH', 'Asia/Singapore': 'SG', 'Europe/Amsterdam': 'NL',
    'Europe/Berlin': 'DE', 'Europe/Paris': 'FR', 'Europe/Zurich': 'CH', 'America/New_York': 'US',
    'America/Los_Angeles': 'US', 'America/Chicago': 'US', 'America/Sao_Paulo': 'BR', 'Australia/Sydney': 'AU',
  };
  return exact[value] || '';
}

function alignment(contextCountry: string, exitCountry: string): 'match' | 'mismatch' | 'unknown' {
  if (!contextCountry || !exitCountry) return 'unknown';
  return contextCountry === exitCountry.toUpperCase() ? 'match' : 'mismatch';
}

function subnetOf(ip: string): string {
  const text = String(ip || '').trim();
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(text)) return `${text.split('.').slice(0, 3).join('.')}.0/24`;
  if (text.includes(':')) return `${text.split(':').slice(0, 4).join(':')}::/64`;
  return '';
}

function deviceCohort(): string {
  if (typeof navigator === 'undefined') return 'background:unknown';
  const nav = navigator as Navigator & { userAgentData?: { platform?: string; mobile?: boolean } };
  const platform = String(nav.userAgentData?.platform || nav.platform || 'unknown').toLowerCase();
  const mobile = nav.userAgentData?.mobile || /mobile/i.test(nav.userAgent) ? 'mobile' : 'desktop';
  return `${platform}:${mobile}`;
}

function tagValue(tags: string[], key: string): string {
  const prefix = `${key.toLowerCase()}:`;
  return String(tags.find((item) => item.toLowerCase().startsWith(prefix)) || '').slice(prefix.length);
}

function stableFingerprint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function sanitizeEndpointSummary(value: string): string {
  return String(value || '').replace(/(\/\/)[^@/\s]+@/g, '$1***@').trim();
}

async function withProbeOperationTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer = 0;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}超时 ${timeoutMs}ms`)), timeoutMs) as unknown as number;
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function classifyObservationError(message: string): string {
  const text = String(message || '').toLowerCase();
  if (/401|403|token|unauthor|forbidden/.test(text)) return 'account-auth';
  if (/429|rate.?limit|too many/.test(text)) return 'rate-limit';
  if (/timeout|abort|timed out/.test(text)) return 'timeout';
  if (/proxy|tunnel|connect|network|fetch/.test(text)) return 'network-proxy';
  if (/captcha|challenge|cloudflare/.test(text)) return 'challenge';
  if (/amount|requirezero/.test(text)) return 'price-not-qualified';
  if (/422|enum|billing_details.*currency|input should be/.test(text)) return 'protocol-incompatible';
  if (/no.link|未返回链接|not eligible|资格/.test(text)) return 'eligibility-miss';
  return 'upstream-other';
}

async function runCheckoutModesForCountry(
  task: ProbeTask,
  token: string,
  country: string,
  account: ProbeAccount,
  accountIndex: number,
  seedOrdinal: number,
): Promise<Awaited<ReturnType<typeof createCheckoutLinkDirect>>> {
  const modes = task.config.checkoutUiMode === 'both'
    ? ['hosted', 'custom'] as const
    : [task.config.checkoutUiMode === 'custom' ? 'custom' : 'hosted'] as const;
  const responses: Awaited<ReturnType<typeof createCheckoutLinkDirect>>[] = [];
  for (const mode of modes) {
    const modeTask: ProbeTask = { ...task, config: { ...task.config, checkoutUiMode: mode } };
    const response = modeTask.config.stagedPipelineEnabled
      ? await runStagedCheckoutForCountry(modeTask, token, country, account, accountIndex, seedOrdinal)
      : await createCheckoutLinkDirect(token, {
          planName: modeTask.config.planName,
          uiMode: mode,
          region: country,
        }, {
          identitySnapshot: account.identitySnapshot,
        });
    responses.push(response);
  }
  const primary = responses.find((item) => item.ok && item.uiMode === 'hosted')
    || responses.find((item) => item.ok)
    || responses[0];
  if (responses.length === 1) return primary;
  return {
    ...primary,
    uiMode: 'hosted',
    checkoutVariants: responses.map((item) => ({
      uiMode: item.uiMode === 'custom' ? 'custom' : 'hosted',
      ok: item.ok,
      message: item.message,
      link: item.link || item.url || '',
      longUrl: item.longUrl || item.providerUrl || '',
      shortUrl: item.shortUrl || item.canonicalUrl || '',
      checkoutSessionId: item.checkoutSessionId || '',
      processorEntity: item.processorEntity || '',
      amount: {
        amountMinor: item.amountMinor ?? null,
        amountHint: item.amountHint || '',
        currency: item.amountCurrency || item.billingDetails?.currency || '',
        source: item.amountSource || 'unknown',
        path: item.amountPath || '',
        verification: item.amountVerification || 'pending',
      },
      retryMetrics: item.retryMetrics || emptyCheckoutRetryMetrics(),
    })),
    retryMetrics: responses.reduce((total, item) => addCheckoutRetryMetrics(total, item.retryMetrics), emptyCheckoutRetryMetrics()),
    message: `双模式完成 · ${responses.map((item) => `${item.uiMode}:${item.ok ? 'ok' : 'fail'}`).join(' / ')} · ${primary.message}`,
  };
}

function emptyCheckoutRetryMetrics(): NonNullable<ProbeHitRecord['checkoutRetryMetrics']> {
  return { checkoutAttempts: 0, updateAttempts: 0, fullFlowAttempts: 0, cfRetryCount: 0, cfExitRotations: 0, invalidPromotionRebuilds: 0, pageFallbackAttempts: 0 };
}

function addCheckoutRetryMetrics(
  total: NonNullable<ProbeHitRecord['checkoutRetryMetrics']>,
  item: ProbeHitRecord['checkoutRetryMetrics'],
): NonNullable<ProbeHitRecord['checkoutRetryMetrics']> {
  if (!item) return total;
  return {
    checkoutAttempts: total.checkoutAttempts + item.checkoutAttempts,
    updateAttempts: total.updateAttempts + item.updateAttempts,
    fullFlowAttempts: total.fullFlowAttempts + item.fullFlowAttempts,
    cfRetryCount: total.cfRetryCount + item.cfRetryCount,
    cfExitRotations: total.cfExitRotations + item.cfExitRotations,
    invalidPromotionRebuilds: total.invalidPromotionRebuilds + item.invalidPromotionRebuilds,
    pageFallbackAttempts: total.pageFallbackAttempts + item.pageFallbackAttempts,
  };
}

async function runStagedCheckoutForCountry(
  task: ProbeTask,
  token: string,
  selectedCountry: string,
  account?: ProbeAccount,
  accountIndex = -1,
  seedOrdinal = 1,
  paymentMethod?: PaymentMethodId,
): Promise<Awaited<ReturnType<typeof createCheckoutLinkDirect>>> {
  const stages = resolveStagedCountries(task, selectedCountry);
  const label = account ? accountLogLabel(account, accountIndex) : '账号';
  let retrySeedOffset = 0;
  return runStagedCheckoutPipeline(token, {
    planName: task.config.planName,
    uiMode: task.config.checkoutUiMode === 'custom' ? 'custom' : 'hosted',
    bootstrapCountry: stages.bootstrapCountry,
    promotionCountry: stages.promotionCountry,
    providerCountry: stages.providerCountry,
    enablePromotionUpdate: task.config.enablePromotionUpdate !== false,
    enableProviderTaxes: Boolean(task.config.enableProviderTaxes),
    requireZero: Boolean(task.config.requireZero),
    identitySnapshot: account?.identitySnapshot,
    checkoutAttempts: Math.min(Math.max(1, task.config.retryCount + 1), task.config.maxCheckoutAttemptsPerUnit),
    updateAttempts: Math.min(Math.max(1, task.config.retryCount + 1), task.config.maxCheckoutAttemptsPerUnit),
    fullFlowAttempts: Math.min(2, task.config.maxCheckoutAttemptsPerUnit),
    cfSameIdentityAttempts: 2,
    onBeforeStage: async (stage, stageCountry) => {
      const method = paymentMethod || resolveTaskPaymentMethod(task);
      await logRun('info', `阶段 ${stage} @ ${stageCountry} · method=${method}`, {
        stage,
        code: `STAGE_${String(stage).toUpperCase()}`,
        taskId: task.id,
        accountId: account?.id || '',
        email: account?.email || '',
        accountLabel: label,
        country: stageCountry,
        meta: {
          bootstrap: stages.bootstrapCountry,
          promotion: stages.promotionCountry,
          provider: stages.providerCountry,
          method,
        },
      });
      const usedPool = await applyMethodStageProxyIfConfigured(task, method, stage, stageCountry, seedOrdinal + retrySeedOffset);
      if (!usedPool) {
        await applyProbeProxy(task, stageCountry, stage);
      } else {
        await logRun('debug', `阶段 ${stage} 使用 method pool seed`, {
          stage,
          code: 'METHOD_POOL',
          taskId: task.id,
          accountId: account?.id || '',
          email: account?.email || '',
          accountLabel: label,
          country: stageCountry,
        });
      }
    },
    onRetry: async (event) => {
      if (event.rotateExit) retrySeedOffset += 1;
      await logRun('warn', `${event.stage} 重试 ${event.attempt}：${event.reason}`, {
        stage: 'retry',
        code: `CHECKOUT_${event.stage.toUpperCase().replace('-', '_')}_RETRY`,
        taskId: task.id,
        accountId: account?.id || '',
        email: account?.email || '',
        accountLabel: label,
        country: event.country,
        meta: { rotateExit: event.rotateExit, retrySeedOffset },
      });
    },
  });
}

function isZeroAmountValue(value: string): boolean {
  const raw = String(value || '').trim();
  if (!raw) return false;
  const num = Number(raw);
  return Number.isFinite(num) && num === 0;
}


function resolveTaskPaymentMethod(task: ProbeTask): PaymentMethodId {
  const configured = String(task.config.paymentMethod || '').trim().toLowerCase();
  if (configured) return configured as PaymentMethodId;
  const preferred = preferredMethodsFromChannels(task.config.channels);
  const nonHosted = preferred.find((item) => item !== 'hosted' && item !== 'paypal');
  return (nonHosted || preferred[0] || 'hosted') as PaymentMethodId;
}

async function applyMethodStageProxyIfConfigured(
  task: ProbeTask,
  method: string,
  stage: 'bootstrap' | 'promotion' | 'provider',
  country: string,
  seedOrdinal = 1,
): Promise<boolean> {
  const proxy = await loadProxySettings();
  if (!proxy.enabled || !proxy.preferMethodPools) return false;
  const picked = pickMethodStageProxy(proxy, method, stage, Math.max(0, seedOrdinal - 1));
  if (!picked.endpoint) return false;
  await applyFixedEndpoint(picked.endpoint);
  lastStageSeed[stage] = {
    method,
    stage,
    rawLine: picked.rawLine,
    endpointSummary: formatProxyEndpoint(picked.endpoint),
  };
  await rememberProbeStageTrace(stage, country, formatProxyEndpoint(picked.endpoint), `method-pool:${method}:${stage}`);
  const patch: Record<string, unknown> = {};
  if (picked.nextPools) patch.methodPools = picked.nextPools;
  if (Object.keys(patch).length) {
    await saveProxySettings(patch as any).catch(() => undefined);
  }
  return true;
}

async function recordStageSeedsOutcome(success: boolean, reason: string): Promise<void> {
  const proxy = await loadProxySettings();
  if (!proxy.seedHealthEnabled) return;
  await logRun(success ? 'info' : 'warn', success ? 'seed 记成功' : `seed 记失败：${reason}`, {
    stage: 'seed',
    code: success ? 'SEED_OK' : 'SEED_FAIL',
    action: success ? undefined : '等待冷却或换 seed',
    meta: { reason: reason || '' },
  });
  let next = proxy;
  for (const stage of ['bootstrap', 'promotion', 'provider'] as const) {
    const ref = lastStageSeed[stage];
    if (!ref) continue;
    const endpoint = {
      enabled: true,
      scheme: 'http' as const,
      host: '',
      port: 0,
      username: '',
      password: '',
      label: ref.endpointSummary,
    };
    // Prefer raw line identity via recordSeedResult rawLine
    const parsed = parseProxyConnectionString(ref.rawLine || '', { enabled: true, scheme: 'http', label: ref.method + '/' + stage });
    const recorded = recordSeedResult(next, {
      method: ref.method,
      stage,
      rawLine: ref.rawLine,
      endpoint: parsed?.endpoint || null,
      success,
      reason,
    });
    next = recorded.settings;
    if (recorded.removedNow && next.preferMethodPools) {
      // drop removed line from corresponding pool raw text
      const pools = (next.methodPools || []).map((pool) => {
        if (pool.method !== ref.method) return pool;
        const key = stage === 'bootstrap' ? 'bootstrapRaw' : stage === 'promotion' ? 'promotionRaw' : 'providerRaw';
        const lines = String(pool[key] || '').split(/\r?\n/).filter((line) => line.trim() !== ref.rawLine.trim());
        return { ...pool, [key]: lines.join('\n') };
      });
      next = { ...next, methodPools: pools };
    }
  }
  await saveProxySettings({
    seedHealth: next.seedHealth,
    methodPools: next.methodPools,
  }).catch(() => undefined);
  // clear refs
  delete lastStageSeed.bootstrap;
  delete lastStageSeed.promotion;
  delete lastStageSeed.provider;
}

type ProbeCheckoutResponse = Awaited<ReturnType<typeof createCheckoutLinkDirect>>;

async function createPaymentMethodCheckout(
  task: ProbeTask,
  account: ProbeAccount,
  method: PaymentMethodId,
  sourceResponse: ProbeCheckoutResponse,
  accountIndex: number,
  seedOrdinal: number,
): Promise<{ response: ProbeCheckoutResponse; sessionDistinct: boolean; checkoutCountry: string }> {
  if (task.config.paymentCheckoutSessionMode === 'reuse_eligibility_session') {
    return {
      response: sourceResponse,
      sessionDistinct: false,
      checkoutCountry: sourceResponse.billingDetails?.country || '',
    };
  }

  const sourceCapability = resolvePaymentCapability(method, {
    country: sourceResponse.billingDetails?.country || '',
    currency: sourceResponse.billingDetails?.currency || '',
  });
  const checkoutCountry = sourceCapability.bootstrapCountry;
  const accessToken = tryExtractAccessToken(account.tokenRaw) || account.tokenRaw;
  const methodTask: ProbeTask = {
    ...task,
    config: {
      ...task.config,
      useSelectedAsBootstrapProvider: true,
      promotionCountry: sourceCapability.promotionCountry,
    },
  };
  const created = task.config.stagedPipelineEnabled
    ? await runStagedCheckoutForCountry(
        methodTask,
        accessToken,
        checkoutCountry,
        account,
        accountIndex,
        seedOrdinal,
        method,
      )
    : await (async () => {
        const used = await applyMethodStageProxyIfConfigured(
          methodTask,
          method,
          'bootstrap',
          checkoutCountry,
          seedOrdinal,
        );
        if (!used) await applyProbeProxy(methodTask, checkoutCountry, 'checkout');
        return createCheckoutLinkDirect(accessToken, {
          planName: task.config.planName,
          uiMode: 'hosted',
          region: checkoutCountry,
        }, {
          identitySnapshot: account.identitySnapshot,
        });
      })();
  const sourceSession = String(sourceResponse.checkoutSessionId || '');
  const createdSession = String(created.checkoutSessionId || '');
  return {
    response: created,
    sessionDistinct: Boolean(sourceSession && createdSession && sourceSession !== createdSession),
    checkoutCountry,
  };
}

function paymentCheckoutFailureStatus(runner: Awaited<ReturnType<typeof runNativePaymentRunner>>): ProbePaymentMethodLink['status'] {
  const reasons = runner.gate?.reasons || [];
  if (reasons.includes('expected_method_missing')) return 'method_not_offered';
  if (runner.status === 'not_qualified') return 'qualification_lost';
  return 'runner_failed';
}

async function resolveHostedCheckoutForAccount(
  response: Awaited<ReturnType<typeof createCheckoutLinkDirect>>,
  account: ProbeAccount | undefined,
  timeoutMs: number,
): Promise<HostedResolutionArtifacts> {
  const candidates = [response.longUrl, response.providerUrl, response.link, response.url, response.canonicalUrl]
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  const responseEvidence = resolveHostedArtifacts({
    finalUrl: candidates[0] || '',
    pageHtml: safeJson(response.raw),
    resourceUrls: candidates,
  });
  if (responseEvidence.hostedUrl || responseEvidence.checkoutSessionType === 'stripe') {
    return responseEvidence;
  }

  const shortUrl = candidates.find(isOaicsCheckoutUrl) || '';
  if (!shortUrl) {
    return {
      ...responseEvidence,
      status: 'not_required',
      message: '当前响应不是 oaics_ 短链',
    };
  }
  if (!account || !isIdentitySnapshotReady(account.identitySnapshot)) {
    return identityResolution('identity_required', '账号只有 accessToken，缺少可恢复的 ChatGPT Cookie/Session', shortUrl);
  }

  try {
    await restoreProbeAccountIdentity(account);
  } catch (error) {
    return identityResolution(
      'identity_required',
      `账号 Cookie/Session 恢复失败：${error instanceof Error ? error.message : String(error)}`,
      shortUrl,
    );
  }

  const identity = await readCurrentProbeSessionIdentity();
  if (!identity.ok) {
    return identityResolution('identity_required', identity.message, shortUrl);
  }
  if (account.email.includes('@') && !sessionEmailsMatch(account.email, identity.email)) {
    return identityResolution(
      'identity_mismatch',
      `恢复后的浏览器会话账号与探测账号不一致（期望 ${maskProbeEmail(account.email)}，实际 ${maskProbeEmail(identity.email)}）`,
      shortUrl,
    );
  }

  return captureHostedPageEvidence(shortUrl, account.identitySnapshot.cookies[0]?.storeId, timeoutMs);
}

async function readCurrentProbeSessionIdentity(): Promise<{ ok: boolean; email: string; message: string }> {
  try {
    const response = await fetch('https://chatgpt.com/api/auth/session', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'include',
      cache: 'no-store',
    });
    if (!response.ok) {
      return { ok: false, email: '', message: `恢复后的 ChatGPT session 返回 HTTP ${response.status}` };
    }
    const data = await response.json() as { user?: { email?: unknown }; accessToken?: unknown };
    const email = String(data?.user?.email || '').trim();
    if (!email || typeof data?.accessToken !== 'string' || !data.accessToken) {
      return { ok: false, email, message: '恢复后的 ChatGPT session 未登录或缺少 accessToken' };
    }
    return { ok: true, email, message: 'ChatGPT Cookie/Session 校验通过' };
  } catch (error) {
    return { ok: false, email: '', message: `恢复后的 ChatGPT session 校验失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

async function captureHostedPageEvidence(
  shortUrl: string,
  cookieStoreId: string | undefined,
  timeoutMs: number,
): Promise<HostedResolutionArtifacts> {
  let tab: Browser.tabs.Tab | undefined;
  try {
    const createProperties = {
      url: shortUrl,
      active: false,
      ...(cookieStoreId ? { cookieStoreId } : {}),
    };
    try {
      tab = await browser.tabs.create(createProperties as Parameters<typeof browser.tabs.create>[0]);
    } catch {
      tab = await browser.tabs.create({ url: shortUrl, active: false });
    }
    const tabId = typeof tab.id === 'number' ? tab.id : 0;
    if (!tabId) return resolveHostedArtifacts({ finalUrl: shortUrl });

    const deadline = Date.now() + Math.max(5_000, timeoutMs);
    let last: HostedResolutionArtifacts = resolveHostedArtifacts({ finalUrl: shortUrl });
    while (Date.now() < deadline) {
      const liveTab = await browser.tabs.get(tabId).catch(() => undefined);
      if (!liveTab) break;
      if (liveTab.status !== 'complete') {
        await delay(450);
        continue;
      }
      await delay(600);
      const evidence = await readHostedPageEvidence(tabId, String(liveTab.url || shortUrl));
      last = resolveHostedArtifacts(evidence);
      if (last.status === 'resolved_hosted' || last.status === 'identity_required') return last;
      if (last.checkoutSessionType === 'stripe' && last.stripePublishableKey) return last;
      await delay(650);
    }
    return last;
  } catch (error) {
    return {
      ...resolveHostedArtifacts({ finalUrl: String(tab?.url || shortUrl) }),
      status: 'failed',
      message: `Hosted 页面解析失败：${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (typeof tab?.id === 'number') await browser.tabs.remove(tab.id).catch(() => undefined);
  }
}

async function readHostedPageEvidence(tabId: number, fallbackUrl: string): Promise<HostedPageEvidence> {
  const results = await browser.scripting.executeScript({
    target: { tabId },
    func: () => ({
      finalUrl: location.href,
      pageText: (document.body?.innerText || document.documentElement?.innerText || '').replace(/\s+/g, ' ').slice(0, 50_000),
      pageHtml: (document.documentElement?.outerHTML || '').slice(0, 250_000),
      resourceUrls: performance.getEntriesByType('resource')
        .map((entry) => String(entry.name || ''))
        .filter(Boolean)
        .slice(0, 600),
    }),
  });
  const value = results?.[0]?.result as HostedPageEvidence | undefined;
  return value && typeof value === 'object' ? value : { finalUrl: fallbackUrl };
}

function maskProbeEmail(value: string): string {
  const [local, domain] = String(value || '').split('@');
  if (!domain) return value ? `${value.slice(0, 2)}***` : '-';
  return `${local.slice(0, 2)}***@${domain}`;
}

async function maybeEnrichFinalUrl(
  task: ProbeTask,
  hit: ProbeHitRecord,
  response: Awaited<ReturnType<typeof createCheckoutLinkDirect>>,
  account?: ProbeAccount,
  accountIndex = -1,
  seedOrdinal = 1,
): Promise<ProbeHitRecord> {
  let next = hit;
  const label = account ? accountLogLabel(account, accountIndex) : (hit.email || hit.accountId || '账号');

  if (account && !(next.qualificationLedger || []).length) {
    next = appendCheckoutQualification(next, response, account);
  }

  const hostedResolution = await resolveHostedCheckoutForAccount(
    response,
    account,
    task.config.sniffTimeoutMs || 15_000,
  );
  if (hostedResolution.checkoutSessionType === 'stripe') {
    response.checkoutSessionId = hostedResolution.checkoutSessionId;
  }
  const candidateStripePk = task.config.stripePublishableKey || hostedResolution.stripePublishableKey;
  const checkoutSessionId = String(response.checkoutSessionId || '');
  const stripeKeyOwnership = candidateStripePk && checkoutSessionId.startsWith('cs_')
    ? await verifyStripeCheckoutKeyOwnership({
        publishableKey: candidateStripePk,
        checkoutSessionId,
      })
    : null;
  const resolvedStripePk = stripeKeyOwnership?.status === 'verified' ? candidateStripePk : '';
  if (hostedResolution.hostedUrl) {
    response.longUrl = hostedResolution.hostedUrl;
    response.providerUrl = hostedResolution.hostedUrl;
  }
  next = {
    ...next,
    hostedResolutionStatus: hostedResolution.status,
    hostedResolutionMessage: hostedResolution.message,
    identitySnapshotReady: isIdentitySnapshotReady(account?.identitySnapshot),
    resolvedCheckoutSessionType: hostedResolution.checkoutSessionType,
    hostedResolutionMethods: hostedResolution.methods,
    stripeResourceCount: hostedResolution.stripeResourceCount,
    stripePublishableKeyFound: Boolean(candidateStripePk),
    stripePublishableKeyVerified: Boolean(resolvedStripePk),
    stripeKeyOwnershipStatus: stripeKeyOwnership?.status || 'not_checked',
    stripeKeyOwnershipCode: stripeKeyOwnership?.code || '',
    detectedMethods: [...new Set([...(next.detectedMethods || []), ...hostedResolution.methods])],
    message: [
      next.message,
      hostedResolution.status === 'not_required' ? '' : `Hosted:${hostedResolution.message}`,
      stripeKeyOwnership ? `StripePK:${stripeKeyOwnership.code}` : '',
    ].filter(Boolean).join(' · '),
    tags: [...new Set([...(next.tags || []), `hosted-${hostedResolution.status}`])],
  };

  if (task.config.detectPaymentMethods && String(response.checkoutSessionId || '').startsWith('cs_') && resolvedStripePk) {
    const detected = await detectPaymentMethodsViaStripeInit({
      checkoutSessionId: response.checkoutSessionId || '',
      stripePk: resolvedStripePk,
      raw: response.raw,
      requireZero: Boolean(task.config.requireZero),
    });
    if (detected.ok && detected.methods.length) {
      const methods = detected.methods;
      const interesting = detected.interestingMethods.map((item) => String(item));
      await appendMethodDetection({
        id: `md-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        country: next.country,
        currency: next.currency || response.billingDetails?.currency || '',
        accountId: next.accountId,
        email: next.email,
        methods,
        interestingMethods: interesting,
        amountHint: detected.amountHint || next.amountHint || '',
        zeroLikely: Boolean(detected.zeroLikely),
        source: detected.source,
        message: detected.message,
        checkoutSessionId: response.checkoutSessionId || '',
        detectedAt: Date.now(),
        taskId: next.taskId,
      }).catch(() => undefined);
      const canonicalMethods = interesting.length ? interesting : methods;
      next = {
        ...next,
        detectedMethods: canonicalMethods,
        channels: task.config.attachDetectedMethods
          ? [...new Set([...(next.channels || []), ...canonicalMethods])]
          : next.channels,
        amountHint: next.amountHint || detected.amountHint || '',
        message: `${next.message} · methods=${methods.join(',')}`,
        tags: [...new Set([...(next.tags || []), 'methods-detected', ...methods])],
      };
      await logRun('success', `探测到支付方式 ${methods.join(',')}`, {
        stage: 'detect-methods',
        code: 'METHODS_OK',
        taskId: task.id,
        accountId: next.accountId,
        email: next.email,
        accountLabel: label,
        country: next.country,
        meta: { methods: methods.join('|'), source: detected.source || '' },
      });
    } else {
      next = {
        ...next,
        message: `${next.message} · methods:${detected.message}`,
        tags: [...new Set([...(next.tags || []), 'methods-miss'])],
      };
      await logRun('warn', `支付方式探测未命中：${detected.message}`, {
        stage: 'detect-methods',
        code: 'METHODS_MISS',
        taskId: task.id,
        accountId: next.accountId,
        email: next.email,
        accountLabel: label,
        country: next.country,
        action: '可继续撞其他国家或检查 stripe pk',
      });
    }
  }

  // Recommend payment methods strictly from detected supported methods for this country.
  if (task.config.autoApplyDetectedMethods) {
    const stateForRec = await loadProbeState();
    const rec = recommendMethodsForCountry(stateForRec.methodDetections || [], next.country);
    const supported = (rec?.interestingMethods?.length ? rec.interestingMethods : (rec?.methods || []))
      .map((item) => String(item || '').toLowerCase())
      .filter(Boolean);
    const local = (next.detectedMethods || []).map((item) => String(item).toLowerCase());
    const preferredSupported = (local.length ? supported.filter((item) => local.includes(item)) : supported);
    if (preferredSupported.length) {
      next = {
        ...next,
        paymentMethod: task.config.paymentMethod || preferredSupported[0] || next.paymentMethod || '',
        channels: [...new Set([...(next.channels || []), ...preferredSupported])],
        message: `${next.message} · 推荐方式=${preferredSupported.join('|')}（按探测支持）`,
        tags: [...new Set([...(next.tags || []), 'method-recommended', ...preferredSupported])],
      };
    }
  }

  const hostedUrl = [response.longUrl, response.providerUrl, response.link, response.url]
    .map((item) => String(item || '').trim())
    .find((item) => isAllowedFinalPaymentUrl('hosted', item)) || '';
  if (hostedUrl) {
    const hostedCapability = resolvePaymentCapability('hosted', {
      country: response.billingDetails?.country || next.country,
      currency: response.billingDetails?.currency || next.currency,
    });
    const hostedSessionReused = Boolean(response.checkoutSessionId);
    const hostedLink: ProbePaymentMethodLink = {
      method: 'hosted',
      url: hostedUrl,
      status: 'hosted_ready',
      message: 'Hosted Checkout 长链已生成',
      checkoutCountry: response.billingDetails?.country || next.country,
      currency: response.billingDetails?.currency || next.currency,
      capabilityScope: hostedCapability.scope,
      currencyPolicy: hostedCapability.currencyPolicy,
      expectedCurrency: hostedCapability.expectedCurrency,
      sessionMode: 'reuse_eligibility_session',
      sessionDistinct: false,
      sourceQualificationVerified: Boolean(next.qualificationVerified),
      sourceSessionReused: hostedSessionReused,
      methodOffered: true,
      qualificationPreserved: hostedSessionReused && Boolean(next.qualificationVerified),
      qualificationVerified: Boolean(next.qualificationVerified),
      finalLinkVerified: true,
      runnerStatus: '',
      runnerCode: '',
      createdAt: Date.now(),
    };
    hostedLink.aggregateStatus = qualificationLinkAggregateStatus(hostedLink);
    next = {
      ...next,
      longUrl: hostedUrl,
      paymentMethodLinks: [hostedLink],
      tags: [...new Set([...(next.tags || []), 'hosted-long-ready'])],
    };
  }

  if (!task.config.extractFinalPaymentUrl) {
    return next;
  }

  let preferred: PaymentMethodId[] = task.config.paymentMethod
    ? [task.config.paymentMethod as PaymentMethodId]
    : preferredMethodsFromChannels([
      ...task.config.channels,
      ...(next.detectedMethods || []),
    ]);
  if (task.config.autoApplyDetectedMethods) {
    const supported = (next.detectedMethods || []).map((item) => String(item).toLowerCase()).filter(Boolean) as PaymentMethodId[];
    if (supported.length) {
      preferred = supported;
    } else if (next.paymentMethod) {
      preferred = [next.paymentMethod as PaymentMethodId];
    }
  }

  const existingUrls = [next.link, next.longUrl, next.shortUrl, response.link || '', response.url || '', response.providerUrl || '', response.canonicalUrl || '']
    .filter(Boolean);
  let extracted = extractPaymentFinalUrls({
    preferredMethods: preferred,
    pageText: '',
    raw: response.raw,
    existingUrls,
    checkoutSessionId: response.checkoutSessionId,
    billingCountry: response.billingDetails?.country || next.country,
  });
  if (
    task.config.enableStripeConfirm
    && resolvedStripePk
    && String(response.checkoutSessionId || '').startsWith('cs_')
    && next.qualificationVerified
    && account
  ) {
    const detectedNativeMethods = [...new Set(
      (next.detectedMethods || [])
        .map((item) => String(item || '').trim().toLowerCase() as PaymentMethodId),
    )]
      .filter((item) => getPaymentMethodAdapter(item).supportsNativeRunner);
    const requestedNativeMethods = [...new Set([
      ...(task.config.paymentMethod ? [task.config.paymentMethod as PaymentMethodId] : []),
      ...preferredMethodsFromChannels(task.config.channels),
    ])].filter((item) => getPaymentMethodAdapter(item).supportsNativeRunner);
    const allCandidates = selectPaymentProbeCandidates({
      detectedMethods: detectedNativeMethods,
      requestedMethods: requestedNativeMethods,
      forceUnlisted: task.config.forceUnlistedPaymentMethodProbe,
    });
    const candidates = (task.config.extractAllDetectedMethods ? allCandidates : allCandidates.slice(0, 1))
      .slice(0, task.config.maxPaymentMethodsPerQualification);
    const accessToken = tryExtractAccessToken(account.tokenRaw) || account.tokenRaw;
    const methodLinks: ProbePaymentMethodLink[] = [...(next.paymentMethodLinks || [])];
    let primaryRunner: Awaited<ReturnType<typeof runNativePaymentRunner>> | null = null;
    let primaryMethod: PaymentMethodId | null = null;
    let consecutiveQualificationDrifts = 0;
    for (const candidate of candidates) {
      if (!accessToken) break;
      const { method, forcedProbe } = candidate;
      const sourceCapability = resolvePaymentCapability(method, {
        country: response.billingDetails?.country || next.country,
        currency: response.billingDetails?.currency || next.currency,
      });
      await logRun('info', `${forcedProbe ? '实验筛查未暴露方式' : '为支付方式准备'} ${method} · ${task.config.paymentCheckoutSessionMode === 'independent_checkout' ? '独立' : '复用'} Checkout`, {
        stage: 'payment-checkout',
        code: forcedProbe
          ? 'FORCED_METHOD_SCREEN'
          : task.config.paymentCheckoutSessionMode === 'independent_checkout' ? 'INDEPENDENT_CHECKOUT' : 'REUSE_ELIGIBILITY_CHECKOUT',
        taskId: task.id,
        accountId: account.id,
        email: account.email,
        accountLabel: label,
        country: sourceCapability.bootstrapCountry,
      });
      const paymentCheckout = await createPaymentMethodCheckout(
        task,
        account,
        method,
        response,
        accountIndex,
        seedOrdinal,
      );
      const runnerResponse = paymentCheckout.response;
      const runnerHostedResolution = await resolveHostedCheckoutForAccount(
        runnerResponse,
        account,
        task.config.sniffTimeoutMs || 15_000,
      );
      if (runnerHostedResolution.checkoutSessionType === 'stripe') {
        runnerResponse.checkoutSessionId = runnerHostedResolution.checkoutSessionId;
      }
      if (runnerHostedResolution.hostedUrl) {
        runnerResponse.longUrl = runnerHostedResolution.hostedUrl;
        runnerResponse.providerUrl = runnerHostedResolution.hostedUrl;
      }
      const previousDriftCount = next.qualificationDriftEvents?.length || 0;
      next = appendCheckoutQualification(next, runnerResponse, account, method);
      const newDrifts = (next.qualificationDriftEvents || []).slice(previousDriftCount);
      consecutiveQualificationDrifts = newDrifts.some((item) => item.stopRequired)
        ? consecutiveQualificationDrifts + 1
        : 0;
      const independent = task.config.paymentCheckoutSessionMode === 'independent_checkout';
      const sourceCheckoutSessionId = String(response.checkoutSessionId || '');
      const capability = resolvePaymentCapability(method, {
        country: runnerResponse.billingDetails?.country || paymentCheckout.checkoutCountry,
        currency: runnerResponse.billingDetails?.currency || '',
      });
      const methodQualification = next.qualificationLedger?.at(-1);
      const qualificationDrifted = newDrifts.some((item) => item.stopRequired);
      if (!methodQualification?.qualified || qualificationDrifted) {
        const evidence = buildPaymentLinkEvidence({
          method,
          sessionMode: task.config.paymentCheckoutSessionMode,
          sourceCheckoutSessionId,
          checkoutSessionId: String(runnerResponse.checkoutSessionId || ''),
          sessionDistinct: paymentCheckout.sessionDistinct,
          sourceQualificationVerified: Boolean(next.qualificationVerified),
        });
        methodLinks.push({
          method,
          url: '',
          status: 'qualification_lost',
          message: qualificationDrifted ? '支付方式 Checkout 资格发生漂移，写操作已停止' : '支付方式 Checkout 未通过严格资格门',
          checkoutCountry: paymentCheckout.checkoutCountry,
          currency: runnerResponse.billingDetails?.currency || capability.expectedCurrency,
          capabilityScope: capability.scope,
          currencyPolicy: capability.currencyPolicy,
          expectedCurrency: capability.expectedCurrency,
          sessionMode: task.config.paymentCheckoutSessionMode,
          sessionDistinct: paymentCheckout.sessionDistinct,
          forcedProbe,
          ...evidence,
          qualificationVerified: false,
          finalLinkVerified: false,
          runnerStatus: 'not_qualified',
          runnerCode: qualificationDrifted ? 'QUALIFICATION_DRIFT' : 'STRICT_GATE_NOT_QUALIFIED',
          createdAt: Date.now(),
        });
        if (consecutiveQualificationDrifts >= task.config.maxConsecutiveQualificationDrifts) break;
        continue;
      }
      if (!runnerResponse.ok || !String(runnerResponse.checkoutSessionId || '').startsWith('cs_')) {
        const evidence = buildPaymentLinkEvidence({
          method,
          sessionMode: task.config.paymentCheckoutSessionMode,
          sourceCheckoutSessionId,
          checkoutSessionId: String(runnerResponse.checkoutSessionId || ''),
          sessionDistinct: paymentCheckout.sessionDistinct,
          sourceQualificationVerified: Boolean(next.qualificationVerified),
        });
        methodLinks.push({
          method,
          url: '',
          status: runnerHostedResolution.status === 'identity_required'
            ? 'identity_required'
            : runnerHostedResolution.status === 'identity_mismatch'
              ? 'identity_mismatch'
              : runnerHostedResolution.status === 'checkout_loaded'
                ? 'checkout_loaded'
                : /requirezero|amount|资格/i.test(runnerResponse.message || '')
                  ? 'qualification_lost'
                  : 'checkout_create_failed',
          message: runnerHostedResolution.status === 'not_required'
            ? (runnerResponse.message || '支付方式 Checkout 创建失败')
            : runnerHostedResolution.message,
          checkoutCountry: paymentCheckout.checkoutCountry,
          currency: runnerResponse.billingDetails?.currency || capability.expectedCurrency,
          capabilityScope: capability.scope,
          currencyPolicy: capability.currencyPolicy,
          expectedCurrency: capability.expectedCurrency,
          sessionMode: task.config.paymentCheckoutSessionMode,
          sessionDistinct: paymentCheckout.sessionDistinct,
          forcedProbe,
          ...evidence,
          qualificationVerified: false,
          finalLinkVerified: false,
          runnerStatus: '',
          runnerCode: '',
          createdAt: Date.now(),
        });
        await logRun('warn', `${method} 支付 Checkout 未通过：${runnerResponse.message}`, {
          stage: 'payment-checkout', code: 'PAYMENT_CHECKOUT_FAILED', taskId: task.id,
          accountId: account.id, email: account.email, accountLabel: label,
          country: paymentCheckout.checkoutCountry,
        });
        continue;
      }
      const runnerCheckoutSessionId = String(runnerResponse.checkoutSessionId);
      if (independent && !paymentCheckout.sessionDistinct) {
        const evidence = buildPaymentLinkEvidence({
          method,
          sessionMode: task.config.paymentCheckoutSessionMode,
          sourceCheckoutSessionId,
          checkoutSessionId: runnerCheckoutSessionId,
          sessionDistinct: paymentCheckout.sessionDistinct,
          sourceQualificationVerified: Boolean(next.qualificationVerified),
        });
        methodLinks.push({
          method,
          url: '',
          status: 'session_not_distinct',
          message: '独立 Checkout 未产生不同会话，已停止提交',
          checkoutCountry: paymentCheckout.checkoutCountry,
          currency: runnerResponse.billingDetails?.currency || capability.expectedCurrency,
          capabilityScope: capability.scope,
          currencyPolicy: capability.currencyPolicy,
          expectedCurrency: capability.expectedCurrency,
          sessionMode: task.config.paymentCheckoutSessionMode,
          sessionDistinct: false,
          forcedProbe,
          ...evidence,
          qualificationVerified: false,
          finalLinkVerified: false,
          runnerStatus: '',
          runnerCode: 'SESSION_NOT_DISTINCT',
          createdAt: Date.now(),
        });
        continue;
      }
      const offered = await detectPaymentMethodsViaStripeInit({
        checkoutSessionId: runnerCheckoutSessionId,
        stripePk: resolvedStripePk,
        raw: runnerResponse.raw,
        requireZero: Boolean(task.config.requireZero),
      });
      const methodOffered = offered.interestingMethods.includes(method)
        || offered.methods.includes(getPaymentMethodAdapter(method).stripeType || method);
      if (!methodOffered) {
        const evidence = buildPaymentLinkEvidence({
          method,
          sessionMode: task.config.paymentCheckoutSessionMode,
          sourceCheckoutSessionId,
          checkoutSessionId: runnerCheckoutSessionId,
          sessionDistinct: paymentCheckout.sessionDistinct,
          sourceQualificationVerified: Boolean(next.qualificationVerified),
        });
        methodLinks.push({
          method,
          url: '',
          status: /requirezero|amount/i.test(offered.message) ? 'qualification_lost' : 'method_not_offered',
          message: `支付方式证据门未通过：${offered.message}`,
          checkoutCountry: paymentCheckout.checkoutCountry,
          currency: runnerResponse.billingDetails?.currency || capability.expectedCurrency,
          capabilityScope: capability.scope,
          currencyPolicy: capability.currencyPolicy,
          expectedCurrency: capability.expectedCurrency,
          sessionMode: task.config.paymentCheckoutSessionMode,
          sessionDistinct: paymentCheckout.sessionDistinct,
          forcedProbe,
          ...evidence,
          methodOffered: false,
          qualificationVerified: false,
          finalLinkVerified: false,
          runnerStatus: '',
          runnerCode: 'METHOD_NOT_OFFERED',
          createdAt: Date.now(),
        });
        await logRun('info', `${method} 未在 Checkout/Stripe init 实际暴露，跳过支付提交`, {
          stage: 'payment-checkout', code: 'METHOD_NOT_OFFERED', taskId: task.id,
          accountId: account.id, email: account.email, accountLabel: label,
          country: paymentCheckout.checkoutCountry,
        });
        continue;
      }
      const stageCountries = {
        bootstrapCountry: capability.bootstrapCountry,
        promotionCountry: capability.promotionCountry,
        providerCountry: capability.providerCountry,
      };
      const paymentOperationState = await loadProbeState();
      const paymentRunId = paymentOperationState.tasks.find((item) => item.id === task.id)?.runtime.runId
        || activeProbeCycleId
        || task.id;
      const paymentOperationKey = buildPaymentOperationIdempotencyKey(
        paymentRunId,
        account.id,
        runnerCheckoutSessionId,
        method,
        `route-${stableFingerprint(Object.values(stageCountries).join('>'))}`,
        next.retryOrdinal || 1,
      );
      const recoveryCheckpoint = paymentOperationState.paymentOperationReceipts
        .find((item) => item.operationKey === paymentOperationKey)
        || paymentOperationState.paymentOperationReceipts.find((item) =>
          item.checkoutSessionId === runnerCheckoutSessionId
          && item.method === method
          && (item.confirmSubmitted || item.approveSubmitted || item.sideEffect === 'unknown' || item.status === 'link_ready'));
      const runner = await runNativePaymentRunner({
        method,
        checkoutSessionId: runnerCheckoutSessionId,
        stripePublishableKey: resolvedStripePk,
        accessToken,
        processorEntity: runnerResponse.processorEntity || (capability.bootstrapCountry === 'US' ? 'openai_llc' : 'openai_ie'),
        billingCountry: runnerResponse.billingDetails?.country || capability.providerCountry,
        checkoutCurrency: runnerResponse.billingDetails?.currency || capability.expectedCurrency,
        billingEmail: account.email,
        returnUrl: runnerResponse.canonicalUrl || runnerResponse.link,
      }, createNativePaymentTransport(), {
        operationKey: paymentOperationKey,
        recovery: recoveryCheckpoint,
        maxWriteOperations: task.config.maxWriteOperationsPerMethod,
        onCheckpoint: persistPaymentOperationReceipt,
        beforeStage: async (runnerStage, role) => {
          const poolStage = role === 'provider' ? 'provider' : role === 'approve' ? 'bootstrap' : 'promotion';
          const country = role === 'provider'
            ? stageCountries.providerCountry
            : role === 'approve'
              ? stageCountries.bootstrapCountry
              : stageCountries.promotionCountry;
          const used = await applyMethodStageProxyIfConfigured(task, method, poolStage, country, seedOrdinal);
          if (!used) await applyProbeProxy(task, country, poolStage);
          await logRun('debug', `支付 Runner ${runnerStage} · ${role} @ ${country}`, {
            stage: `payment-${runnerStage}`,
            code: `RUNNER_${runnerStage.toUpperCase()}`,
            taskId: task.id,
            accountId: account.id,
            email: account.email,
            accountLabel: label,
            country,
          });
        },
      });
      if (runner.ok && runner.gate) {
        next = appendQualificationToHit(next, classifyCheckoutQualification(runner.gate, {
          source: 'provider-final',
          sessionId: runnerCheckoutSessionId,
          identityKey: account.chatgptAccountId || account.id,
          method,
          redactedPayloadHash: stableFingerprint(safeJson(runner.gate)),
        }));
      }
      const evidence = buildPaymentLinkEvidence({
        method,
        sessionMode: task.config.paymentCheckoutSessionMode,
        sourceCheckoutSessionId,
        checkoutSessionId: runnerCheckoutSessionId,
        sessionDistinct: paymentCheckout.sessionDistinct,
        sourceQualificationVerified: independent ? Boolean(runner.gate?.passed) : Boolean(next.qualificationVerified),
        gate: runner.gate,
      });
      const linkStatus = runner.ok && runner.finalUrl && evidence.qualificationPreserved
        ? 'link_ready'
        : runner.ok && runner.finalUrl
          ? 'qualification_lost'
          : paymentCheckoutFailureStatus(runner);
      methodLinks.push({
        method,
        url: runner.finalUrl || '',
        status: linkStatus,
        message: runner.message,
        checkoutCountry: paymentCheckout.checkoutCountry,
        currency: runnerResponse.billingDetails?.currency || capability.expectedCurrency,
        capabilityScope: capability.scope,
        currencyPolicy: capability.currencyPolicy,
        expectedCurrency: capability.expectedCurrency,
        sessionMode: task.config.paymentCheckoutSessionMode,
        sessionDistinct: paymentCheckout.sessionDistinct,
        forcedProbe,
        ...evidence,
        qualificationVerified: Boolean(runner.gate?.passed),
        finalLinkVerified: linkStatus === 'link_ready' && Boolean(runner.finalUrl),
        runnerStatus: runner.status,
        runnerCode: runner.code,
        createdAt: Date.now(),
      });
      if (!primaryRunner || (!primaryRunner.ok && runner.ok && runner.finalUrl)) {
        primaryRunner = runner;
        primaryMethod = method;
      }
      if (runner.ok && runner.finalUrl && extracted.best?.source !== 'stripe_confirm') {
        extracted = {
          ok: true,
          message: runner.message,
          matches: [{ method, url: runner.finalUrl, source: 'stripe_confirm', confidence: 'high' }],
          best: { method, url: runner.finalUrl, source: 'stripe_confirm', confidence: 'high' },
        };
      }
      if (!runner.ok) {
        await logRun(runner.status === 'not_qualified' ? 'info' : 'warn', `支付 Runner 未形成终链：${method} · ${runner.status} · ${runner.code}`, {
          stage: 'payment-runner', code: runner.code, taskId: task.id,
          accountId: account.id, email: account.email, accountLabel: label,
          country: paymentCheckout.checkoutCountry,
        });
      }
      if (consecutiveQualificationDrifts >= task.config.maxConsecutiveQualificationDrifts) {
        await logRun('warn', `连续资格漂移达到预算上限 ${consecutiveQualificationDrifts}`, {
          stage: 'payment-runner', code: 'QUALIFICATION_DRIFT_STOP', taskId: task.id,
          accountId: account.id, email: account.email, accountLabel: label,
          country: paymentCheckout.checkoutCountry,
        });
        break;
      }
    }
    const aggregatedMethodLinks = methodLinks.map((item) => ({
      ...item,
      aggregateStatus: qualificationLinkAggregateStatus(item),
    }));
    const nativeMethodLinks = aggregatedMethodLinks.filter((item) => item.method !== 'hosted');
    const successfulLinks = nativeMethodLinks.filter((item) => item.finalLinkVerified && item.url);
    next = {
      ...next,
      paymentMethodLinks: aggregatedMethodLinks,
      paymentCheckoutSessionMode: task.config.paymentCheckoutSessionMode,
      paymentCheckoutStatus: successfulLinks[0]?.status || nativeMethodLinks[0]?.status || '',
      paymentCheckoutSessionDistinct: nativeMethodLinks.some((item) => item.sessionDistinct),
      message: `${next.message} · 支付终链=${successfulLinks.length}/${nativeMethodLinks.length}`,
      tags: [...new Set([
        ...(next.tags || []),
        `checkout-${task.config.paymentCheckoutSessionMode}`,
        ...(nativeMethodLinks.some((item) => item.forcedProbe) ? ['forced-method-probe'] : []),
        ...aggregatedMethodLinks.map((item) => `${item.method}-${item.status}`),
      ])],
    };
    if (primaryRunner && primaryMethod) {
      const runner = primaryRunner;
      next = {
        ...next,
        paymentRunnerStatus: runner.status,
        paymentRunnerStage: runner.stage,
        paymentRunnerCode: runner.code,
        qualificationVerified: Boolean(next.qualificationVerified || runner.gate?.passed),
        submittedPaymentMethod: runner.confirmSubmitted && runner.paymentMethodId ? primaryMethod : '',
        paymentRunnerConfirmSubmitted: runner.confirmSubmitted,
        paymentRunnerConfirmSucceeded: runner.events.some((event) => event.stage === 'confirm' && event.status === 'passed'),
        paymentRunnerApproveSubmitted: runner.approveSubmitted,
        paymentRunnerApproveSucceeded: runner.events.some((event) => event.stage === 'approve' && event.status === 'passed'),
        finalLinkVerified: Boolean(next.finalLinkVerified || runner.status === 'link_ready'),
        checkoutCreated: true,
        qualificationGateVersion: runner.status === 'link_ready' ? 'native-runner-zero-v1' : next.qualificationGateVersion,
        linkVerificationLevel: runner.status === 'link_ready' ? 'provider-final' : next.linkVerificationLevel,
        linkUsable: Boolean(next.linkUsable || (runner.status === 'link_ready' && runner.finalUrl)),
        message: `${next.message} · runner=${primaryMethod}:${runner.status}/${runner.code}`,
        tags: [...new Set([...(next.tags || []), `runner-${runner.status}`, `runner-${runner.stage}`])],
      };
    }
  }
  if (!extracted.best) {
    await logRun('warn', '终链未提取', {
      stage: 'final-url',
      code: 'NO_FINAL_URL',
      taskId: task.id,
      accountId: next.accountId,
      email: next.email,
      accountLabel: label,
      country: next.country,
      action: '可开启 stripe confirm 或换支付方式',
    });
    return {
      ...next,
      message: `${next.message} · 终链未提取`,
      tags: [...new Set([...(next.tags || []), 'no-final-url'])],
    };
  }
  const best = extracted.best;
  // Final method must come from detected supported methods when available.
  const supportedSet = new Set((next.detectedMethods || []).map((item) => String(item).toLowerCase()));
  let method = best.method === 'unknown' ? resolveTaskPaymentMethod(task) : best.method;
  if (supportedSet.size) {
    if (supportedSet.has(String(method).toLowerCase())) {
      // keep
    } else if (next.paymentMethod && supportedSet.has(String(next.paymentMethod).toLowerCase())) {
      method = next.paymentMethod as PaymentMethodId;
    } else {
      method = ([...supportedSet][0] as PaymentMethodId) || method;
    }
  }
  await logRun('success', `终链提取成功 final=${method}@${best.source}`, {
    stage: 'final-url',
    code: 'FINAL_URL',
    taskId: task.id,
    accountId: next.accountId,
    email: next.email,
    accountLabel: label,
    country: next.country,
    meta: { method, source: best.source || '' },
  });
  return {
    ...next,
    finalPaymentUrl: best.url,
    paymentMethod: method,
    finalUrlSource: best.source,
    link: best.url || next.link,
    longUrl: next.longUrl || best.url,
    channels: [...new Set([...(next.channels || []), method])],
    message: `${next.message} · final=${method}@${best.source}`,
    tags: [...new Set([...(next.tags || []), 'final-url', method])],
  };
}

async function applyProbeProxy(
  task: ProbeTask,
  country: string,
  traceStage: 'bootstrap' | 'promotion' | 'provider' | 'checkout' = 'checkout',
): Promise<void> {
  const proxy = await loadProxySettings();
  if (!proxy.enabled) {
    await rememberProbeStageTrace(traceStage, country, '', 'proxy-disabled');
    return;
  }

  // Entry stage first (PoW/session warm) — best-effort.
  if (task.config.entryProxyMode === 'front') {
    await applyProxyStage('front').catch(() => undefined);
  } else if (task.config.entryProxyMode === 'exit1') {
    await applyProxyStage('exit1').catch(() => undefined);
  }

  if (!task.config.autoSwitchExitByCountry && task.config.exitProxyMode === 'none') {
    await rememberProbeStageTrace(traceStage, country, '', 'no-switch');
    return;
  }

  if (task.config.exitProxyMode === 'fixed-front') {
    await applyProxyStage('front');
    await rememberProbeStageTrace(traceStage, country, formatProxyEndpoint(proxy.front), 'fixed-front');
    return;
  }
  if (task.config.exitProxyMode === 'fixed-exit2') {
    await applyProxyStage('exit2');
    await rememberProbeStageTrace(traceStage, country, formatProxyEndpoint(proxy.exit2), 'fixed-exit2');
    return;
  }
  if (task.config.exitProxyMode === 'none') {
    await rememberProbeStageTrace(traceStage, country, '', 'direct');
    return;
  }

  // follow-country: prefer explicit country exit map, then template/host fallbacks.
  const mapped = resolveCountryExit(proxy, country);
  if (mapped) {
    await applyFixedEndpoint(mapped);
    await rememberProbeStageTrace(traceStage, country, formatProxyEndpoint(mapped), 'country-map');
    return;
  }
  const countryEndpoint = resolveCountryProxyEndpoint(proxy.exit2, proxy.front, country);
  if (countryEndpoint) {
    await applyFixedEndpoint(countryEndpoint);
    await rememberProbeStageTrace(traceStage, country, formatProxyEndpoint(countryEndpoint), 'country-template');
    return;
  }
  // fallback stages
  const stage: ProxyStage = proxy.exit2.host ? 'exit2' : proxy.front.host ? 'front' : 'none';
  if (stage !== 'none') {
    await applyProxyStage(stage);
    const endpoint = stage === 'exit2' ? proxy.exit2 : proxy.front;
    await rememberProbeStageTrace(traceStage, country, formatProxyEndpoint(endpoint), `fallback-${stage}`);
  }
}

function resolveCountryProxyEndpoint(
  exit2: ProxyEndpoint,
  front: ProxyEndpoint,
  country: string,
): ProxyEndpoint | null {
  // Convention 1: exit2.host contains {CC} placeholder
  const hostTemplate = String(exit2.host || '');
  if (hostTemplate.includes('{CC}') || hostTemplate.includes('{country}')) {
    return {
      ...exit2,
      host: hostTemplate.replaceAll('{CC}', country.toLowerCase()).replaceAll('{country}', country.toLowerCase()),
      label: `${exit2.label || '出口'} / ${country}`,
    };
  }
  // Convention 2: port offset encoding disabled; fall back null and use stage.
  if (exit2.host && exit2.port > 0) {
    return {
      ...exit2,
      label: `${exit2.label || '出口2'} · ${country}`,
    };
  }
  if (front.host && front.port > 0) {
    return {
      ...front,
      label: `${front.label || '前置'} · ${country}`,
    };
  }
  return null;
}

async function applyFixedEndpoint(endpoint: ProxyEndpoint): Promise<void> {
  const chromeLike = globalThis as typeof globalThis & {
    chrome?: { proxy?: { settings?: { set?: (details: { value: unknown; scope?: string }) => Promise<void> } } };
  };
  const set = chromeLike.chrome?.proxy?.settings?.set
    || (browser as typeof browser & { proxy?: { settings?: { set?: (details: { value: unknown; scope?: string }) => Promise<void> } } }).proxy?.settings?.set;
  if (!set) return;
  await set({
    value: {
      mode: 'fixed_servers',
      rules: {
        singleProxy: {
          scheme: endpoint.scheme,
          host: endpoint.host,
          port: endpoint.port,
        },
        bypassList: ['127.0.0.1', 'localhost', '<local>'],
      },
    },
    scope: 'regular',
  });
}

async function notifyProbeHit(task: ProbeTask, hit: ProbeHitRecord): Promise<void> {
  try {
    if (task.config.notifyMode !== 'silent') {
      await browser.action.setBadgeBackgroundColor({ color: '#16a34a' });
      await browser.action.setBadgeText({ text: 'HIT' });
      await browser.action.setTitle({ title: `OPX 命中 ${hit.email} @ ${hit.country}` });
    }
    if (task.config.soundEnabled && task.config.notifyMode !== 'silent') {
      // Best-effort: notifications API if available.
      const notifications = (browser as typeof browser & {
        notifications?: { create?: (id: string, options: Record<string, unknown>) => Promise<string> };
      }).notifications;
      if (notifications?.create) {
        await notifications.create(`opx-probe-${hit.id}`, {
          type: 'basic',
          iconUrl: 'icon/128.png',
          title: '优惠资格命中',
          message: `${hit.email || '账号'} · ${hit.country}/${hit.currency}\n${hit.message}`,
          priority: 2,
        });
      }
    }
  } catch (error) {
    console.debug('[OPX probe notify]', error);
  }
}

function buildHit(
  task: ProbeTask,
  account: ProbeAccount,
  country: string,
  partial: Partial<ProbeHitRecord> & { ok: boolean; hitKind: ProbeHitKind; message: string },
): ProbeHitRecord {
  const meta = listProbeCountries().find((item) => item.country === country);
  return {
    id: `hit-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    taskId: task.id,
    accountId: account.id,
    email: account.email,
    country,
    currency: meta?.currency || '',
    planName: task.config.planName,
    ok: partial.ok,
    hitKind: partial.hitKind,
    message: partial.message,
    link: partial.link || '',
    longUrl: partial.longUrl || '',
    shortUrl: partial.shortUrl || '',
    channels: partial.channels || [],
    amountHint: partial.amountHint || '',
    promoHint: partial.promoHint || '',
    createdAt: Date.now(),
    rawKeys: partial.rawKeys || [],
    tabId: partial.tabId,
    sniff: partial.sniff,
    finalPaymentUrl: partial.finalPaymentUrl || '',
    paymentMethod: partial.paymentMethod || '',
    finalUrlSource: partial.finalUrlSource || '',
    detectedMethods: partial.detectedMethods || [],
    paymentRunnerStatus: partial.paymentRunnerStatus || '',
    paymentRunnerStage: partial.paymentRunnerStage || '',
    paymentRunnerCode: partial.paymentRunnerCode || '',
    paymentCheckoutSessionMode: partial.paymentCheckoutSessionMode || task.config.paymentCheckoutSessionMode,
    paymentCheckoutStatus: partial.paymentCheckoutStatus || '',
    paymentCheckoutSessionDistinct: Boolean(partial.paymentCheckoutSessionDistinct),
    paymentMethodLinks: partial.paymentMethodLinks || [],
    qualificationVerified: Boolean(partial.qualificationVerified),
    qualificationType: partial.qualificationType || 'unknown',
    qualificationEvidenceLevel: partial.qualificationEvidenceLevel || 'candidate',
    qualificationLedger: partial.qualificationLedger || [],
    qualificationDriftEvents: partial.qualificationDriftEvents || [],
    submittedPaymentMethod: partial.submittedPaymentMethod || '',
    paymentRunnerConfirmSubmitted: Boolean(partial.paymentRunnerConfirmSubmitted),
    paymentRunnerConfirmSucceeded: Boolean(partial.paymentRunnerConfirmSucceeded),
    paymentRunnerApproveSubmitted: Boolean(partial.paymentRunnerApproveSubmitted),
    paymentRunnerApproveSucceeded: Boolean(partial.paymentRunnerApproveSucceeded),
    finalLinkVerified: Boolean(partial.finalLinkVerified),
    checkoutCreated: Boolean(partial.checkoutCreated),
    qualificationGateVersion: partial.qualificationGateVersion || '',
    linkVerificationLevel: partial.linkVerificationLevel || 'candidate',
    linkUsable: Boolean(partial.linkUsable),
    retryOrdinal: Math.max(1, partial.retryOrdinal || 1),
    checkoutUiMode: partial.checkoutUiMode || task.config.checkoutUiMode,
    checkoutVariants: partial.checkoutVariants || [],
    checkoutRetryMetrics: partial.checkoutRetryMetrics || emptyCheckoutRetryMetrics(),
    hostedResolutionStatus: partial.hostedResolutionStatus || 'not_required',
    hostedResolutionMessage: partial.hostedResolutionMessage || '',
    identitySnapshotReady: partial.identitySnapshotReady ?? isIdentitySnapshotReady(account.identitySnapshot),
    resolvedCheckoutSessionType: partial.resolvedCheckoutSessionType || 'unknown',
    hostedResolutionMethods: partial.hostedResolutionMethods || [],
    stripeResourceCount: Math.max(0, partial.stripeResourceCount || 0),
    stripePublishableKeyFound: Boolean(partial.stripePublishableKeyFound),
  };
}

async function preflightProbeAccounts(
  task: ProbeTask,
  accounts: ProbeAccount[],
  country: string,
): Promise<{ state: ProbeState; invalidCount: number }> {
  const current = await loadProbeState();
  if (!accounts.length) return { state: current, invalidCount: 0 };
  try {
    await withProbeOperationTimeout(applyProbeProxy(task, country, 'checkout'), 20_000, '凭证预检代理切换');
  } catch (error) {
    await logRun('warn', `凭证预检沿用当前网络：${error instanceof Error ? error.message : String(error)}`, {
      stage: 'account', code: 'CREDENTIAL_PREFLIGHT_PROXY', taskId: task.id, country,
    });
  }

  const freshnessMs = 6 * 60 * 60 * 1000;
  const now = Date.now();
  const checked = new Map<string, ProbeAccount>();
  let invalidCount = 0;
  for (const account of accounts) {
    const recent = Boolean(account.credentialCheckedAt && now - account.credentialCheckedAt < freshnessMs);
    if (recent && (account.serverCredentialStatus === 'valid' || account.serverCredentialStatus === 'invalid')) {
      checked.set(account.id, account);
      if (account.serverCredentialStatus === 'invalid') invalidCount += 1;
      continue;
    }
    const result = await preflightProbeCredential(account);
    const next: ProbeAccount = {
      ...account,
      serverCredentialStatus: result.status,
      credentialCheckedAt: Date.now(),
      credentialMessage: result.message,
    };
    checked.set(account.id, next);
    if (result.status === 'invalid') invalidCount += 1;
    await logRun(result.status === 'invalid' ? 'warn' : 'debug', `${accountLogLabel(account)} 凭证预检：${result.message}`, {
      stage: 'account',
      code: result.status === 'invalid' ? 'CREDENTIAL_INVALID' : result.status === 'valid' ? 'CREDENTIAL_VALID' : 'CREDENTIAL_UNKNOWN',
      taskId: task.id,
      accountId: account.id,
      email: account.email,
      country,
    });
  }
  const state = await saveProbeState({
    accounts: current.accounts.map((account) => checked.get(account.id) || account),
  });
  return { state, invalidCount };
}

async function preflightProbeCredential(account: ProbeAccount): Promise<{
  status: NonNullable<ProbeAccount['serverCredentialStatus']>;
  message: string;
}> {
  const token = tryExtractAccessToken(account.tokenRaw) || account.tokenRaw;
  if (!token) return { status: 'invalid', message: '本地 token 格式无效' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch('https://chatgpt.com/backend-api/me', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal,
    });
    const bodyText = await response.text().catch(() => '');
    if (response.status === 401 || response.status === 403) {
      const authStatus = classifyTokenAuthFailure(response.status, bodyText);
      if (authStatus === 'invalid_jwt' || authStatus === 'token_rejected') {
        return { status: 'invalid', message: `服务端拒绝凭证 HTTP ${response.status} · ${authStatus}（accessToken 已失效，需重新同步会话）` };
      }
      return { status: 'unknown', message: `预检 HTTP ${response.status} · ${authStatus}（疑似网络/CF 层，保留账号继续实验）` };
    }
    if (response.ok) return { status: 'valid', message: `服务端凭证有效 HTTP ${response.status}` };
    return { status: 'unknown', message: `预检端点 HTTP ${response.status}，保留账号继续实验` };
  } catch (error) {
    return { status: 'unknown', message: `预检网络不确定：${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearTimeout(timer);
  }
}

function selectAccounts(accounts: ProbeAccount[], source: ProbeTaskConfig['accountSource']): ProbeAccount[] {
  const eligible = accounts.filter((item) => item.serverCredentialStatus !== 'invalid');
  if (source === 'all') return eligible;
  if (source === 'manual-only') return eligible.filter((item) => item.source === 'manual' && item.enabled);
  return eligible.filter((item) => item.enabled);
}

async function markAccountHit(accountId: string, country: string, message: string, success: boolean): Promise<void> {
  const current = await loadProbeState();
  const accounts = current.accounts.map((account) => account.id === accountId
    ? {
        ...account,
        lastProbeAt: Date.now(),
        lastProbeCountry: country,
        lastHitAt: success ? Date.now() : account.lastHitAt,
        lastMessage: message,
        successCount: success ? account.successCount + 1 : account.successCount,
        failCount: success ? account.failCount : account.failCount + 1,
      }
    : account);
  await saveProbeState({ accounts });
}

async function markAccountCredentialInvalid(accountId: string, message: string): Promise<void> {
  const current = await loadProbeState();
  const accounts = current.accounts.map((account) => account.id === accountId
    ? {
        ...account,
        serverCredentialStatus: 'invalid' as const,
        credentialCheckedAt: Date.now(),
        credentialMessage: message.slice(0, 240),
        lastMessage: message.slice(0, 240),
      }
    : account);
  await saveProbeState({ accounts });
}

async function updateTaskRuntime(taskId: string, patch: Partial<ProbeTask['runtime']>): Promise<ProbeState> {
  const current = await loadProbeState();
  const tasks = current.tasks.map((task) => task.id === taskId
    ? {
        ...task,
        runtime: {
          ...task.runtime,
          ...patch,
        },
        updatedAt: Date.now(),
      }
    : task);
  return saveProbeState({ tasks, activeTaskId: taskId });
}

async function ensureAlarm(taskId: string, intervalSec: number): Promise<void> {
  const alarms = (browser as typeof browser & {
    alarms?: {
      create?: (name: string, info: { periodInMinutes?: number; when?: number; delayInMinutes?: number }) => void;
      clear?: (name: string) => Promise<boolean>;
    };
  }).alarms;
  if (!alarms?.create) return;
  const name = `${ALARM_PREFIX}${taskId}`;
  await alarms.clear?.(name);
  const minutes = Math.max(0.5, intervalSec / 60);
  alarms.create(name, { periodInMinutes: minutes });
}

async function clearProbeAlarm(taskId: string): Promise<void> {
  const alarms = (browser as typeof browser & { alarms?: { clear?: (name: string) => Promise<boolean> } }).alarms;
  await alarms?.clear?.(`${ALARM_PREFIX}${taskId}`);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value || {});
  } catch {
    return '';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


async function openAndSniffCheckoutHit(task: ProbeTask, hit: ProbeHitRecord): Promise<ProbeHitRecord> {
  try {
    const tab = await browser.tabs.create({
      url: hit.link,
      active: task.config.pinOnSuccess || task.config.notifyMode === 'sound-badge-pin',
    });
    const tabId = typeof tab.id === 'number' ? tab.id : 0;
    let sniff: ProbeCheckoutSniff | undefined;
    if (task.config.sniffCheckoutOnHit && tabId > 0) {
      sniff = await sniffCheckoutTab(tabId, task.config.sniffTimeoutMs || 12000);
    }
    const upgradedKind = sniff?.zeroLikely ? 'zero' : sniff?.trialLikely ? 'trial' : hit.hitKind;
    const pageQualified = task.config.requireZero ? Boolean(sniff?.zeroLikely) : Boolean(sniff?.zeroLikely || sniff?.trialLikely);
    const messageParts = [hit.message];
    if (sniff?.checked) {
      messageParts.push(sniff.message);
    }
    const classified = enrichHitClassification({
      ...hit,
      hitKind: upgradedKind,
      amountHint: sniff?.amountText || hit.amountHint,
      promoHint: sniff?.trialText || hit.promoHint,
      message: messageParts.filter(Boolean).join(' · '),
      tabId: tabId || undefined,
      sniff,
      checkoutCreated: true,
      qualificationVerified: Boolean(hit.qualificationVerified || pageQualified),
      qualificationGateVersion: pageQualified ? (task.config.requireZero ? 'strict-zero-page-v2' : 'page-qualification-v1') : hit.qualificationGateVersion,
      linkVerificationLevel: pageQualified ? (task.config.requireZero ? 'strict-page' : 'page') : hit.linkVerificationLevel,
      linkUsable: Boolean(hit.linkUsable || (pageQualified && sniff?.ok && hit.link)),
    });
    if (!sniff?.checked) return classified;
    const previous = classified.qualificationLedger?.at(-1);
    const pageEvidence = classifyCheckoutQualification({
      amount_total: sniff.zeroLikely ? 0 : null,
      currency: classified.currency,
      free_trial: sniff.trialLikely,
      page_text: [sniff.amountText, sniff.trialText, sniff.message].filter(Boolean).join(' '),
    }, {
      source: 'checkout-page',
      sessionId: previous?.sessionId || '',
      identityKey: previous?.identityKey || classified.accountId,
      method: previous?.method || classified.paymentMethod,
      observedAt: sniff.checkedAt,
      redactedPayloadHash: stableFingerprint([sniff.amountText, sniff.trialText, sniff.pageUrl].join('|')),
    });
    return appendQualificationToHit(classified, pageEvidence);
  } catch (error) {
    return {
      ...hit,
      message: `${hit.message} · 打开结账页失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function appendCheckoutQualification(
  hit: ProbeHitRecord,
  response: ProbeCheckoutResponse,
  account: ProbeAccount,
  method = '',
): ProbeHitRecord {
  const source = response.amountSource === 'checkout-page'
    ? 'checkout-page'
    : response.amountSource === 'tax-response'
      ? 'tax-response'
      : response.amountSource === 'update-response'
        ? 'update-response'
        : 'create-response';
  const payload = {
    response: response.raw,
    amount_total: response.amountMinor ?? undefined,
    currency: response.amountCurrency || response.billingDetails?.currency || '',
    ...(response.promoLikely ? { promo: true } : {}),
    ...(response.trialLikely ? { free_trial: true } : {}),
  };
  const evidence = classifyCheckoutQualification(payload, {
    source,
    sessionId: response.checkoutSessionId || '',
    identityKey: account.chatgptAccountId || account.id,
    method,
    redactedPayloadHash: stableFingerprint(safeJson(payload)),
  });
  return appendQualificationToHit(hit, evidence);
}

function appendQualificationToHit(
  hit: ProbeHitRecord,
  evidence: NonNullable<ProbeHitRecord['qualificationLedger']>[number],
): ProbeHitRecord {
  const appended = appendQualificationEvidence(
    hit.qualificationLedger || [],
    hit.qualificationDriftEvents || [],
    evidence,
  );
  const strongestLevel = strongerVerificationLevel(hit.qualificationEvidenceLevel, evidence.level);
  return {
    ...hit,
    qualificationVerified: Boolean(hit.qualificationVerified || evidence.qualified),
    qualificationType: evidence.type,
    qualificationEvidenceLevel: strongestLevel,
    qualificationLedger: appended.ledger,
    qualificationDriftEvents: appended.driftEvents,
    linkVerificationLevel: strongerVerificationLevel(hit.linkVerificationLevel, evidence.level),
  };
}

function strongerVerificationLevel(
  current: ProbeHitRecord['qualificationEvidenceLevel'],
  candidate: NonNullable<ProbeHitRecord['qualificationEvidenceLevel']>,
): NonNullable<ProbeHitRecord['qualificationEvidenceLevel']> {
  const levels = ['candidate', 'page', 'strict-response', 'strict-page', 'provider-final', 'entitlement-verified'] as const;
  const currentIndex = levels.indexOf(current || 'candidate');
  const candidateIndex = levels.indexOf(candidate);
  return levels[Math.max(0, currentIndex, candidateIndex)];
}

async function persistPaymentOperationReceipt(
  checkpoint: ProbeState['paymentOperationReceipts'][number],
): Promise<void> {
  const current = await loadProbeState();
  const receipts = [
    checkpoint,
    ...current.paymentOperationReceipts.filter((item) => item.operationKey !== checkpoint.operationKey),
  ].slice(0, 200);
  await saveProbeState({ paymentOperationReceipts: receipts });
}

async function sniffCheckoutTab(tabId: number, timeoutMs: number): Promise<ProbeCheckoutSniff> {
  const deadline = Date.now() + Math.max(3000, timeoutMs);
  let lastUrl = '';
  while (Date.now() < deadline) {
    try {
      const tab = await browser.tabs.get(tabId);
      lastUrl = String(tab.url || '');
      if (tab.status === 'complete' && lastUrl && !lastUrl.startsWith('chrome://')) {
        break;
      }
    } catch {
      break;
    }
    await delay(400);
  }
  await delay(800);
  try {
    const results = await browser.scripting.executeScript({
      target: { tabId },
      func: () => {
        const text = (document.body?.innerText || document.documentElement?.innerText || '').replace(/\s+/g, ' ').slice(0, 20000);
        const amountMatch = text.match(/(?:total|due|amount|pay|price|today)[^\d]{0,20}((?:php|usd|eur|idr|inr|try|brl|gbp|¥|\$|€)?\s*\d+(?:[.,]\d{1,2})?)/i) || text.match(/((?:php|usd|eur|idr|inr|try|brl|gbp)\s*\d+(?:[.,]\d{1,2})?)/i);
        const amountText = amountMatch?.[1]?.trim() || '';
        const trialMatch = text.match(/(\d+\s*-\s*day(?:s)?\s*free|free\s*trial|1\s*month\s*free|试用|免费试用|首月免费)/i);
        const trialText = trialMatch?.[1] || '';
        const zeroLikely = /(?:^|[^\d])0(?:[.,]00)?(?:[^\d]|$)/.test(amountText) || /php\s*0|usd\s*0|pay\s*0|total\s*0|due\s*0/i.test(text);
        const trialLikely = Boolean(trialText) || /free trial|plus-1-month-free|试用/i.test(text);
        return { amountText, trialText, zeroLikely, trialLikely, pageUrl: location.href };
      },
    });
    const data = (results?.[0]?.result || {}) as { amountText?: string; trialText?: string; zeroLikely?: boolean; trialLikely?: boolean; pageUrl?: string };
    const amountText = String(data.amountText || '');
    const trialText = String(data.trialText || '');
    const zeroLikely = Boolean(data.zeroLikely);
    const trialLikely = Boolean(data.trialLikely);
    const message = [zeroLikely ? '页面疑似 0 金额' : '', trialLikely ? `试用:${trialText || 'yes'}` : '', amountText ? `页面金额:${amountText}` : '未识别到金额文案'].filter(Boolean).join(' / ');
    return { checked: true, ok: true, amountText, trialText, zeroLikely, trialLikely, pageUrl: String(data.pageUrl || lastUrl), message, checkedAt: Date.now() };
  } catch (error) {
    return { checked: true, ok: false, amountText: '', trialText: '', zeroLikely: false, trialLikely: false, pageUrl: lastUrl, message: `结账页识别失败：${error instanceof Error ? error.message : String(error)}`, checkedAt: Date.now() };
  }
}

export async function runProxyHealthCheck(countries: string[]): Promise<ProbeState> {
  const proxy = await loadProxySettings();
  const targets = [...new Set(countries.map((item) => String(item || '').trim().toUpperCase()).filter((item) => /^[A-Z]{2}$/.test(item)))];
  const items: ProbeProxyHealthItem[] = [];
  for (const country of targets) {
    const endpoint = resolveCountryExit(proxy, country) || (proxy.exit2.host ? proxy.exit2 : null) || (proxy.front.host ? proxy.front : null);
    if (!endpoint || !isProxyEndpointReady(endpoint)) {
      items.push({ country, status: 'skip', latencyMs: 0, endpointSummary: '未配置出口', message: '无可用国家出口/前置/出口2', checkedAt: Date.now() });
      continue;
    }
    const started = Date.now();
    try {
      await applyFixedEndpoint(endpoint);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const response = await fetch('https://chatgpt.com/cdn-cgi/trace', { method: 'GET', cache: 'no-store', signal: controller.signal });
      clearTimeout(timer);
      const text = await response.text();
      const loc = /loc=([A-Z]{2})/i.exec(text)?.[1]?.toUpperCase() || '';
      const ip = /ip=([^\n]+)/i.exec(text)?.[1] || '';
      const coloFromTrace = /colo=([^\n]+)/i.exec(text)?.[1] || '';
      let meta: { clientIp?: string; country?: string; colo?: string; asn?: number | string; asOrganization?: string } = {};
      try {
        const metaController = new AbortController();
        const metaTimer = setTimeout(() => metaController.abort(), 5000);
        const metaResponse = await fetch('https://speed.cloudflare.com/meta', { method: 'GET', cache: 'no-store', signal: metaController.signal });
        clearTimeout(metaTimer);
        if (metaResponse.ok) meta = await metaResponse.json() as typeof meta;
      } catch {
        // Trace result remains sufficient for basic health when ASN metadata is unavailable.
      }
      const actualIp = String(meta.clientIp || ip || '');
      const actualCountry = String(meta.country || loc || '').toUpperCase();
      const asn = meta.asn ? `AS${String(meta.asn).replace(/^AS/i, '')}` : '';
      const asOrganization = String(meta.asOrganization || '');
      const networkType = classifyNetworkType(asOrganization);
      const latencyMs = Date.now() - started;
      const ok = response.ok;
      items.push({
        country,
        status: ok ? 'ok' : 'fail',
        latencyMs,
        endpointSummary: formatProxyEndpoint(endpoint),
        message: ok ? `通 · ${latencyMs}ms · ip=${actualIp || '-'} · loc=${actualCountry || ''}${actualCountry && actualCountry !== country ? ` (期望${country})` : ''} · ${asn || 'ASN未知'}` : `HTTP ${response.status} · ${latencyMs}ms`,
        checkedAt: Date.now(),
        actualIp,
        actualCountry,
        colo: String(meta.colo || coloFromTrace || ''),
        asn,
        asOrganization,
        ipVersion: actualIp ? (actualIp.includes(':') ? 'IPv6' : 'IPv4') : '',
        networkType,
      });
    } catch (error) {
      items.push({ country, status: 'fail', latencyMs: Date.now() - started, endpointSummary: formatProxyEndpoint(endpoint), message: error instanceof Error ? error.message : String(error), checkedAt: Date.now() });
    }
  }
  return saveProxyHealth(items);
}

function classifyNetworkType(organization: string): 'residential' | 'hosting' | 'unknown' {
  const value = String(organization || '').toLowerCase();
  if (!value) return 'unknown';
  if (/amazon|google cloud|microsoft|azure|digitalocean|linode|vultr|hosting|cloud|datacenter|data center|server|colo|ovh|hetzner/.test(value)) return 'hosting';
  if (/telecom|mobile|broadband|fiber|cable|communications|wireless|isp/.test(value)) return 'residential';
  return 'unknown';
}

// silence unused import in some builds
void stageLabel;
