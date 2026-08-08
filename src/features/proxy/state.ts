import { scopedStorageKey } from '../../app/storage-scope';
import { resolveSeedPoolIndex } from './pool-selection';
import {
  DEFAULT_EXIT1_PROXY,
  DEFAULT_EXIT2_PROXY,
  DEFAULT_FRONT_PROXY,
  DEFAULT_AUTOMATION_PROXY_ROUTING,
  DEFAULT_PROXY_META_URL,
  DEFAULT_PROXY_SETTINGS,
  DEFAULT_PROXY_TRACE_URL,
  type AutomationProxyFallbackStage,
  type AutomationProxyRouting,
  type AutomationProxyStage,
  type AutomationProxyStageRoute,
  type ProxyChainMode,
  type ProxyEndpoint,
  type ProxyScheme,
  type ProxyMethodId,
  type ProxyMethodStagePool,
  type ProxySeedHealthRecord,
  type ProxySettings,
  type ProxyStage,
} from './types';

const PROXY_STORAGE_KEY = 'opx.proxy.settings';

export async function loadProxySettings(): Promise<ProxySettings> {
  const storageKey = scopedStorageKey(PROXY_STORAGE_KEY);
  const data = await browser.storage.local.get(storageKey);
  return normalizeProxySettings(data[storageKey]);
}

export async function saveProxySettings(patch: Partial<ProxySettings>): Promise<ProxySettings> {
  const current = await loadProxySettings();
  const next = normalizeProxySettings({
    ...current,
    ...patch,
    front: patch.front ? { ...current.front, ...patch.front } : current.front,
    exit1: patch.exit1 ? { ...current.exit1, ...patch.exit1 } : current.exit1,
    exit2: patch.exit2 ? { ...current.exit2, ...patch.exit2 } : current.exit2,
    countryExits: patch.countryExits !== undefined ? patch.countryExits : current.countryExits,
    methodPools: patch.methodPools !== undefined ? patch.methodPools : current.methodPools,
    automationRouting: patch.automationRouting
      ? {
          ...current.automationRouting,
          ...patch.automationRouting,
          auth: { ...current.automationRouting.auth, ...patch.automationRouting.auth },
          checkout: { ...current.automationRouting.checkout, ...patch.automationRouting.checkout },
          billing: { ...current.automationRouting.billing, ...patch.automationRouting.billing },
          evidence: patch.automationRouting.evidence ?? current.automationRouting.evidence,
        }
      : current.automationRouting,
    seedHealth: patch.seedHealth !== undefined ? patch.seedHealth : current.seedHealth,
    updatedAt: Date.now(),
  });
  await browser.storage.local.set({ [scopedStorageKey(PROXY_STORAGE_KEY)]: next });
  return next;
}

export function normalizeProxySettings(value: unknown): ProxySettings {
  const source = isRecord(value) ? value : {};
  return {
    enabled: source.enabled === undefined ? DEFAULT_PROXY_SETTINGS.enabled : Boolean(source.enabled),
    chainMode: normalizeChainMode(source.chainMode),
    front: normalizeEndpoint(source.front, DEFAULT_FRONT_PROXY),
    exit1: normalizeEndpoint(source.exit1, DEFAULT_EXIT1_PROXY),
    exit2: normalizeEndpoint(source.exit2, DEFAULT_EXIT2_PROXY),
    countryExits: normalizeCountryExits(source.countryExits),
    methodPools: normalizeMethodPools(source.methodPools),
    preferMethodPools: source.preferMethodPools === undefined ? DEFAULT_PROXY_SETTINGS.preferMethodPools : Boolean(source.preferMethodPools),
    automationRouting: normalizeAutomationRouting(source.automationRouting),
    seedHealthEnabled: source.seedHealthEnabled === undefined ? DEFAULT_PROXY_SETTINGS.seedHealthEnabled : Boolean(source.seedHealthEnabled),
    seedFailCooldownSec: clampInt(source.seedFailCooldownSec, 0, 86400, DEFAULT_PROXY_SETTINGS.seedFailCooldownSec),
    seedRemoveAfterFails: clampInt(source.seedRemoveAfterFails, 1, 50, DEFAULT_PROXY_SETTINGS.seedRemoveAfterFails),
    seedFailSkipAfter: clampInt(source.seedFailSkipAfter, 1, 20, DEFAULT_PROXY_SETTINGS.seedFailSkipAfter),
    seedHealth: normalizeSeedHealth(source.seedHealth),
    activeStage: normalizeStage(source.activeStage),
    updatedAt: Number(source.updatedAt || DEFAULT_PROXY_SETTINGS.updatedAt),
  };
}

