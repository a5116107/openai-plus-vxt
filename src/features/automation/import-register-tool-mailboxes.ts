/**
 * Normalize GPT-Register-Tool mailbox inventory into plugin Outlook lines:
 * email----password----client_id----refresh_token
 *
 * Supported sources:
 * - mailbox_acica_export / chatai: already 4-field ---- lines
 * - mailbox_tokens.txt: email---password---refresh_token (3 dashes)
 * - config.json email_registration single account fields
 * - loose lines with mixed --- / ---- separators
 */
export const DEFAULT_MS_OAUTH_CLIENT_ID = '9e5f94bc-e8a4-4e73-b8be-63364c29d753';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const MS_CLIENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RegisterToolMailboxImportResult {
  ok: boolean;
  message: string;
  lines: string[];
  count: number;
  skipped: number;
  errors: string[];
  source: string;
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

function looksMsClientId(value: string): boolean {
  return MS_CLIENT_ID_RE.test(String(value || '').trim());
}

function splitCredentialParts(raw: string): string[] {
  const text = String(raw || '').trim();
  if (!text) return [];
  if (text.includes('----')) {
    return text.split('----').map((part) => part.trim()).filter((part, index, arr) => part || index < arr.length - 1);
  }
  // Register-Tool mailbox_tokens.txt uses three dashes.
  if (text.includes('---')) {
    return text.split('---').map((part) => part.trim());
  }
  return [text];
}

/**
 * Convert one raw mailbox credential line into plugin outlook-line format.
 * Returns empty string when the line cannot form an auto-OTP account.
 */
export function normalizeRegisterToolMailboxLine(
  rawLine: string,
  options: { defaultClientId?: string } = {},
): { ok: true; line: string; email: string } | { ok: false; reason: string } {
  const raw = String(rawLine || '').trim().replace(/^\uFEFF/, '');
  if (!raw || raw.startsWith('#') || raw.startsWith('//')) {
    return { ok: false, reason: 'empty' };
  }

  // Strip optional gmail:// / cfworker:// prefixes — only outlook graph lines are auto-OTP ready.
  const payload = raw.includes('://') ? raw.split('://', 2)[1].trim() : raw;
  const parts = splitCredentialParts(payload).filter((part) => part !== undefined);
  const email = String(parts[0] || '').trim();
  if (!EMAIL_RE.test(email)) {
    return { ok: false, reason: '邮箱格式不正确' };
  }

  const defaultClientId = options.defaultClientId || DEFAULT_MS_OAUTH_CLIENT_ID;

  // email only
  if (parts.length === 1) {
    return { ok: false, reason: '缺少 password/client_id/refresh_token，无法自动收码' };
  }

  // email----password----client_id----refresh_token[----access]
  if (parts.length >= 4) {
    let password = parts[1] || '';
    let clientId = parts[2] || '';
    let refreshToken = parts[3] || '';
    // tolerate swapped client/refresh
    if (!looksMsClientId(clientId) && looksMsClientId(refreshToken)) {
      const tmp = clientId;
      clientId = refreshToken;
      refreshToken = tmp;
    }
    if (!looksMsClientId(clientId) && looksMsClientId(password) && !looksMsClientId(clientId)) {
      // email----client----refresh (missing password) — keep password empty invalid
    }
    if (!clientId) clientId = defaultClientId;
    if (!refreshToken) {
      return { ok: false, reason: '缺少 refresh_token' };
    }
    if (!looksMsClientId(clientId)) clientId = defaultClientId;
    return {
      ok: true,
      email: email.toLowerCase(),
      line: `${email}----${password}----${clientId}----${refreshToken}`,
    };
  }

  // email---password---refresh_token  (mailbox_tokens.txt)
  if (parts.length === 3) {
    const password = parts[1] || '';
    const third = parts[2] || '';
    const clientId = looksMsClientId(third) ? third : defaultClientId;
    const refreshToken = looksMsClientId(third) ? '' : third;
    if (!refreshToken) {
      return { ok: false, reason: '三字段行缺少 refresh_token' };
    }
    return {
      ok: true,
      email: email.toLowerCase(),
      line: `${email}----${password}----${clientId}----${refreshToken}`,
    };
  }

  // email----password----refresh_token (missing client)
  if (parts.length === 2) {
    return { ok: false, reason: '两字段行无法构成 Outlook 自动收码凭证' };
  }

  return { ok: false, reason: `无法识别的字段数: ${parts.length}` };
}

export function importRegisterToolMailboxText(
  text: string,
  options: { defaultClientId?: string; source?: string } = {},
): RegisterToolMailboxImportResult {
  const errors: string[] = [];
  const byEmail = new Map<string, string>();
  let skipped = 0;
  const rows = String(text || '').split(/\r?\n/);
  rows.forEach((row, index) => {
    const normalized = normalizeRegisterToolMailboxLine(row, options);
    if (!normalized.ok) {
      if (normalized.reason !== 'empty') {
        skipped += 1;
        if (errors.length < 8) errors.push(`第 ${index + 1} 行：${normalized.reason}`);
      }
      return;
    }
    byEmail.set(normalized.email, normalized.line);
  });

  const lines = [...byEmail.values()];
  return {
    ok: lines.length > 0,
    message: lines.length > 0
      ? `已解析邮箱 ${lines.length} 个（跳过 ${skipped}）`
      : `没有解析到可用 Outlook 行（跳过 ${skipped}）`,
    lines,
    count: lines.length,
    skipped,
    errors,
    source: options.source || 'mailbox-text',
  };
}

/**
 * Extract mailbox lines from Register-Tool config.json object.
 * Includes email_registration single account when complete.
 */
export function importRegisterToolMailboxesFromConfig(
  rawConfig: unknown,
  options: { defaultClientId?: string } = {},
): RegisterToolMailboxImportResult {
  if (!isRecord(rawConfig)) {
    return {
      ok: false,
      message: '配置不是 JSON 对象',
      lines: [],
      count: 0,
      skipped: 0,
      errors: ['配置不是 JSON 对象'],
      source: 'config.json',
    };
  }

  const emailReg = isRecord(rawConfig.email_registration) ? rawConfig.email_registration : {};
  const clientId = firstString(emailReg.oauth_client_id, options.defaultClientId, DEFAULT_MS_OAUTH_CLIENT_ID);
  const email = firstString(emailReg.email);
  const password = firstString(emailReg.password);
  const refreshToken = firstString(emailReg.refresh_token);
  const chunks: string[] = [];

  if (email && password && refreshToken) {
    chunks.push(`${email}----${password}----${clientId}----${refreshToken}`);
  }

  // Optional embedded pools
  for (const key of ['mailbox_lines', 'mailbox_pool', 'accounts', 'emails']) {
    const value = emailReg[key] ?? rawConfig[key];
    if (typeof value === 'string' && value.trim()) chunks.push(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') chunks.push(item);
        else if (isRecord(item)) {
          const rowEmail = firstString(item.email);
          const rowPassword = firstString(item.password);
          const rowClient = firstString(item.client_id, item.oauth_client_id, item.token, clientId);
          const rowRefresh = firstString(item.refresh_token);
          if (rowEmail && rowPassword && rowRefresh) {
            chunks.push(`${rowEmail}----${rowPassword}----${rowClient || clientId}----${rowRefresh}`);
          }
        }
      }
    }
  }

  const tokenFileHint = firstString(emailReg.token_file);
  const imported = importRegisterToolMailboxText(chunks.join('\n'), {
    defaultClientId: clientId || DEFAULT_MS_OAUTH_CLIENT_ID,
    source: 'config.json',
  });

  if (!imported.ok) {
    return {
      ...imported,
      message: tokenFileHint
        ? `config 未内嵌邮箱池。请粘贴 ${tokenFileHint} 或 mailbox_acica_export.txt（邮箱代理 ≠ 邮箱账号）`
        : 'config 未内嵌可用邮箱账号。请另导入 mailbox_acica_export.txt / mailbox_tokens.txt',
    };
  }

  return {
    ...imported,
    message: `从 config 解析邮箱 ${imported.count} 个`,
  };
}

export function mergeMailboxLinesByEmail(current: string, incomingLines: string[]): string {
  const byEmail = new Map<string, string>();
  const push = (line: string) => {
    const normalized = normalizeRegisterToolMailboxLine(line);
    if (!normalized.ok) {
      // keep unknown non-empty raw lines as-is only if they already look like emails
      const raw = line.trim();
      if (!raw) return;
      const email = raw.split('----')[0]?.split('---')[0]?.trim().toLowerCase() || raw.toLowerCase();
      if (!byEmail.has(email)) byEmail.set(email, raw);
      return;
    }
    byEmail.set(normalized.email, normalized.line);
  };
  for (const line of String(current || '').split(/\r?\n/)) push(line);
  for (const line of incomingLines) push(line);
  return [...byEmail.values()].join('\n');
}
