import {
  formatProxyEndpoint,
  isProxyEndpointReady,
  loadProxySettings,
  parseProxyConnectionString,
  resolveProxyEndpoint,
  saveProxySettings,
} from './state';
import type {
  AutomationProxyExitEvidence,
  AutomationProxyStage,
  AutomationProxyStageRoute,
  ProxyEndpoint,
  ProxyRuntimeStatus,
  ProxySettings,
  ProxyStage,
} from './types';
import { DEFAULT_PROXY_META_URL, DEFAULT_PROXY_TRACE_URL } from './types';
import { importRegisterToolLocalRuntime } from './import-register-tool';

const BYPASS_LIST = [
  '127.0.0.1',
  'localhost',
  '<local>',
  '::1',
  'mail-api.yuecheng.shop',
  'mail.acica.top',
  '*.acica.top',
];

type ProxyAuthCredentials = {
  username: string;
  password: string;
};

let currentAuth: ProxyAuthCredentials | null = null;
let authListenerInstalled = false;

export async function getProxyRuntimeStatus(): Promise<ProxyRuntimeStatus> {
  const settings = await loadProxySettings();
  const resolved = resolveProxyEndpoint(settings, settings.activeStage);
  const browserProxyMode = await readBrowserProxyMode();
  return {
    ok: true,
    message: settings.enabled
      ? `代理已启用 · 当前阶段 ${stageLabel(settings.activeStage)} · ${resolved.reason}`
      : '代理总开关关闭',
    settings,
    applied: {
      stage: settings.activeStage,
      mode: settings.activeStage === 'none' || !resolved.endpoint ? 'cleared' : 'fixed_servers',
      endpoint: resolved.endpoint,
      viaFront: resolved.viaFront,
      summary: resolved.endpoint ? formatProxyEndpoint(resolved.endpoint) : '未应用代理',
    },
    browserProxyMode,
  };
}

export async function applyProxyStage(stage: ProxyStage): Promise<ProxyRuntimeStatus> {
  let settings = await loadProxySettings();
  if (!settings.enabled && settings.updatedAt === 0 && stage !== 'none') {
    const preset = importRegisterToolLocalRuntime({ existing: settings, merge: false, enableMethodPools: true });
    if (preset.ok) {
      settings = await saveProxySettings(preset.settings);
    }
  }
  if (!settings.enabled) {
    await clearBrowserProxy();
    const next = await saveProxySettings({ activeStage: 'none' });
    return {
      ok: true,
      message: '代理总开关关闭，已保持直连',
      settings: next,
      applied: {
        stage: 'none',
        mode: 'cleared',
        endpoint: null,
        viaFront: false,
        summary: '直连',
      },
      browserProxyMode: await readBrowserProxyMode(),
    };
  }

  if (stage === 'none') {
    return clearProxyStage();
  }

  const resolved = resolveProxyEndpoint(settings, stage);
  if (!resolved.endpoint || !isProxyEndpointReady(resolved.endpoint)) {
    return {
      ok: false,
      message: `无法应用 ${stageLabel(stage)}：${resolved.reason}`,
      settings,
      applied: {
        stage: settings.activeStage,
        mode: 'cleared',
        endpoint: null,
        viaFront: false,
        summary: resolved.reason,
      },
      browserProxyMode: await readBrowserProxyMode(),
    };
  }

  await setFixedProxy(resolved.endpoint);
  const next = await saveProxySettings({ activeStage: stage });
  return {
    ok: true,
    message: `已切换到${stageLabel(stage)}：${formatProxyEndpoint(resolved.endpoint)}（${resolved.reason}）`,
    settings: next,
    applied: {
      stage,
      mode: 'fixed_servers',
      endpoint: resolved.endpoint,
      viaFront: resolved.viaFront,
      summary: formatProxyEndpoint(resolved.endpoint),
    },
    browserProxyMode: await readBrowserProxyMode(),
  };
}

