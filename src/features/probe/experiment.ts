import type {
  ProbeAccount,
  ProbeExperimentFactor,
  ProbeExperimentArm,
  ProbeExperimentCoverage,
  ProbeExperimentMode,
  ProbeObservation,
  ProbeRouteVariant,
} from './types';

export interface ProbeScheduleEntry {
  account: ProbeAccount;
  accountIndex: number;
  country: string;
  block: number;
  cellAttempt: number;
  arm: ProbeExperimentArm;
  routeVariantId: string;
  authCountry: string;
  checkoutCountry: string;
  billingCountry: string;
  paymentMethod: string;
  seedOrdinal: number;
  designCellKey: string;
}

export const DEFAULT_CONTROLLED_FACTORS: ProbeExperimentFactor[] = [
  'account', 'country', 'route', 'paymentMethod', 'seed', 'time', 'sequence',
];

export const DEFAULT_ROUTE_VARIANTS: ProbeRouteVariant[] = [
  { id: 'same', authCountry: '@', checkoutCountry: '@', billingCountry: '@' },
  { id: 'split', authCountry: '@', checkoutCountry: 'VN', billingCountry: '@' },
];

export const EMPTY_EXPERIMENT_COVERAGE: ProbeExperimentCoverage = {
  generatedAt: 0,
  taskId: '',
  accountCount: 0,
  exitCountryCount: 0,
  totalCells: 0,
  coveredCells: 0,
  completedCells: 0,
  missingCells: 0,
  coveragePercent: 0,
  completionPercent: 0,
  targetSamplesPerCell: 3,
  minRepeatIntervalMinutes: 240,
  minTotalSamples: 100,
  matrixSampleSize: 0,
  sameAccountMultiExitCount: 0,
  sameExitMultiAccountCount: 0,
  repeatedCellCount: 0,
  crossTimeCellCount: 0,
  evidenceReady: false,
  armCounts: { exploit: 0, balanced: 0, explore: 0 },
  routeVariantCount: 0,
  paymentMethodCount: 0,
  seedOrdinalCount: 0,
  designCellCount: 0,
  blockers: ['尚未建立平衡实验矩阵'],
  cells: [],
};

export function normalizeExperimentMode(value: unknown, legacyResearchMode = false): ProbeExperimentMode {
  return value === 'discovery' || value === 'attribution' || value === 'hybrid'
    ? value
    : legacyResearchMode ? 'attribution' : 'discovery';
}

export function normalizeTrafficAllocation(input: {
  exploit?: unknown;
  balanced?: unknown;
  explore?: unknown;
}): Record<ProbeExperimentArm, number> {
  const raw = [input.exploit, input.balanced, input.explore].map((value, index) => {
    const fallback = [60, 25, 15][index];
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : fallback;
  });
  const total = raw.reduce((sum, value) => sum + value, 0);
  if (!total) return { exploit: 60, balanced: 25, explore: 15 };
  const scaled = raw.map((value) => (value / total) * 100);
  const base = scaled.map(Math.floor);
  let remaining = 100 - base.reduce((sum, value) => sum + value, 0);
  const order = scaled.map((value, index) => ({ index, fraction: value - base[index] }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let index = 0; index < remaining; index += 1) base[order[index % order.length].index] += 1;
  return { exploit: base[0], balanced: base[1], explore: base[2] };
}

export function normalizeControlledFactors(value: unknown): ProbeExperimentFactor[] {
  const allowed = new Set<ProbeExperimentFactor>(DEFAULT_CONTROLLED_FACTORS);
  if (!Array.isArray(value)) return [...DEFAULT_CONTROLLED_FACTORS];
  const values = value;
  const normalized = values.map((item) => String(item || '').trim() as ProbeExperimentFactor).filter((item) => allowed.has(item));
  return [...new Set(normalized)];
}

export function normalizeRouteVariants(value: unknown): ProbeRouteVariant[] {
  if (!Array.isArray(value)) return DEFAULT_ROUTE_VARIANTS.map((item) => ({ ...item }));
  const normalized = value.map((item, index) => {
    const source = item && typeof item === 'object' ? item as Partial<ProbeRouteVariant> : {};
    const id = String(source.id || `route-${index + 1}`).trim().replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40);
    const authCountry = normalizeRouteCountry(source.authCountry);
    const checkoutCountry = normalizeRouteCountry(source.checkoutCountry);
    const billingCountry = normalizeRouteCountry(source.billingCountry);
    return id && authCountry && checkoutCountry && billingCountry ? { id, authCountry, checkoutCountry, billingCountry } : null;
  }).filter((item): item is ProbeRouteVariant => Boolean(item));
  const seen = new Set<string>();
  const unique = normalized.filter((item) => !seen.has(item.id) && Boolean(seen.add(item.id)));
  return unique.length ? unique.slice(0, 20) : DEFAULT_ROUTE_VARIANTS.map((item) => ({ ...item }));
}

