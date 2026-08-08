import { appendAutomationLog } from '../automation/state';
import { loadAutomationState, loadOAuthState, saveOAuthState } from '../../app/state';
import type { ActionResult } from '../../app/types';

type OAuthPhoneLogEntry = Awaited<ReturnType<typeof loadOAuthState>>['phoneVerification']['logs'][number];

let oauthPhoneLogWriteQueue = Promise.resolve();

export function logOAuthPhone(stage: string, data: Record<string, unknown> | ActionResult | undefined = undefined): void {
  const prefix = `[OPX OAuthPhone] ${stage}`;
  const safeData = sanitizeOAuthPhoneLogData(data);
  if (data === undefined) console.info(prefix);
  else console.info(prefix, safeData);
  const entry: OAuthPhoneLogEntry = {
    id: `${Date.now()}-${stage}-${Math.random().toString(36).slice(2, 7)}`,
    time: Date.now(),
    stage,
    message: data && 'message' in data ? redactOAuthPhoneLogText(String(data.message || '')) : '',
    data: serializeOAuthPhoneLogData(safeData),
  };
  oauthPhoneLogWriteQueue = oauthPhoneLogWriteQueue
    .then(async () => {
      await appendOAuthPhoneLog(entry);
      await mirrorOAuthPhoneLogToAutomation(entry);
    })
    .catch((error) => {
      console.info('[OPX OAuthPhone] log-persist-skipped', error);
    });
}

export async function resetOAuthPhoneLogs(): Promise<void> {
  const current = await loadOAuthState();
  await saveOAuthState({ phoneVerification: { ...current.phoneVerification, logs: [] } });
}

async function appendOAuthPhoneLog(entry: OAuthPhoneLogEntry): Promise<void> {
  const current = await loadOAuthState();
  await saveOAuthState({
    phoneVerification: {
      ...current.phoneVerification,
      logs: [...current.phoneVerification.logs, entry].slice(-80),
    },
  });
}

async function mirrorOAuthPhoneLogToAutomation(entry: OAuthPhoneLogEntry): Promise<void> {
  const automation = await loadAutomationState();
  const stepId = 'wait-oauth-email-code';
  const stepRunning = automation.steps.some((step) => step.id === stepId && step.status === 'running');
  if (!automation.run.running || automation.run.currentStepId !== stepId || !stepRunning) return;
  await appendAutomationLog(resolveOAuthPhoneAutomationLogLevel(entry), formatOAuthPhoneAutomationLog(entry), stepId);
}

function resolveOAuthPhoneAutomationLogLevel(entry: OAuthPhoneLogEntry): 'info' | 'success' | 'warn' | 'error' {
  const normalizedStage = entry.stage.toLowerCase();
  const normalizedData = `${entry.message}\n${entry.data}`.toLowerCase();
  if (normalizedStage.includes('error') || normalizedData.includes('"ok":false') || normalizedData.includes('"error":true')) return 'error';
  if (normalizedStage.includes('success') || normalizedStage.includes('complete') || normalizedStage.includes('received') || normalizedData.includes('"hascode":true')) return 'success';
  if (normalizedStage.includes('fallback') || normalizedStage.includes('timeout') || normalizedStage.includes('cancel') || normalizedStage.includes('rejected')) return 'warn';
  return 'info';
}

function formatOAuthPhoneAutomationLog(entry: OAuthPhoneLogEntry): string {
  const parts = [`OAuth接码：${entry.stage}`];
  if (entry.message) parts.push(entry.message);
  if (entry.data) parts.push(truncateAutomationLogData(entry.data, 900));
  return parts.join(' ');
}

function truncateAutomationLogData(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

export async function flushOAuthPhoneLogs(): Promise<void> {
  await oauthPhoneLogWriteQueue.catch(() => undefined);
}

function serializeOAuthPhoneLogData(data: unknown): string {
  if (data === undefined) return '';
  try {
    return JSON.stringify(sanitizeOAuthPhoneLogData(data));
  } catch {
    return redactOAuthPhoneLogText(String(data));
  }
}

function sanitizeOAuthPhoneLogData(value: unknown): unknown {
  if (typeof value === 'string') return redactOAuthPhoneLogText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeOAuthPhoneLogData(item));
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, childValue] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (['apikey', 'accesstoken', 'idtoken', 'refreshtoken', 'sessiontoken', 'token', 'authorization', 'bearer', 'clientsecret', 'code', 'codeparam', 'codeverifier', 'codechallenge'].includes(normalizedKey)) {
      result[key] = '[REDACTED]';
      continue;
    }
    result[key] = sanitizeOAuthPhoneLogData(childValue);
  }
  return result;
}

export function redactOAuthPhoneLogText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>，。；)]+/gi, (match) => redactLogUrl(match))
    .replace(/(api_key=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/(api[_-]?key["':\s=]+)([^"',\s}]+)/gi, '$1[REDACTED]')
    .replace(/\b(access[_-]?token|id[_-]?token|refresh[_-]?token|session[_-]?token|authorization|bearer|code[_-]?verifier|code[_-]?challenge|code)\b([="'\s:]+)([^\s,;，。]+)/gi, '$1$2[REDACTED]');
}

export function redactLogUrl(value: string): string {
  try {
    const url = new URL(value);
    const path = url.pathname.split('/').filter(Boolean).map((segment) => segment.length > 18 ? `${segment.slice(0, 6)}...${segment.slice(-4)}` : segment).join('/');
    return `${url.origin}${path ? `/${path}` : ''}${url.search ? '?[REDACTED]' : ''}${url.hash ? '#[REDACTED]' : ''}`;
  } catch {
    return '[URL_REDACTED]';
  }
}

export function maskPhone(value: string): string {
  const digits = value.replace(/[^\d]/g, '');
  return digits.length > 4 ? `${digits.slice(0, 3)}***${digits.slice(-4)}` : digits;
}

export function maskEmail(value: string): string {
  const email = value.trim();
  const [name, domain] = email.split('@');
  if (!name || !domain) return email ? '[EMAIL]' : '';
  const visible = name.length <= 2 ? `${name[0] || ''}*` : `${name.slice(0, 2)}***${name.slice(-1)}`;
  return `${visible}@${domain}`;
}