export async function applyAutomationProxyStage(
  stage: AutomationProxyStage,
  cycleId: string,
  forceRotate = false,
  options: { excludeIps?: string[]; requireDifferentIp?: boolean; reason?: string } = {},
): Promise<ProxyRuntimeStatus> {
  let settings = await loadProxySettings();
  if (!settings.enabled && settings.updatedAt === 0) {
    const preset = importRegisterToolLocalRuntime({ existing: settings, merge: false, enableMethodPools: true });
    if (preset.ok) settings = await saveProxySettings(preset.settings);
  }
  if (!settings.enabled) return applyProxyStage('none');

  const routing = settings.automationRouting;
  const route = routing[stage];
  if (!routing.enabled || !route.enabled) {
    const fallback = await applyProxyStage(route.fallbackStage);
    return {
      ...fallback,
      message: `${automationStageLabel(stage)}三阶段路由未启用，${fallback.message}`,
      applied: { ...fallback.applied, businessStage: stage },
    };
  }

  const previous = routing.evidence[stage];
  if (
    routing.stickyWithinStage
    && !forceRotate
    && routing.activeBusinessStage === stage
    && previous?.cycleId === cycleId
  ) {
    const status = await getProxyRuntimeStatus();
    return {
      ...status,
      message: `${automationStageLabel(stage)}阶段内固定：${previous.endpointSummary}`,
      applied: { ...status.applied, businessStage: stage, summary: previous.endpointSummary, evidence: previous },
    };
  }

  const lines = proxyPoolLines(route.poolRaw);
  const excludeIps = [...new Set((options.excludeIps || []).map(normalizeExitIp).filter(Boolean))];
  const requireDifferentIp = Boolean(options.requireDifferentIp || excludeIps.length);
  const verifyExit = routing.verifyExitOnSwitch || requireDifferentIp;
  const attempts = Math.max(1, (routing.requireDistinctExits || verifyExit) ? routing.maxSwitchAttempts : 1);
  let lastEvidence: AutomationProxyExitEvidence | null = null;
  let selectedEndpoint: ProxyEndpoint | null = null;
  let selectedSource = '';
  let nextIndex = route.poolIndex;
  let repeatedIpRejected = 0;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const picked = pickAutomationEndpoint(settings, stage, route, lines, attempt);
    if (!picked.endpoint) {
      return failedAutomationStageStatus(settings, stage, picked.message);
    }
    selectedEndpoint = picked.endpoint;
    selectedSource = picked.source;
    nextIndex = picked.nextIndex;
    await setFixedProxy(selectedEndpoint);
    const trace = verifyExit
      ? await verifyCurrentExit(routing.verificationTraceUrl, routing.verificationMetaUrl)
      : {
          verified: false,
          ip: '',
          country: '',
          colo: '',
          asn: '',
          asOrganization: '',
          latencyMs: 0,
          checkedAt: Date.now(),
          message: '出口验证已关闭',
        };
    const distinct = isDistinctAutomationExit(routing.evidence, stage, cycleId, trace.ip, selectedEndpoint);
    const candidate = assessAutomationExitCandidate({
      verified: trace.verified,
      ip: trace.ip,
      excludeIps,
      distinct,
      requireDistinct: routing.requireDistinctExits,
      requireDifferentIp,
      requireVerified: verifyExit,
    });
    if (candidate.excludedIp) repeatedIpRejected += 1;
    lastEvidence = {
      stage,
      cycleId,
      source: selectedSource,
      endpointSummary: formatProxyEndpoint(selectedEndpoint),
      ip: trace.ip,
      country: trace.country,
      colo: trace.colo,
      asn: trace.asn,
      asOrganization: trace.asOrganization,
      latencyMs: trace.latencyMs,
      verified: trace.verified,
      distinct,
      excludedIp: candidate.excludedIp,
      repeatedIpRejected,
      checkedAt: Date.now(),
      message: candidate.excludedIp
        ? `出口 IP ${trace.ip} 与失败 Auth 出口重复，已拒绝`
        : trace.message,
    };
    if (candidate.accepted) break;
  }

  if (!selectedEndpoint || !lastEvidence) {
    return failedAutomationStageStatus(settings, stage, '没有选出可用代理');
  }
  const nextRoute: AutomationProxyStageRoute = { ...route, poolIndex: nextIndex };
  const nextRouting = {
    ...routing,
    [stage]: nextRoute,
    activeBusinessStage: stage,
    evidence: { ...routing.evidence, [stage]: lastEvidence },
  };
  const next = await saveProxySettings({
    activeStage: route.fallbackStage,
    automationRouting: nextRouting,
  });
  const evidenceText = lastEvidence.verified
    ? `${lastEvidence.country || '--'} · ${lastEvidence.ip}${lastEvidence.colo ? ` · ${lastEvidence.colo}` : ''}`
    : lastEvidence.message;
  const verificationFailed = verifyExit && !lastEvidence.verified;
  const distinctConflict = routing.requireDistinctExits && !lastEvidence.distinct;
  const repeatedIpConflict = requireDifferentIp && Boolean(lastEvidence.excludedIp);
  return {
    ok: !verificationFailed && !distinctConflict && !repeatedIpConflict,
    code: repeatedIpConflict ? 'AUTH_EXIT_NOT_ROTATED' : undefined,
    message: repeatedIpConflict
      ? `${automationStageLabel(stage)}出口池没有形成新 IP：${lastEvidence.ip || '未探测到 IP'}，重复 IP 已拒绝 ${repeatedIpRejected} 次`
      : verificationFailed
      ? `${automationStageLabel(stage)}所有候选 seed 均未通过出口验证：${lastEvidence.message}`
      : distinctConflict
      ? `${automationStageLabel(stage)}出口与本轮其他阶段重复：${evidenceText}`
      : `${automationStageLabel(stage)}出口已切换：${evidenceText}`,
    settings: next,
    applied: {
      stage: route.fallbackStage,
      businessStage: stage,
      mode: 'fixed_servers',
      endpoint: selectedEndpoint,
      viaFront: false,
      summary: formatProxyEndpoint(selectedEndpoint),
      evidence: lastEvidence,
    },
    browserProxyMode: await readBrowserProxyMode(),
  };
}