export function parseRouteVariantsText(raw: string): ProbeRouteVariant[] {
  const rows = String(raw || '').split(/\r?\n/).map((line, index) => {
    const text = line.trim();
    if (!text || text.startsWith('#')) return null;
    const splitAt = text.indexOf('=');
    const id = splitAt >= 0 ? text.slice(0, splitAt).trim() : `route-${index + 1}`;
    const route = (splitAt >= 0 ? text.slice(splitAt + 1) : text).split('>').map((item) => item.trim());
    return { id, authCountry: route[0], checkoutCountry: route[1], billingCountry: route[2] };
  }).filter(Boolean);
  return normalizeRouteVariants(rows);
}

export function formatRouteVariantsText(variants: ProbeRouteVariant[]): string {
  return normalizeRouteVariants(variants)
    .map((item) => `${item.id}=${item.authCountry}>${item.checkoutCountry}>${item.billingCountry}`)
    .join('\n');
}

export function buildProbeExperimentSchedule(input: {
  mode: ProbeExperimentMode;
  accounts: ProbeAccount[];
  countries: string[];
  preferredCountries?: string[];
  observations: ProbeObservation[];
  taskId: string;
  round: number;
  targetSamplesPerCell: number;
  minRepeatIntervalMinutes: number;
  balancedOrderEnabled?: boolean;
  traffic?: Partial<Record<ProbeExperimentArm, number>>;
  controlledFactors?: ProbeExperimentFactor[];
  routeVariants?: ProbeRouteVariant[];
  paymentMethodVariants?: string[];
  supportedPaymentMethodsByCountry?: Record<string, string[]>;
  seedReplicatesPerCell?: number;
  now?: number;
}): ProbeScheduleEntry[] {
  const controlled = new Set(normalizeControlledFactors(input.controlledFactors));
  const routes = normalizeRouteVariants(input.routeVariants);
  const seedReplicates = clampInt(input.seedReplicatesPerCell, 1, 20, 1);
  const paymentVariants = uniqueMethods(input.paymentMethodVariants || []);
  const preferred = new Set(uniqueCountries(input.preferredCountries || []));
  let balanced = buildBalancedProbeSchedule({
    accounts: input.accounts,
    countries: input.countries,
    observations: input.mode === 'discovery'
      ? []
      : input.mode === 'hybrid'
        ? input.observations.filter((item) => item.experimentArm === 'balanced')
        : input.observations,
    taskId: input.taskId,
    round: input.round,
    targetSamplesPerCell: input.mode === 'discovery' ? 1 : input.targetSamplesPerCell,
    minRepeatIntervalMinutes: input.mode === 'discovery' ? 0 : input.minRepeatIntervalMinutes,
    balancedOrderEnabled: input.balancedOrderEnabled,
    now: input.now,
  });
  if (input.mode === 'hybrid' && !balanced.length) {
    balanced = buildBalancedProbeSchedule({
      accounts: input.accounts,
      countries: input.countries,
      observations: [],
      taskId: input.taskId,
      round: input.round,
      targetSamplesPerCell: 1,
      minRepeatIntervalMinutes: 0,
      balancedOrderEnabled: input.balancedOrderEnabled,
      now: input.now,
    });
  }
  const decorate = (entry: ProbeScheduleEntry, arm: ProbeExperimentArm, index: number): ProbeScheduleEntry => {
    const route = controlled.has('route') ? routes[(entry.accountIndex + entry.cellAttempt + input.round + index) % routes.length] : routes[0];
    const supported = uniqueMethods(input.supportedPaymentMethodsByCountry?.[entry.country] || []);
    const allowed = paymentVariants.length ? supported.filter((method) => paymentVariants.includes(method)) : supported;
    const methods = paymentVariants.length ? allowed : supported;
    const paymentMethod = controlled.has('paymentMethod') && methods.length
      ? methods[(entry.accountIndex + entry.cellAttempt + index) % methods.length]
      : '';
    const seedOrdinal = controlled.has('seed') ? ((entry.cellAttempt + index - 1) % seedReplicates) + 1 : 1;
    const authCountry = materializeRouteCountry(route.authCountry, entry.country);
    const checkoutCountry = materializeRouteCountry(route.checkoutCountry, entry.country);
    const billingCountry = materializeRouteCountry(route.billingCountry, entry.country);
    return {
      ...entry,
      arm,
      routeVariantId: route.id,
      authCountry,
      checkoutCountry,
      billingCountry,
      paymentMethod,
      seedOrdinal,
      designCellKey: [entry.account.id, entry.country, route.id, paymentMethod || 'auto', seedOrdinal].join('|'),
    };
  };

  if (input.mode === 'attribution') return balanced.map((entry, index) => decorate(entry, 'balanced', index));
  if (input.mode === 'discovery') {
    return balanced.map((entry, index) => decorate(entry, preferred.size && !preferred.has(entry.country) ? 'explore' : 'exploit', index));
  }

  const traffic = normalizeTrafficAllocation({
    exploit: input.traffic?.exploit,
    balanced: input.traffic?.balanced,
    explore: input.traffic?.explore,
  });
  const desired = allocateCounts(balanced.length, traffic);
  const rotated = rotate(balanced, Math.max(0, input.round - 1));
  const pools: Record<ProbeExperimentArm, ProbeScheduleEntry[]> = {
    exploit: rotated.filter((entry) => !preferred.size || preferred.has(entry.country)),
    balanced: rotated,
    explore: rotated.filter((entry) => !preferred.size || !preferred.has(entry.country)),
  };
  const selected = new Set<string>();
  const result: ProbeScheduleEntry[] = [];
  const take = (arm: ProbeExperimentArm, count: number) => {
    if (count <= 0) return;
    for (const entry of pools[arm]) {
      const key = cellKey(entry.account.id, entry.country);
      if (selected.has(key)) continue;
      selected.add(key);
      result.push(decorate(entry, arm, result.length));
      if (--count <= 0) break;
    }
  };
  take('exploit', desired.exploit);
  take('explore', desired.explore);
  take('balanced', desired.balanced);
  take('balanced', balanced.length - result.length);
  return result;
}

