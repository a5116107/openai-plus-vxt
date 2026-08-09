import type { ActionResult } from '../../app/types';

export function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return url.slice(0, 80);
  }
}

export function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function summarizeActionData(data: unknown): string {
  if (!isRecord(data)) {
    return '';
  }
  return [
    ...summarizePageData(data),
    ...summarizePaymentControlData(data),
    ...summarizeInputDiscoveryData(data),
    ...summarizeInputFillData(data),
    ...summarizeInputStateData(data),
    ...summarizeButtonData(data),
  ].join('；');
}

function summarizePageData(actionData: Record<string, unknown>): string[] {
  const parts: string[] = [];
  const url = String(actionData.url || '');
  const pageKind = String(actionData.pageKind || '');
  if (url) {
    parts.push(`页面=${shortUrl(url)}`);
  }
  if (pageKind) {
    parts.push(`状态=${pageKind}`);
  }
  if ('tabStatus' in actionData) {
    parts.push(`加载=${String(actionData.tabStatus || '未知')}`);
  }
  if ('navigationMs' in actionData) {
    parts.push(`跳转耗时=${Math.round(Number(actionData.navigationMs || 0) / 100) / 10}s`);
  }
  const loadMessage = String(actionData.loadMessage || '');
  if (loadMessage) {
    parts.push(`加载结果=${loadMessage}`);
  }
  const readyMessage = String(actionData.readyMessage || '');
  if (readyMessage) {
    parts.push(`控件结果=${readyMessage}`);
  }
  return parts;
}

function summarizePaymentControlData(actionData: Record<string, unknown>): string[] {
  const parts: string[] = [];
  if ('amountFound' in actionData) {
    parts.push(`金额=${actionData.amountFound ? String(actionData.amountText || '已找到') : '未找到'}`);
  }
  if ('paypalButtonFound' in actionData) {
    parts.push(`PayPal按钮=${actionData.paypalButtonFound ? '是' : '否'}`);
  }
  if ('submitButtonFound' in actionData) {
    parts.push(`提交按钮=${actionData.submitButtonFound ? '是' : '否'}`);
  }
  if ('createAccountButtonFound' in actionData) {
    parts.push(`创建账户=${actionData.createAccountButtonFound ? '是' : '否'}`);
  }
  if ('emailInputFound' in actionData) {
    parts.push(`PayPal邮箱框=${actionData.emailInputFound ? '是' : '否'}`);
  }
  if ('continueButtonFound' in actionData) {
    parts.push(`继续按钮=${actionData.continueButtonFound ? '是' : '否'}`);
  }
  if ('billingConsentButtonFound' in actionData) {
    parts.push(`同意按钮=${actionData.billingConsentButtonFound ? '是' : '否'}`);
  }
  if ('readyState' in actionData) {
    parts.push(`ready=${String(actionData.readyState || '')}`);
  }
  return parts;
}

function summarizeInputDiscoveryData(actionData: Record<string, unknown>): string[] {
  const parts: string[] = [];
  if ('inputFound' in actionData) {
    parts.push(`输入框=${actionData.inputFound ? String(actionData.inputSelector || '已找到') : '未找到'}`);
  }
  if ('inputValueLength' in actionData || 'expectedLength' in actionData) {
    parts.push(`值长度=${Number(actionData.inputValueLength || 0)}/${Number(actionData.expectedLength || 0)}`);
  }
  if ('inputMatchesExpected' in actionData) {
    parts.push(`值匹配=${actionData.inputMatchesExpected ? '是' : '否'}`);
  }
  return parts;
}

function summarizeInputFillData(actionData: Record<string, unknown>): string[] {
  const parts: string[] = [];
  const fillMethod = String(actionData.fillMethod || '');
  if (fillMethod) {
    parts.push(`写入方式=${fillMethod}`);
  }
  if ('fillMethodOk' in actionData) {
    parts.push(`写入成功=${actionData.fillMethodOk ? '是' : '否'}`);
  }
  if ('fillImmediateLength' in actionData || 'fillAfterEventLength' in actionData) {
    parts.push(`写入长度=${Number(actionData.fillImmediateLength || 0)}->${Number(actionData.fillAfterEventLength || 0)}`);
  }
  const fillMessage = String(actionData.fillMessage || '');
  if (fillMessage) {
    parts.push(`写入结果=${fillMessage}`);
  }
  return parts;
}

