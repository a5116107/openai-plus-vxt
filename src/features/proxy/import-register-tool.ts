import {
  DEFAULT_PROXY_SETTINGS,
  type ProxyEndpoint,
  type ProxyMethodId,
  type ProxyMethodStagePool,
  type ProxySettings,
} from './types';
import { normalizeEndpoint, normalizeProxySettings, parseProxyConnectionString } from './state';

/** Known local chain-proxy listeners from GPT-Register-Tool runtime. */
export const REGISTER_TOOL_CHAIN_PORTS: Record<string, number> = {
  TH: 18090,
  IN: 18091,
  VN: 18091,
  JP: 18092,
  US: 18093,
};

export interface RegisterToolImportOptions {
  /** Prefer socks5 for local front when URL says socks; default http. */
  preferFrontScheme?: 'http' | 'socks5';
  /** Enable method pools from paypal/upi stage_proxies. */
  enableMethodPools?: boolean;
  /** Merge into existing settings instead of replacing countryExits/methodPools. */
  merge?: boolean;
  existing?: Partial<ProxySettings> | null;
}

export interface RegisterToolImportResult {
  ok: boolean;
  message: string;
  settings: ProxySettings;
  summary: {
    front: string;
    exit1: string;
    exit2: string;
    countries: string[];
    methods: string[];
    source: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function endpointFromUrl(
  raw: string,
  label: string,
  fallbackScheme: 'http' | 'https' | 'socks4' | 'socks5' = 'http',
): ProxyEndpoint | null {
  const text = String(raw || '').trim();
  if (!text || text === 'direct') return null;
  const parsed = parseProxyConnectionString(text, {
    enabled: true,
    scheme: fallbackScheme,
    label,
  });
  if (!parsed?.endpoint?.host || !parsed.endpoint.port) return null;
  return {
    ...parsed.endpoint,
    enabled: true,
    label: label || parsed.endpoint.label || '导入代理',
  };
}

function endpointFromHostPort(
  host: string,
  port: number,
  label: string,
  scheme: 'http' | 'socks5' = 'http',
): ProxyEndpoint {
  return {
    enabled: true,
    scheme,
    host: host || '127.0.0.1',
    port,
    username: '',
    password: '',
    label,
  };
}

function formatSummary(endpoint: ProxyEndpoint | null | undefined): string {
  if (!endpoint?.host || !endpoint.port) return '-';
  const auth = endpoint.username ? `${endpoint.username}@` : '';
  return `${endpoint.scheme}://${auth}${endpoint.host}:${endpoint.port}`;
}

function stageProxyMap(source: unknown): Record<string, string> {
  if (!isRecord(source)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && value.trim() && value.trim() !== 'direct') {
      out[key] = value.trim();
    }
  }
  return out;
}

function stageCountryMap(source: unknown): Record<string, string> {
  if (!isRecord(source)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    const cc = String(value || '').trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(cc)) out[key] = cc;
  }
  return out;
}

function pushUniqueCountry(
  rows: Array<{ country: string; endpoint: ProxyEndpoint }>,
  country: string,
  endpoint: ProxyEndpoint,
): void {
  const cc = country.toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return;
  const idx = rows.findIndex((item) => item.country === cc);
  const row = { country: cc, endpoint: { ...endpoint, label: `${cc}出口` } };
  if (idx >= 0) rows[idx] = row;
  else rows.push(row);
}

function buildMethodPool(
  method: ProxyMethodId,
  stages: Record<string, string>,
): ProxyMethodStagePool | null {
  const bootstrap = stages.checkout || stages.bootstrap || stages.stripe_init || '';
  const promotion = stages.promotion || '';
  const provider = stages.provider || stages.payment_method || stages.confirm || stages.approve || '';
  if (!bootstrap && !promotion && !provider) return null;
  return {
    method,
    bootstrapRaw: bootstrap,
    promotionRaw: promotion,
    providerRaw: provider,
    bootstrapIndex: 0,
    promotionIndex: 0,
    providerIndex: 0,
  };
}

/**
 * Import GPT-Register-Tool config.json object into plugin ProxySettings.
 * Maps:
 * - front <- mailbox_proxy / proxy.default
 * - exit1 <- paypal.stage_proxies.checkout || JP chain
 * - exit2 <- paypal.stage_proxies.provider/confirm || US chain
 * - countryExits <- stage_proxy_countries + known chain ports + explicit proxies
 * - methodPools <- paypal/upi stage_proxies (optional)
 */