export function normalizeAutomationRouting(value: unknown): AutomationProxyRouting {
  const source = isRecord(value) ? value : {};
  return {
    enabled: source.enabled === undefined ? DEFAULT_AUTOMATION_PROXY_ROUTING.enabled : Boolean(source.enabled),
    stickyWithinStage: source.stickyWithinStage === undefined
      ? DEFAULT_AUTOMATION_PROXY_ROUTING.stickyWithinStage
      : Boolean(source.stickyWithinStage),
    verifyExitOnSwitch: source.verifyExitOnSwitch === undefined
      ? DEFAULT_AUTOMATION_PROXY_ROUTING.verifyExitOnSwitch
      : Boolean(source.verifyExitOnSwitch),
    verificationTraceUrl: validatedVerificationUrl(
      source.verificationTraceUrl,
      DEFAULT_PROXY_TRACE_URL,
    ),
    verificationMetaUrl: validatedVerificationUrl(
      source.verificationMetaUrl,
      DEFAULT_PROXY_META_URL,
      true,
    ),
    requireDistinctExits: source.requireDistinctExits === undefined
      ? DEFAULT_AUTOMATION_PROXY_ROUTING.requireDistinctExits
      : Boolean(source.requireDistinctExits),
    maxSwitchAttempts: clampInt(source.maxSwitchAttempts, 1, 10, DEFAULT_AUTOMATION_PROXY_ROUTING.maxSwitchAttempts),
    activeBusinessStage: normalizeAutomationStage(source.activeBusinessStage),
    auth: normalizeAutomationRoute(source.auth, DEFAULT_AUTOMATION_PROXY_ROUTING.auth),
    checkout: normalizeAutomationRoute(source.checkout, DEFAULT_AUTOMATION_PROXY_ROUTING.checkout),
    billing: normalizeAutomationRoute(source.billing, DEFAULT_AUTOMATION_PROXY_ROUTING.billing),
    evidence: normalizeAutomationEvidence(source.evidence),
  };
}

function validatedVerificationUrl(value: unknown, fallback: string, allowEmpty = false): string {
  const raw = value === undefined ? fallback : String(value).trim();
  if (allowEmpty && !raw) return '';
  try {
    const parsed = new URL(raw);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && !parsed.username
      && !parsed.password
      && raw.length <= 2048
      ? parsed.toString()
      : fallback;
  } catch {
    return fallback;
  }
}

function normalizeAutomationRoute(value: unknown, fallback: AutomationProxyStageRoute): AutomationProxyStageRoute {
  const source = isRecord(value) ? value : {};
  return {
    enabled: source.enabled === undefined ? fallback.enabled : Boolean(source.enabled),
    fallbackStage: normalizeAutomationFallbackStage(source.fallbackStage, fallback.fallbackStage),
    poolRaw: String(source.poolRaw ?? fallback.poolRaw),
    poolIndex: Math.max(0, Math.floor(Number(source.poolIndex ?? fallback.poolIndex)) || 0),
    rotateOnEnter: source.rotateOnEnter === undefined ? fallback.rotateOnEnter : Boolean(source.rotateOnEnter),
  };
}

function normalizeAutomationFallbackStage(value: unknown, fallback: AutomationProxyFallbackStage): AutomationProxyFallbackStage {
  const stage = String(value || fallback);
  return stage === 'front' || stage === 'exit1' || stage === 'exit2' ? stage : fallback;
}

function normalizeAutomationStage(value: unknown): AutomationProxyStage | '' {
  const stage = String(value || '');
  return stage === 'auth' || stage === 'checkout' || stage === 'billing' ? stage : '';
}

