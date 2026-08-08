import type { PaymentMethodId } from './types';

export type StrictGateReason =
  | 'payload_malformed'
  | 'amount_missing' | 'amount_malformed' | 'amount_conflict' | 'amount_not_zero'
  | 'mode_missing' | 'mode_malformed' | 'mode_conflict' | 'mode_not_subscription'
  | 'currency_missing' | 'currency_malformed' | 'currency_conflict' | 'currency_unexpected'
  | 'methods_missing' | 'methods_malformed' | 'methods_conflict' | 'expected_method_missing';

export interface StrictZeroGateResult {
  passed: boolean;
  amount: number | null;
  mode: string | null;
  currency: string | null;
  methods: string[] | null;
  reasons: StrictGateReason[];
  checkedAt: number;
}

type Path = readonly string[];
const AMOUNT_PATHS: Path[] = [
  ['total_summary', 'due'], ['amount_total'], ['amount'], ['elements_options', 'amount'], ['invoice', 'amount_due'],
];
const MODE_PATHS: Path[] = [['mode'], ['elements_options', 'mode']];
const CURRENCY_PATHS: Path[] = [
  ['currency'], ['elements_options', 'currency'], ['total_summary', 'currency'], ['invoice', 'currency'],
];
const METHOD_PATHS: Path[] = [
  ['payment_method_types'], ['elements_options', 'payment_method_types'], ['invoice', 'payment_method_types'],
];
const MISSING = Symbol('missing');
const MALFORMED = Symbol('malformed');

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readPath(payload: Record<string, unknown>, path: Path): unknown | typeof MISSING | typeof MALFORMED {
  let value: unknown = payload;
  for (const key of path) {
    if (!isRecord(value)) return MALFORMED;
    if (!Object.prototype.hasOwnProperty.call(value, key)) return MISSING;
    value = value[key];
  }
  return value;
}

function collect<T>(
  payload: Record<string, unknown>,
  paths: Path[],
  normalize: (value: unknown) => T | null,
  field: 'amount' | 'mode' | 'currency' | 'methods',
  reasons: StrictGateReason[],
): T | null {
  const values: T[] = [];
  let malformed = false;
  for (const path of paths) {
    const raw = readPath(payload, path);
    if (raw === MISSING) continue;
    if (raw === MALFORMED) {
      malformed = true;
      continue;
    }
    const normalized = normalize(raw);
    if (normalized === null) malformed = true;
    else values.push(normalized);
  }
  if (malformed) reasons.push(`${field}_malformed` as StrictGateReason);
  if (!values.length) reasons.push(`${field}_missing` as StrictGateReason);
  if (values.length > 1 && values.some((value) => JSON.stringify(value) !== JSON.stringify(values[0]))) {
    reasons.push(`${field}_conflict` as StrictGateReason);
  }
  return malformed || !values.length || reasons.includes(`${field}_conflict` as StrictGateReason) ? null : values[0];
}

function canonicalAmount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function canonicalMode(value: unknown): string | null {
  return typeof value === 'string' && ['payment', 'setup', 'subscription'].includes(value) ? value : null;
}

function canonicalCurrency(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z]{3}$/.test(value) ? value : null;
}

function canonicalMethods(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.length) return null;
  if (value.some((item) => typeof item !== 'string' || !/^[a-z][a-z0-9_]*$/.test(item))) return null;
  const result = [...value].sort();
  return new Set(result).size === result.length ? result : null;
}

export function evaluateStrictZeroGate(
  payload: unknown,
  expectedMethod: PaymentMethodId,
  expectedCurrency: string,
  now = Date.now(),
): StrictZeroGateResult {
  if (!isRecord(payload)) {
    return { passed: false, amount: null, mode: null, currency: null, methods: null, reasons: ['payload_malformed'], checkedAt: now };
  }
  const reasons: StrictGateReason[] = [];
  const amount = collect(payload, AMOUNT_PATHS, canonicalAmount, 'amount', reasons);
  const mode = collect(payload, MODE_PATHS, canonicalMode, 'mode', reasons);
  const currency = collect(payload, CURRENCY_PATHS, canonicalCurrency, 'currency', reasons);
  const methods = collect(payload, METHOD_PATHS, canonicalMethods, 'methods', reasons);
  if (amount !== null && amount !== 0) reasons.push('amount_not_zero');
  if (mode !== null && mode !== 'subscription') reasons.push('mode_not_subscription');
  if (currency !== null && currency !== expectedCurrency) reasons.push('currency_unexpected');
  if (methods !== null && !methods.includes(expectedMethod === 'kakao' ? 'kakao_pay' : expectedMethod)) {
    reasons.push('expected_method_missing');
  }
  return { passed: reasons.length === 0, amount, mode, currency, methods, reasons, checkedAt: now };
}

export function isDeterministicQualificationMiss(gate: StrictZeroGateResult): boolean {
  return gate.reasons.length > 0 && gate.reasons.every((reason) => [
    'amount_not_zero', 'mode_not_subscription', 'currency_unexpected', 'expected_method_missing',
  ].includes(reason));
}
