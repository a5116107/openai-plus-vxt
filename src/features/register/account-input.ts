import type { ParsedAccountInput } from './types';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MS_CLIENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_MS_OAUTH_CLIENT_ID = '9e5f94bc-e8a4-4e73-b8be-63364c29d753';

export function parseAccountInput(rawInput: string): ParsedAccountInput {
  const raw = rawInput.trim();
  if (!raw) {
    return invalid('empty', '请输入邮箱或 Outlook 账号行');
  }

  const firstLine = raw.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';

  // Prefer 4-dash separator; also accept Register-Tool mailbox_tokens 3-dash form.
  if (firstLine.includes('----') || /@[^-\s]+---/.test(firstLine)) {
    const parts = firstLine.includes('----')
      ? firstLine.split('----').map((item) => item.trim())
      : firstLine.split('---').map((item) => item.trim());
    const email = parts[0] || '';
    if (!EMAIL_RE.test(email)) {
      return invalid('invalid', 'Outlook 行里的邮箱格式不正确');
    }

    let password = parts[1] || '';
    let clientId = parts[2] || '';
    let refreshToken = parts[3] || '';

    // mailbox_tokens.txt: email---password---refresh_token
    if (parts.length === 3 && !refreshToken) {
      const third = parts[2] || '';
      if (MS_CLIENT_ID_RE.test(third)) {
        clientId = third;
        refreshToken = '';
      } else {
        clientId = DEFAULT_MS_OAUTH_CLIENT_ID;
        refreshToken = third;
      }
    }

    if (!clientId) clientId = DEFAULT_MS_OAUTH_CLIENT_ID;
    if (!refreshToken) {
      return invalid('invalid', 'Outlook 行需要 email----password----client_id----refresh_token');
    }

    const accountLine = `${email}----${password}----${clientId}----${refreshToken}`;
    return {
      ok: true,
      mode: 'outlook-line',
      email,
      accountLine,
      message: 'Outlook API 自动验证码',
    };
  }

  if (!EMAIL_RE.test(firstLine)) {
    return invalid('invalid', '邮箱格式不正确');
  }

  return {
    ok: true,
    mode: 'email',
    email: firstLine,
    accountLine: '',
    message: '单邮箱模式，验证码手动输入',
  };
}

function invalid(mode: ParsedAccountInput['mode'], message: string): ParsedAccountInput {
  return {
    ok: false,
    mode,
    email: '',
    accountLine: '',
    message,
  };
}