export function buildBalancedProbeSchedule(input: {
  accounts: ProbeAccount[];
  countries: string[];
  observations: ProbeObservation[];
  taskId: string;
  round: number;
  targetSamplesPerCell: number;
  minRepeatIntervalMinutes: number;
  balancedOrderEnabled?: boolean;
  now?: number;
}): ProbeScheduleEntry[] {
  const now = input.now || Date.now();
  const accounts = uniqueAccounts(input.accounts);
  const countries = uniqueCountries(input.countries);
  const target = clampInt(input.targetSamplesPerCell, 1, 20, 3);
  const minIntervalMs = clampInt(input.minRepeatIntervalMinutes, 0, 10080, 240) * 60000;
  const cells = indexCellObservations(input.observations, input.taskId, new Set(accounts.map((item) => item.id)), new Set(countries));
  const candidates: Array<ProbeScheduleEntry & { latinPosition: number; lastObservedAt: number }> = [];

  for (let step = 0; step < countries.length; step += 1) {
    for (let accountIndex = 0; accountIndex < accounts.length; accountIndex += 1) {
      const countryIndex = input.balancedOrderEnabled === false
        ? step
        : (step + accountIndex + Math.max(0, input.round - 1)) % countries.length;
      const country = countries[countryIndex];
      const samples = cells.get(cellKey(accounts[accountIndex].id, country)) || [];
      const lastObservedAt = samples[samples.length - 1]?.observedAt || 0;
      if (samples.length >= target || (lastObservedAt && now - lastObservedAt < minIntervalMs)) continue;
      candidates.push({
        account: accounts[accountIndex],
        accountIndex,
        country,
        block: samples.length + 1,
        cellAttempt: samples.length + 1,
        latinPosition: (step * accounts.length) + accountIndex,
        lastObservedAt,
        arm: 'balanced',
        routeVariantId: 'same',
        authCountry: country,
        checkoutCountry: country,
        billingCountry: country,
        paymentMethod: '',
        seedOrdinal: 1,
        designCellKey: [accounts[accountIndex].id, country, 'same', 'auto', 1].join('|'),
      });
    }
  }

  return candidates
    .sort((a, b) => a.cellAttempt - b.cellAttempt || a.lastObservedAt - b.lastObservedAt || a.latinPosition - b.latinPosition)
    .map(({ latinPosition: _latinPosition, lastObservedAt: _lastObservedAt, ...entry }) => entry);
}

