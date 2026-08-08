import { getPaymentMethodAdapter } from './runner-adapters';
import { evaluateStrictZeroGate, isDeterministicQualificationMiss } from './strict-zero-gate';
import type {
  PaymentApproveState,
  PaymentConfirmState,
  PaymentFinalState,
  PaymentMethodToken,
  PaymentPollState,
  PaymentProxyRole,
  PaymentQualificationSnapshot,
  PaymentRunnerContext,
  PaymentRunnerCheckpoint,
  PaymentRunnerEvent,
  PaymentRunnerHooks,
  PaymentRunnerResult,
  PaymentRunnerStage,
  PaymentRunnerStatus,
  PaymentRunnerTransport,
  PaymentStepResult,
} from './runner-types';

interface RunnerState {
  events: PaymentRunnerEvent[];
  stage: PaymentRunnerStage;
  gate?: PaymentQualificationSnapshot;
  paymentMethod?: PaymentMethodToken;
  confirm?: PaymentConfirmState;
  approve?: PaymentApproveState;
  poll?: PaymentPollState;
  confirmSubmitted: boolean;
  approveSubmitted: boolean;
  sideEffect: 'none' | 'confirmed' | 'unknown';
}

export async function runNativePaymentRunner(
  context: PaymentRunnerContext,
  transport: PaymentRunnerTransport,
  hooks: PaymentRunnerHooks = {},
): Promise<PaymentRunnerResult> {
  const adapter = getPaymentMethodAdapter(context.method);
  const expectedCurrency = adapter.resolveExpectedCurrency(context.checkoutCurrency);
  const now = hooks.now || Date.now;
  const state: RunnerState = {
    events: [], stage: 'screen', confirmSubmitted: false, approveSubmitted: false, sideEffect: 'none',
  };

  const recovery = validRecoveryCheckpoint(context, hooks.recovery);
  if (recovery) {
    state.stage = recovery.stage;
    state.confirmSubmitted = recovery.confirmSubmitted;
    state.approveSubmitted = recovery.approveSubmitted;
    state.sideEffect = recovery.sideEffect;
    state.gate = recovery.gate ? { payload: {}, gate: recovery.gate, revision: 0 } : undefined;
    state.paymentMethod = recovery.paymentMethodId ? { id: recovery.paymentMethodId } : undefined;
    state.confirm = recovery.confirm
      ? { payload: {}, requiresApproval: recovery.confirm.requiresApproval, redirectUrl: recovery.confirm.redirectUrl }
      : recovery.confirmSubmitted ? { payload: {}, requiresApproval: false } : undefined;
    state.approve = recovery.approve ? { payload: {}, approved: recovery.approve.approved } : undefined;
  }

  const saveCheckpoint = async (
    status: PaymentRunnerCheckpoint['status'] = 'running',
    code = '',
    finalUrl = '',
  ) => {
    await hooks.onCheckpoint?.({
      version: 1,
      operationKey: String(hooks.operationKey || recovery?.operationKey || ''),
      checkoutSessionId: context.checkoutSessionId,
      method: context.method,
      stage: state.stage,
      status,
      code,
      updatedAt: now(),
      confirmSubmitted: state.confirmSubmitted,
      approveSubmitted: state.approveSubmitted,
      sideEffect: state.sideEffect,
      paymentMethodId: state.paymentMethod?.id,
      gate: state.gate?.gate,
      confirm: state.confirm ? {
        requiresApproval: state.confirm.requiresApproval,
        ...(state.confirm.redirectUrl ? { redirectUrl: state.confirm.redirectUrl } : {}),
      } : undefined,
      approve: state.approve ? { approved: state.approve.approved } : undefined,
      ...(finalUrl ? { finalUrl } : {}),
    });
  };

  const emit = async (
    stage: PaymentRunnerStage,
    status: PaymentRunnerEvent['status'],
    code: string,
    message: string,
    gateReasons?: string[],
  ) => {
    const event: PaymentRunnerEvent = {
      stage, status, code, message, at: now(), proxyRole: adapter.proxyRole(stage), gateReasons,
    };
    state.events.push(event);
    await hooks.onEvent?.(event);
  };

  const begin = async (stage: PaymentRunnerStage) => {
    state.stage = stage;
    if (hooks.signal?.aborted) throw new DOMException('Payment runner aborted', 'AbortError');
    const role = adapter.proxyRole(stage);
    await hooks.beforeStage?.(stage, role);
    await emit(stage, 'started', 'STAGE_STARTED', `${stage} started`);
    await saveCheckpoint();
  };

  const finishFailure = async <T>(stage: PaymentRunnerStage, result: PaymentStepResult<T>): Promise<PaymentRunnerResult> => {
    await emit(stage, 'failed', result.code, result.message);
    const failure = buildFailure(context, state, result);
    await saveCheckpoint(failure.status, failure.code);
    return failure;
  };

  const qualify = async (
    stage: 'screen' | 'revalidate',
    result: PaymentStepResult<unknown>,
    revision: number,
  ): Promise<PaymentRunnerResult | null> => {
    if (!result.ok) return finishFailure(stage, result);
    const gate = evaluateStrictZeroGate(result.data, context.method, expectedCurrency, now());
    if (!gate.passed) {
      await emit(stage, 'failed', 'STRICT_GATE_CLOSED', gate.reasons.join(','), gate.reasons);
      const deterministic = isDeterministicQualificationMiss(gate);
      return {
        ok: false,
        status: deterministic ? 'not_qualified' : 'network_inconclusive',
        method: context.method,
        stage,
        code: deterministic ? 'STRICT_GATE_NOT_QUALIFIED' : 'STRICT_GATE_INCOMPLETE',
        message: gate.reasons.join(','),
        events: state.events,
        gate,
        confirmSubmitted: state.confirmSubmitted,
        approveSubmitted: state.approveSubmitted,
      };
    }
    state.gate = { payload: result.data, gate, revision };
    await emit(stage, 'passed', 'STRICT_GATE_PASSED', `revision=${revision}`);
    return null;
  };

  const revalidate = async (checkpoint: string, revision: number): Promise<PaymentRunnerResult | null> => {
    await begin('revalidate');
    return qualify('revalidate', await transport.revalidate(context, checkpoint), revision);
  };

  const pollAndFinalize = async (revision: number): Promise<PaymentRunnerResult> => {
    await begin('poll');
    const poll = await transport.poll(
      context,
      state.confirm || { payload: {}, requiresApproval: false },
      state.approve,
    );
    if (!poll.ok || !poll.data) return finishFailure('poll', poll);
    state.poll = poll.data;
    await emit('poll', 'passed', poll.code, poll.message);
    await saveCheckpoint();

    const failure = await revalidate('before_finalize', revision);
    if (failure) return failure;

    await begin('finalize');
    const final = await transport.finalize(context, state.poll);
    if (!final.ok || !final.data?.url) return finishFailure('finalize', final);
    if (!adapter.acceptsFinalUrl(final.data.url)) {
      return finishFailure('finalize', {
        ok: false,
        code: 'FINAL_URL_NOT_ALLOWED',
        message: 'final URL did not match the method allowlist',
        errorClass: 'invalid-final-url',
      } satisfies PaymentStepResult<PaymentFinalState>);
    }
    await emit('finalize', 'passed', final.code, final.message);
    state.sideEffect = state.confirmSubmitted ? 'confirmed' : state.sideEffect;
    await saveCheckpoint('link_ready', 'LINK_READY', final.data.url);
    return {
      ok: true,
      status: 'link_ready',
      method: context.method,
      stage: 'finalize',
      code: 'LINK_READY',
      message: 'strict qualification and final URL verified',
      events: state.events,
      gate: state.gate?.gate,
      paymentMethodId: state.paymentMethod?.id,
      finalUrl: final.data.url,
      confirmSubmitted: state.confirmSubmitted,
      approveSubmitted: state.approveSubmitted,
    };
  };

  try {
    if (!adapter.supportsNativeRunner) {
      return buildStaticFailure(context, state, 'screen', 'METHOD_RUNNER_UNAVAILABLE', 'method-unavailable');
    }
    if (!context.checkoutSessionId.startsWith('cs_') || !context.stripePublishableKey) {
      return buildStaticFailure(context, state, 'screen', 'RUNNER_CONTEXT_INVALID', 'internal');
    }

    if (recovery?.status === 'link_ready' && recovery.finalUrl && adapter.acceptsFinalUrl(recovery.finalUrl)) {
      return {
        ok: true,
        status: 'link_ready',
        method: context.method,
        stage: 'finalize',
        code: recovery.code || 'LINK_READY',
        message: 'restored completed payment operation',
        events: state.events,
        gate: recovery.gate,
        paymentMethodId: recovery.paymentMethodId,
        finalUrl: recovery.finalUrl,
        confirmSubmitted: recovery.confirmSubmitted,
        approveSubmitted: recovery.approveSubmitted,
      };
    }
    if (recovery?.confirmSubmitted || recovery?.approveSubmitted || recovery?.sideEffect === 'unknown') {
      await emit('poll', 'started', 'RECOVERY_QUERY_ORIGINAL_CHECKOUT', 'recover by polling original checkout only');
      return pollAndFinalize(6);
    }

    await begin('screen');
    const screenFailure = await qualify('screen', await transport.screen(context), 1);
    if (screenFailure) return screenFailure;

    let failure = await revalidate('before_create_pm', 2);
    if (failure) return failure;

    await begin('createPM');
    const pm = await transport.createPaymentMethod(context, state.gate!);
    if (!pm.ok || !pm.data?.id) return finishFailure('createPM', pm);
    state.paymentMethod = pm.data;
    await emit('createPM', 'passed', pm.code, pm.message);

    failure = await revalidate('before_confirm', 3);
    if (failure) return failure;

    await begin('confirm');
    state.confirmSubmitted = true;
    state.sideEffect = 'unknown';
    await saveCheckpoint('running', 'CONFIRM_SUBMITTED');
    const confirm = await transport.confirm(context, state.gate!, state.paymentMethod);
    if (!confirm.ok) {
      if (confirm.sideEffect !== 'unknown') return finishFailure('confirm', confirm);
      await emit('confirm', 'failed', confirm.code, `${confirm.message}; poll same checkout only`);
      state.confirm = confirm.data || { payload: {}, requiresApproval: false };
    } else {
      state.confirm = confirm.data;
      state.sideEffect = 'confirmed';
      await emit('confirm', 'passed', confirm.code, confirm.message);
    }
    await saveCheckpoint('running', confirm.code);

    if (state.confirm?.requiresApproval && confirm.ok) {
      if ((hooks.maxWriteOperations ?? 2) <= 1) {
        return finishFailure('approve', {
          ok: false,
          code: 'WRITE_BUDGET_EXHAUSTED',
          message: 'approve write budget exhausted after confirm',
          errorClass: 'side-effect-unknown',
          sideEffect: 'unknown',
        });
      }
      failure = await revalidate('before_approve', 4);
      if (failure) return failure;
      await begin('approve');
      state.approveSubmitted = true;
      state.sideEffect = 'unknown';
      await saveCheckpoint('running', 'APPROVE_SUBMITTED');
      const approve = await transport.approve(context, state.confirm);
      if (!approve.ok && approve.sideEffect !== 'unknown') return finishFailure('approve', approve);
      state.approve = approve.data;
      state.sideEffect = approve.ok ? 'confirmed' : 'unknown';
      await emit('approve', approve.ok ? 'passed' : 'failed', approve.code, approve.message);
      await saveCheckpoint('running', approve.code);
    } else {
      await emit('approve', 'skipped', 'APPROVE_NOT_REQUIRED', 'confirm does not require approval');
    }

    return pollAndFinalize(5);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      await emit(state.stage, 'failed', 'RUNNER_STOPPED', 'runner stopped');
      return buildStaticFailure(context, state, state.stage, 'RUNNER_STOPPED', 'network', 'stopped');
    }
    await emit(state.stage, 'failed', 'RUNNER_EXCEPTION', String(error));
    return buildStaticFailure(
      context,
      state,
      state.stage,
      'RUNNER_EXCEPTION',
      state.confirmSubmitted ? 'side-effect-unknown' : 'internal',
    );
  }
}

