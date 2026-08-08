/**
 * mail.acica.top external mailbox provider.
 * list accounts for registration email pool + poll OTP by email.
 */
export const DEFAULT_ACICA_BASE_URL = 'https://mail.acica.top';
export const DEFAULT_ACICA_API_KEY = '0d807524f93491e4f7505237f1887737';
export const DEFAULT_ACICA_WEB_PASSWORD = 'liuyujian';

export interface AcicaMailboxSettings {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  webPassword: string;
  folder: string;
  otpWaitSeconds: number;
  otpPollIntervalSec: number;
  autoSyncOnEmpty: boolean;
  preferAcicaOtp: boolean;
}

export const DEFAULT_ACICA_MAILBOX_SETTINGS: AcicaMailboxSettings = {
  enabled: true,
  baseUrl: DEFAULT_ACICA_BASE_URL,
  apiKey: DEFAULT_ACICA_API_KEY,
  webPassword: DEFAULT_ACICA_WEB_PASSWORD,
  folder: 'all',
  otpWaitSeconds: 90,
  otpPollIntervalSec: 3,
  autoSyncOnEmpty: true,
  preferAcicaOtp: true,
};

export interface AcicaAccountRow {
  email: string;
  status: string;
  provider: string;
  id: string | number;
  raw: Record<string, unknown>;
}

export interface AcicaSyncResult {
  ok: boolean;
  message: string;
  emails: string[];
  count: number;
  lines: string[];
}

export interface AcicaOtpResult {
  ok: boolean;
  code?: string;
  message: string;
  fatal?: boolean;
  failureKind?: AcicaOtpFailureKind;
}

export type AcicaOtpFailureKind =
  | 'mail_not_arrived'
  | 'otp_not_found'
  | 'provider_error'
  | 'configuration_error'
  | 'stopped';

export interface AcicaOtpParseDiagnostic {
  code: string;
  candidateCount: number;
  normalizedLength: number;
  reason: 'matched' | 'empty_body' | 'no_six_digit_candidate' | 'no_qualified_candidate';
}

export interface MailboxUrlOtpResult extends AcicaOtpResult {
  messageCount?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function normalizeAcicaMailboxSettings(value: unknown): AcicaMailboxSettings {
  const source = isRecord(value) ? value : {};
  const baseUrl = String(source.baseUrl || DEFAULT_ACICA_BASE_URL).trim().replace(/\/+$/, '') || DEFAULT_ACICA_BASE_URL;
  const apiKey = String(source.apiKey || DEFAULT_ACICA_API_KEY).trim();
  return {
    enabled: source.enabled === undefined ? true : Boolean(source.enabled),
    baseUrl,
    apiKey,
    webPassword: String(source.webPassword || DEFAULT_ACICA_WEB_PASSWORD).trim(),
    folder: String(source.folder || 'all').trim() || 'all',
    otpWaitSeconds: Math.max(5, Math.min(180, Number(source.otpWaitSeconds || 90) || 90)),
    otpPollIntervalSec: Math.max(1, Math.min(15, Number(source.otpPollIntervalSec || 3) || 3)),
    autoSyncOnEmpty: source.autoSyncOnEmpty === undefined ? true : Boolean(source.autoSyncOnEmpty),
    preferAcicaOtp: source.preferAcicaOtp === undefined ? true : Boolean(source.preferAcicaOtp),
  };
}

function buildUrl(baseUrl: string, path: string, params: Record<string, string | number | undefined>): string {
  const url = new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function acicaGet(
  settings: AcicaMailboxSettings,
  path: string,
  params: Record<string, string | number | undefined> = {},
  timeoutMs = 30_000,
): Promise<{ status: number; body: unknown; rawText: string }> {
  if (!settings.apiKey) throw new Error('Acica API Key 为空');
  const url = buildUrl(settings.baseUrl, path, { ...params, api_key: settings.apiKey });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-API-Key': settings.apiKey,
        'User-Agent': 'openai-plus-vxt-acica/0.0.24',
      },
      cache: 'no-store',
      signal: controller.signal,
    });
    const rawText = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(rawText);
    } catch {
      body = { raw: rawText.slice(0, 300), success: false };
    }
    return { status: response.status, body, rawText };
  } finally {
    clearTimeout(timer);
  }
}

