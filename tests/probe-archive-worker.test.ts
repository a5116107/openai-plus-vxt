import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MemoryProbeArchiveDriver,
  ProbeArchiveRepository,
  type ProbeArchiveDriver,
} from '../src/features/probe/archive';
import {
  BROWSER_GLOBAL_PROXY_CONTEXT,
  ProbeProxyContextScheduler,
  resolveProbeWorkerPlan,
  runProbeWorkerPool,
  type ProbeProxyContext,
} from '../src/features/probe/worker-pool';
import type {
  ProbeHitDatabaseRecord,
  ProbeObservation,
  ProbeTask,
} from '../src/features/probe/types';

test('legacy local migration is idempotent and archive query is paged, ordered and filtered', async () => {
  const repository = new ProbeArchiveRepository(new MemoryProbeArchiveDriver());
  const observations = Array.from({ length: 25 }, (_, index) => observation(index));
  const hits = [hit('hit-a', 'US', 10), hit('hit-b', 'JP', 20)];
  const task = runTask();

  const first = await repository.migrateLegacy({ observations, hits, tasks: [task] });
  assert.equal(first.degraded, false);
  assert.equal(first.observationCount, 25);
  assert.equal(first.hitCount, 2);
  assert.equal(first.runCount, 1);

  const second = await repository.migrateLegacy({
    observations: [observation(99)],
    hits: [hit('late-legacy', 'DE', 99)],
    tasks: [],
  });
  assert.equal(second.observationCount, 25);
  assert.equal(second.hitCount, 2);

  const page = await repository.query({ entity: 'observations', page: 2, pageSize: 10 });
  assert.equal(page.total, 25);
  assert.deepEqual(page.records.map((item) => (item as ProbeObservation).observedAt), [14, 13, 12, 11, 10, 9, 8, 7, 6, 5]);

  const filtered = await repository.query({ entity: 'observations', country: 'US', outcome: 'hit', query: 'account-2' });
  assert.ok(filtered.total > 0);
  assert.ok(filtered.records.every((item) => {
    const value = item as ProbeObservation;
    return value.probeCountry === 'US' && value.outcome === 'hit' && value.accountId.includes('account-2');
  }));
});

test('archive upsert, delete, clear and export keep independent entity counts', async () => {
  const repository = new ProbeArchiveRepository(new MemoryProbeArchiveDriver());
  await repository.migrateLegacy({ observations: [], hits: [], tasks: [] });
  await repository.upsertObservations([observation(1), observation(2)]);
  await repository.upsertHits([hit('hit-a', 'US', 1)]);
  assert.deepEqual(repository.getStatus(), {
    available: true,
    degraded: false,
    backend: 'indexeddb',
    schemaVersion: 1,
    migratedAt: repository.getStatus().migratedAt,
    observationCount: 2,
    hitCount: 1,
    runCount: 0,
    retentionDays: 0,
    lastPrunedAt: 0,
    lastError: '',
  });

  const exported = JSON.parse(await repository.export({ entity: 'hits', country: 'US' })) as { records: ProbeHitDatabaseRecord[] };
  assert.equal(exported.records.length, 1);
  await repository.deleteHit('hit-a');
  assert.equal(repository.getStatus().hitCount, 0);
  await repository.clear('observations');
  assert.equal(repository.getStatus().observationCount, 0);
});

test('archive retention policy removes expired records and persists its status', async () => {
  const repository = new ProbeArchiveRepository(new MemoryProbeArchiveDriver());
  await repository.migrateLegacy({ observations: [], hits: [], tasks: [] });
  const expired = observation(1);
  expired.observedAt = Date.now() - 100 * 86_400_000;
  const current = hit('current-hit', 'US', Date.now());
  await repository.upsertObservations([expired]);
  await repository.upsertHits([current]);
  const result = await repository.prune(30);
  assert.equal(result.removed, 1);
  assert.equal(result.status.observationCount, 0);
  assert.equal(result.status.hitCount, 1);
  assert.equal(result.status.retentionDays, 30);
  assert.ok(result.status.lastPrunedAt > 0);
});