export function assessAutomationExitCandidate(input: {
  verified: boolean;
  ip: string;
  excludeIps: string[];
  distinct: boolean;
  requireDistinct: boolean;
  requireDifferentIp: boolean;
  requireVerified: boolean;
}): { accepted: boolean; excludedIp: boolean } {
  const ip = normalizeExitIp(input.ip);
  const excludedIp = Boolean(ip) && input.excludeIps.map(normalizeExitIp).includes(ip);
  const verified = !input.requireVerified || (input.verified && (!input.requireDifferentIp || Boolean(ip)));
  return {
    accepted: verified && !excludedIp && (!input.requireDistinct || input.distinct),
    excludedIp,
  };
}

function normalizeExitIp(value: string): string {
  return String(value || '').trim().toLowerCase();
}

function pickAutomationEndpoint(
  settings: ProxySettings,
  stage: AutomationProxyStage,
  route: AutomationProxyStageRoute,
  lines: string[],
  attempt: number,
): { endpoint: ProxyEndpoint | null; source: string; nextIndex: number; message: string } {
  if (lines.length) {
    const offset = route.rotateOnEnter ? attempt : 0;
    const index = (route.poolIndex + offset) % lines.length;
    const session = createProxySessionToken(stage);
    const raw = lines[index].replace(/\{SESSION\}/gi, session);
    const parsed = parseProxyConnectionString(raw, { enabled: true, scheme: 'http', label: `${automationStageLabel(stage)} seed` });
    if (parsed && isProxyEndpointReady(parsed.endpoint)) {
      const nextIndex = route.rotateOnEnter ? (index + 1) % lines.length : index;
      return { endpoint: parsed.endpoint, source: `pool #${index + 1}/${lines.length}`, nextIndex, message: '' };
    }
  }
  const fallback = resolveProxyEndpoint(settings, route.fallbackStage);
  return {
    endpoint: fallback.endpoint,
    source: `fallback:${route.fallbackStage}`,
    nextIndex: route.poolIndex,
    message: fallback.reason,
  };
}

