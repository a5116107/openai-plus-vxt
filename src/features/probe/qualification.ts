import { parseStructuredCheckoutAmount } from '../link-extractor/checkout-amount';
import type {
  ProbeLinkVerificationLevel,
  ProbePaymentLinkAggregateStatus,
  ProbeQualificationDriftEvent,
  ProbeQualificationEvidence,
  ProbeQualificationEvidenceSource,
} from './types';

export interface CheckoutQualificationOptions {
  source: ProbeQualificationEvidenceSource;
  observedAt?: number;
  sessionId?: string;
  identityKey?: string;
  method?: string;
  entitlementVerified?: boolean;
  redactedPayloadHash?: string;
}

export function classifyCheckoutQualification(
  value: unknown,
  options: CheckoutQualificationOptions,
): ProbeQualificationEvidence {
  const parsed = parseStructuredCheckoutAmount(value);
  const text = qualificationText(value).toLowerCase();
  const methods = collectMethods(value);
  const trial = /free[_ -]?trial|trial_period|trialing|1-month-free|days? free|免费试用|首月免费|试用/i.test(text);
  const promo = /promo_campaign|promo|campaign|coupon|discount|introductory|percent_off|amount_off|1-month-free/i.test(text);
  const introductory = /introductory|intro_discount|first_period|first_month/i.test(text);
  const deferred = /payment_method_collection[^a-z]+(?:always|required)|save_payment_method|future_usage|deferred/i.test(text);
  const structuredTrial = hasStructuredTrial(value);
  const amount = parsed.amountMinor;
  const recurring = parsed.recurringAmountMinor;
  let type: ProbeQualificationEvidence['type'] = 'unknown';
  let qualified = false;

  if (options.entitlementVerified) {
    type = trial ? 'free_trial' : amount === 0 ? 'zero_amount' : 'candidate';
    qualified = true;
  } else if (amount !== null && amount > 0) {
    type = 'nonzero';
  } else if (amount === 0 && recurring !== null && recurring > 0 && (introductory || promo || trial)) {
    type = 'intro_discount_zero';
    qualified = true;
  } else if (amount === 0 && trial) {
    type = 'free_trial';
    qualified = true;
  } else if (amount === 0 && promo) {
    type = 'promo_zero';
    qualified = true;
  } else if (amount === 0 && (deferred || (recurring !== null && recurring > 0))) {
    type = 'deferred_payment';
    qualified = true;
  } else if (amount === 0) {
    type = 'zero_amount';
    qualified = true;
  } else if (structuredTrial) {
    type = 'free_trial';
    qualified = true;
  } else if (trial || promo) {
    type = 'candidate';
  }

  const observedAt = options.observedAt ?? Date.now();
  const level = evidenceLevel(options.source, amount, qualified, options.entitlementVerified);
  return {
    id: evidenceId(options.sessionId || '', options.method || '', level, observedAt),
    type,
    level,
    source: options.source,
    amountMinor: amount,
    recurringAmountMinor: recurring,
    currency: parsed.currency,
    sessionId: String(options.sessionId || ''),
    identityKey: String(options.identityKey || ''),
    method: String(options.method || '').toLowerCase(),
    methods,
    qualified,
    observedAt,
    redactedPayloadHash: String(options.redactedPayloadHash || ''),
  };
}

export function appendQualificationEvidence(
  currentLedger: ProbeQualificationEvidence[],
  currentDrifts: ProbeQualificationDriftEvent[],
  evidence: ProbeQualificationEvidence,
): { ledger: ProbeQualificationEvidence[]; driftEvents: ProbeQualificationDriftEvent[]; stopRequired: boolean } {
  const ledger = [...currentLedger.filter((item) => item.id !== evidence.id), evidence]
    .sort((a, b) => a.observedAt - b.observedAt)
    .slice(-20);
  const previous = ledger.length > 1 ? ledger[ledger.length - 2] : undefined;
  const additions = previous ? qualificationDrifts(previous, evidence) : [];
  const driftEvents = [...currentDrifts, ...additions]
    .filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index)
    .slice(-40);
  return { ledger, driftEvents, stopRequired: additions.some((item) => item.stopRequired) };
}

