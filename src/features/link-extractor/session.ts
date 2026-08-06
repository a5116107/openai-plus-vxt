import type { ChatGptSessionInfo, ChatGptSessionResponse } from './types';

const SESSION_URL = 'https://chatgpt.com/api/auth/session';

export async function fetchChatGptSession(): Promise<ChatGptSessionResponse> {
  let response: Response;
  try {
    response = await fetch(SESSION_URL, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
  } catch (error) {
    return fail(`无法请求 ChatGPT session：${String(error)}`);
  }

  const text = await response.text();
  const data = parseJson(text);
  if (!response.ok) {
    return fail(`ChatGPT session HTTP ${response.status}：${shorten(text || response.statusText)}`);
  }

  if (!isRecord(data)) {
    return fail('ChatGPT session 响应不是 JSON 对象');
  }

  const session = extractSessionInfo(data);
  session.identitySnapshot = await captureIdentitySnapshot();
  if (!session.accessToken) {
    return {
      ok: false,
      message: session.email ? '已读取账号信息，但 session 内没有 accessToken' : '未读取到登录 session',
      session,
    };
  }

  return {
    ok: true,
    message: '已读取 ChatGPT session',
    session,
  };
}

async function captureIdentitySnapshot(): Promise<NonNullable<ChatGptSessionInfo['identitySnapshot']>> {
  const cookies = await listIdentityCookies();
  const deviceCookie = cookies.find((cookie) => /^(oai-did|oai-device-id)$/i.test(cookie.name));
  return {
    deviceId: deviceCookie?.value || createIdentityId(),
    sessionId: createIdentityId(),
    cookies,
    capturedAt: Date.now(),
  };
}

async function listIdentityCookies(): Promise<NonNullable<ChatGptSessionInfo['identitySnapshot']>['cookies']> {
  const output = new Map<string, NonNullable<ChatGptSessionInfo['identitySnapshot']>['cookies'][number]>();
  for (const domain of ['chatgpt.com', 'openai.com']) {
    let batch: Browser.cookies.Cookie[] = [];
    try { batch = await browser.cookies.getAll({ domain }); } catch { batch = []; }
    for (const cookie of batch) {
      const key = `${cookie.storeId}|${cookie.domain}|${cookie.path}|${cookie.name}`;
      output.set(key, {
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path || '/',
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: String(cookie.sameSite || '') || undefined,
        expirationDate: cookie.expirationDate,
        storeId: cookie.storeId,
        firstPartyDomain: String((cookie as Browser.cookies.Cookie & { firstPartyDomain?: string }).firstPartyDomain || ''),
      });
    }
  }
  return [...output.values()];
}

function createIdentityId(): string {
  try { return crypto.randomUUID(); } catch { return `${Date.now()}-${Math.random().toString(36).slice(2, 14)}`; }
}

function extractSessionInfo(data: Record<string, unknown>): ChatGptSessionInfo {
  const user = isRecord(data.user) ? data.user : {};
  const account = isRecord(data.account) ? data.account : {};
  return {
    email: stringValue(user.email),
    planType: stringValue(account.planType) || stringValue(account.plan_type),
    accessToken: stringValue(data.accessToken),
    sessionToken: stringValue(data.sessionToken) || stringValue(data.session_token),
    accountId: stringValue(account.id) || stringValue(account.accountId) || stringValue(account.account_id),
    userId: stringValue(user.id) || stringValue(user.userId) || stringValue(user.user_id),
    expiresAt: stringValue(data.expires) || stringValue(data.expiresAt) || stringValue(data.expires_at),
    fetchedAt: Date.now(),
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function fail(message: string): ChatGptSessionResponse {
  return { ok: false, message };
}

function shorten(text: string, limit = 400): string {
  return String(text || '').replace(/\s+/g, ' ').slice(0, limit);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object');
}
