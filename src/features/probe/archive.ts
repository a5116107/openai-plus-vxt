import type {
  ProbeArchiveEntity,
  ProbeArchivePage,
  ProbeArchiveQuery,
  ProbeArchiveStatus,
  ProbeHitDatabaseRecord,
  ProbeObservation,
  ProbeRunArchiveRecord,
  ProbeTask,
} from './types';

const ARCHIVE_DB_NAME = 'opx-probe-archive';
const ARCHIVE_SCHEMA_VERSION = 1;
const MIGRATION_KEY = 'legacy-local-v1';
const RETENTION_KEY = 'retention-policy-v1';

type ArchiveStoreName = ProbeArchiveEntity | 'meta';
type ArchiveRecord = ProbeObservation | ProbeHitDatabaseRecord | ProbeRunArchiveRecord;

interface ArchiveMetaRecord {
  key: string;
  value: unknown;
  updatedAt: number;
}

export interface ProbeArchiveDriver {
  putMany(store: ProbeArchiveEntity, values: ArchiveRecord[]): Promise<void>;
  delete(store: ProbeArchiveEntity, key: string): Promise<void>;
  clear(store: ProbeArchiveEntity): Promise<void>;
  count(store: ProbeArchiveEntity): Promise<number>;
  scan(store: ProbeArchiveEntity, visitor: (value: ArchiveRecord) => void): Promise<void>;
  getMeta(key: string): Promise<ArchiveMetaRecord | undefined>;
  setMeta(record: ArchiveMetaRecord): Promise<void>;
}

const EMPTY_STATUS: ProbeArchiveStatus = {
  available: false,
  degraded: false,
  backend: 'local',
  schemaVersion: ARCHIVE_SCHEMA_VERSION,
  migratedAt: 0,
  observationCount: 0,
  hitCount: 0,
  runCount: 0,
  retentionDays: 0,
  lastPrunedAt: 0,
  lastError: '',
};

export class ProbeArchiveRepository {
  private status: ProbeArchiveStatus = { ...EMPTY_STATUS };

  constructor(private readonly driver: ProbeArchiveDriver) {}

  getStatus(): ProbeArchiveStatus {
    return { ...this.status };
  }

  async migrateLegacy(input: {
    observations: ProbeObservation[];
    hits: ProbeHitDatabaseRecord[];
    tasks: ProbeTask[];
  }): Promise<ProbeArchiveStatus> {
    return this.guard(async () => {
      const migrated = await this.driver.getMeta(MIGRATION_KEY);
      if (!migrated) {
        await this.driver.putMany('observations', input.observations);
        await this.driver.putMany('hits', input.hits);
        await this.driver.putMany('runs', input.tasks.map(taskToRunArchive).filter((item): item is ProbeRunArchiveRecord => Boolean(item)));
        const migratedAt = Date.now();
        await this.driver.setMeta({ key: MIGRATION_KEY, value: { schemaVersion: ARCHIVE_SCHEMA_VERSION }, updatedAt: migratedAt });
        this.status.migratedAt = migratedAt;
      } else {
        this.status.migratedAt = migrated.updatedAt;
      }
      const retention = await this.driver.getMeta(RETENTION_KEY);
      if (retention && isRetentionMeta(retention.value)) {
        this.status.retentionDays = retention.value.retentionDays;
        this.status.lastPrunedAt = retention.updatedAt;
      }
      return this.refreshCounts();
    });
  }

  async upsertObservations(values: ProbeObservation[]): Promise<ProbeArchiveStatus> {
    return this.guard(async () => {
      await this.driver.putMany('observations', values);
      return this.refreshCounts();
    });
  }

  async upsertHits(values: ProbeHitDatabaseRecord[]): Promise<ProbeArchiveStatus> {
    return this.guard(async () => {
      await this.driver.putMany('hits', values);
      return this.refreshCounts();
    });
  }

  async upsertTask(task: ProbeTask): Promise<ProbeArchiveStatus> {
    const record = taskToRunArchive(task);
    if (!record) return this.getStatus();
    return this.guard(async () => {
      await this.driver.putMany('runs', [record]);
      return this.refreshCounts();
    });
  }

  async deleteHit(dbId: string): Promise<ProbeArchiveStatus> {
    return this.guard(async () => {
      await this.driver.delete('hits', dbId);
      return this.refreshCounts();
    });
  }