function proxyPoolLines(raw: string): string[] {
  return String(raw || '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
}

function createProxySessionToken(stage: AutomationProxyStage): string {
  const random = globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 12)
    || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return `${stage}-${random}`;
}

function isDistinctAutomationExit(
  evidence: ProxySettings['automationRouting']['evidence'],
  stage: AutomationProxyStage,
  cycleId: string,
  ip: string,
  endpoint: ProxyEndpoint,
): boolean {
  const auth = endpoint.username ? `${endpoint.username}@` : '';
  const signature = `${endpoint.scheme}://${auth}${endpoint.host}:${endpoint.port}`;
  return (Object.entries(evidence) as Array<[AutomationProxyStage, AutomationProxyExitEvidence]>).every(([otherStage, row]) => {
    if (!row || otherStage === stage || row.cycleId !== cycleId) return true;
    if (ip && row.ip) return ip !== row.ip;
    const previousSignature = row.endpointSummary.match(/(?:https?|socks4|socks5):\/\/\S+$/i)?.[0] || row.endpointSummary;
    return previousSignature !== signature;
  });
}

export interface ProxyExitTrace {
  verified: boolean;
  ip: string;
  country: string;
  colo: string;
  asn: string;
  asOrganization: string;
  latencyMs: number;
  checkedAt: number;
  message: string;
}

