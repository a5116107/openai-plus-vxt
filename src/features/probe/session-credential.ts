export type SessionAccessTokenFailureReason =
  | 'invalid_response'
  | 'session_refresh_error'
  | 'access_token_missing'
  | 'access_token_malformed'
  | 'access_token_expired';

export interface SessionAccessTokenResult {
  ok: boolean;
  accessToken: string;
  sessionToken: string;
  refreshToken: string;
  userEmail: string;
  expiresAt: number;
  reason?: SessionAccessTokenFailureReason;
  message: string;
}

export function parseSessionAccessTokenResponse(value: unknown, nowMs = Date.now()): SessionAccessTokenResult {
  if (!isRecord(value)) return fail('invalid_response', 'Session 响应不是对象');

  const responseError = stringValue(value.error);
  if (responseError) {
    return fail('session_refresh_error', `Session 刷新返回 ${responseError}`);
  }

  const accessToken = stringValue(value.accessToken) || stringValue(value.access_token);
  if (!accessToken) return fail('access_token_missing', 'Session 响应缺少 accessToken');

  const expiresAt = jwtExpiryMs(accessToken);
  if (!expiresAt) return fail('access_token_malformed', 'Session accessToken 不是可解析 JWT');
  if (expiresAt <= nowMs + 30_000) {
    return fail('access_token_expired', 'Session 返回的 accessToken 已过期或即将过期', expiresAt);
  }

  const user = isRecord(value.user) ? value.user : {};
  return {
    ok: true,
    accessToken,
    sessionToken: stringValue(value.sessionToken) || stringValue(value.session_token),
    refreshToken: stringValue(value.refreshToken) || stringValue(value.refresh_token),
    userEmail: stringValue(user.email),
    expiresAt,
    message: 'Session accessToken 有效',
  };
}

function jwtExpiryMs(token: string): number {
  try {
    const segment = token.split('.')[1];
    if (!segment) return 0;
    const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const payload = JSON.parse(atob(padded)) as { exp?: unknown };
    const seconds = Number(payload.exp || 0);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
  } catch {
    return 0;
  }
}

function fail(reason: SessionAccessTokenFailureReason, message: string, expiresAt = 0): SessionAccessTokenResult {
  return {
    ok: false,
    accessToken: '',
    sessionToken: '',
    refreshToken: '',
    userEmail: '',
    expiresAt,
    reason,
    message,
  };
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