  async clear(entity: ProbeArchiveEntity | 'all'): Promise<ProbeArchiveStatus> {
    return this.guard(async () => {
      const stores: ProbeArchiveEntity[] = entity === 'all' ? ['observations', 'hits', 'runs'] : [entity];
      await Promise.all(stores.map((store) => this.driver.clear(store)));
      return this.refreshCounts();
    });
  }

  async prune(retentionDaysInput: number): Promise<{ status: ProbeArchiveStatus; removed: number }> {
    const retentionDays = clampInt(retentionDaysInput, 1, 3650, 90);
    const cutoff = Date.now() - retentionDays * 86_400_000;
    let removed = 0;
    const status = await this.guard(async () => {
      for (const store of ['observations', 'hits', 'runs'] as ProbeArchiveEntity[]) {
        const keys: string[] = [];
        await this.driver.scan(store, (record) => {
          const source = record as unknown as Record<string, unknown>;
          const timestamp = Number(source.observedAt || source.savedAt || source.updatedAt || 0);
          if (timestamp > 0 && timestamp < cutoff) keys.push(recordKey(store, record));
        });
        for (const key of keys) await this.driver.delete(store, key);
        removed += keys.length;
      }
      const lastPrunedAt = Date.now();
      await this.driver.setMeta({ key: RETENTION_KEY, value: { retentionDays }, updatedAt: lastPrunedAt });
      this.status.retentionDays = retentionDays;
      this.status.lastPrunedAt = lastPrunedAt;
      return this.refreshCounts();
    });
    return { status, removed };
  }

  async query(input: ProbeArchiveQuery): Promise<ProbeArchivePage> {
    const page = clampInt(input.page, 1, 1_000_000, 1);
    const pageSize = clampInt(input.pageSize, 10, 200, 50);
    const offset = (page - 1) * pageSize;
    const records: ArchiveRecord[] = [];
    let total = 0;
    try {
      await this.driver.scan(input.entity, (record) => {
        if (!matchesArchiveQuery(record, input)) return;
        if (total >= offset && records.length < pageSize) records.push(record);
        total += 1;
      });
      await this.refreshCounts();
    } catch (error) {
      this.markDegraded(error);
    }
    return { entity: input.entity, page, pageSize, total, records, status: this.getStatus() };
  }

  async export(input: Omit<ProbeArchiveQuery, 'page' | 'pageSize'>): Promise<string> {
    const records: ArchiveRecord[] = [];
    try {
      await this.driver.scan(input.entity, (record) => {
        if (matchesArchiveQuery(record, input)) records.push(record);
      });
    } catch (error) {
      this.markDegraded(error);
      return '';
    }
    return JSON.stringify({ schemaVersion: ARCHIVE_SCHEMA_VERSION, entity: input.entity, exportedAt: Date.now(), records }, null, 2);
  }

  private async refreshCounts(): Promise<ProbeArchiveStatus> {
    const [observationCount, hitCount, runCount] = await Promise.all([
      this.driver.count('observations'),
      this.driver.count('hits'),
      this.driver.count('runs'),
    ]);
    this.status = {
      ...this.status,
      available: true,
      degraded: false,
      backend: 'indexeddb',
      schemaVersion: ARCHIVE_SCHEMA_VERSION,
      observationCount,
      hitCount,
      runCount,
      lastError: '',
    };
    return this.getStatus();
  }

  private async guard(operation: () => Promise<ProbeArchiveStatus>): Promise<ProbeArchiveStatus> {
    try {
      return await operation();
    } catch (error) {
      this.markDegraded(error);
      return this.getStatus();
    }
  }

  private markDegraded(error: unknown): void {
    this.status = {
      ...this.status,
      available: false,
      degraded: true,
      backend: 'local',
      lastError: error instanceof Error ? error.message : String(error),
    };
  }
}

class IndexedDbProbeArchiveDriver implements ProbeArchiveDriver {
  private databasePromise?: Promise<IDBDatabase>;

  async putMany(store: ProbeArchiveEntity, values: ArchiveRecord[]): Promise<void> {
    if (!values.length) return;
    const db = await this.open();
    await transactionDone(db, [store], 'readwrite', (tx) => {
      const objectStore = tx.objectStore(store);
      for (const value of values) objectStore.put(value);
    });
  }