export async function verifyCurrentExit(
  traceUrl = DEFAULT_PROXY_TRACE_URL,
  metaUrl = DEFAULT_PROXY_META_URL,
): Promise<ProxyExitTrace> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), 8_000);
  try {
    const [response, metaResponse] = await Promise.all([
      fetch(traceUrl, { cache: 'no-store', signal: controller.signal }),
      metaUrl
        ? fetch(metaUrl, { cache: 'no-store', signal: controller.signal }).catch(() => null)
        : Promise.resolve(null),
    ]);
    const body = await response.text();
    const values = Object.fromEntries(body.split(/\r?\n/).map((line) => line.split('=', 2)).filter((row) => row.length === 2));
    const meta = metaResponse?.ok
      ? await metaResponse.json().catch(() => ({})) as { clientIp?: string; country?: string; colo?: string; asn?: string | number; asOrganization?: string }
      : {};
    const ip = String(meta.clientIp || values.ip || '').trim();
    const country = String(meta.country || values.loc || '').trim().toUpperCase();
    const colo = String(meta.colo || values.colo || '').trim().toUpperCase();
    const asn = meta.asn ? `AS${String(meta.asn).replace(/^AS/i, '')}` : '';
    return {
      verified: response.ok && Boolean(ip),
      ip,
      country,
      colo,
      asn,
      asOrganization: String(meta.asOrganization || ''),
      latencyMs: Date.now() - startedAt,
      checkedAt: Date.now(),
      message: response.ok && ip ? '出口 trace 已验证' : `出口 trace HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      verified: false,
      ip: '',
      country: '',
      colo: '',
      asn: '',
      asOrganization: '',
      latencyMs: Date.now() - startedAt,
      checkedAt: Date.now(),
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    globalThis.clearTimeout(timer);
  }
}

function failedAutomationStageStatus(settings: ProxySettings, stage: AutomationProxyStage, message: string): ProxyRuntimeStatus {
  return {
    ok: false,
    message: `${automationStageLabel(stage)}出口切换失败：${message}`,
    settings,
    applied: {
      stage: settings.activeStage,
      businessStage: stage,
      mode: 'cleared',
      endpoint: null,
      viaFront: false,
      summary: message,
    },
  };
}

export async function clearProxyStage(): Promise<ProxyRuntimeStatus> {
  await clearBrowserProxy();
  const current = await loadProxySettings();
  const next = await saveProxySettings({
    activeStage: 'none',
    automationRouting: { ...current.automationRouting, activeBusinessStage: '' },
  });
  return {
    ok: true,
    message: '已清除扩展代理，恢复浏览器直连/系统代理',
    settings: next,
    applied: {
      stage: 'none',
      mode: 'cleared',
      endpoint: null,
      viaFront: false,
      summary: '已清除',
    },
    browserProxyMode: await readBrowserProxyMode(),
  };
}

export async function saveAndMaybeApplyProxy(
  patch: Partial<ProxySettings>,
  applyStage?: ProxyStage,
): Promise<ProxyRuntimeStatus> {
  const saved = await saveProxySettings(patch);
  if (!saved.enabled) {
    await clearBrowserProxy();
    const cleared = await saveProxySettings({ activeStage: 'none' });
    return {
      ok: true,
      message: '代理设置已保存，总开关关闭并已清除浏览器代理',
      settings: cleared,
      applied: {
        stage: 'none',
        mode: 'cleared',
        endpoint: null,
        viaFront: false,
        summary: '直连',
      },
      browserProxyMode: await readBrowserProxyMode(),
    };
  }
  if (applyStage) {
    return applyProxyStage(applyStage);
  }
  if (saved.activeStage !== 'none') {
    return applyProxyStage(saved.activeStage);
  }
  return getProxyRuntimeStatus();
}

async function setFixedProxy(endpoint: ProxyEndpoint): Promise<void> {
  const proxyApi = getProxyApi();
  if (!proxyApi?.settings?.set) {
    throw new Error('当前浏览器不支持 chrome.proxy.settings');
  }

  currentAuth = endpoint.username
    ? { username: endpoint.username, password: endpoint.password || '' }
    : null;
  ensureAuthListener();

  await withProxyApiTimeout(proxyApi.settings.set({
    value: proxyValue(endpoint),
    scope: 'regular',
  }), '设置浏览器代理');
}

async function clearBrowserProxy(): Promise<void> {
  currentAuth = null;
  const proxyApi = getProxyApi();
  if (!proxyApi?.settings?.clear) {
    return;
  }
  try {
    await withProxyApiTimeout(proxyApi.settings.clear({ scope: 'regular' }), '清除浏览器代理');
  } catch (error) {
    console.debug('[OPX] proxy clear failed', error);
  }
}

function ensureAuthListener(): void {
  if (authListenerInstalled) {
    return;
  }
  const webRequest = (browser as typeof browser & {
    webRequest?: {
      onAuthRequired?: {
        addListener: (
          callback: (details: { isProxy?: boolean }) => unknown,
          filter: { urls: string[] },
          extraInfoSpec?: string[],
        ) => void;
      };
    };
  }).webRequest;
  if (!webRequest?.onAuthRequired?.addListener) {
    return;
  }
  try {
    webRequest.onAuthRequired.addListener(
      (details) => {
        if (!details?.isProxy || !currentAuth) {
          return undefined;
        }
        return {
          authCredentials: {
            username: currentAuth.username,
            password: currentAuth.password,
          },
        };
      },
      { urls: ['<all_urls>'] },
      ['blocking'],
    );
    authListenerInstalled = true;
  } catch (error) {
    console.debug('[OPX] proxy auth listener setup failed', error);
  }
}

async function readBrowserProxyMode(): Promise<string> {
  const proxyApi = getProxyApi();
  if (!proxyApi?.settings?.get) {
    return 'unsupported';
  }
  try {
    const result = await withProxyApiTimeout(proxyApi.settings.get({}), '读取浏览器代理');
    const value = result?.value as { mode?: string } | undefined;
    return value?.mode || 'unknown';
  } catch {
    return 'unavailable';
  }
}

function proxyValue(endpoint: ProxyEndpoint): unknown {
  const isFirefox = (() => {
    try { return browser.runtime.getURL('').startsWith('moz-extension://'); } catch { return false; }
  })();
  if (isFirefox) {
    const address = `${endpoint.host}:${endpoint.port}`;
    if (endpoint.scheme === 'socks4' || endpoint.scheme === 'socks5') {
      return {
        proxyType: 'manual',
        socks: address,
        socksVersion: endpoint.scheme === 'socks4' ? 4 : 5,
        proxyDNS: true,
        passthrough: 'localhost, 127.0.0.1, <local>',
      };
    }
    return {
      proxyType: 'manual',
      http: address,
      ssl: address,
      httpProxyAll: true,
      passthrough: 'localhost, 127.0.0.1, <local>',
    };
  }
  return {
    mode: 'fixed_servers',
    rules: {
      singleProxy: { scheme: endpoint.scheme, host: endpoint.host, port: endpoint.port },
      bypassList: BYPASS_LIST,
    },
  };
}

async function withProxyApiTimeout<T>(operation: Promise<T>, label: string, timeoutMs = 10_000): Promise<T> {
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

function getProxyApi(): {
  settings?: {
    set?: (details: { value: unknown; scope?: string }) => Promise<void>;
    clear?: (details: { scope?: string }) => Promise<void>;
    get?: (details: Record<string, unknown>) => Promise<{ value?: unknown }>;
  };
} | null {
  const chromeLike = globalThis as typeof globalThis & {
    chrome?: { proxy?: unknown };
    browser?: { proxy?: unknown };
  };
  const api = (chromeLike.browser as { proxy?: unknown } | undefined)?.proxy
    || (chromeLike.chrome as { proxy?: unknown } | undefined)?.proxy
    || (browser as typeof browser & { proxy?: unknown }).proxy;
  return (api as {
    settings?: {
      set?: (details: { value: unknown; scope?: string }) => Promise<void>;
      clear?: (details: { scope?: string }) => Promise<void>;
      get?: (details: Record<string, unknown>) => Promise<{ value?: unknown }>;
    };
  } | null) || null;
}

export function stageLabel(stage: ProxyStage): string {
  switch (stage) {
    case 'front':
      return '前置代理';
    case 'exit1':
      return '出口1（任意国家/用途）';
    case 'exit2':
      return '出口2（任意国家/用途）';
    default:
      return '直连';
  }
}

export function automationStageLabel(stage: AutomationProxyStage): string {
  if (stage === 'auth') return 'Auth/注册';
  if (stage === 'checkout') return 'Checkout/优惠评估';
  return 'Billing/支付';
}

export function automationStageForAutomationStep(stepId: string): AutomationProxyStage | null {
  if (
    stepId === 'cleanup-environment'
    || stepId === 'select-email'
    || stepId === 'open-register'
    || stepId === 'fill-register-email'
    || stepId === 'wait-register-email-code'
    || stepId === 'fill-profile'
  ) return 'auth';
  if (stepId === 'read-chatgpt-session' || stepId === 'create-checkout-link' || stepId === 'run-plus-checkout-closure') return 'checkout';
  if (
    stepId === 'open-checkout-link'
    || stepId === 'submit-openai-checkout'
    || stepId === 'open-paypal-account'
    || stepId === 'fill-paypal-email'
    || stepId === 'select-sms'
    || stepId === 'fill-payment-profile'
    || stepId === 'wait-payment-sms'
    || stepId === 'create-oauth-session'
    || stepId === 'fill-oauth-email'
    || stepId === 'wait-oauth-email-code'
    || stepId === 'export-oauth-files'
    || stepId === 'generate-direct-files'
  ) return 'billing';
  return null;
}

export function stageForAutomationStep(stepId: string): ProxyStage | null {
  if (
    stepId === 'cleanup-environment'
    || stepId === 'select-email'
    || stepId === 'open-register'
    || stepId === 'fill-register-email'
    || stepId === 'wait-register-email-code'
    || stepId === 'fill-profile'
  ) {
    return 'exit1';
  }
  if (
    stepId === 'read-chatgpt-session'
    || stepId === 'create-checkout-link'
    || stepId === 'open-checkout-link'
    || stepId === 'submit-openai-checkout'
    || stepId === 'open-paypal-account'
    || stepId === 'fill-paypal-email'
    || stepId === 'select-sms'
    || stepId === 'fill-payment-profile'
    || stepId === 'wait-payment-sms'
    || stepId === 'create-oauth-session'
    || stepId === 'fill-oauth-email'
    || stepId === 'wait-oauth-email-code'
    || stepId === 'export-oauth-files'
    || stepId === 'generate-direct-files'
  ) {
    return 'exit2';
  }
  return null;
}