export function importRegisterToolConfig(
  rawConfig: unknown,
  options: RegisterToolImportOptions = {},
): RegisterToolImportResult {
  if (!isRecord(rawConfig)) {
    return {
      ok: false,
      message: '配置不是 JSON 对象',
      settings: normalizeProxySettings(options.existing || DEFAULT_PROXY_SETTINGS),
      summary: { front: '-', exit1: '-', exit2: '-', countries: [], methods: [], source: 'invalid' },
    };
  }

  const existing = normalizeProxySettings(options.existing || DEFAULT_PROXY_SETTINGS);
  const proxyBlock = isRecord(rawConfig.proxy) ? rawConfig.proxy : {};
  const paypal = isRecord(rawConfig.paypal) ? rawConfig.paypal : {};
  const upi = isRecord(rawConfig.upi) ? rawConfig.upi : {};
  const phoneReuse = isRecord(rawConfig.phone_reuse) ? rawConfig.phone_reuse : {};

  const frontRaw = firstString(
    rawConfig.mailbox_proxy,
    proxyBlock.default,
    Array.isArray(proxyBlock.pool) ? proxyBlock.pool[0] : '',
    phoneReuse.proxy,
    Array.isArray(paypal.proxies) ? paypal.proxies[0] : '',
  );
  const frontScheme = options.preferFrontScheme || (frontRaw.includes('socks') ? 'socks5' : 'http');
  let front = endpointFromUrl(frontRaw, '前置代理(Register-Tool)', frontScheme)
    || endpointFromHostPort('127.0.0.1', 10808, '前置代理(Register-Tool)', 'http');

  const paypalStages = stageProxyMap(paypal.stage_proxies);
  const upiStages = stageProxyMap(upi.stage_proxies);
  const paypalCountries = stageCountryMap(paypal.stage_proxy_countries);
  const upiCountries = stageCountryMap(upi.stage_proxy_countries);

  const frontKey = `${front.host}:${front.port}`;
  const pickExit = (
    urls: string[],
    countries: string[],
    fallbackCc: string,
    label: string,
  ): ProxyEndpoint => {
    for (let i = 0; i < urls.length; i += 1) {
      const url = urls[i];
      if (!url) continue;
      const ep = endpointFromUrl(url, label);
      if (!ep) continue;
      const sameAsFront = `${ep.host}:${ep.port}` === frontKey;
      const cc = (countries[i] || '').toUpperCase();
      if (sameAsFront && cc && REGISTER_TOOL_CHAIN_PORTS[cc]) {
        return endpointFromHostPort('127.0.0.1', REGISTER_TOOL_CHAIN_PORTS[cc], `${label}/${cc} chain :${REGISTER_TOOL_CHAIN_PORTS[cc]}`);
      }
      if (!sameAsFront) return ep;
    }
    for (const cc of countries) {
      const code = String(cc || '').toUpperCase();
      if (code && REGISTER_TOOL_CHAIN_PORTS[code]) {
        return endpointFromHostPort('127.0.0.1', REGISTER_TOOL_CHAIN_PORTS[code], `${label}/${code} chain :${REGISTER_TOOL_CHAIN_PORTS[code]}`);
      }
    }
    const fb = fallbackCc.toUpperCase();
    return endpointFromHostPort('127.0.0.1', REGISTER_TOOL_CHAIN_PORTS[fb] || REGISTER_TOOL_CHAIN_PORTS.US, `${label}(${fb} chain)`);
  };

  const exit1 = pickExit(
    [paypalStages.checkout, upiStages.checkout, paypalStages.stripe_init],
    [paypalCountries.checkout, upiCountries.checkout, paypalCountries.stripe_init, 'JP'],
    'JP',
    '出口1(checkout)',
  );

  const exit2 = pickExit(
    [paypalStages.provider, paypalStages.confirm, upiStages.provider, paypalStages.approve],
    [paypalCountries.provider, paypalCountries.confirm, upiCountries.provider, 'US'],
    'US',
    '出口2(provider)',
  );

  const countryExits: Array<{ country: string; endpoint: ProxyEndpoint }> = options.merge
    ? [...(existing.countryExits || [])]
    : [];

  // From explicit stage country + proxy pairs
  const pairSources: Array<{ stages: Record<string, string>; countries: Record<string, string> }> = [
    { stages: paypalStages, countries: paypalCountries },
    { stages: upiStages, countries: upiCountries },
  ];
  for (const source of pairSources) {
    for (const [stage, cc] of Object.entries(source.countries)) {
      const url = source.stages[stage];
      if (!url) continue;
      const ep = endpointFromUrl(url, `${cc}/${stage}`);
      if (ep) pushUniqueCountry(countryExits, cc, ep);
    }
  }

  // Known local chain listeners (GPT-Register-Tool start_chain_proxy_*.py)
  for (const [cc, port] of Object.entries(REGISTER_TOOL_CHAIN_PORTS)) {
    pushUniqueCountry(
      countryExits,
      cc,
      endpointFromHostPort('127.0.0.1', port, `${cc} chain :${port}`),
    );
  }

  // proxy.pool extras as generic exits if they look like country sid
  if (Array.isArray(proxyBlock.pool)) {
    for (const item of proxyBlock.pool) {
      if (typeof item !== 'string') continue;
      const ep = endpointFromUrl(item, 'pool');
      if (!ep) continue;
      const m = String(ep.username || item).match(/region-([A-Za-z]{2})/i);
      if (m) pushUniqueCountry(countryExits, m[1].toUpperCase(), ep);
    }
  }

  const methodPools: ProxyMethodStagePool[] = options.merge ? [...(existing.methodPools || [])] : [];
  const enablePools = options.enableMethodPools !== false;
  if (enablePools) {
    const paypalPool = buildMethodPool('paypal', paypalStages);
    const upiPool = buildMethodPool('upi', upiStages);
    const hostedPool = buildMethodPool('hosted', {
      checkout: paypalStages.checkout || '',
      promotion: paypalStages.promotion || '',
      provider: paypalStages.provider || paypalStages.confirm || '',
    });
    for (const pool of [hostedPool, paypalPool, upiPool]) {
      if (!pool) continue;
      const idx = methodPools.findIndex((item) => item.method === pool.method);
      if (idx >= 0) methodPools[idx] = pool;
      else methodPools.push(pool);
    }
  }

  // Health defaults from paypal.proxy_health when present
  const health = isRecord(paypal.proxy_health) ? paypal.proxy_health : {};
  const seedFailSkipAfter = Number(health.fail_skip_after || existing.seedFailSkipAfter || 2) || 2;
  const seedFailCooldownSec = Number(health.fail_cooldown_seconds || existing.seedFailCooldownSec || 180) || 180;
  const stagePool = (...values: unknown[]) => Array.from(new Set(values
    .map((value) => String(value || '').trim())
    .filter(Boolean))).join('\n');
  const automationRouting = {
    ...existing.automationRouting,
    enabled: true,
    stickyWithinStage: true,
    verifyExitOnSwitch: true,
    activeBusinessStage: '' as const,
    auth: {
      ...existing.automationRouting.auth,
      enabled: true,
      fallbackStage: 'exit1' as const,
      poolRaw: stagePool(paypalStages.checkout, upiStages.checkout) || existing.automationRouting.auth.poolRaw,
      poolIndex: 0,
      rotateOnEnter: true,
    },
    checkout: {
      ...existing.automationRouting.checkout,
      enabled: true,
      fallbackStage: 'exit1' as const,
      poolRaw: stagePool(paypalStages.promotion, upiStages.promotion, upiStages.checkout, paypalStages.checkout)
        || existing.automationRouting.checkout.poolRaw,
      poolIndex: 0,
      rotateOnEnter: true,
    },
    billing: {
      ...existing.automationRouting.billing,
      enabled: true,
      fallbackStage: 'exit2' as const,
      poolRaw: stagePool(paypalStages.provider, paypalStages.confirm, upiStages.provider)
        || existing.automationRouting.billing.poolRaw,
      poolIndex: 0,
      rotateOnEnter: true,
    },
    evidence: {},
  };

  const settings = normalizeProxySettings({
    ...existing,
    enabled: true,
    chainMode: 'direct-exit',
    front: normalizeEndpoint(front, existing.front),
    exit1: normalizeEndpoint(exit1, existing.exit1),
    exit2: normalizeEndpoint(exit2, existing.exit2),
    countryExits,
    methodPools,
    preferMethodPools: enablePools && methodPools.length > 0,
    automationRouting,
    seedHealthEnabled: health.enabled === undefined ? true : Boolean(health.enabled),
    seedFailSkipAfter,
    seedFailCooldownSec,
    seedRemoveAfterFails: existing.seedRemoveAfterFails || 3,
    activeStage: 'front',
    updatedAt: Date.now(),
  });

  const methods = methodPools.map((item) => item.method);
  const countries = countryExits.map((item) => item.country);
  return {
    ok: true,
    message: `已接入 Register-Tool 配置：前置 ${formatSummary(settings.front)} · 出口1 ${formatSummary(settings.exit1)} · 出口2 ${formatSummary(settings.exit2)} · 国家 ${countries.length} · 方式池 ${methods.length}`,
    settings,
    summary: {
      front: formatSummary(settings.front),
      exit1: formatSummary(settings.exit1),
      exit2: formatSummary(settings.exit2),
      countries,
      methods,
      source: 'config.json',
    },
  };
}

