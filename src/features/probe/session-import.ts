import type { CheckoutIdentitySnapshot } from '../link-extractor/types';

export interface StructuredProbeCredential {
  email: string;
  tokenRaw: string;
  sessionToken?: string;
  chatgptAccountId?: string;
  lineNumber?: number;
}

export function parseStructuredProbeCredentials(raw: string): StructuredProbeCredential[] {
  const text = String(raw || '').trim();
  if (!text.startsWith('{') && !text.startsWith('[')) return [];
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return [];
  }

  const output: StructuredProbeCredential[] = [];
  const seen = new Set<string>();
  visit(root);
  return output;

  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isRecord(value)) return;

    const accessToken = stringValue(value.access_token)
      || stringValue(value.accessToken)
      || jwtValue(value.token);
    const sessionToken = stringValue(value.session_token) || stringValue(value.sessionToken);
    if (accessToken || sessionToken) {
      const email = stringValue(value.email) || emailFromToken(accessToken);
      const chatgptAccountId = stringValue(value.chatgpt_account_id)
        || stringValue(value.account_id)
        || stringValue(value.accountId);
      const tokenRaw = accessToken || JSON.stringify({ sessionToken });
      const key = `${email.toLowerCase()}|${accessToken.slice(0, 32)}|${sessionToken.slice(0, 32)}`;
      if (!seen.has(key)) {
        seen.add(key);
        output.push({ email, tokenRaw, sessionToken, chatgptAccountId });
      }
    }
    Object.values(value).forEach(visit);
  }
}

export function createSessionIdentitySnapshot(
  sessionToken: string,
  fallback?: CheckoutIdentitySnapshot,
): CheckoutIdentitySnapshot {
  const cookies = (fallback?.cookies || []).filter((cookie) => cookie.name !== '__Secure-next-auth.session-token');
  cookies.unshift({
    name: '__Secure-next-auth.session-token',
    value: sessionToken,
    domain: '.chatgpt.com',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
    firstPartyDomain: '',
  });
  return {
    deviceId: fallback?.deviceId || createIdentityId(),
    sessionId: fallback?.sessionId || createIdentityId(),
    cookies,
    capturedAt: Date.now(),
  };
}

function emailFromToken(token: string): string {
  try {
    const segment = token.split('.')[1];
    if (!segment) return '';
    const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const payload = JSON.parse(atob(padded)) as Record<string, unknown>;
    const profile = isRecord(payload['https://api.openai.com/profile'])
      ? payload['https://api.openai.com/profile'] as Record<string, unknown>
      : {};
    return stringValue(profile.email)
      || stringValue(payload.email)
      || stringValue(payload.preferred_username);
  } catch {
    return '';
  }
}

function jwtValue(value: unknown): string {
  const text = stringValue(value);
  return text.split('.').length === 3 ? text : '';
}

function createIdentityId(): string {
  try { return crypto.randomUUID(); } catch { return `${Date.now()}-${Math.random().toString(36).slice(2, 14)}`; }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