export function buildExperimentCoverage(input: {
  observations: ProbeObservation[];
  accountIds: string[];
  countries: string[];
  taskId?: string;
  targetSamplesPerCell: number;
  minRepeatIntervalMinutes: number;
  minTotalSamples: number;
  evidenceArm?: 'all' | 'balanced';
  now?: number;
}): ProbeExperimentCoverage {
  const now = input.now || Date.now();
  const accountIds = [...new Set(input.accountIds.map((item) => String(item || '').trim()).filter(Boolean))];
  const countries = uniqueCountries(input.countries);
  const target = clampInt(input.targetSamplesPerCell, 1, 20, 3);
  const minIntervalMinutes = clampInt(input.minRepeatIntervalMinutes, 0, 10080, 240);
  const minIntervalMs = minIntervalMinutes * 60000;
  const minTotalSamples = clampInt(input.minTotalSamples, 20, 10000, 100);
  const accountSet = new Set(accountIds);
  const countrySet = new Set(countries);
  const allIndexed = indexCellObservations(input.observations, input.taskId || '', accountSet, countrySet);
  const allObservations = [...allIndexed.values()].flat();
  const matrixObservations = input.evidenceArm === 'balanced'
    ? allObservations.filter((item) => item.experimentArm === 'balanced')
    : allObservations;
  const indexed = indexCellObservations(matrixObservations, '', accountSet, countrySet);
  const cells = accountIds.flatMap((accountId) => countries.map((country) => {
    const samples = indexed.get(cellKey(accountId, country)) || [];
    const firstObservedAt = samples[0]?.observedAt || 0;
    const lastObservedAt = samples[samples.length - 1]?.observedAt || 0;
    const spanMs = firstObservedAt && lastObservedAt ? Math.max(0, lastObservedAt - firstObservedAt) : 0;
    const intervalComplete = target <= 1 || spanMs >= minIntervalMs;
    const complete = samples.length >= target && intervalComplete;
    const nextEligibleAt = lastObservedAt && samples.length < target ? lastObservedAt + minIntervalMs : 0;
    return {
      accountId,
      country,
      samples: samples.length,
      targetSamples: target,
      firstObservedAt,
      lastObservedAt,
      nextEligibleAt,
      spanMinutes: Math.round(spanMs / 60000),
      status: complete ? 'complete' as const
        : !samples.length ? 'missing' as const
          : nextEligibleAt > now ? 'cooldown' as const
            : 'ready' as const,
    };
  }));
  const totalCells = cells.length;
  const coveredCells = cells.filter((item) => item.samples > 0).length;
  const completedCells = cells.filter((item) => item.status === 'complete').length;
  const repeatedCellCount = cells.filter((item) => item.samples >= 2).length;
  const crossTimeCellCount = cells.filter((item) => item.samples >= 2 && item.spanMinutes >= minIntervalMinutes).length;
  const accountExitSets = new Map<string, Set<string>>();
  const exitAccountSets = new Map<string, Set<string>>();
  for (const observation of matrixObservations) {
    const exit = exitIdentity(observation);
    if (!exit) continue;
    addToSetMap(accountExitSets, observation.accountId, exit);
    addToSetMap(exitAccountSets, exit, observation.accountId);
  }
  const sameAccountMultiExitCount = [...accountExitSets.values()].filter((set) => set.size >= 2).length;
  const sameExitMultiAccountCount = [...exitAccountSets.values()].filter((set) => set.size >= 2).length;
  const blockers: string[] = [];
  if (accountIds.length < 2) blockers.push('启用账号少于 2 个，无法执行同出口换账号对照');
  if (countries.length < 2) blockers.push('出口国家少于 2 个，无法执行同账号换出口对照');
  if (completedCells < totalCells) blockers.push(`完整矩阵 ${completedCells}/${totalCells} 单元达到目标重复数与时间间隔`);
  if (sameAccountMultiExitCount < accountIds.length) blockers.push(`同账号多出口覆盖 ${sameAccountMultiExitCount}/${accountIds.length}`);
  if (countries.length > 0 && sameExitMultiAccountCount < 1) blockers.push('尚无同一实际出口端点覆盖多个账号');
  if (matrixObservations.length < minTotalSamples) blockers.push(`平衡样本 ${matrixObservations.length}/${minTotalSamples}`);
  const evidenceReady = totalCells > 0 && blockers.length === 0;
  const armCounts: Record<ProbeExperimentArm, number> = { exploit: 0, balanced: 0, explore: 0 };
  for (const observation of allObservations) armCounts[observation.experimentArm || 'balanced'] += 1;

  return {
    generatedAt: now,
    taskId: input.taskId || '',
    accountCount: accountIds.length,
    exitCountryCount: countries.length,
    totalCells,
    coveredCells,
    completedCells,
    missingCells: Math.max(0, totalCells - completedCells),
    coveragePercent: percent(coveredCells, totalCells),
    completionPercent: percent(completedCells, totalCells),
    targetSamplesPerCell: target,
    minRepeatIntervalMinutes: minIntervalMinutes,
    minTotalSamples,
    matrixSampleSize: matrixObservations.length,
    sameAccountMultiExitCount,
    sameExitMultiAccountCount,
    repeatedCellCount,
    crossTimeCellCount,
    evidenceReady,
    armCounts,
    routeVariantCount: new Set(allObservations.map((item) => item.routeVariantId).filter(Boolean)).size,
    paymentMethodCount: new Set(allObservations.map((item) => item.plannedPaymentMethod || item.paymentMethod).filter(Boolean)).size,
    seedOrdinalCount: new Set(allObservations.map((item) => item.plannedSeedOrdinal).filter((item) => item > 0)).size,
    designCellCount: new Set(allObservations.map((item) => item.designCellKey).filter(Boolean)).size,
    blockers,
    cells: cells.sort((a, b) => statusWeight(a.status) - statusWeight(b.status) || a.samples - b.samples || a.accountId.localeCompare(b.accountId) || a.country.localeCompare(b.country)).slice(0, 1000),
  };
}

