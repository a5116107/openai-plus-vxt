import type { ProbeTaskConfig } from './types';

export type ProbeBudgetAction = 'probe-unit' | 'checkout' | 'payment-method' | 'confirm' | 'approve' | 'qualification-drift';

export interface ProbeBudgetCounters {
  probeUnits: number;
  checkoutAttempts: number;
  methodAttempts: number;
  confirmWrites: number;
  approveWrites: number;
  consecutiveQualificationDrifts: number;
}

export interface ProbeBudgetDecision {
  allowed: boolean;
  code: string;
  message: string;
}

export function evaluateProbeBudget(
  config: Pick<ProbeTaskConfig,
    | 'maxProbeUnitsPerRun'
    | 'maxCheckoutAttemptsPerUnit'
    | 'maxPaymentMethodsPerQualification'
    | 'maxWriteOperationsPerMethod'
    | 'maxConsecutiveQualificationDrifts'>,
  counters: ProbeBudgetCounters,
  action: ProbeBudgetAction,
): ProbeBudgetDecision {
  if (action === 'probe-unit' && counters.probeUnits >= config.maxProbeUnitsPerRun) return denied('PROBE_UNIT_BUDGET_EXHAUSTED');
  if (action === 'checkout' && counters.checkoutAttempts >= config.maxCheckoutAttemptsPerUnit) return denied('CHECKOUT_BUDGET_EXHAUSTED');
  if (action === 'payment-method' && counters.methodAttempts >= config.maxPaymentMethodsPerQualification) return denied('METHOD_BUDGET_EXHAUSTED');
  if ((action === 'confirm' || action === 'approve')
    && counters.confirmWrites + counters.approveWrites >= config.maxWriteOperationsPerMethod) return denied('WRITE_BUDGET_EXHAUSTED');
  if (action === 'qualification-drift'
    && counters.consecutiveQualificationDrifts >= config.maxConsecutiveQualificationDrifts) return denied('QUALIFICATION_DRIFT_STOP');
  return { allowed: true, code: 'BUDGET_AVAILABLE', message: 'budget available' };
}

export function buildPaymentOperationIdempotencyKey(
  runId: string,
  accountId: string,
  checkoutSessionId: string,
  method: string,
  routeVariantId = 'default',
  attemptOrdinal = 1,
): string {
  return ['payment-operation', runId, accountId, routeVariantId, checkoutSessionId, method.toLowerCase(), Math.max(1, attemptOrdinal)]
    .map((item) => encodeURIComponent(String(item || '').trim()))
    .join('/');
}

export function recoveryActionForPaymentCheckpoint(checkpoint: {
  status: string;
  confirmSubmitted: boolean;
  approveSubmitted: boolean;
  sideEffect: 'none' | 'confirmed' | 'unknown';
}): 'revalidate_completed' | 'query_original_checkout' | 'restart_read_only' {
  if (checkpoint.status === 'link_ready') return 'revalidate_completed';
  if (checkpoint.sideEffect === 'unknown' || checkpoint.confirmSubmitted || checkpoint.approveSubmitted) {
    return 'query_original_checkout';
  }
  return 'restart_read_only';
}

function denied(code: string): ProbeBudgetDecision {
  return { allowed: false, code, message: code.toLowerCase() };
}
