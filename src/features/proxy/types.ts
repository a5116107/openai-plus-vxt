export type ProxyScheme = 'http' | 'https' | 'socks4' | 'socks5';
export type ProxyStage = 'none' | 'front' | 'exit1' | 'exit2';
export type ProxyChainMode = 'direct-exit' | 'front-gateway';
export type AutomationProxyStage = 'auth' | 'checkout' | 'billing';
export type AutomationProxyFallbackStage = Exclude<ProxyStage, 'none'>;

export interface ProxyEndpoint {
  enabled: boolean;
  scheme: ProxyScheme;
  host: string;
  port: number;
  username: string;
  password: string;
  label: string;
}

export interface ProxyCountryExit {
  country: string;
  endpoint: ProxyEndpoint;
}

export type ProxyMethodId = 'hosted' | 'paypal' | 'momo' | 'gopay' | 'ideal' | 'upi' | 'pix' | 'blik' | 'twint' | 'kakao';

export interface ProxyMethodStagePool {
  method: ProxyMethodId;
  /** Multi-line raw proxy list (host:port:user:pass / URL). */
  bootstrapRaw: string;
  promotionRaw: string;
  providerRaw: string;
  bootstrapIndex: number;
  promotionIndex: number;
  providerIndex: number;
}

export interface AutomationProxyStageRoute {
  enabled: boolean;
  /** Used when poolRaw is empty or every seed is unavailable. */
  fallbackStage: AutomationProxyFallbackStage;
  /** One proxy per line. {SESSION} is replaced whenever a stage is entered. */
  poolRaw: string;
  poolIndex: number;
  rotateOnEnter: boolean;
}

export interface AutomationProxyExitEvidence {
  stage: AutomationProxyStage;
  cycleId: string;
  source: string;
  endpointSummary: string;
  ip: string;
  country: string;
  colo: string;
  asn?: string;
  asOrganization?: string;
  latencyMs?: number;
  verified: boolean;
  distinct: boolean;
  excludedIp?: boolean;
  repeatedIpRejected?: number;
  checkedAt: number;
  message: string;
}

export interface AutomationProxyRouting {
  enabled: boolean;
  stickyWithinStage: boolean;
  verifyExitOnSwitch: boolean;
  /** Trace endpoint used to verify the active browser exit. */
  verificationTraceUrl: string;
  /** Optional metadata endpoint used to enrich IP/country/ASN evidence. */
  verificationMetaUrl: string;
  requireDistinctExits: boolean;
  maxSwitchAttempts: number;
  activeBusinessStage: AutomationProxyStage | '';
  auth: AutomationProxyStageRoute;
  checkout: AutomationProxyStageRoute;
  billing: AutomationProxyStageRoute;
  evidence: Partial<Record<AutomationProxyStage, AutomationProxyExitEvidence>>;
}


export interface ProxySettings {
  /** Master switch for extension-managed browser proxy. */
  enabled: boolean;
  /** When exit1/exit2 is applied: direct-exit uses exit host; front-gateway points browser to front. */
  chainMode: ProxyChainMode;
  front: ProxyEndpoint;
  exit1: ProxyEndpoint;
  exit2: ProxyEndpoint;
  /** Optional per-country exits for eligibility probing. */
  countryExits: ProxyCountryExit[];
  /** Optional per payment-method three-stage proxy pools (UPL P1). */
  methodPools: ProxyMethodStagePool[];
  /** Prefer method pools over countryExits when method is set. */
  preferMethodPools: boolean;
  /** Auth -> Checkout/eligibility -> Billing routing for normal automation. */
  automationRouting: AutomationProxyRouting;
  seedHealthEnabled: boolean;
  seedFailCooldownSec: number;
  seedRemoveAfterFails: number;
  seedFailSkipAfter: number;
  seedHealth: ProxySeedHealthRecord[];
  activeStage: ProxyStage;
  updatedAt: number;
}

export interface ProxyApplyRequest {
  type: 'opx:proxy-apply';
  stage: ProxyStage;
}

export interface ProxyAutomationStageRequest {
  type: 'opx:proxy-automation-stage';
  stage: AutomationProxyStage;
  cycleId: string;
  forceRotate?: boolean;
  excludeIps?: string[];
  requireDifferentIp?: boolean;
  reason?: string;
}

export interface ProxyClearRequest {
  type: 'opx:proxy-clear';
}