function indexCellObservations(
  observations: ProbeObservation[],
  taskId: string,
  accountIds: Set<string>,
  countries: Set<string>,
): Map<string, ProbeObservation[]> {
  const map = new Map<string, ProbeObservation[]>();
  for (const observation of observations) {
    if (!isCoverageObservation(observation)) continue;
    if (taskId && observation.taskId !== taskId) continue;
    if (!accountIds.has(observation.accountId) || !countries.has(observation.probeCountry)) continue;
    const key = cellKey(observation.accountId, observation.probeCountry);
    const rows = map.get(key) || [];
    rows.push(observation);
    map.set(key, rows);
  }
  for (const rows of map.values()) rows.sort((a, b) => a.observedAt - b.observedAt);
  return map;
}

function isCoverageObservation(observation: ProbeObservation): boolean {
  return observation.experimentValidForAttribution !== false
    && observation.outcome !== 'error'
    && observation.countryTreatmentApplied !== false;
}

function exitIdentity(observation: ProbeObservation): string {
  return observation.checkout.endpointSummary
    || observation.checkout.ip
    || observation.checkout.asn
    || observation.probeCountry;
}

function uniqueAccounts(accounts: ProbeAccount[]): ProbeAccount[] {
  const seen = new Set<string>();
  return accounts.filter((account) => Boolean(account.id) && !seen.has(account.id) && Boolean(seen.add(account.id)));
}