function summarizeInputStateData(actionData: Record<string, unknown>): string[] {
  const parts: string[] = [];
  if ('inputReadOnly' in actionData) {
    parts.push(`只读=${actionData.inputReadOnly ? '是' : '否'}`);
  }
  if ('inputDisabled' in actionData) {
    parts.push(`禁用=${actionData.inputDisabled ? '是' : '否'}`);
  }
  if ('inputConnected' in actionData) {
    parts.push(`连接=${actionData.inputConnected ? '是' : '否'}`);
  }
  return parts;
}

function summarizeButtonData(actionData: Record<string, unknown>): string[] {
  const parts: string[] = [];
  if ('buttonFound' in actionData) {
    parts.push(`按钮=${actionData.buttonFound ? String(actionData.buttonText || actionData.buttonSelector || '已找到') : '未找到'}`);
  }
  if ('buttonDisabled' in actionData) {
    parts.push(`按钮禁用=${actionData.buttonDisabled ? '是' : '否'}`);
  }
  const validationText = String(actionData.validationText || '');
  if (validationText) {
    parts.push(`页面提示=${validationText}`);
  }
  const activeElement = String(actionData.activeElement || '');
  if (activeElement) {
    parts.push(`焦点=${activeElement}`);
  }
  return parts;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object');
}

export function isActionResultLike(value: unknown): value is ActionResult {
  return isRecord(value) && typeof value.ok === 'boolean' && typeof value.message === 'string';
}

export function actionDataStatus(data: unknown): string {
  return isRecord(data) && 'status' in data ? String(data.status || '') : '';
}

export function shortFailureReason(message: string): string {
  const text = message.replace(/\s+/g, ' ').trim();
  return text.length > 160 ? `${text.slice(0, 160)}...` : text;
}

export function sanitizeDebugData(value: unknown, depth = 0): unknown {
  if (depth > 4) {
    return '[MaxDepth]';
  }
  if (typeof value === 'string') {
    return redactDebugText(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 24).map((item) => sanitizeDebugData(item, depth + 1));
  }
  if (isRecord(value)) {
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 80)) {
      if (isSensitiveDebugKey(key)) {
        next[key] = '[REDACTED]';
      } else {
        next[key] = sanitizeDebugData(item, depth + 1);
      }
    }
    return next;
  }
  return String(value);
}

function isSensitiveDebugKey(key: string): boolean {
  return /token|secret|authorization|password|cookie|credential/i.test(key);
}

export function debugPayloadText(payload: unknown): string {
  let text = '';
  try {
    text = JSON.stringify(payload);
  } catch {
    text = String(payload);
  }
  return text.length > 1400 ? `${text.slice(0, 1400)}...` : text;
}

function redactDebugText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>，。；)]+/gi, (match) => redactDebugUrl(match))
    .replace(/\b(access[_-]?token|id[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|authorization|bearer)\b([="'\s:]+)([^\s,;，。]+)/gi, '$1$2[REDACTED]')
    .replace(/\b(token|ba_token|setup_intent_client_secret)=([^&\s]+)/gi, '$1=[REDACTED]');
}

function redactDebugUrl(value: string): string {
  try {
    const url = new URL(value);
    const path = url.pathname
      .split('/')
      .filter(Boolean)
      .map((segment) => segment.length > 18 ? `${segment.slice(0, 6)}...${segment.slice(-4)}` : segment)
      .join('/');
    return `${url.origin}${path ? `/${path}` : ''}${url.search ? '?[REDACTED]' : ''}${url.hash ? '#[REDACTED]' : ''}`;
  } catch {
    return '[URL_REDACTED]';
  }
}
