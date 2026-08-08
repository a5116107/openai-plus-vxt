const AUTH_FLOW_URL_PATTERNS = [
  'https://auth.openai.com/api/accounts/email-otp/send*',
  'https://auth.openai.com/api/accounts/email-otp/validate*',
  'https://auth.openai.com/api/accounts/create_account*',
];
const AUTH_NETWORK_OBSERVATION_TTL_MS = 5 * 60_000;

export type AuthNetworkClassification = 'ok' | 'cloudflare-challenge' | 'http-error';

export interface AuthNetworkObservation {
  tabId: number;
  requestId: string;
  url: string;
  method: string;
  status: number;
  contentType: string;
  server: string;
  cfRay: string;
  classification: AuthNetworkClassification;
  cloudflareChallenge: boolean;
  observedAt: number;
}

export interface AuthNetworkResultRequest {
  type: 'opx:get-auth-network-result';
  tabId: number;
  since?: number;
}

export interface AuthNetworkResultResponse {
  ok: boolean;
  observation: AuthNetworkObservation | null;
}

interface AuthResponseDetails {
  tabId: number;
  requestId: string;
  url: string;
  method: string;
  statusCode: number;
  responseHeaders?: Array<{ name?: string; value?: string }>;
}

const observations = new Map<number, AuthNetworkObservation>();
let observerInstalled = false;

export function classifyAuthOtpValidateResponse(input: {
  status: number;
  contentType?: string;
  server?: string;
  cfRay?: string;
}): Pick<AuthNetworkObservation, 'classification' | 'cloudflareChallenge'> {
  const contentType = String(input.contentType || '').toLowerCase();
  const server = String(input.server || '').toLowerCase();
  const hasCloudflareHeaders = server.includes('cloudflare') || Boolean(String(input.cfRay || '').trim());
  const cloudflareChallenge = input.status === 403 && (contentType.includes('text/html') || hasCloudflareHeaders);
  return {
    classification: cloudflareChallenge ? 'cloudflare-challenge' : input.status >= 400 ? 'http-error' : 'ok',
    cloudflareChallenge,
  };
}

export function installAuthNetworkObserver(): void {
  if (observerInstalled) return;
  const webRequest = (browser as typeof browser & {
    webRequest?: {
      onCompleted?: {
        addListener(
          callback: (details: AuthResponseDetails) => void,
          filter: { urls: string[] },
          extraInfoSpec?: string[],
        ): void;
      };
    };
  }).webRequest;
  if (!webRequest?.onCompleted?.addListener) return;

  const listener = (details: AuthResponseDetails) => {
    if (details.tabId < 0) return;
    const contentType = responseHeader(details.responseHeaders, 'content-type');
    const server = responseHeader(details.responseHeaders, 'server');
    const cfRay = responseHeader(details.responseHeaders, 'cf-ray');
    const classified = classifyAuthOtpValidateResponse({
      status: details.statusCode,
      contentType,
      server,
      cfRay,
    });
    observations.set(details.tabId, {
      tabId: details.tabId,
      requestId: details.requestId,
      url: details.url,
      method: details.method,
      status: details.statusCode,
      contentType,
      server,
      cfRay,
      ...classified,
      observedAt: Date.now(),
    });
    pruneExpiredObservations();
  };

  try {
    webRequest.onCompleted.addListener(listener, { urls: AUTH_FLOW_URL_PATTERNS }, ['responseHeaders']);
  } catch {
    webRequest.onCompleted.addListener(listener, { urls: AUTH_FLOW_URL_PATTERNS });
  }
  observerInstalled = true;
}

export function getAuthNetworkResult(request: AuthNetworkResultRequest): AuthNetworkResultResponse {
  pruneExpiredObservations();
  const observation = observations.get(request.tabId) || null;
  const since = Math.max(0, Number(request.since || 0));
  return {
    ok: true,
    observation: observation && observation.observedAt >= since ? observation : null,
  };
}

export function isAuthNetworkResultRequest(message: unknown): message is AuthNetworkResultRequest {
  if (!message || typeof message !== 'object') return false;
  const request = message as AuthNetworkResultRequest;
  return request.type === 'opx:get-auth-network-result' && Number.isInteger(request.tabId) && request.tabId >= 0;
}

function responseHeader(headers: AuthResponseDetails['responseHeaders'], name: string): string {
  const match = headers?.find((header) => String(header.name || '').toLowerCase() === name);
  return String(match?.value || '').trim();
}

function pruneExpiredObservations(): void {
  const cutoff = Date.now() - AUTH_NETWORK_OBSERVATION_TTL_MS;
  for (const [tabId, observation] of observations) {
    if (observation.observedAt < cutoff) observations.delete(tabId);
  }
}
