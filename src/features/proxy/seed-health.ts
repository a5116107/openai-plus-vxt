import type { ProxyEndpoint, ProxySeedHealthRecord, ProxySettings } from './types';
import { formatProxyEndpoint, isProxyEndpointReady } from './state';

export function seedKey(method: string, stage: string, endpoint: ProxyEndpoint | null | undefined, rawLine = ''): string {
  if (endpoint && endpoint.host) {
    return [method, stage, endpoint.host, endpoint.port, endpoint.username || ''].join('|').toLowerCase();
  }
  const line = String(rawLine || '').trim();
  return [method, stage, line].join('|').toLowerCase();
}

export function summarizeSeed(endpoint: ProxyEndpoint | null | undefined, rawLine = ''): string {
  if (endpoint && isProxyEndpointReady(endpoint)) return formatProxyEndpoint(endpoint);
  const line = String(rawLine || '').trim();
  return line ? line.slice(0, 80) : 'unknown';
}

export function getSeedRecord(settings: ProxySettings, key: string): ProxySeedHealthRecord | null {
  return (settings.seedHealth || []).find((item) => item.key === key) || null;
}

export function isSeedAvailable(
  settings: ProxySettings,
  key: string,
  now = Date.now(),
): { ok: boolean; reason: string; record: ProxySeedHealthRecord | null } {
  if (!settings.seedHealthEnabled) return { ok: true, reason: 'seed health off', record: null };
  const record = getSeedRecord(settings, key);
  if (!record) return { ok: true, reason: 'new seed', record: null };
  if (record.removed) return { ok: false, reason: 'removed:' + (record.lastReason || 'removed'), record };
  const skipAfter = Math.max(1, settings.seedFailSkipAfter || 1);
  if (record.fail >= skipAfter && record.cooldownUntil > now) {
    const left = Math.ceil((record.cooldownUntil - now) / 1000);
    return { ok: false, reason: 'cooldown ' + left + 's fail=' + record.fail, record };
  }
  return { ok: true, reason: 'available', record };
}

export function recordSeedResult(
  settings: ProxySettings,
  input: {
    method: string;
    stage: 'bootstrap' | 'promotion' | 'provider' | 'seed';
    endpoint?: ProxyEndpoint | null;
    rawLine?: string;
    success: boolean;
    reason: string;
    now?: number;
  },
): { settings: ProxySettings; record: ProxySeedHealthRecord; removedNow: boolean } {
  const now = input.now || Date.now();
  const key = seedKey(input.method, input.stage, input.endpoint, input.rawLine);
  const list = [...(settings.seedHealth || [])];
  const idx = list.findIndex((item) => item.key === key);
  const prev = idx >= 0 ? list[idx] : null;
  const success = input.success ? (prev?.success || 0) + 1 : (prev?.success || 0);
  const fail = input.success ? (prev?.fail || 0) : (prev?.fail || 0) + 1;
  const cooldownSec = Math.max(0, settings.seedFailCooldownSec || 0);
  const removeAfter = Math.max(1, settings.seedRemoveAfterFails || 3);
  const effectiveRemoveAfter = success > 0 ? removeAfter : Math.min(removeAfter, 1);
  let removed = Boolean(prev?.removed);
  let removedNow = false;
  let cooldownUntil = prev?.cooldownUntil || 0;
  if (!input.success) {
    cooldownUntil = cooldownSec > 0 ? now + cooldownSec * 1000 : Number.MAX_SAFE_INTEGER;
    if (!removed && fail >= effectiveRemoveAfter) {
      removed = true;
      removedNow = true;
    }
  } else {
    cooldownUntil = 0;
  }

  const record: ProxySeedHealthRecord = {
    key,
    method: String(input.method || '').toLowerCase(),
    stage: input.stage,
    endpointSummary: summarizeSeed(input.endpoint, input.rawLine),
    success,
    fail,
    lastSuccessAt: input.success ? now : (prev?.lastSuccessAt || 0),
    lastFailAt: input.success ? (prev?.lastFailAt || 0) : now,
    lastReason: input.reason || '',
    cooldownUntil,
    removed,
    updatedAt: now,
  };
  if (idx >= 0) list[idx] = record;
  else list.push(record);
  list.sort((a, b) => b.updatedAt - a.updatedAt);

  return {
    settings: {
      ...settings,
      seedHealth: list.slice(0, 500),
    },
    record,
    removedNow,
  };
}

export function filterPoolLinesBySeedHealth(
  settings: ProxySettings,
  method: string,
  stage: 'bootstrap' | 'promotion' | 'provider',
  lines: string[],
  parseLine: (line: string) => { endpoint: import('./types').ProxyEndpoint | null },
): { kept: string[]; skipped: Array<{ line: string; reason: string }> } {
  if (!settings.seedHealthEnabled) return { kept: lines, skipped: [] };
  const kept: string[] = [];
  const skipped: Array<{ line: string; reason: string }> = [];
  for (const line of lines) {
    const parsed = parseLine(line);
    const key = seedKey(method, stage, parsed.endpoint, line);
    const avail = isSeedAvailable(settings, key);
    if (avail.ok) kept.push(line);
    else skipped.push({ line, reason: avail.reason });
  }
  return { kept, skipped };
}

export function purgeRemovedFromPoolRaw(
  raw: string,
  removedKeys: Set<string>,
  method: string,
  stage: string,
  parseLine: (line: string) => { endpoint: import('./types').ProxyEndpoint | null },
): string {
  const lines = String(raw || '').split(/\r?\n/);
  const next = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return true;
    const parsed = parseLine(trimmed);
    const key = seedKey(method, stage, parsed.endpoint, trimmed);
    return !removedKeys.has(key);
  });
  return next.join('\n');
}

export function exportSeedHealthCsv(records: import('./types').ProxySeedHealthRecord[]): string {
  const header = ['updatedAt','method','stage','endpointSummary','success','fail','cooldownUntil','removed','lastReason','key'];
  const lines = [header.join(',')];
  for (const item of records || []) {
    const row = [
      item.updatedAt ? new Date(item.updatedAt).toISOString() : '',
      item.method,
      item.stage,
      item.endpointSummary,
      item.success,
      item.fail,
      item.cooldownUntil ? new Date(item.cooldownUntil).toISOString() : '',
      item.removed ? '1' : '0',
      String(item.lastReason || '').replace(/[\r\n,]/g, ' '),
      item.key,
    ];
    lines.push(row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
  }
  return lines.join('\n');
}

export function exportSeedHealthJson(records: import('./types').ProxySeedHealthRecord[]): string {
  return JSON.stringify(records || [], null, 2);
}