function uniqueCountries(countries: string[]): string[] {
  return [...new Set(countries.map((item) => String(item || '').trim().toUpperCase()).filter((item) => /^[A-Z]{2}$/.test(item)))];
}

function addToSetMap(map: Map<string, Set<string>>, key: string, value: string): void {
  const values = map.get(key) || new Set<string>();
  values.add(value);
  map.set(key, values);
}

function cellKey(accountId: string, country: string): string {
  return `${accountId}\u0000${country}`;
}

function percent(value: number, total: number): number {
  return total ? Math.round((value / total) * 1000) / 10 : 0;
}

function statusWeight(status: ProbeExperimentCoverage['cells'][number]['status']): number {
  return ({ missing: 0, ready: 1, cooldown: 2, complete: 3 })[status];
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function normalizeRouteCountry(value: unknown): string {
  const country = String(value || '').trim().toUpperCase();
  return country === '@' || /^[A-Z]{2}$/.test(country) ? country : '';
}

function materializeRouteCountry(value: string, selectedCountry: string): string {
  return value === '@' ? selectedCountry : value;
}

function uniqueMethods(methods: string[]): string[] {
  return [...new Set(methods.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean))].slice(0, 20);
}

function rotate<T>(values: T[], offset: number): T[] {
  if (!values.length) return [];
  const index = offset % values.length;
  return [...values.slice(index), ...values.slice(0, index)];
}

function allocateCounts(total: number, traffic: Record<ProbeExperimentArm, number>): Record<ProbeExperimentArm, number> {
  const arms: ProbeExperimentArm[] = ['exploit', 'balanced', 'explore'];
  const exact = arms.map((arm) => ({ arm, value: total * traffic[arm] / 100 }));
  const counts = Object.fromEntries(exact.map((item) => [item.arm, Math.floor(item.value)])) as Record<ProbeExperimentArm, number>;
  let remainder = total - arms.reduce((sum, arm) => sum + counts[arm], 0);
  const order = exact.sort((a, b) => (b.value - Math.floor(b.value)) - (a.value - Math.floor(a.value)) || arms.indexOf(a.arm) - arms.indexOf(b.arm));
  for (let index = 0; index < remainder; index += 1) counts[order[index % order.length].arm] += 1;
  if (total >= arms.filter((arm) => traffic[arm] > 0).length) {
    for (const arm of arms.filter((item) => traffic[item] > 0 && counts[item] === 0)) {
      const donor = arms.filter((item) => counts[item] > 1).sort((a, b) => counts[b] - counts[a])[0];
      if (donor) { counts[donor] -= 1; counts[arm] += 1; }
    }
  }
  return counts;
}