test('archive failure exposes local degraded status without breaking hot-state callers', async () => {
  const failure = new Error('fixture indexeddb failure');
  const driver: ProbeArchiveDriver = {
    putMany: async () => { throw failure; },
    delete: async () => { throw failure; },
    clear: async () => { throw failure; },
    count: async () => { throw failure; },
    scan: async () => { throw failure; },
    getMeta: async () => { throw failure; },
    setMeta: async () => { throw failure; },
  };
  const repository = new ProbeArchiveRepository(driver);
  const status = await repository.migrateLegacy({ observations: [observation(1)], hits: [], tasks: [] });
  assert.equal(status.degraded, true);
  assert.equal(status.backend, 'local');
  assert.match(status.lastError, /fixture indexeddb failure/);
  const page = await repository.query({ entity: 'observations' });
  assert.equal(page.total, 0);
  assert.equal(page.status.degraded, true);
});

test('browser-global proxy context remains serial even when requested concurrency is higher', async () => {
  const plan = resolveProbeWorkerPlan(8, [BROWSER_GLOBAL_PROXY_CONTEXT]);
  assert.equal(plan.effectiveConcurrency, 1);
  assert.equal(plan.contexts[0].proxyContextId, 'browser-global');
  const unproven = resolveProbeWorkerPlan(4, [{
    proxyContextId: 'claimed-isolated',
    isolation: 'isolated',
    adapter: 'external-worker',
    isolationProof: '',
  }]);
  assert.equal(unproven.effectiveConcurrency, 1);

  const scheduler = new ProbeProxyContextScheduler();
  let active = 0;
  let maxActive = 0;
  await Promise.all([1, 2, 3].map((value) => scheduler.run(BROWSER_GLOBAL_PROXY_CONTEXT, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await delay(10);
    active -= 1;
    return value;
  })));
  assert.equal(maxActive, 1);
});

test('isolated proxy contexts run concurrently and failed work releases its lease', async () => {
  const contexts: ProbeProxyContext[] = [
    { proxyContextId: 'profile-a', isolation: 'isolated', adapter: 'external-worker', isolationProof: 'fixture-profile-a' },
    { proxyContextId: 'profile-b', isolation: 'isolated', adapter: 'external-worker', isolationProof: 'fixture-profile-b' },
  ];
  const plan = resolveProbeWorkerPlan(4, contexts);
  assert.equal(plan.effectiveConcurrency, 2);
  let active = 0;
  let maxActive = 0;
  const results = await runProbeWorkerPool({
    items: [1, 2, 3, 4],
    plan,
    execute: async (item) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(12);
      active -= 1;
      return item * 2;
    },
  });
  assert.deepEqual(results, [2, 4, 6, 8]);
  assert.equal(maxActive, 2);

  const scheduler = new ProbeProxyContextScheduler();
  await assert.rejects(scheduler.run(contexts[0], async () => { throw new Error('fixture failure'); }), /fixture failure/);
  await assert.rejects(scheduler.run(contexts[0], async () => { throw new Error('AbortError: fixture cancelled'); }), /cancelled/);
  assert.equal(await scheduler.run(contexts[0], async () => 'released'), 'released');
});

function observation(index: number): ProbeObservation {
  return {
    id: `observation-${index}`,
    observedAt: index,
    accountId: `account-${index % 4}`,
    probeCountry: index % 2 === 0 ? 'US' : 'JP',
    outcome: index % 2 === 0 ? 'hit' : 'miss',
    hitKind: index % 2 === 0 ? 'trial' : 'none',
    message: `fixture ${index}`,
  } as unknown as ProbeObservation;
}

function hit(dbId: string, country: string, savedAt: number): ProbeHitDatabaseRecord {
  return {
    id: `record-${dbId}`,
    dbId,
    savedAt,
    createdAt: savedAt,
    email: `${dbId}@example.test`,
    country,
    hitKind: 'trial',
    link: `https://example.test/${dbId}`,
    sourceTaskName: 'fixture',
    archived: false,
  } as ProbeHitDatabaseRecord;
}

function runTask(): ProbeTask {
  return {
    id: 'task-a',
    config: { name: 'fixture task' },
    runtime: {
      runId: 'run-a',
      cycleId: 'cycle-a',
      status: 'completed',
      startedAt: 1,
      finishedAt: 2,
      totalUnits: 1,
      completedUnits: 1,
      skippedUnits: 0,
      processed: 1,
      hits: 1,
      errors: 0,
      lastMessage: 'done',
      unitStates: [],
    },
    createdAt: 1,
    updatedAt: 2,
  } as unknown as ProbeTask;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