/**
 * Apply local GPT-Register-Tool runtime defaults without reading files.
 * front=10808, country chain ports TH/IN/JP/US, exit1=JP, exit2=US, UPI method pool.
 */
export function importRegisterToolLocalRuntime(
  options: RegisterToolImportOptions = {},
): RegisterToolImportResult {
  const synthetic = {
    mailbox_proxy: 'http://127.0.0.1:10808',
    proxy: { default: 'http://127.0.0.1:10808', pool: ['http://127.0.0.1:10808'] },
    paypal: {
      stage_proxies: {
        checkout: 'http://127.0.0.1:18092',
        promotion: '',
        provider: 'http://127.0.0.1:18093',
        stripe_init: 'http://127.0.0.1:10808',
        payment_method: 'http://127.0.0.1:18093',
        confirm: 'http://127.0.0.1:18093',
        approve: 'http://127.0.0.1:18093',
      },
      stage_proxy_countries: {
        checkout: 'JP',
        provider: 'US',
        stripe_init: 'US',
        payment_method: 'US',
        confirm: 'US',
        approve: 'US',
      },
      proxy_health: {
        enabled: true,
        fail_skip_after: 2,
        fail_cooldown_seconds: 180,
      },
    },
    upi: {
      stage_proxies: {
        checkout: 'http://127.0.0.1:18091',
        promotion: 'http://127.0.0.1:18092',
        provider: 'http://127.0.0.1:18091',
        stripe_init: 'http://127.0.0.1:18091',
        approve: 'http://127.0.0.1:18091',
        confirm: 'http://127.0.0.1:18091',
      },
      stage_proxy_countries: {
        checkout: 'IN',
        promotion: 'JP',
        provider: 'IN',
        stripe_init: 'IN',
        approve: 'IN',
        confirm: 'IN',
      },
    },
  };
  const result = importRegisterToolConfig(synthetic, options);
  if (result.ok) {
    const allLocalExits = Array.from(new Set(Object.values(REGISTER_TOOL_CHAIN_PORTS)))
      .map((port) => `http://127.0.0.1:${port}`)
      .join('\n');
    result.settings = normalizeProxySettings({
      ...result.settings,
      automationRouting: {
        ...result.settings.automationRouting,
        requireDistinctExits: true,
        maxSwitchAttempts: 4,
        auth: { ...result.settings.automationRouting.auth, poolRaw: allLocalExits, poolIndex: 2 },
        checkout: { ...result.settings.automationRouting.checkout, poolRaw: allLocalExits, poolIndex: 0 },
        billing: { ...result.settings.automationRouting.billing, poolRaw: allLocalExits, poolIndex: 3 },
        evidence: {},
      },
    });
  }
  return {
    ...result,
    message: result.ok
      ? result.message.replace('Register-Tool 配置', 'Register-Tool 本机链式默认环境')
      : result.message,
    summary: { ...result.summary, source: 'local-runtime-preset' },
  };
}

export function parseRegisterToolConfigText(text: string): unknown {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('配置文本为空');
  return JSON.parse(raw);
}