function normalizeAutomationEvidence(value: unknown): AutomationProxyRouting['evidence'] {
  const source = isRecord(value) ? value : {};
  const out: AutomationProxyRouting['evidence'] = {};
  for (const stage of ['auth', 'checkout', 'billing'] as const) {
    const row = isRecord(source[stage]) ? source[stage] : null;
    if (!row) continue;
    out[stage] = {
      stage,
      cycleId: String(row.cycleId || ''),
      source: String(row.source || ''),
      endpointSummary: String(row.endpointSummary || ''),
      ip: String(row.ip || ''),
      country: String(row.country || '').toUpperCase(),
      colo: String(row.colo || '').toUpperCase(),
      asn: String(row.asn || ''),
      asOrganization: String(row.asOrganization || ''),
      latencyMs: Math.max(0, Number(row.latencyMs || 0)),
      verified: Boolean(row.verified),
      distinct: row.distinct === undefined ? true : Boolean(row.distinct),
      excludedIp: Boolean(row.excludedIp),
      repeatedIpRejected: Math.max(0, Number(row.repeatedIpRejected || 0)),
      checkedAt: Math.max(0, Number(row.checkedAt || 0)),
      message: String(row.message || ''),
    };
  }
  return out;
}

export function normalizeEndpoint(value: unknown, fallback: ProxyEndpoint): ProxyEndpoint {
  const source = isRecord(value) ? value : {};
  const portRaw = Number(source.port ?? fallback.port);
  return {
    enabled: source.enabled === undefined ? fallback.enabled : Boolean(source.enabled),
    scheme: normalizeScheme(source.scheme, fallback.scheme),
    host: String(source.host ?? fallback.host).trim(),
    port: Number.isFinite(portRaw) ? Math.max(0, Math.floor(portRaw)) : fallback.port,
    username: String(source.username ?? fallback.username),
    password: String(source.password ?? fallback.password),
    label: String(source.label ?? fallback.label).trim() || fallback.label,
  };
}

export function isProxyEndpointReady(endpoint: ProxyEndpoint | null | undefined): boolean {
  if (!endpoint?.enabled) {
    return false;
  }
  return Boolean(endpoint.host.trim()) && endpoint.port > 0 && endpoint.port <= 65535;
}

export function formatProxyEndpoint(endpoint: ProxyEndpoint | null | undefined): string {
  if (!endpoint) {
    return '未配置';
  }
  if (!endpoint.host || endpoint.port <= 0) {
    return `${endpoint.label || '代理'}（未填主机/端口）`;
  }
  const auth = endpoint.username ? `${endpoint.username}@` : '';
  return `${endpoint.label || '代理'}: ${endpoint.scheme}://${auth}${endpoint.host}:${endpoint.port}`;
}

export function resolveProxyEndpoint(
  settings: ProxySettings,
  stage: ProxyStage,
): { endpoint: ProxyEndpoint | null; viaFront: boolean; reason: string } {
  if (!settings.enabled || stage === 'none') {
    return { endpoint: null, viaFront: false, reason: '代理总开关关闭或阶段为空' };
  }

  if (stage === 'front') {
    if (!isProxyEndpointReady(settings.front)) {
      return { endpoint: null, viaFront: false, reason: '前置代理未启用或未配置完整' };
    }
    return { endpoint: settings.front, viaFront: true, reason: '使用前置代理' };
  }

  const exit = stage === 'exit1' ? settings.exit1 : settings.exit2;
  const exitReady = isProxyEndpointReady(exit);
  const frontReady = isProxyEndpointReady(settings.front);

  if (settings.chainMode === 'front-gateway') {
    if (!frontReady) {
      if (exitReady) {
        return { endpoint: exit, viaFront: false, reason: '前置不可用，回退到出口直连' };
      }
      return { endpoint: null, viaFront: false, reason: '前置网关模式需要可用的前置代理' };
    }
    return {
      endpoint: settings.front,
      viaFront: true,
      reason: exitReady
        ? `前置网关模式：浏览器走前置，请确保本地客户端已切到${exit.label || stage}`
        : '前置网关模式：浏览器走前置',
    };
  }

  if (exitReady) {
    return { endpoint: exit, viaFront: false, reason: `直连${exit.label || stage}` };
  }
  if (frontReady) {
    return { endpoint: settings.front, viaFront: true, reason: '出口未配置，回退前置代理' };
  }
  return { endpoint: null, viaFront: false, reason: `${stage} 未配置可用出口或前置` };
}

