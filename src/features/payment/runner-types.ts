import type { StrictZeroGateResult } from './strict-zero-gate';
import type { PaymentMethodId } from './types';

export type PaymentRunnerStage = 'screen' | 'revalidate' | 'createPM' | 'confirm' | 'approve' | 'poll' | 'finalize';
export type PaymentProxyRole = 'checkout' | 'provider' | 'approve';
export type PaymentSideEffect = 'none' | 'confirmed' | 'unknown';
export type PaymentRunnerErrorClass =
  | 'qualification' | 'method-unavailable' | 'credential' | 'network' | 'rate-limit'
  | 'provider-decline' | 'protocol' | 'side-effect-unknown' | 'invalid-final-url' | 'internal';
export type PaymentRunnerStatus =
  | 'link_ready' | 'not_qualified' | 'method_unavailable' | 'credential_terminal'
  | 'network_inconclusive' | 'protocol_incompatible' | 'side_effect_inconclusive'
  | 'invalid_final_url' | 'stopped';

export interface PaymentRunnerContext {
  method: PaymentMethodId;
  checkoutSessionId: string;
  stripePublishableKey: string;
  accessToken: string;
  processorEntity: string;
  billingCountry: string;
  /** Actual currency reported by the qualified Checkout session. */
  checkoutCurrency?: string;
  billingEmail?: string;
  returnUrl?: string;
}

export interface PaymentStepResult<T> {
  ok: boolean;
  data?: T;
  code: string;
  message: string;
  errorClass?: PaymentRunnerErrorClass;
  retryable?: boolean;
  sideEffect?: PaymentSideEffect;
}

export interface PaymentQualificationSnapshot {
  payload: unknown;
  gate: StrictZeroGateResult;
  revision: number;
}

export interface PaymentMethodToken {
  id: string;
  payload?: unknown;
}

export interface PaymentConfirmState {
  payload: unknown;
  requiresApproval: boolean;
  redirectUrl?: string;
}

export interface PaymentApproveState { payload: unknown; approved: boolean }
export interface PaymentPollState { payload: unknown; redirectUrl?: string }
export interface PaymentFinalState { url: string; payload?: unknown }

export interface PaymentRunnerTransport {
  screen(context: PaymentRunnerContext): Promise<PaymentStepResult<unknown>>;
  revalidate(context: PaymentRunnerContext, checkpoint: string): Promise<PaymentStepResult<unknown>>;
  createPaymentMethod(context: PaymentRunnerContext, snapshot: PaymentQualificationSnapshot): Promise<PaymentStepResult<PaymentMethodToken>>;
  confirm(context: PaymentRunnerContext, snapshot: PaymentQualificationSnapshot, paymentMethod: PaymentMethodToken): Promise<PaymentStepResult<PaymentConfirmState>>;
  approve(context: PaymentRunnerContext, confirm: PaymentConfirmState): Promise<PaymentStepResult<PaymentApproveState>>;
  poll(context: PaymentRunnerContext, confirm: PaymentConfirmState, approve?: PaymentApproveState): Promise<PaymentStepResult<PaymentPollState>>;
  finalize(context: PaymentRunnerContext, poll: PaymentPollState): Promise<PaymentStepResult<PaymentFinalState>>;
}

export interface PaymentRunnerEvent {
  stage: PaymentRunnerStage;
  status: 'started' | 'passed' | 'failed' | 'skipped';
  code: string;
  message: string;
  at: number;
  proxyRole: PaymentProxyRole;
  gateReasons?: string[];
}

export interface PaymentRunnerResult {
  ok: boolean;
  status: PaymentRunnerStatus;
  method: PaymentMethodId;
  stage: PaymentRunnerStage;
  code: string;
  message: string;
  events: PaymentRunnerEvent[];
  gate?: StrictZeroGateResult;
  paymentMethodId?: string;
  finalUrl?: string;
  confirmSubmitted: boolean;
  approveSubmitted: boolean;
}

export interface PaymentRunnerCheckpoint {
  version: 1;
  operationKey: string;
  checkoutSessionId: string;
  method: PaymentMethodId;
  stage: PaymentRunnerStage;
  status: 'running' | PaymentRunnerStatus;
  code: string;
  updatedAt: number;
  confirmSubmitted: boolean;
  approveSubmitted: boolean;
  sideEffect: PaymentSideEffect;
  paymentMethodId?: string;
  gate?: StrictZeroGateResult;
  confirm?: Pick<PaymentConfirmState, 'requiresApproval' | 'redirectUrl'>;
  approve?: Pick<PaymentApproveState, 'approved'>;
  finalUrl?: string;
}

export interface PaymentRunnerHooks {
  signal?: AbortSignal;
  now?: () => number;
  operationKey?: string;
  recovery?: PaymentRunnerCheckpoint;
  maxWriteOperations?: number;
  beforeStage?: (stage: PaymentRunnerStage, role: PaymentProxyRole) => Promise<void> | void;
  onEvent?: (event: PaymentRunnerEvent) => Promise<void> | void;
  onCheckpoint?: (checkpoint: PaymentRunnerCheckpoint) => Promise<void> | void;
}