export interface ProxyStatusRequest {
  type: 'opx:proxy-status';
}

export interface ProxySaveRequest {
  type: 'opx:proxy-save';
  settings: Partial<ProxySettings>;
  /** Optionally apply a stage after save. */
  applyStage?: ProxyStage;
}

export interface ProxyRuntimeStatus {
  ok: boolean;
  code?: string;
  message: string;
  settings: ProxySettings;
  applied: {
    stage: ProxyStage;
    mode: 'direct' | 'fixed_servers' | 'system' | 'cleared';
    endpoint: ProxyEndpoint | null;
    viaFront: boolean;
    summary: string;
    businessStage?: AutomationProxyStage | '';
    evidence?: AutomationProxyExitEvidence;
  };
  browserProxyMode?: string;
}


export interface ProxySeedHealthRecord {
  /** Stable key: method|stage|host:port:user */
  key: string;
  method: string;
  stage: 'bootstrap' | 'promotion' | 'provider' | 'seed';
  endpointSummary: string;
  success: number;
  fail: number;
  lastSuccessAt: number;
  lastFailAt: number;
  lastReason: string;
  /** Soft-skip until this timestamp (ms). */
  cooldownUntil: number;
  removed: boolean;
  updatedAt: number;
}

export interface ProxySeedHealthSettings {
  enabled: boolean;
  failCooldownSec: number;
  removeAfterFails: number;
  /** Failures required before cooldown skip applies. */
  failSkipAfter: number;
}
export const DEFAULT_FRONT_PROXY: ProxyEndpoint = {
  enabled: true,
  scheme: 'http',
  host: '127.0.0.1',
  port: 7890,
  username: '',
  password: '',
  label: '前置代理',
};

export const DEFAULT_EXIT1_PROXY: ProxyEndpoint = {
  enabled: true,
  scheme: 'http',
  host: '',
  port: 0,
  username: '',
  password: '',
  label: '出口1（可任意国家）',
};

export const DEFAULT_EXIT2_PROXY: ProxyEndpoint = {
  enabled: true,
  scheme: 'http',
  host: '',
  port: 0,
  username: '',
  password: '',
  label: '出口2（可任意国家）',
};

export const DEFAULT_PROXY_TRACE_URL = 'https://www.cloudflare.com/cdn-cgi/trace';
export const DEFAULT_PROXY_META_URL = 'https://speed.cloudflare.com/meta';

export const DEFAULT_AUTOMATION_PROXY_ROUTING: AutomationProxyRouting = {
  enabled: true,
  stickyWithinStage: true,
  verifyExitOnSwitch: true,
  verificationTraceUrl: DEFAULT_PROXY_TRACE_URL,
  verificationMetaUrl: DEFAULT_PROXY_META_URL,
  requireDistinctExits: false,
  maxSwitchAttempts: 3,
  activeBusinessStage: '',
  auth: {
    enabled: true,
    fallbackStage: 'exit1',
    poolRaw: '',
    poolIndex: 0,
    rotateOnEnter: true,
  },
  checkout: {
    enabled: true,
    fallbackStage: 'exit1',
    poolRaw: '',
    poolIndex: 0,
    rotateOnEnter: true,
  },
  billing: {
    enabled: true,
    fallbackStage: 'exit2',
    poolRaw: '',
    poolIndex: 0,
    rotateOnEnter: true,
  },
  evidence: {},
};

export const DEFAULT_PROXY_SETTINGS: ProxySettings = {
  enabled: false,
  chainMode: 'direct-exit',
  front: { ...DEFAULT_FRONT_PROXY },
  exit1: { ...DEFAULT_EXIT1_PROXY },
  exit2: { ...DEFAULT_EXIT2_PROXY },
  countryExits: [],
  methodPools: [],
  preferMethodPools: false,
  automationRouting: {
    ...DEFAULT_AUTOMATION_PROXY_ROUTING,
    auth: { ...DEFAULT_AUTOMATION_PROXY_ROUTING.auth },
    checkout: { ...DEFAULT_AUTOMATION_PROXY_ROUTING.checkout },
    billing: { ...DEFAULT_AUTOMATION_PROXY_ROUTING.billing },
    evidence: {},
  },
  seedHealthEnabled: true,
  seedFailCooldownSec: 180,
  seedRemoveAfterFails: 3,
  seedFailSkipAfter: 1,
  seedHealth: [],
  activeStage: 'none',
  updatedAt: 0,
};
