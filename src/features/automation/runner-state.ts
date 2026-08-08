import {
  loadAutomationState,
  saveRegisterState,
} from '../../app/state';
import {
  updateAutomationEmails,
  updateAutomationRun,
  updateAutomationSmsTargets,
} from './state';
import type {
  AutomationEmailAccount,
  AutomationSmsTarget,
  AutomationState,
} from './types';
import { shortFailureReason } from './runner-format';

export async function ensureSelectedEmail(): Promise<AutomationEmailAccount> {
  const state = await loadAutomationState();
  const email = currentEmail(state);
  if (!email) {
    const selected = selectEmail(state);
    if (selected) {
      await updateAutomationRun({
        selectedEmailId: selected.id,
        sessionEmail: selected.email,
      });
      return writeRegisterStateFromEmail(selected);
    }
    throw new Error('没有当前邮箱，请先执行“选择邮箱”或在自动化设置页添加邮箱');
  }
  return writeRegisterStateFromEmail(email);
}

export async function writeRegisterStateFromEmail(email: AutomationEmailAccount): Promise<AutomationEmailAccount> {
  const tokenLine = email.rawInput.includes('----') || /---/.test(email.rawInput);
  await saveRegisterState({
    rawInput: email.rawInput || email.email,
    email: email.email,
    accountLine: tokenLine ? email.rawInput : email.email,
    inputMode: tokenLine ? 'outlook-line' : 'email',
    autoOtp: true, // Acica 可按邮箱取件；token 行也可本地 OTP
  });
  return email;
}

export function selectEmail(state: AutomationState): AutomationEmailAccount | null {
  if (state.settings.emailSelectionMode === 'specified' && state.settings.specifiedEmailId) {
    return state.emails.find((email) => email.id === state.settings.specifiedEmailId) || null;
  }
  if (state.run.selectedEmailId) {
    const selected = state.emails.find((email) => email.id === state.run.selectedEmailId && email.status === 'running');
    if (selected) {
      return selected;
    }
  }
  const available = state.emails.filter((email) => email.status !== 'used' && email.status !== 'error');
  if (!available.length) {
    return null;
  }
  if (state.settings.emailSelectionMode === 'random') {
    const candidates = healthiestRandomEmailCandidates(state, available);
    return candidates[Math.floor(Math.random() * candidates.length)] || candidates[0] || available[0];
  }
  return [...available]
    .sort((left, right) => left.lastUsedAt - right.lastUsedAt || left.useCount - right.useCount)[0] || null;
}

function healthiestRandomEmailCandidates(
  state: AutomationState,
  available: AutomationEmailAccount[],
): AutomationEmailAccount[] {
  const domainStats = new Map<string, { total: number; errors: number }>();
  for (const email of state.emails) {
    const domain = emailDomain(email.email);
    if (!domain) continue;
    const current = domainStats.get(domain) || { total: 0, errors: 0 };
    current.total += 1;
    if (email.status === 'error') current.errors += 1;
    domainStats.set(domain, current);
  }
  const rates = available.map((email) => {
    const stats = domainStats.get(emailDomain(email.email)) || { total: 1, errors: 0 };
    return stats.errors / Math.max(1, stats.total);
  });
  const bestRate = Math.min(...rates);
  return available.filter((email) => {
    const stats = domainStats.get(emailDomain(email.email)) || { total: 1, errors: 0 };
    return stats.errors / Math.max(1, stats.total) === bestRate;
  });
}

function emailDomain(email: string): string {
  return String(email || '').trim().toLowerCase().split('@')[1] || '';
}

export function selectSmsTarget(state: AutomationState): AutomationSmsTarget | null {
  const available = availableSmsTargets(state);
  if (!available.length) {
    return null;
  }
  const candidates = [...available].sort((left, right) => left.useCount - right.useCount || left.lastUsedAt - right.lastUsedAt);
  if (state.settings.smsSelectionMode === 'next') {
    return candidates[0] || null;
  }
  const leastUsed = candidates.slice(0, Math.max(1, Math.ceil(candidates.length / 2)));
  return leastUsed[Math.floor(Math.random() * leastUsed.length)] || candidates[0] || null;
}

export function availableSmsTargets(state: AutomationState): AutomationSmsTarget[] {
  return state.smsTargets.filter((target) => target.source === 'api' && !target.disabled);
}

export function hasNextBatchEmail(state: AutomationState): boolean {
  if (state.settings.emailSelectionMode === 'specified') {
    return false;
  }
  return state.emails.some((email) => email.status !== 'used' && email.status !== 'error');
}

export function normalizeBatchAccountLimit(value: unknown): number {
  const limit = Number(value || 1);
  if (!Number.isInteger(limit) || limit < 1) {
    return 1;
  }
  return Math.min(limit, 999);
}

export function currentEmail(state: AutomationState): AutomationEmailAccount | null {
  return state.emails.find((email) => email.id === state.run.selectedEmailId) || null;
}

export function currentSmsTarget(state: AutomationState): AutomationSmsTarget | null {
  return state.smsTargets.find((target) => target.id === state.run.selectedSmsId) || null;
}

export async function markSelectedEmailUsed(message: string): Promise<void> {
  const state = await loadAutomationState();
  if (!state.run.selectedEmailId) {
    return;
  }
  await updateAutomationEmails(state.emails.map((email) => email.id === state.run.selectedEmailId
    ? { ...email, status: 'used', lastMessage: message }
    : email));
}

export async function markSelectedEmailError(message: string): Promise<void> {
  const state = await loadAutomationState();
  if (!state.run.selectedEmailId) {
    return;
  }
  await updateAutomationEmails(state.emails.map((email) => email.id === state.run.selectedEmailId
    ? { ...email, status: 'error', lastMessage: message }
    : email));
}

export async function recordSelectedEmailMessage(message: string): Promise<void> {
  const state = await loadAutomationState();
  if (!state.run.selectedEmailId) {
    return;
  }
  await updateAutomationEmails(state.emails.map((email) => email.id === state.run.selectedEmailId
    ? { ...email, lastMessage: message }
    : email));
}

export async function markSmsCodeReceived(id: string, message: string): Promise<void> {
  const state = await loadAutomationState();
  await updateAutomationSmsTargets(state.smsTargets.map((target) => target.id === id
    ? { ...target, lastCodeAt: Date.now(), lastMessage: message }
    : target));
}

export async function markSmsMessage(id: string, message: string): Promise<void> {
  const state = await loadAutomationState();
  await updateAutomationSmsTargets(state.smsTargets.map((target) => target.id === id
    ? { ...target, lastMessage: message }
    : target));
}

export async function markSelectedSmsDisabled(reason: string): Promise<AutomationSmsTarget | null> {
  const state = await loadAutomationState();
  const selectedId = state.run.selectedSmsId;
  const selected = selectedId
    ? state.smsTargets.find((target) => target.id === selectedId) || null
    : null;
  if (!selected) {
    await updateAutomationRun({ selectedSmsId: '' });
    return null;
  }
  const disabledAt = Date.now();
  const disabledReason = shortFailureReason(reason);
  await updateAutomationSmsTargets(state.smsTargets.map((target) => target.id === selected.id
    ? {
        ...target,
        disabled: true,
        disabledAt,
        disabledReason,
        lastMessage: disabledReason,
      }
    : target));
  await updateAutomationRun({ selectedSmsId: '' });
  return {
    ...selected,
    disabled: true,
    disabledAt,
    disabledReason,
    lastMessage: disabledReason,
  };
}