  async delete(store: ProbeArchiveEntity, key: string): Promise<void> {
    const db = await this.open();
    await transactionDone(db, [store], 'readwrite', (tx) => tx.objectStore(store).delete(key));
  }

  async clear(store: ProbeArchiveEntity): Promise<void> {
    const db = await this.open();
    await transactionDone(db, [store], 'readwrite', (tx) => tx.objectStore(store).clear());
  }

  async count(store: ProbeArchiveEntity): Promise<number> {
    const db = await this.open();
    return requestResult(db.transaction(store, 'readonly').objectStore(store).count());
  }

  async scan(store: ProbeArchiveEntity, visitor: (value: ArchiveRecord) => void): Promise<void> {
    const db = await this.open();
    const indexName = store === 'observations' ? 'observedAt' : store === 'hits' ? 'savedAt' : 'updatedAt';
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const request = tx.objectStore(store).index(indexName).openCursor(null, 'prev');
      request.onerror = () => reject(request.error || new Error(`IndexedDB ${store} cursor failed`));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        visitor(cursor.value as ArchiveRecord);
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error(`IndexedDB ${store} scan failed`));
      tx.onabort = () => reject(tx.error || new Error(`IndexedDB ${store} scan aborted`));
    });
  }

  async getMeta(key: string): Promise<ArchiveMetaRecord | undefined> {
    const db = await this.open();
    return requestResult(db.transaction('meta', 'readonly').objectStore('meta').get(key));
  }

  async setMeta(record: ArchiveMetaRecord): Promise<void> {
    const db = await this.open();
    await transactionDone(db, ['meta'], 'readwrite', (tx) => tx.objectStore('meta').put(record));
  }

  private open(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise;
    this.databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB is not available in this extension context'));
        return;
      }
      const isIncognito = typeof browser !== 'undefined' && Boolean(browser.extension?.inIncognitoContext);
      const request = indexedDB.open(isIncognito ? `${ARCHIVE_DB_NAME}.incognito` : ARCHIVE_DB_NAME, ARCHIVE_SCHEMA_VERSION);
      request.onupgradeneeded = () => createSchema(request.result);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
      request.onblocked = () => reject(new Error('IndexedDB upgrade is blocked by another extension page'));
    });
    this.databasePromise = this.databasePromise.catch((error) => {
      this.databasePromise = undefined;
      throw error;
    });
    return this.databasePromise;
  }
}

export class MemoryProbeArchiveDriver implements ProbeArchiveDriver {
  private readonly stores: Record<ProbeArchiveEntity, Map<string, ArchiveRecord>> = {
    observations: new Map(), hits: new Map(), runs: new Map(),
  };
  private readonly meta = new Map<string, ArchiveMetaRecord>();

  async putMany(store: ProbeArchiveEntity, values: ArchiveRecord[]): Promise<void> {
    for (const value of values) this.stores[store].set(recordKey(store, value), structuredClone(value));
  }
  async delete(store: ProbeArchiveEntity, key: string): Promise<void> { this.stores[store].delete(key); }
  async clear(store: ProbeArchiveEntity): Promise<void> { this.stores[store].clear(); }
  async count(store: ProbeArchiveEntity): Promise<number> { return this.stores[store].size; }
  async scan(store: ProbeArchiveEntity, visitor: (value: ArchiveRecord) => void): Promise<void> {
    const timeKey = store === 'observations' ? 'observedAt' : store === 'hits' ? 'savedAt' : 'updatedAt';
    const values = [...this.stores[store].values()].sort((a, b) => Number((b as unknown as Record<string, unknown>)[timeKey] || 0) - Number((a as unknown as Record<string, unknown>)[timeKey] || 0));
    values.forEach((value) => visitor(structuredClone(value)));
  }
  async getMeta(key: string): Promise<ArchiveMetaRecord | undefined> { return this.meta.get(key); }
  async setMeta(record: ArchiveMetaRecord): Promise<void> { this.meta.set(record.key, record); }
}

let defaultRepository: ProbeArchiveRepository | undefined;
let migrationPromise: Promise<ProbeArchiveStatus> | undefined;

export function getProbeArchiveRepository(): ProbeArchiveRepository {
  defaultRepository ||= new ProbeArchiveRepository(new IndexedDbProbeArchiveDriver());
  return defaultRepository;
}

