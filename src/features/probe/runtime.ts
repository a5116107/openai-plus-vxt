import type { ProbeHitRecord, ProbeStageExitSnapshot, ProbeTaskRuntime, ProbeTaskUnitRuntime } from './types';

export type ProbeStageTraceInput = ProbeStageExitSnapshot;

export function createProbeRunUnits(
  runId: string,
  entries: Array<{ accountId: string; email: string; country: string }>,
): ProbeTaskUnitRuntime[] {
  return entries.map((entry, index) => {
    const unitId = `${runId}-u${index + 1}`;
    return {
      unitId,
      runId,
      cycleId: `${unitId}-cycle`,
      attemptId: `${unitId}-a1`,
      accountId: entry.accountId,
      email: entry.email,
      country: String(entry.country || '').trim().toUpperCase(),
      status: 'planned',
      attempt: 0,
      startedAt: 0,
      finishedAt: 0,
      durationMs: 0,
      hitKind: 'none',
      errorClass: '',
      message: '',
    };
  });
}

export function getProbeRuntimeProgress(runtime: ProbeTaskRuntime, fallbackTotal = 0): {
  completed: number;
  total: number;
  percent: number;
} {
  const total = Math.max(0, runtime.totalUnits || fallbackTotal || runtime.unitStates.length);
  const completed = Math.min(total || Number.MAX_SAFE_INTEGER, Math.max(0, runtime.completedUnits || runtime.processed));
  return {
    completed,
    total,
    percent: total ? Math.round((completed / total) * 1000) / 10 : 0,
  };
}

export function dedupeProbeHits<T extends ProbeHitRecord>(hits: T[]): T[] {
  const seen = new Set<string>();
  const output: T[] = [];
  for (const hit of hits || []) {
    if (!hit) continue;
    const dbIdentity = String(hit.dbId || '').trim();
    const hitIdentity = String(hit.id || '').trim();
    const linkIdentity = hit.link
      ? [hit.accountId || hit.email, hit.country, hit.link].map((item) => String(item || '').trim().toLowerCase()).join('|')
      : '';
    const keys = [
      dbIdentity ? `db:${dbIdentity}` : '',
      hitIdentity ? `hit:${hitIdentity}` : '',
      linkIdentity ? `link:${linkIdentity}` : '',
    ].filter(Boolean);
    if (keys.some((key) => seen.has(key))) continue;
    keys.forEach((key) => seen.add(key));
    output.push(hit);
  }
  return output;
}

export function buildFreshProbeStageSnapshot(
  trace: ProbeStageTraceInput | undefined,
  fallbackCountry: string,
  observationStartedAt = 0,
): ProbeStageExitSnapshot {
  const fresh = Boolean(trace && (!observationStartedAt || trace.checkedAt >= observationStartedAt));
  return {
    cycleId: String(trace?.cycleId || ''),
    configuredCountry: String(trace?.configuredCountry || fallbackCountry || '').trim().toUpperCase(),
    country: fresh ? trace?.country || '' : '',
    ip: fresh ? trace?.ip || '' : '',
    asn: fresh ? trace?.asn || '' : '',
    colo: fresh ? trace?.colo || '' : '',
    latencyMs: fresh ? trace?.latencyMs || 0 : 0,
    checkedAt: fresh ? trace?.checkedAt || 0 : 0,
    endpointSummary: fresh ? trace?.endpointSummary || '' : '',
    source: fresh ? trace?.source || '' : '',
    verified: Boolean(fresh && trace?.verified),
    message: fresh ? trace?.message || '' : trace ? '阶段证据早于当前观测，已丢弃' : '当前观测没有该阶段证据',
  };
}