function normalizeScheme(value: unknown, fallback: ProxyScheme): ProxyScheme {
  const scheme = String(value || fallback).trim().toLowerCase();
  if (scheme === 'http' || scheme === 'https' || scheme === 'socks4' || scheme === 'socks5') {
    return scheme;
  }
  return fallback;
}

function normalizeChainMode(value: unknown): ProxyChainMode {
  return String(value || '') === 'front-gateway' ? 'front-gateway' : 'direct-exit';
}

function normalizeStage(value: unknown): ProxyStage {
  const stage = String(value || 'none');
  if (stage === 'front' || stage === 'exit1' || stage === 'exit2' || stage === 'none') {
    return stage;
  }
  return 'none';
}


export function normalizeMethodPools(value: unknown): ProxyMethodStagePool[] {
  if (!Array.isArray(value)) return [];
  const out: ProxyMethodStagePool[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const method = normalizeMethodId(item.method);
    if (!method) continue;
    out.push({
      method,
      bootstrapRaw: String(item.bootstrapRaw || ''),
      promotionRaw: String(item.promotionRaw || ''),
      providerRaw: String(item.providerRaw || ''),
      bootstrapIndex: Math.max(0, Math.floor(Number(item.bootstrapIndex || 0)) || 0),
      promotionIndex: Math.max(0, Math.floor(Number(item.promotionIndex || 0)) || 0),
      providerIndex: Math.max(0, Math.floor(Number(item.providerIndex || 0)) || 0),
    });
  }
  return out;
}

function normalizeMethodId(value: unknown): ProxyMethodId | null {
  const id = String(value || '').trim().toLowerCase();
  const allowed: ProxyMethodId[] = ['hosted', 'paypal', 'momo', 'gopay', 'ideal', 'upi', 'pix', 'blik', 'twint', 'kakao'];
  return (allowed as string[]).includes(id) ? (id as ProxyMethodId) : null;
}

export function getMethodPool(
  settings: ProxySettings,
  method: string,
): ProxyMethodStagePool | null {
  const id = normalizeMethodId(method);
  if (!id) return null;
  return (settings.methodPools || []).find((item) => item.method === id) || null;
}

export function pickMethodStageProxy(
  settings: ProxySettings,
  method: string,
  stage: 'bootstrap' | 'promotion' | 'provider',
  preferredOrdinal?: number,
): { endpoint: ProxyEndpoint | null; rawLine: string; reason: string; nextPools: ProxyMethodStagePool[] } {
  const pool = getMethodPool(settings, method);
  if (!pool) {
    return { endpoint: null, rawLine: '', reason: '无对应 method pool', nextPools: settings.methodPools || [] };
  }
  const rawKey = stage === 'bootstrap' ? 'bootstrapRaw' : stage === 'promotion' ? 'promotionRaw' : 'providerRaw';
  const indexKey = stage === 'bootstrap' ? 'bootstrapIndex' : stage === 'promotion' ? 'promotionIndex' : 'providerIndex';
  const allLines = String(pool[rawKey] || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  // seed health skip: drop removed / cooling seeds when enabled
  const lines = allLines.filter((line) => {
    if (!settings.seedHealthEnabled) return true;
    const parsed = parseProxyConnectionString(line, { enabled: true, scheme: 'http', label: `${method}/${stage}` });
    const endpoint = parsed?.endpoint || null;
    const keyHost = endpoint?.host
      ? [String(method || '').toLowerCase(), stage, endpoint.host, endpoint.port, endpoint.username || ''].join('|').toLowerCase()
      : '';
    const keyRaw = [String(method || '').toLowerCase(), stage, line].join('|').toLowerCase();
    const rec = (settings.seedHealth || []).find((item) => item.key === keyHost || item.key === keyRaw);
    if (!rec) return true;
    if (rec.removed) return false;
    const skipAfter = Math.max(1, settings.seedFailSkipAfter || 1);
    if (rec.fail >= skipAfter && rec.cooldownUntil > Date.now()) return false;
    return true;
  });
  if (!lines.length) {
    return { endpoint: null, rawLine: '', reason: `${method}/${stage} 池为空或均在冷却/已剔除`, nextPools: settings.methodPools || [] };
  }
  const index = resolveSeedPoolIndex(preferredOrdinal, pool[indexKey], lines.length);
  const rawLine = lines[index];
  const parsed = parseProxyConnectionString(rawLine, {
    enabled: true,
    scheme: 'http',
    label: `${method}/${stage}`,
  });
  const endpoint = parsed
    ? normalizeEndpoint({ ...parsed.endpoint, enabled: true, label: `${method}/${stage}` }, {
        enabled: true,
        scheme: 'http',
        host: '',
        port: 0,
        username: '',
        password: '',
        label: `${method}/${stage}`,
      })
    : null;
  const nextPools = (settings.methodPools || []).map((item) => {
    if (item.method !== pool.method) return item;
    return {
      ...item,
      [indexKey]: (index + 1) % lines.length,
    };
  });
  if (!endpoint || !isProxyEndpointReady(endpoint)) {
    return { endpoint: null, rawLine, reason: `${method}/${stage} 行解析失败: ${rawLine.slice(0, 80)}`, nextPools };
  }
  return { endpoint, rawLine, reason: `method pool ${method}/${stage} #${index + 1}/${lines.length}`, nextPools };
}


function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(num)));
}