export function qualificationLinkAggregateStatus(input: {
  sessionMode?: 'independent_checkout' | 'reuse_eligibility_session';
  sessionDistinct?: boolean;
  sourceQualificationVerified?: boolean;
  sourceSessionReused?: boolean;
  methodOffered?: boolean;
  qualificationPreserved?: boolean;
  qualificationVerified?: boolean;
  finalLinkVerified?: boolean;
}): ProbePaymentLinkAggregateStatus {
  const sessionProven = input.sessionMode === 'independent_checkout'
    ? Boolean(input.sessionDistinct && input.sourceSessionReused)
    : Boolean(input.sourceSessionReused);
  return input.sourceQualificationVerified
    && sessionProven
    && input.methodOffered
    && input.qualificationPreserved
    && input.qualificationVerified
    && input.finalLinkVerified
    ? 'qualified_payment_link'
    : 'probe_required';
}

function qualificationDrifts(
  previous: ProbeQualificationEvidence,
  next: ProbeQualificationEvidence,
): ProbeQualificationDriftEvent[] {
  const changes: Array<{ kind: ProbeQualificationDriftEvent['kind']; before: string; after: string; stop: boolean }> = [];
  if (previous.amountMinor !== next.amountMinor) changes.push({ kind: 'amount', before: valueText(previous.amountMinor), after: valueText(next.amountMinor), stop: previous.qualified });
  if (previous.currency && next.currency && previous.currency !== next.currency) changes.push({ kind: 'currency', before: previous.currency, after: next.currency, stop: previous.qualified });
  if (previous.identityKey && next.identityKey && previous.identityKey !== next.identityKey) changes.push({ kind: 'identity', before: previous.identityKey, after: next.identityKey, stop: true });
  const beforeMethods = [...previous.methods].sort().join(',');
  const afterMethods = [...next.methods].sort().join(',');
  if (beforeMethods !== afterMethods) changes.push({ kind: 'payment-method', before: beforeMethods, after: afterMethods, stop: previous.qualified });
  if (previous.qualified && !next.qualified) changes.push({ kind: 'qualification', before: previous.type, after: next.type, stop: true });
  return changes.map((change) => ({
    id: `qualification-drift-${change.kind}-${stableKey(`${previous.id}|${next.id}|${change.before}|${change.after}`)}`,
    kind: change.kind,
    before: change.before,
    after: change.after,
    sessionId: next.sessionId || previous.sessionId,
    detectedAt: next.observedAt,
    stopRequired: change.stop,
  }));
}

function evidenceLevel(
  source: ProbeQualificationEvidenceSource,
  amount: number | null,
  qualified: boolean,
  entitlementVerified = false,
): ProbeLinkVerificationLevel {
  if (entitlementVerified || source === 'entitlement') return 'entitlement-verified';
  if (source === 'provider-final') return 'provider-final';
  if (source === 'checkout-page') return qualified || amount !== null ? 'strict-page' : 'page';
  return qualified || amount !== null ? 'strict-response' : 'candidate';
}

function collectMethods(value: unknown): string[] {
  const text = safeJson(value).toLowerCase();
  const methods = ['hosted', 'paypal', 'momo', 'gopay', 'ideal', 'upi', 'pix', 'blik', 'twint', 'kakao'];
  return methods.filter((method) => new RegExp(`(?:payment_method_types|payment_methods|methods)[^}]{0,300}\\b${method}\\b`, 'i').test(text));
}

function hasStructuredTrial(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasStructuredTrial);
  return Object.entries(value as Record<string, unknown>).some(([key, item]) => {
    if (/^(free_trial|trial_period|trial_period_days|trialing)$/i.test(key)) return Boolean(item) || item === 0;
    if (/^(status|mode|type)$/i.test(key) && typeof item === 'string' && /trialing|free_trial/i.test(item)) return true;
    return hasStructuredTrial(item);
  });
}

function evidenceId(sessionId: string, method: string, level: string, observedAt: number): string {
  return `qualification-${stableKey(`${sessionId}|${method}|${level}|${observedAt}`)}`;
}

function stableKey(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function valueText(value: number | null): string {
  return value === null ? 'unknown' : String(value);
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value || {}); } catch { return ''; }
}

function qualificationText(value: unknown): string {
  if (value === null || value === undefined || value === false) return '';
  if (value === true) return 'true';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(qualificationText).filter(Boolean).join(' ');
  if (typeof value !== 'object') return '';
  return Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => {
      const nested = qualificationText(item);
      return nested ? `${key} ${nested}` : '';
    })
    .filter(Boolean)
    .join(' ');
}