export async function listAcicaAccounts(settings: AcicaMailboxSettings): Promise<AcicaAccountRow[]> {
  const { status, body } = await acicaGet(settings, '/api/external/accounts', {}, 30_000);
  if (status !== 200 || !isRecord(body) || body.success === false) {
    throw new Error(`Acica 拉账号失败：HTTP ${status} ${JSON.stringify(body).slice(0, 200)}`);
  }
  const rows = Array.isArray(body.accounts) ? body.accounts : [];
  const out: AcicaAccountRow[] = [];
  const seen = new Set<string>();
  for (const item of rows) {
    if (!isRecord(item)) continue;
    const email = String(item.email || '').trim().toLowerCase();
    if (!email || !email.includes('@') || seen.has(email)) continue;
    const statusText = String(item.status || 'active').toLowerCase();
    if (statusText.includes('disable') || statusText.includes('ban') || statusText.includes('delete')) continue;
    seen.add(email);
    out.push({
      email,
      status: statusText,
      provider: String(item.provider || 'outlook'),
      id: (item.id as string | number) || email,
      raw: item,
    });
  }
  return out;
}

export async function syncAcicaEmailPool(settings: AcicaMailboxSettings): Promise<AcicaSyncResult> {
  if (!settings.enabled) {
    return { ok: false, message: 'Acica 邮箱源未启用', emails: [], count: 0, lines: [] };
  }
  try {
    const accounts = await listAcicaAccounts(settings);
    const emails = accounts.map((item) => item.email);
    return {
      ok: emails.length > 0,
      message: emails.length > 0 ? `已从 Acica 自动同步 ${emails.length} 个邮箱` : 'Acica 返回空账号池',
      emails,
      count: emails.length,
      lines: emails.slice(),
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      emails: [],
      count: 0,
      lines: [],
    };
  }
}

export async function pollAcicaOtp(
  email: string,
  settings: AcicaMailboxSettings,
  options: { keyword?: string; signal?: AbortSignal; waitSeconds?: number; since?: number } = {},
): Promise<AcicaOtpResult> {
  const target = String(email || '').trim();
  if (!target) return { ok: false, fatal: true, failureKind: 'configuration_error', message: 'Acica OTP 缺少邮箱' };
  if (!settings.enabled || !settings.apiKey) return { ok: false, fatal: true, failureKind: 'configuration_error', message: 'Acica OTP 未配置' };
  if (options.signal?.aborted) return { ok: false, fatal: true, failureKind: 'stopped', message: '已停止邮箱验证码接收' };

  const waitSeconds = Math.min(10, options.waitSeconds || settings.otpWaitSeconds);
  const timeoutMs = Math.max(20_000, (waitSeconds + 25) * 1000);
  try {
    const { status, body } = await acicaGet(
      settings,
      '/api/external/otp',
      {
        email: target,
        folder: settings.folder || 'all',
        wait_seconds: waitSeconds,
        poll_interval: settings.otpPollIntervalSec,
        top: 10,
        keyword: options.keyword || '',
        subject_contains: options.keyword || '',
      },
      timeoutMs,
    );
    if (options.signal?.aborted) return { ok: false, fatal: true, failureKind: 'stopped', message: '已停止邮箱验证码接收' };
    if (status === 504) {
      const fallback = await pollAcicaWebOtp(target, settings, options);
      return fallback.ok ? fallback : { ...fallback, ok: false, message: `Acica OTP 等待超时（504）；${fallback.message}` };
    }
    if (!isRecord(body)) {
      const fallback = await pollAcicaWebOtp(target, settings, options);
      return fallback.ok ? fallback : { ...fallback, ok: false, message: `Acica OTP 响应异常 HTTP ${status}；${fallback.message}` };
    }
    const code = String(body.code || '').trim();
    const mail = isRecord(body.email) ? body.email : {};
    const receivedAt = Date.parse(String(mail.date || '')) || 0;
    const sourceText = `${String(mail.from || '')} ${String(mail.subject || '')}`;
    if (code && !/^[A-Za-z0-9]{6}$/.test(code)) {
      return { ok: false, failureKind: 'otp_not_found', message: `Acica 忽略非 6 位 ChatGPT 验证码：${code}` };
    }
    if (code && options.since && receivedAt && receivedAt < options.since - 120_000) {
      return { ok: false, failureKind: 'mail_not_arrived', message: `Acica 忽略旧验证码邮件：${String(mail.date || '')}` };
    }
    if (code && !/(chatgpt|openai\.com)/i.test(sourceText)) {
      const fallback = await pollAcicaWebOtp(target, settings, options);
      return fallback.ok ? fallback : { ...fallback, ok: false, message: `Acica 忽略非 ChatGPT 邮件：${sourceText.slice(0, 120)}；${fallback.message}` };
    }
    if (code) return { ok: true, code, message: `收到 Acica ChatGPT 验证码：${code}` };
    const fallback = await pollAcicaWebOtp(target, settings, options);
    if (fallback.ok) return fallback;
    if (status !== 200 || body.success === false) {
      return {
        ...fallback,
        ok: false,
        message: `Acica 暂无验证码：HTTP ${status} ${String(body.message || body.error || '').slice(0, 120)}；${fallback.message}`,
      };
    }
    return { ...fallback, ok: false, message: `Acica 暂未返回验证码；${fallback.message}` };
  } catch (error) {
    if (options.signal?.aborted) return { ok: false, fatal: true, failureKind: 'stopped', message: '已停止邮箱验证码接收' };
    const text = error instanceof Error ? error.message : String(error);
    const fatal = /Failed to fetch|NetworkError|API Key|HTTP 401|HTTP 403/i.test(text);
    return { ok: false, fatal, failureKind: 'provider_error', message: `Acica OTP 请求失败：${text}` };
  }
}