function normalizeSeedHealth(value: unknown): ProxySeedHealthRecord[] {
  if (!Array.isArray(value)) return [];
  const out: ProxySeedHealthRecord[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const key = String(row.key || '').trim();
    if (!key) continue;
    const stageRaw = String(row.stage || 'seed');
    const stage = (stageRaw === 'bootstrap' || stageRaw === 'promotion' || stageRaw === 'provider' || stageRaw === 'seed') ? stageRaw : 'seed';
    out.push({
      key,
      method: String(row.method || '').toLowerCase(),
      stage,
      endpointSummary: String(row.endpointSummary || ''),
      success: Math.max(0, Number(row.success || 0) || 0),
      fail: Math.max(0, Number(row.fail || 0) || 0),
      lastSuccessAt: Number(row.lastSuccessAt || 0) || 0,
      lastFailAt: Number(row.lastFailAt || 0) || 0,
      lastReason: String(row.lastReason || ''),
      cooldownUntil: Number(row.cooldownUntil || 0) || 0,
      removed: Boolean(row.removed),
      updatedAt: Number(row.updatedAt || 0) || 0,
    });
  }
  return out.slice(0, 500);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object');
}


function normalizeCountryExits(value: unknown): import('./types').ProxyCountryExit[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const row = isRecord(item) ? item : {};
      const country = String(row.country || '').trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(country)) return null;
      return {
        country,
        endpoint: normalizeEndpoint(row.endpoint, {
          enabled: true,
          scheme: 'http',
          host: '',
          port: 0,
          username: '',
          password: '',
          label: `出口/${country}`,
        }),
      };
    })
    .filter((item): item is import('./types').ProxyCountryExit => Boolean(item));
}

export function resolveCountryExit(settings: ProxySettings, country: string): ProxyEndpoint | null {
  const code = String(country || '').trim().toUpperCase();
  const found = settings.countryExits.find((item) => item.country === code);
  if (found && isProxyEndpointReady(found.endpoint)) {
    return found.endpoint;
  }
  return null;
}

export interface ParsedProxyConnection {
  endpoint: ProxyEndpoint;
  raw: string;
  format: string;
}

/**
 * One-click parse common proxy paste formats:
 * - host:port:username:password
 * - username:password@host:port
 * - scheme://user:pass@host:port
 * - host:port
 * - curl -x host:port -U "user:pass" ...
 * - multi-line list (first valid line used unless parseAll)
 */
export function parseProxyConnectionString(
  rawInput: string,
  fallback: Partial<ProxyEndpoint> = {},
): ParsedProxyConnection | null {
  const lines = String(rawInput || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    const parsed = parseOneProxyLine(line, fallback);
    if (parsed) return parsed;
  }
  // also try whole blob for curl one-liners
  return parseOneProxyLine(String(rawInput || '').trim(), fallback);
}