function validRecoveryCheckpoint(
  context: PaymentRunnerContext,
  checkpoint: PaymentRunnerCheckpoint | undefined,
): PaymentRunnerCheckpoint | undefined {
  return checkpoint
    && checkpoint.version === 1
    && checkpoint.checkoutSessionId === context.checkoutSessionId
    && checkpoint.method === context.method
    ? checkpoint
    : undefined;
}

function buildFailure<T>(
  context: PaymentRunnerContext,
  state: RunnerState,
  result: PaymentStepResult<T>,
): PaymentRunnerResult {
  return buildStaticFailure(context, state, state.stage, result.code, result.errorClass || 'internal');
}

function buildStaticFailure(
  context: PaymentRunnerContext,
  state: RunnerState,
  stage: PaymentRunnerStage,
  code: string,
  errorClass: NonNullable<PaymentStepResult<unknown>['errorClass']>,
  forcedStatus?: PaymentRunnerStatus,
): PaymentRunnerResult {
  const status: PaymentRunnerStatus = forcedStatus || ({
    qualification: 'not_qualified',
    'method-unavailable': 'method_unavailable',
    credential: 'credential_terminal',
    network: 'network_inconclusive',
    'rate-limit': 'network_inconclusive',
    'provider-decline': 'protocol_incompatible',
    protocol: 'protocol_incompatible',
    'side-effect-unknown': 'side_effect_inconclusive',
    'invalid-final-url': 'invalid_final_url',
    internal: state.confirmSubmitted ? 'side_effect_inconclusive' : 'network_inconclusive',
  } satisfies Record<string, PaymentRunnerStatus>)[errorClass];
  return {
    ok: false,
    status,
    method: context.method,
    stage,
    code,
    message: state.events.at(-1)?.message || code,
    events: state.events,
    gate: state.gate?.gate,
    paymentMethodId: state.paymentMethod?.id,
    confirmSubmitted: state.confirmSubmitted,
    approveSubmitted: state.approveSubmitted,
  };
}

export function paymentProxyRoleForStage(stage: PaymentRunnerStage, method: PaymentRunnerContext['method']): PaymentProxyRole {
  return getPaymentMethodAdapter(method).proxyRole(stage);
}