export function ensureProbeArchiveMigrated(input: {
  observations: ProbeObservation[];
  hits: ProbeHitDatabaseRecord[];
  tasks: ProbeTask[];
}): Promise<ProbeArchiveStatus> {
  const repository = getProbeArchiveRepository();
  migrationPromise ||= repository.migrateLegacy(input).then((status) => {
    if (status.degraded) migrationPromise = undefined;
    return status;
  });
  return migrationPromise.then((status) => status.degraded ? status : repository.getStatus());
}

export function resetProbeArchiveForTests(repository?: ProbeArchiveRepository): void {
  defaultRepository = repository;
  migrationPromise = undefined;
}

function createSchema(db: IDBDatabase): void {
  const observations = db.objectStoreNames.contains('observations')
    ? undefined
    : db.createObjectStore('observations', { keyPath: 'id' });
  observations?.createIndex('observedAt', 'observedAt');
  observations?.createIndex('accountId', 'accountId');
  observations?.createIndex('country', 'probeCountry');
  const hits = db.objectStoreNames.contains('hits') ? undefined : db.createObjectStore('hits', { keyPath: 'dbId' });
  hits?.createIndex('savedAt', 'savedAt');
  hits?.createIndex('email', 'email');
  hits?.createIndex('country', 'country');
  const runs = db.objectStoreNames.contains('runs') ? undefined : db.createObjectStore('runs', { keyPath: 'archiveId' });
  runs?.createIndex('updatedAt', 'updatedAt');
  runs?.createIndex('taskId', 'taskId');
  if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
}

function transactionDone(
  db: IDBDatabase,
  stores: ArchiveStoreName[],
  mode: IDBTransactionMode,
  action: (transaction: IDBTransaction) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    action(tx);
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function taskToRunArchive(task: ProbeTask): ProbeRunArchiveRecord | null {
  const runtime = task.runtime;
  if (!runtime.runId) return null;
  return {
    archiveId: `${task.id}:${runtime.runId}`,
    taskId: task.id,
    taskName: task.config.name,
    runId: runtime.runId,
    cycleId: runtime.cycleId,
    status: runtime.status,
    startedAt: runtime.startedAt,
    finishedAt: runtime.finishedAt,
    totalUnits: runtime.totalUnits,
    completedUnits: runtime.completedUnits,
    skippedUnits: runtime.skippedUnits,
    processed: runtime.processed,
    hits: runtime.hits,
    errors: runtime.errors,
    message: runtime.lastMessage,
    units: runtime.unitStates.map((unit) => ({ ...unit })),
    updatedAt: task.updatedAt,
  };
}

function matchesArchiveQuery(record: ArchiveRecord, query: Omit<ProbeArchiveQuery, 'page' | 'pageSize'>): boolean {
  const country = String(query.country || '').trim().toUpperCase();
  const outcome = String(query.outcome || '').trim().toLowerCase();
  const search = String(query.query || '').trim().toLowerCase();
  const source = record as unknown as Record<string, unknown>;
  const recordCountry = String(source.probeCountry || source.country || '').toUpperCase();
  if (country && recordCountry !== country) return false;
  if (outcome) {
    const recordOutcome = String(source.outcome || source.hitKind || source.status || '').toLowerCase();
    if (recordOutcome !== outcome) return false;
  }
  if (!search) return true;
  const bag = [
    source.id, source.dbId, source.runId, source.taskId, source.accountId, source.email,
    source.country, source.probeCountry, source.hitKind, source.outcome, source.status,
    source.message, source.link, source.taskName,
  ].map((value) => String(value || '')).join(' ').toLowerCase();
  return bag.includes(search);
}

function recordKey(store: ProbeArchiveEntity, record: ArchiveRecord): string {
  if (store === 'observations') return (record as ProbeObservation).id;
  if (store === 'hits') return (record as ProbeHitDatabaseRecord).dbId;
  return (record as ProbeRunArchiveRecord).archiveId;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function isRetentionMeta(value: unknown): value is { retentionDays: number } {
  if (!value || typeof value !== 'object') return false;
  const retentionDays = Number((value as { retentionDays?: unknown }).retentionDays);
  return Number.isFinite(retentionDays) && retentionDays >= 1 && retentionDays <= 3650;
}