export function parseProxyConnectionList(
  rawInput: string,
  fallback: Partial<ProxyEndpoint> = {},
): ParsedProxyConnection[] {
  const out: ParsedProxyConnection[] = [];
  const seen = new Set<string>();
  for (const line of String(rawInput || '').split(/\r?\n/)) {
    const parsed = parseOneProxyLine(line.trim(), fallback);
    if (!parsed) continue;
    const key = `${parsed.endpoint.scheme}://${parsed.endpoint.username}:${parsed.endpoint.password}@${parsed.endpoint.host}:${parsed.endpoint.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parsed);
  }
  if (!out.length) {
    const one = parseProxyConnectionString(rawInput, fallback);
    if (one) out.push(one);
  }
  return out;
}

function parseOneProxyLine(line: string, fallback: Partial<ProxyEndpoint> = {}): ParsedProxyConnection | null {
  let text = String(line || '').trim();
  if (!text) return null;
  // strip labels like "主机端口 : xxx"
  text = text.replace(/^(主机端口|用户名|密码|host|hostname|port|user|username|pass|password)\s*[:：]\s*/i, '').trim();
  text = text.replace(/^['"]|['"]$/g, '').trim();

  let scheme = String(fallback.scheme || 'http').toLowerCase();
  let host = '';
  let port = 0;
  let username = String(fallback.username || '');
  let password = String(fallback.password || '');
  let format = 'unknown';

  // curl -x host:port -U user:pass  OR  curl -x scheme://host:port -U "user:pass"
  const curlProxy = text.match(/(?:^|\s)-x\s+(\S+)/i);
  const curlAuth = text.match(/(?:^|\s)-U\s+"([^"]+)"|(?:^|\s)-U\s+'([^']+)'|(?:^|\s)-U\s+(\S+)/i);
  if (curlProxy) {
    text = curlProxy[1];
    format = 'curl';
    if (curlAuth) {
      const auth = curlAuth[1] || curlAuth[2] || curlAuth[3] || '';
      const idx = auth.indexOf(':');
      if (idx >= 0) {
        username = auth.slice(0, idx);
        password = auth.slice(idx + 1);
      } else if (auth) {
        username = auth;
      }
    }
  }

  // scheme://user:pass@host:port
  if (/^[a-z0-9]+:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      scheme = (url.protocol.replace(':', '') || scheme).toLowerCase();
      host = url.hostname;
      port = Number(url.port || (scheme === 'https' ? 443 : scheme.startsWith('socks') ? 1080 : 80));
      if (url.username) username = decodeURIComponent(url.username);
      if (url.password) password = decodeURIComponent(url.password);
      format = format === 'unknown' ? 'url' : format;
    } catch {
      // fall through
    }
  }

  // user:pass@host:port
  if (!host) {
    const m = text.match(/^(?:([^:@\s]+):([^@\s]*)@)?([^:\s\/]+):(\d{2,5})$/);
    if (m) {
      if (m[1]) username = m[1];
      if (m[2] !== undefined && m[1]) password = m[2];
      host = m[3];
      port = Number(m[4]);
      format = format === 'unknown' ? (m[1] ? 'user@host:port' : 'host:port') : format;
    }
  }

  // host:port:user:pass  (Cliproxy / common residential format)
  // password may contain ':' so take first two as host/port, rest split once
  if (!host) {
    const parts = text.split(':');
    if (parts.length >= 4 && /^\d+$/.test(parts[1])) {
      host = parts[0];
      port = Number(parts[1]);
      username = parts[2];
      password = parts.slice(3).join(':');
      format = format === 'unknown' ? 'host:port:user:pass' : format;
    } else if (parts.length === 2 && /^\d+$/.test(parts[1])) {
      host = parts[0];
      port = Number(parts[1]);
      format = format === 'unknown' ? 'host:port' : format;
    }
  }

  host = String(host || '').trim();
  port = Number(port || 0);
  if (!host || !(port > 0 && port <= 65535)) return null;
  if (scheme === 'socks') scheme = 'socks5';
  if (!['http', 'https', 'socks4', 'socks5'].includes(scheme)) scheme = 'http';

  const endpoint = normalizeEndpoint({
    enabled: true,
    scheme,
    host,
    port,
    username: username || '',
    password: password || '',
    label: fallback.label || '解析代理',
  }, {
    enabled: true,
    scheme: 'http',
    host: '',
    port: 0,
    username: '',
    password: '',
    label: '解析代理',
  });
  return { endpoint, raw: line, format };
}