async function pollAcicaWebOtp(
  email: string,
  settings: AcicaMailboxSettings,
  options: { signal?: AbortSignal; since?: number },
): Promise<AcicaOtpResult> {
  if (!settings.webPassword) {
    return { ok: false, failureKind: 'configuration_error', message: 'Acica Web 取件密码未配置' };
  }
  const listPath = `/api/emails/${encodeURIComponent(email)}`;
  const listParams = { method: 'imap_new', folder: settings.folder || 'all', skip: 0, top: 20 };
  let listed = await acicaWebGet(settings, listPath, listParams, options.signal);
  if (listed.status === 401) {
    const login = await acicaWebLogin(settings, options.signal);
    if (!login.ok) return login;
    listed = await acicaWebGet(settings, listPath, listParams, options.signal);
  }
  if (listed.status !== 200 || !isRecord(listed.body)) {
    return { ok: false, failureKind: 'provider_error', message: `Acica Web 邮件列表 HTTP ${listed.status}` };
  }

  const rows = (Array.isArray(listed.body.emails) ? listed.body.emails : [])
    .filter(isRecord)
    .filter((item) => {
      const receivedAt = Date.parse(String(item.date || '')) || 0;
      return !options.since || !receivedAt || receivedAt >= options.since - 120_000;
    })
    .sort((a, b) => (Date.parse(String(b.date || '')) || 0) - (Date.parse(String(a.date || '')) || 0))
    .slice(0, 10);

  let detailCount = 0;
  let candidateCount = 0;
  let topicMatchCount = 0;
  const diagnostics: string[] = [];
  for (const item of rows) {
    const messageId = String(item.id || '').trim();
    if (!messageId) continue;
    const maskedId = messageId.replace(/[^a-z0-9]/gi, '').slice(-6) || 'unknown';
    const folder = String(item.folder || 'inbox').trim() || 'inbox';
    const detailPath = `/api/email/${encodeURIComponent(email)}/${encodeURIComponent(messageId)}`;
    const detail = await acicaWebGet(settings, detailPath, { method: 'imap_new', folder }, options.signal);
    if (detail.status !== 200 || !isRecord(detail.body) || !isRecord(detail.body.email)) {
      diagnostics.push(`${maskedId}:detail_http_${detail.status}`);
      continue;
    }
    detailCount += 1;
    const mail = detail.body.email;
    const source = collectMailText(item, mail);
    const topicMatched = /(chatgpt|openai\.com|verification|security code|验证码)/i.test(source);
    if (topicMatched) topicMatchCount += 1;
    const parsed = analyzeChatGptOtp(source);
    candidateCount += parsed.candidateCount;
    diagnostics.push(`${maskedId}:${topicMatched ? 'topic' : 'other'}:${parsed.reason}:${parsed.candidateCount}`);
    if (parsed.code && topicMatched) {
      return { ok: true, code: parsed.code, message: `收到 Acica Web ChatGPT 验证码：${parsed.code}` };
    }
  }
  if (!rows.length) {
    return { ok: false, failureKind: 'mail_not_arrived', message: 'Acica Web 暂未收到本轮新邮件（扫描=0）' };
  }
  return {
    ok: false,
    failureKind: detailCount ? 'otp_not_found' : 'provider_error',
    message: `Acica Web 解析诊断：扫描=${rows.length}，详情=${detailCount}，主题命中=${topicMatchCount}，候选码=${candidateCount}，结果=${detailCount ? '暂未识别 OTP' : '详情读取失败'}，样本=${diagnostics.slice(0, 5).join('|') || 'none'}`,
  };
}

