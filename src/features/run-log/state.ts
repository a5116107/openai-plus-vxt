import { scopedStorageKey } from '../../app/storage-scope';
import type { RunLogEvent, RunLogLevel, RunLogState } from './types';

const STORAGE_KEY = 'opx.runlog.state';
const MAX_EVENTS = 2000;

const DEFAULT_STATE: RunLogState = {
  connected: true,
  autoScroll: true,
  events: [],
  updatedAt: 0,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object');
}

export function normalizeRunLogEvent(value: unknown): RunLogEvent | null {
  if (!isRecord(value)) return null;
  const message = String(value.message || '').trim();
  if (!message) return null;
  const levelRaw = String(value.level || 'info');
  const level = (['debug', 'info', 'success', 'warn', 'error'].includes(levelRaw)
    ? levelRaw
    : 'info') as RunLogLevel;
  return {
    id: String(value.id || `log-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`),
    ts: Number(value.ts || Date.now()) || Date.now(),
    level,
    accountLabel: String(value.accountLabel || value.email || value.accountId || '系统'),
    accountId: String(value.accountId || ''),
    email: String(value.email || ''),
    stage: String(value.stage || 'system'),
    message,
    code: String(value.code || ''),
    progress: String(value.progress || ''),
    taskId: String(value.taskId || ''),
    country: String(value.country || '').toUpperCase(),
    meta: isRecord(value.meta) ? (value.meta as RunLogEvent['meta']) : undefined,
    action: value.action ? String(value.action) : undefined,
  };
}

export function normalizeRunLogState(value: unknown): RunLogState {
  const source = isRecord(value) ? value : {};
  const events = Array.isArray(source.events)
    ? source.events.map((item) => normalizeRunLogEvent(item)).filter((item): item is RunLogEvent => Boolean(item)).slice(-MAX_EVENTS)
    : [];
  return {
    connected: source.connected === undefined ? true : Boolean(source.connected),
    autoScroll: source.autoScroll === undefined ? true : Boolean(source.autoScroll),
    events,
    updatedAt: Number(source.updatedAt || 0) || 0,
  };
}

export async function loadRunLogState(): Promise<RunLogState> {
  const key = scopedStorageKey(STORAGE_KEY);
  const data = await browser.storage.local.get(key);
  return normalizeRunLogState(data[key]);
}

export async function saveRunLogState(patch: Partial<RunLogState>): Promise<RunLogState> {
  const current = await loadRunLogState();
  const next = normalizeRunLogState({
    ...current,
    ...patch,
    events: Object.prototype.hasOwnProperty.call(patch, 'events') ? patch.events || [] : current.events,
    updatedAt: Date.now(),
  });
  await browser.storage.local.set({ [scopedStorageKey(STORAGE_KEY)]: next });
  return next;
}

export async function appendRunLogEvent(
  partial: Partial<RunLogEvent> & { message: string; level?: RunLogLevel },
): Promise<RunLogState> {
  const event = normalizeRunLogEvent({
    ...partial,
    id: partial.id || `log-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    ts: partial.ts || Date.now(),
    level: partial.level || 'info',
  });
  if (!event) {
    return loadRunLogState();
  }
  const current = await loadRunLogState();
  const events = [...current.events, event].slice(-MAX_EVENTS);
  return saveRunLogState({ events, connected: true });
}

export async function clearRunLogEvents(): Promise<RunLogState> {
  return saveRunLogState({ events: [] });
}

export function listRunLogEvents(
  state: RunLogState,
  filter?: { limit?: number; accountId?: string; level?: RunLogLevel | 'all' },
): RunLogEvent[] {
  let events = state.events || [];
  if (filter?.accountId) {
    const id = filter.accountId;
    events = events.filter((item) => item.accountId === id || item.accountLabel === id || item.email === id);
  }
  if (filter?.level && filter.level !== 'all') {
    events = events.filter((item) => item.level === filter.level);
  }
  const limit = Math.max(1, Math.min(5000, filter?.limit || 500));
  return events.slice(-limit);
}

export function exportRunLogCsv(events: RunLogEvent[]): string {
  const header = ['ts', 'level', 'accountLabel', 'accountId', 'email', 'stage', 'code', 'progress', 'country', 'taskId', 'message', 'action'];
  const lines = [header.join(',')];
  for (const item of events) {
    const row = [
      new Date(item.ts).toISOString(),
      item.level,
      item.accountLabel,
      item.accountId,
      item.email,
      item.stage,
      item.code,
      item.progress,
      item.country,
      item.taskId,
      String(item.message || '').replace(/[\r\n,]/g, ' '),
      item.action || '',
    ];
    lines.push(row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
  }
  return lines.join('\n');
}

export function exportRunLogJsonl(events: RunLogEvent[]): string {
  return events.map((item) => JSON.stringify(item)).join('\n');
}