async function acicaWebLogin(settings: AcicaMailboxSettings, signal?: AbortSignal): Promise<AcicaOtpResult> {
  try {
    const response = await fetch(`${settings.baseUrl}/login`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: settings.webPassword }),
      credentials: 'include',
      cache: 'no-store',
      signal,
    });
    const body = await response.json().catch(() => null) as unknown;
    if (response.ok && isRecord(body) && body.success !== false) {
      return { ok: true, message: 'Acica Web 登录成功' };
    }
    return { ok: false, fatal: response.status === 401 || response.status === 403, message: `Acica Web 登录 HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, message: `Acica Web 登录失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

async function acicaWebGet(
  settings: AcicaMailboxSettings,
  path: string,
  params: Record<string, string | number>,
  signal?: AbortSignal,
): Promise<{ status: number; body: unknown }> {
  try {
    const response = await fetch(buildUrl(settings.baseUrl, path, params), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'include',
      cache: 'no-store',
      signal,
    });
    return { status: response.status, body: await response.json().catch(() => null) as unknown };
  } catch {
    return { status: 0, body: null };
  }
}

export function analyzeChatGptOtp(source: string): AcicaOtpParseDiagnostic {
  const text = normalizeOtpSource(source);
  if (!text.trim()) {
    return { code: '', candidateCount: 0, normalizedLength: 0, reason: 'empty_body' };
  }
  const candidates: Array<{ code: string; score: number }> = [];
  const pattern = /(^|[^\d])((?:\d[\s\u00a0\u200b\u200c\u200d\u2060-]*){5}\d)(?!\d)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const code = match[2].replace(/\D/g, '');
    if (code.length !== 6) continue;
    const start = Math.max(0, match.index - 500);
    const end = Math.min(text.length, match.index + match[0].length + 200);
    const context = text.slice(start, end);
    let score = 0;
    if (/(验证码|verification code|temporary code|security code|one[-\s]?time code)/i.test(context)) score += 4;
    if (/(chatgpt|openai\.com|noreply@tm\.openai\.com)/i.test(context)) score += 3;
    if (/\b(code|otp)\b/i.test(context)) score += 1;
    if (/^20\d{4}$/.test(code) && match[2].includes('-')) score -= 5;
    const previous = candidates.find((candidate) => candidate.code === code);
    if (previous) previous.score = Math.max(previous.score, score);
    else candidates.push({ code, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  const code = candidates[0] && candidates[0].score >= 3 ? candidates[0].code : '';
  return {
    code,
    candidateCount: candidates.length,
    normalizedLength: text.length,
    reason: code ? 'matched' : candidates.length ? 'no_qualified_candidate' : 'no_six_digit_candidate',
  };
}

export function extractChatGptOtp(source: string): string {
  return analyzeChatGptOtp(source).code;
}

export async function pollMailboxUrlOtp(
  mailboxUrl: string,
  options: { signal?: AbortSignal } = {},
): Promise<MailboxUrlOtpResult> {
  let url: URL;
  try {
    url = new URL(String(mailboxUrl || '').trim());
  } catch {
    return { ok: false, fatal: true, failureKind: 'configuration_error', message: 'E2E 邮件 URL 格式不正确' };
  }
  if (!['https:', 'http:'].includes(url.protocol)) {
    return { ok: false, fatal: true, failureKind: 'configuration_error', message: 'E2E 邮件 URL 协议不受支持' };
  }
  if (options.signal?.aborted) {
    return { ok: false, fatal: true, failureKind: 'stopped', message: '已停止 E2E 邮件验证码接收' };
  }

  try {
    const response = await fetch(url.href, {
      method: 'GET',
      headers: { Accept: 'application/json, text/html;q=0.9, text/plain;q=0.8' },
      cache: 'no-store',
      credentials: 'omit',
      signal: options.signal,
    });
    const contentType = response.headers.get('content-type') || '';
    const source = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        fatal: response.status === 401 || response.status === 403,
        failureKind: 'provider_error',
        message: `E2E 邮件源响应 HTTP ${response.status}`,
      };
    }
    return extractMailboxUrlOtp(source, contentType);
  } catch (error) {
    if (options.signal?.aborted) {
      return { ok: false, fatal: true, failureKind: 'stopped', message: '已停止 E2E 邮件验证码接收' };
    }
    return {
      ok: false,
      failureKind: 'provider_error',
      message: `E2E 邮件源请求失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function extractMailboxUrlOtp(source: string, contentType = ''): MailboxUrlOtpResult {
  const raw = String(source || '');
  const json = /json/i.test(contentType) ? parseMailboxJson(raw) : null;
  const searchable = json === null ? htmlToMailboxText(raw) : JSON.stringify(json);
  const code = analyzeChatGptOtp(searchable).code;
  const messageCount = mailboxMessageCount(json, raw);
  if (code) {
    return { ok: true, code, message: '收到 E2E 邮件源 ChatGPT 验证码', messageCount };
  }
  if (messageCount === 0 || /暂无邮件|no\s+messages?|empty\s+mailbox/i.test(searchable)) {
    return { ok: false, failureKind: 'mail_not_arrived', message: 'E2E 邮件源暂未收到邮件', messageCount: 0 };
  }
  return {
    ok: false,
    failureKind: messageCount ? 'otp_not_found' : 'mail_not_arrived',
    message: messageCount ? 'E2E 邮件源暂未识别 ChatGPT 验证码' : 'E2E 邮件源暂未收到新验证码',
    messageCount,
  };
}

function parseMailboxJson(source: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    return null;
  }
}

function mailboxMessageCount(value: unknown, html: string): number | undefined {
  if (Array.isArray(value)) return value.length;
  if (isRecord(value)) {
    for (const key of ['messages', 'emails', 'items', 'data']) {
      if (Array.isArray(value[key])) return value[key].length;
    }
    if (typeof value.count === 'number') return value.count;
  }
  const htmlCount = html.match(/(?:本页显示|显示)\s*(\d+)\s*封/);
  return htmlCount ? Number(htmlCount[1]) : undefined;
}

function htmlToMailboxText(source: string): string {
  return source
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, value: string) => String.fromCodePoint(Number(value)))
    .replace(/&#x([0-9a-f]+);/gi, (_, value: string) => String.fromCodePoint(Number.parseInt(value, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeOtpSource(source: string): string {
  return String(source || '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/style\s*=\s*(["'])[\s\S]*?\1/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/td>|<\/tr>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);?/gi, (_, value: string) => safeCodePoint(value, 16))
    .replace(/&#(\d+);?/g, (_, value: string) => safeCodePoint(value, 10))
    .replace(/&nbsp;|&ensp;|&emsp;|&thinsp;|&zwnj;|&zwj;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;|&apos;/gi, ' ')
    .replace(/[０-９]/g, (digit) => String(digit.charCodeAt(0) - 0xff10))
    .replace(/\s+/g, ' ');
}

function safeCodePoint(value: string, radix: number): string {
  const codePoint = Number.parseInt(value, radix);
  if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return ' ';
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return ' ';
  }
}

function collectMailText(...records: Record<string, unknown>[]): string {
  const fields = ['from', 'sender', 'subject', 'body', 'text', 'html', 'content'];
  const values: string[] = [];
  for (const record of records) {
    for (const field of fields) {
      const value = record[field];
      if (typeof value === 'string') values.push(value);
      else if (value && typeof value === 'object') values.push(JSON.stringify(value));
    }
  }
  return values.join('\n');
}

export function extractEmailFromAccountLine(accountLine: string): string {
  const raw = String(accountLine || '').trim();
  if (!raw) return '';
  if (raw.includes('@') && !raw.includes('----') && !raw.includes('---')) return raw.toLowerCase();
  const first = raw.split('----')[0]?.split('---')[0]?.trim() || '';
  return first.toLowerCase();
}
