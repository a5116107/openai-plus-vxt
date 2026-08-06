export type PlusCheckoutClosurePhase =
  | 'idle'
  | 'session_ready'
  | 'checkout_a_creating'
  | 'checkout_a_qualified'
  | 'card_setup_running'
  | 'card_reconciled'
  | 'checkout_b_creating'
  | 'checkout_b_qualified'
  | 'saved_card_selected'
  | 'billing_ready'
  | 'subscription_submitting'
  | 'subscription_submitted'
  | 'setup_verifying'
  | 'subscription_verified'
  | 'failed_terminal'
  | 'side_effect_unknown'
  | 'paused_user_action'
  | 'cancelled';

export type PlusCheckoutClosureErrorCode =
  | 'IDENTITY_CHANGED'
  | 'CHECKOUT_A_NOT_ZERO'
  | 'CHECKOUT_SIDE_EFFECT_UNKNOWN'
  | 'SETUP_SIDE_EFFECT_UNKNOWN'
  | 'CARD_RECONCILE_FAILED'
  | 'CHECKOUT_NOT_DISTINCT'
  | 'QUALIFICATION_DRIFT'
  | 'SAVED_CARD_NOT_FOUND'
  | 'BILLING_VERIFY_FAILED'
  | 'SUBMIT_SIDE_EFFECT_UNKNOWN'
  | 'SUBSCRIPTION_NOT_VERIFIED'
  | 'NETWORK_EVIDENCE_MISSING'
  | 'CANCELLED';

export interface PlusCheckoutClosureSettings {
  enabled: boolean;
  liveEnabled: boolean;
  requireVerifiedNetwork: boolean;
  targetCountry: string;
  billingCountry: string;
  expectedCurrency: string;
}

export interface ClosureNetworkEvidence {
  plane: 'browser-auth' | 'browser-billing' | 'server-checkout';
  requestId: string;
  ip: string;
  country: string;
  colo: string;
  asn: string;
  verified: boolean;
  capturedAt: number;
}

export interface ClosureCheckoutEvidence {
  sessionId: string;
  processorEntity: string;
  canonicalUrl: string;
  planName: string;
  country: string;
  currency: string;
  amountMinor: number | null;
  zeroVerified: boolean;
  networkEvidence?: ClosureNetworkEvidence;
}

export interface ClosureSavedMethodEvidence {
  paymentMethodDigest: string;
  brand: string;
  last4: string;
  intentSucceeded: boolean;
  attached: boolean;
  reusable: boolean;
  defaultVerified: boolean;
}

export interface PlusCheckoutClosureRun {
  id: string;
  accountDigest: string;
  phase: PlusCheckoutClosurePhase;
  checkoutA?: ClosureCheckoutEvidence;
  savedMethod?: ClosureSavedMethodEvidence;
  checkoutB?: ClosureCheckoutEvidence;
  billingCountry: string;
  submitted: boolean;
  subscriptionVerified: boolean;
  networkEvidence: ClosureNetworkEvidence[];
  submitCount: number;
  verifyReference: string;
  finalPlanType: string;
  errorCode?: PlusCheckoutClosureErrorCode;
  message: string;
  createdAt: number;
  updatedAt: number;
}

export interface PlusCheckoutClosureDependencies {
  readSession(): Promise<{ accountDigest: string; planType?: string }>;
  createCheckout(input: {
    slot: 'A' | 'B';
    accountDigest: string;
    previousSessionId?: string;
  }): Promise<ClosureCheckoutEvidence>;
  saveCard(input: { accountDigest: string }): Promise<{
    status: 'reconciled' | 'paused' | 'side-effect-unknown';
    evidence?: ClosureSavedMethodEvidence;
    message?: string;
  }>;
  selectSavedCard(input: { expectedLast4: string }): Promise<{ selected: boolean; last4: string }>;
  fillAndVerifyBilling(input: { country: string }): Promise<{ verified: boolean; country: string }>;
  submitQualifiedCheckout(): Promise<{
    submitted: boolean;
    sideEffectUnknown?: boolean;
    verifyReference?: string;
  }>;
  verifySubscription(input: { verifyReference: string }): Promise<{ verified: boolean; planType: string }>;
  isCancelled?(): boolean;
  onCheckpoint?(run: PlusCheckoutClosureRun): Promise<void> | void;
  now?(): number;
  randomId?(): string;
}

export const DEFAULT_PLUS_CHECKOUT_CLOSURE_SETTINGS: PlusCheckoutClosureSettings = {
  enabled: false,
  liveEnabled: false,
  requireVerifiedNetwork: true,
  targetCountry: 'PH',
  billingCountry: 'US',
  expectedCurrency: 'PHP',
};

export function normalizePlusCheckoutClosureSettings(value: unknown): PlusCheckoutClosureSettings {
  const source = isRecord(value) ? value : {};
  return {
    enabled: Boolean(source.enabled),
    liveEnabled: Boolean(source.liveEnabled),
    requireVerifiedNetwork: source.requireVerifiedNetwork === undefined
      ? DEFAULT_PLUS_CHECKOUT_CLOSURE_SETTINGS.requireVerifiedNetwork
      : Boolean(source.requireVerifiedNetwork),
    targetCountry: country(source.targetCountry, DEFAULT_PLUS_CHECKOUT_CLOSURE_SETTINGS.targetCountry),
    billingCountry: country(source.billingCountry, DEFAULT_PLUS_CHECKOUT_CLOSURE_SETTINGS.billingCountry),
    expectedCurrency: currency(source.expectedCurrency, DEFAULT_PLUS_CHECKOUT_CLOSURE_SETTINGS.expectedCurrency),
  };
}

export function normalizePlusCheckoutClosureRun(value: unknown): PlusCheckoutClosureRun | undefined {
  if (!isRecord(value) || !String(value.id || '').trim()) return undefined;
  const phase = normalizePhase(value.phase);
  return {
    id: String(value.id),
    accountDigest: safeToken(value.accountDigest),
    phase,
    ...(normalizeCheckoutEvidence(value.checkoutA) ? { checkoutA: normalizeCheckoutEvidence(value.checkoutA) } : {}),
    ...(normalizeSavedMethodEvidence(value.savedMethod) ? { savedMethod: normalizeSavedMethodEvidence(value.savedMethod) } : {}),
    ...(normalizeCheckoutEvidence(value.checkoutB) ? { checkoutB: normalizeCheckoutEvidence(value.checkoutB) } : {}),
    billingCountry: country(value.billingCountry, ''),
    submitted: Boolean(value.submitted),
    subscriptionVerified: Boolean(value.subscriptionVerified),
    networkEvidence: normalizeNetworkEvidenceList(value.networkEvidence),
    submitCount: normalizeSubmitCount(value.submitCount),
    verifyReference: safeReference(value.verifyReference),
    finalPlanType: safeToken(value.finalPlanType),
    ...(normalizeErrorCode(value.errorCode) ? { errorCode: normalizeErrorCode(value.errorCode) } : {}),
    message: safeMessage(value.message),
    createdAt: nonNegativeSafeInteger(value.createdAt),
    updatedAt: nonNegativeSafeInteger(value.updatedAt),
  };
}

export function createPlusCheckoutClosureOrchestrator(
  dependencies: PlusCheckoutClosureDependencies,
  settingsInput: Partial<PlusCheckoutClosureSettings> = {},
) {
  const settings = normalizePlusCheckoutClosureSettings(settingsInput);
  let inFlight: Promise<PlusCheckoutClosureRun> | null = null;

  const run = (existing?: PlusCheckoutClosureRun): Promise<PlusCheckoutClosureRun> => {
    if (inFlight) return inFlight;
    inFlight = executePlusCheckoutClosure(existing, {
      dependencies,
      settings,
      now: dependencies.now || Date.now,
    }).finally(() => { inFlight = null; });
    return inFlight;
  };

  return { run, settings };
}

interface ClosureExecutionContext {
  dependencies: PlusCheckoutClosureDependencies;
  settings: PlusCheckoutClosureSettings;
  now: () => number;
}

async function executePlusCheckoutClosure(
  existing: PlusCheckoutClosureRun | undefined,
  context: ClosureExecutionContext,
): Promise<PlusCheckoutClosureRun> {
  const { dependencies, now } = context;
  const session = await dependencies.readSession();
  let state = existing ? sanitizePlusCheckoutClosureRun(existing) : freshRun(session.accountDigest, now(), dependencies.randomId);
  if (state.accountDigest && state.accountDigest !== session.accountDigest) {
    return checkpoint(failRun(state, 'IDENTITY_CHANGED', 'account digest changed', now()), dependencies);
  }
  const interrupted = interruptedWriteState(state, now());
  if (interrupted) state = await checkpoint(interrupted, dependencies);
  if (isStoppedState(state)) return checkpoint(state, dependencies);
  const recoveringUnknownSubmit = state.errorCode === 'SUBMIT_SIDE_EFFECT_UNKNOWN' && state.submitCount >= 1;
  if (dependencies.isCancelled?.()) return checkpoint(cancelRun(state, now()), dependencies);

  if (state.phase === 'idle') state = await transition(state, 'session_ready', dependencies, now());
  state = await advanceCheckoutA(state, context);
  if (isStoppedState(state)) return state;
  state = await advanceSavedCard(state, context);
  if (isStoppedState(state) || state.phase === 'paused_user_action') return state;
  state = await advanceCheckoutB(state, context);
  if (isStoppedState(state)) return state;
  state = await advanceCardSelectionAndBilling(state, context);
  if (isStoppedState(state)) return state;
  state = await advanceSubscriptionSubmit(state, context, recoveringUnknownSubmit);
  if (isStoppedState(state) && state.errorCode !== 'SUBMIT_SIDE_EFFECT_UNKNOWN') return state;
  if (!state.submitted && state.errorCode !== 'SUBMIT_SIDE_EFFECT_UNKNOWN') return state;
  return verifyPlusEntitlement(state, context);
}

async function advanceCheckoutA(state: PlusCheckoutClosureRun, context: ClosureExecutionContext): Promise<PlusCheckoutClosureRun> {
  const { dependencies, settings, now } = context;
  if (state.checkoutA) return state;
  state = await transition(state, 'checkout_a_creating', dependencies, now());
  let checkoutA: ClosureCheckoutEvidence;
  try {
    checkoutA = await dependencies.createCheckout({ slot: 'A', accountDigest: state.accountDigest });
  } catch (error) {
    return checkpoint(failRun(
      state, 'CHECKOUT_SIDE_EFFECT_UNKNOWN',
      `Checkout A create result unknown: ${errorMessage(error)}`, now(), 'side_effect_unknown',
    ), dependencies);
  }
  const gate = qualificationError(checkoutA, settings, 'A');
  if (gate) return checkpoint(failRun(state, gate, 'Checkout A qualification failed', now()), dependencies);
  state = { ...state, checkoutA, networkEvidence: appendNetwork(state.networkEvidence, checkoutA.networkEvidence) };
  return transition(state, 'checkout_a_qualified', dependencies, now());
}

async function advanceSavedCard(state: PlusCheckoutClosureRun, context: ClosureExecutionContext): Promise<PlusCheckoutClosureRun> {
  const { dependencies, now } = context;
  if (state.savedMethod) return state;
  if (await identityChanged(state, dependencies)) {
    return checkpoint(failRun(state, 'IDENTITY_CHANGED', 'account digest changed before card setup', now()), dependencies);
  }
  if (dependencies.isCancelled?.()) return checkpoint(cancelRun(state, now()), dependencies);
  state = await transition(state, 'card_setup_running', dependencies, now());
  let saved: Awaited<ReturnType<PlusCheckoutClosureDependencies['saveCard']>>;
  try {
    saved = await dependencies.saveCard({ accountDigest: state.accountDigest });
  } catch (error) {
    return checkpoint(failRun(
      state, 'SETUP_SIDE_EFFECT_UNKNOWN',
      `SetupIntent result unknown: ${errorMessage(error)}`, now(), 'side_effect_unknown',
    ), dependencies);
  }
  if (saved.status === 'paused') {
    return checkpoint({ ...state, phase: 'paused_user_action', message: safeMessage(saved.message), updatedAt: now() }, dependencies);
  }
  if (saved.status === 'side-effect-unknown') {
    return checkpoint(failRun(
      state, 'SETUP_SIDE_EFFECT_UNKNOWN', saved.message || 'setup side effect unknown', now(), 'side_effect_unknown',
    ), dependencies);
  }
  const savedMethod = saved.evidence ? normalizeSavedMethodEvidence(saved.evidence) : undefined;
  if (!savedMethod || !savedMethod.intentSucceeded || !savedMethod.attached || !savedMethod.reusable) {
    return checkpoint(failRun(state, 'CARD_RECONCILE_FAILED', saved.message || 'saved card reconciliation failed', now()), dependencies);
  }
  state = { ...state, savedMethod };
  return transition(state, 'card_reconciled', dependencies, now());
}

async function advanceCheckoutB(state: PlusCheckoutClosureRun, context: ClosureExecutionContext): Promise<PlusCheckoutClosureRun> {
  const { dependencies, settings, now } = context;
  if (state.checkoutB) return state;
  if (await identityChanged(state, dependencies)) {
    return checkpoint(failRun(state, 'IDENTITY_CHANGED', 'account digest changed before Checkout B', now()), dependencies);
  }
  if (dependencies.isCancelled?.()) return checkpoint(cancelRun(state, now()), dependencies);
  state = await transition(state, 'checkout_b_creating', dependencies, now());
  let checkoutB: ClosureCheckoutEvidence;
  try {
    checkoutB = await dependencies.createCheckout({
      slot: 'B', accountDigest: state.accountDigest, previousSessionId: state.checkoutA?.sessionId,
    });
  } catch (error) {
    return checkpoint(failRun(
      state, 'CHECKOUT_SIDE_EFFECT_UNKNOWN',
      `Checkout B create result unknown: ${errorMessage(error)}`, now(), 'side_effect_unknown',
    ), dependencies);
  }
  if (checkoutB.sessionId === state.checkoutA?.sessionId) {
    return checkpoint(failRun(state, 'CHECKOUT_NOT_DISTINCT', 'Checkout B reused Checkout A', now()), dependencies);
  }
  const gate = qualificationError(checkoutB, settings, 'B', state.checkoutA);
  if (gate) return checkpoint(failRun(state, gate, 'Checkout B qualification drifted', now()), dependencies);
  state = { ...state, checkoutB, networkEvidence: appendNetwork(state.networkEvidence, checkoutB.networkEvidence) };
  return transition(state, 'checkout_b_qualified', dependencies, now());
}

async function advanceCardSelectionAndBilling(
  state: PlusCheckoutClosureRun,
  context: ClosureExecutionContext,
): Promise<PlusCheckoutClosureRun> {
  const { dependencies, settings, now } = context;
  if (state.phase === 'checkout_b_qualified') {
    if (await identityChanged(state, dependencies)) {
      return checkpoint(failRun(state, 'IDENTITY_CHANGED', 'account digest changed before Saved Card selection', now()), dependencies);
    }
    const expectedLast4 = state.savedMethod?.last4 || '';
    if (!expectedLast4) {
      return checkpoint(failRun(state, 'CARD_RECONCILE_FAILED', 'saved card evidence is incomplete', now()), dependencies);
    }
    let selected: Awaited<ReturnType<PlusCheckoutClosureDependencies['selectSavedCard']>>;
    try {
      selected = await dependencies.selectSavedCard({ expectedLast4 });
    } catch (error) {
      return checkpoint(failRun(
        state, 'SAVED_CARD_NOT_FOUND', `saved card selection failed: ${errorMessage(error)}`, now(),
      ), dependencies);
    }
    if (!selected.selected || selected.last4 !== expectedLast4) {
      return checkpoint(failRun(state, 'SAVED_CARD_NOT_FOUND', 'expected saved card was not selected', now()), dependencies);
    }
    state = await transition(state, 'saved_card_selected', dependencies, now());
  }
  if (state.phase !== 'saved_card_selected') return state;
  let billing: Awaited<ReturnType<PlusCheckoutClosureDependencies['fillAndVerifyBilling']>>;
  try {
    billing = await dependencies.fillAndVerifyBilling({ country: settings.billingCountry });
  } catch (error) {
    return checkpoint(failRun(
      state, 'BILLING_VERIFY_FAILED', `billing address verification failed: ${errorMessage(error)}`, now(),
    ), dependencies);
  }
  if (!billing.verified || country(billing.country, '') !== settings.billingCountry) {
    return checkpoint(failRun(state, 'BILLING_VERIFY_FAILED', 'billing address verification failed', now()), dependencies);
  }
  state = { ...state, billingCountry: settings.billingCountry };
  return transition(state, 'billing_ready', dependencies, now());
}

async function advanceSubscriptionSubmit(
  state: PlusCheckoutClosureRun,
  context: ClosureExecutionContext,
  recoveringUnknownSubmit: boolean,
): Promise<PlusCheckoutClosureRun> {
  const { dependencies, now } = context;
  if (state.submitted || recoveringUnknownSubmit) return state;
  if (state.phase !== 'billing_ready') return state;
  if (await identityChanged(state, dependencies)) {
    return checkpoint(failRun(state, 'IDENTITY_CHANGED', 'account digest changed before submit', now()), dependencies);
  }
  if (dependencies.isCancelled?.()) return checkpoint(cancelRun(state, now()), dependencies);
  state = await checkpoint({
    ...state,
    phase: 'subscription_submitting',
    submitCount: 1,
    message: 'subscription submit started',
    updatedAt: now(),
  }, dependencies);
  let submit: Awaited<ReturnType<PlusCheckoutClosureDependencies['submitQualifiedCheckout']>>;
  try {
    submit = await dependencies.submitQualifiedCheckout();
  } catch (error) {
    submit = { submitted: false, sideEffectUnknown: true };
    state = { ...state, message: safeMessage(errorMessage(error)) };
  }
  if (submit.sideEffectUnknown) {
    return checkpoint({
      ...state,
      phase: 'side_effect_unknown',
      errorCode: 'SUBMIT_SIDE_EFFECT_UNKNOWN',
      submitCount: 1,
      verifyReference: safeReference(submit.verifyReference),
      message: 'submit side effect unknown',
      updatedAt: now(),
    }, dependencies);
  }
  if (!submit.submitted) {
    return checkpoint(failRun(state, 'SUBMIT_SIDE_EFFECT_UNKNOWN', 'checkout submit did not complete', now()), dependencies);
  }
  state = { ...state, submitted: true, submitCount: 1, verifyReference: safeReference(submit.verifyReference) };
  return transition(state, 'subscription_submitted', dependencies, now());
}

async function verifyPlusEntitlement(
  state: PlusCheckoutClosureRun,
  context: ClosureExecutionContext,
): Promise<PlusCheckoutClosureRun> {
  const { dependencies, now } = context;
  state = await transition(state, 'setup_verifying', dependencies, now());
  let verified: Awaited<ReturnType<PlusCheckoutClosureDependencies['verifySubscription']>>;
  try {
    verified = await dependencies.verifySubscription({ verifyReference: state.verifyReference });
  } catch (error) {
    return checkpoint({
      ...state,
      phase: 'side_effect_unknown',
      errorCode: 'SUBMIT_SIDE_EFFECT_UNKNOWN',
      submitCount: Math.max(1, state.submitCount),
      message: safeMessage(`subscription verification unavailable: ${errorMessage(error)}`),
      updatedAt: now(),
    }, dependencies);
  }
  if (!verified.verified || !isPlusPlan(verified.planType)) {
    if (state.errorCode === 'SUBMIT_SIDE_EFFECT_UNKNOWN') {
      return checkpoint({
        ...state,
        phase: 'side_effect_unknown',
        errorCode: 'SUBMIT_SIDE_EFFECT_UNKNOWN',
        message: 'submit state is still unknown; entitlement is not Plus yet',
        updatedAt: now(),
      }, dependencies);
    }
    return checkpoint(failRun(state, 'SUBSCRIPTION_NOT_VERIFIED', 'server entitlement is not Plus', now()), dependencies);
  }
  state = {
    ...state,
    errorCode: undefined,
    submitted: true,
    subscriptionVerified: true,
    finalPlanType: safeToken(verified.planType),
    message: 'Plus entitlement verified',
  };
  return transition(state, 'subscription_verified', dependencies, now());
}

function isStoppedState(state: PlusCheckoutClosureRun): boolean {
  return state.phase === 'subscription_verified' || state.phase === 'failed_terminal' ||
    state.phase === 'cancelled' ||
    (state.phase === 'side_effect_unknown' && state.errorCode !== 'SUBMIT_SIDE_EFFECT_UNKNOWN');
}

function interruptedWriteState(
  state: PlusCheckoutClosureRun,
  now: number,
): PlusCheckoutClosureRun | undefined {
  if (state.phase === 'checkout_a_creating' || state.phase === 'checkout_b_creating') {
    return failRun(
      state, 'CHECKOUT_SIDE_EFFECT_UNKNOWN', 'checkout creation was interrupted; original result must be reconciled',
      now, 'side_effect_unknown',
    );
  }
  if (state.phase === 'card_setup_running') {
    return failRun(
      state, 'SETUP_SIDE_EFFECT_UNKNOWN', 'card setup was interrupted; original intent must be reconciled',
      now, 'side_effect_unknown',
    );
  }
  if (state.phase === 'subscription_submitting') {
    return {
      ...state,
      phase: 'side_effect_unknown',
      errorCode: 'SUBMIT_SIDE_EFFECT_UNKNOWN',
      submitCount: Math.max(1, state.submitCount),
      message: 'subscription submit was interrupted; verify without replay',
      updatedAt: now,
    };
  }
  return undefined;
}

export function sanitizePlusCheckoutClosureRun(run: PlusCheckoutClosureRun): PlusCheckoutClosureRun {
  return normalizePlusCheckoutClosureRun(run) || freshRun('', 0);
}

async function transition(
  state: PlusCheckoutClosureRun,
  phase: PlusCheckoutClosurePhase,
  dependencies: PlusCheckoutClosureDependencies,
  now: number,
): Promise<PlusCheckoutClosureRun> {
  return checkpoint({ ...state, phase, updatedAt: now }, dependencies);
}

async function checkpoint(
  state: PlusCheckoutClosureRun,
  dependencies: PlusCheckoutClosureDependencies,
): Promise<PlusCheckoutClosureRun> {
  const sanitized = sanitizePlusCheckoutClosureRun(state);
  await dependencies.onCheckpoint?.(sanitized);
  return sanitized;
}

function qualificationError(
  checkout: ClosureCheckoutEvidence,
  settings: PlusCheckoutClosureSettings,
  slot: 'A' | 'B',
  previous?: ClosureCheckoutEvidence,
): PlusCheckoutClosureErrorCode | undefined {
  if (!checkout.zeroVerified || checkout.amountMinor !== 0) {
    return slot === 'A' ? 'CHECKOUT_A_NOT_ZERO' : 'QUALIFICATION_DRIFT';
  }
  if (country(checkout.country, '') !== settings.targetCountry || currency(checkout.currency, '') !== settings.expectedCurrency) {
    return slot === 'A' ? 'CHECKOUT_A_NOT_ZERO' : 'QUALIFICATION_DRIFT';
  }
  if (previous && (checkout.planName !== previous.planName || checkout.country !== previous.country || checkout.currency !== previous.currency)) {
    return 'QUALIFICATION_DRIFT';
  }
  if (settings.requireVerifiedNetwork && checkout.networkEvidence?.verified !== true) {
    return 'NETWORK_EVIDENCE_MISSING';
  }
  return undefined;
}

function failRun(
  state: PlusCheckoutClosureRun,
  errorCode: PlusCheckoutClosureErrorCode,
  message: string,
  now: number,
  phase: PlusCheckoutClosurePhase = 'failed_terminal',
): PlusCheckoutClosureRun {
  return { ...state, phase, errorCode, message: safeMessage(message), updatedAt: now };
}

function cancelRun(state: PlusCheckoutClosureRun, now: number): PlusCheckoutClosureRun {
  return { ...state, phase: 'cancelled', errorCode: 'CANCELLED', message: 'closure cancelled', updatedAt: now };
}

async function identityChanged(
  state: PlusCheckoutClosureRun,
  dependencies: PlusCheckoutClosureDependencies,
): Promise<boolean> {
  const session = await dependencies.readSession();
  return Boolean(state.accountDigest && session.accountDigest !== state.accountDigest);
}

function freshRun(accountDigest: string, now: number, randomId?: () => string): PlusCheckoutClosureRun {
  return {
    id: randomId?.() || `pcc-${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    accountDigest: safeToken(accountDigest),
    phase: 'idle',
    billingCountry: '',
    submitted: false,
    subscriptionVerified: false,
    networkEvidence: [],
    submitCount: 0,
    verifyReference: '',
    finalPlanType: '',
    message: '',
    createdAt: now,
    updatedAt: now,
  };
}

function appendNetwork(list: ClosureNetworkEvidence[], evidence?: ClosureNetworkEvidence): ClosureNetworkEvidence[] {
  if (!evidence) return list;
  const normalized = normalizeNetworkEvidence(evidence);
  if (!normalized) return list;
  return [...list.filter((item) => !(item.plane === normalized.plane && item.requestId === normalized.requestId)), normalized].slice(-12);
}

function normalizeCheckoutEvidence(value: unknown): ClosureCheckoutEvidence | undefined {
  if (!isRecord(value) || !safeToken(value.sessionId)) return undefined;
  return {
    sessionId: safeToken(value.sessionId),
    processorEntity: safeToken(value.processorEntity),
    canonicalUrl: safeCheckoutReference(value.canonicalUrl),
    planName: safeToken(value.planName),
    country: country(value.country, ''),
    currency: currency(value.currency, ''),
    amountMinor: normalizeAmountMinor(value.amountMinor),
    zeroVerified: Boolean(value.zeroVerified),
    ...(normalizeNetworkEvidence(value.networkEvidence) ? { networkEvidence: normalizeNetworkEvidence(value.networkEvidence) } : {}),
  };
}

function normalizeSavedMethodEvidence(value: unknown): ClosureSavedMethodEvidence | undefined {
  if (!isRecord(value) || !/^\d{4}$/.test(String(value.last4 || ''))) return undefined;
  return {
    paymentMethodDigest: safeToken(value.paymentMethodDigest),
    brand: safeToken(value.brand),
    last4: String(value.last4),
    intentSucceeded: Boolean(value.intentSucceeded),
    attached: Boolean(value.attached),
    reusable: Boolean(value.reusable),
    defaultVerified: Boolean(value.defaultVerified),
  };
}

function normalizeNetworkEvidenceList(value: unknown): ClosureNetworkEvidence[] {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeNetworkEvidence).filter((item): item is ClosureNetworkEvidence => Boolean(item)).slice(-12);
}

function normalizeNetworkEvidence(value: unknown): ClosureNetworkEvidence | undefined {
  if (!isRecord(value)) return undefined;
  const plane = value.plane;
  if (plane !== 'browser-auth' && plane !== 'browser-billing' && plane !== 'server-checkout') return undefined;
  const ip = safeToken(value.ip);
  const evidenceCountry = country(value.country, '');
  if (!ip || !evidenceCountry) return undefined;
  return {
    plane,
    requestId: safeToken(value.requestId),
    ip,
    country: evidenceCountry,
    colo: safeToken(value.colo),
    asn: safeToken(value.asn),
    verified: Boolean(value.verified),
    capturedAt: nonNegativeSafeInteger(value.capturedAt),
  };
}

function normalizePhase(value: unknown): PlusCheckoutClosurePhase {
  const phases = new Set<PlusCheckoutClosurePhase>([
    'idle', 'session_ready', 'checkout_a_creating', 'checkout_a_qualified', 'card_setup_running',
    'card_reconciled', 'checkout_b_creating', 'checkout_b_qualified', 'saved_card_selected',
    'billing_ready', 'subscription_submitting', 'subscription_submitted', 'setup_verifying', 'subscription_verified',
    'failed_terminal', 'side_effect_unknown', 'paused_user_action', 'cancelled',
  ]);
  return phases.has(value as PlusCheckoutClosurePhase) ? value as PlusCheckoutClosurePhase : 'idle';
}

function normalizeErrorCode(value: unknown): PlusCheckoutClosureErrorCode | undefined {
  const codes = new Set<PlusCheckoutClosureErrorCode>([
    'IDENTITY_CHANGED', 'CHECKOUT_A_NOT_ZERO', 'CHECKOUT_SIDE_EFFECT_UNKNOWN', 'SETUP_SIDE_EFFECT_UNKNOWN', 'CARD_RECONCILE_FAILED',
    'CHECKOUT_NOT_DISTINCT', 'QUALIFICATION_DRIFT', 'SAVED_CARD_NOT_FOUND', 'BILLING_VERIFY_FAILED',
    'SUBMIT_SIDE_EFFECT_UNKNOWN', 'SUBSCRIPTION_NOT_VERIFIED', 'NETWORK_EVIDENCE_MISSING', 'CANCELLED',
  ]);
  return codes.has(value as PlusCheckoutClosureErrorCode) ? value as PlusCheckoutClosureErrorCode : undefined;
}

function isPlusPlan(value: string): boolean {
  return /(?:^|[-_\s])plus(?:$|[-_\s])/i.test(value) || value.toLowerCase() === 'chatgptplusplan';
}

function country(value: unknown, fallback: string): string {
  const normalized = String(value || fallback).trim().toUpperCase();
  return /^[A-Z]{2}$/.test(normalized) ? normalized : fallback;
}

function currency(value: unknown, fallback: string): string {
  const normalized = String(value || fallback).trim().toUpperCase();
  return /^[A-Z]{3}$/.test(normalized) ? normalized : fallback;
}

function safeToken(value: unknown): string {
  return String(value || '').replace(/[^A-Za-z0-9_.:@/-]/g, '').slice(0, 160);
}

function safeReference(value: unknown): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) {
      if (/secret|token|client/i.test(key)) url.searchParams.delete(key);
    }
    return url.href.slice(0, 500);
  } catch {
    return safeToken(raw);
  }
}

function safeCheckoutReference(value: unknown): string {
  const reference = safeReference(value);
  if (!reference) return '';
  try {
    const url = new URL(reference);
    return url.protocol === 'https:' && (url.hostname === 'chatgpt.com' || url.hostname === 'pay.openai.com')
      ? url.href
      : '';
  } catch {
    return '';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeMessage(value: unknown): string {
  const redacted = String(value || '')
    .replace(/(?:sk|pk)_(?:live|test)_[A-Za-z0-9_-]+/g, '[redacted-key]')
    .replace(/\bcookie\b\s*[:=]\s*[^\r\n]*/gi, 'cookie=[redacted]')
    .replace(/\b(accessToken|client_secret|authorization)\b\s*[:=]\s*(?:Bearer\s+)?(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1=[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted-jwt]');
  return redactPanCandidates(redacted).slice(0, 300);
}

function normalizeSubmitCount(value: unknown): number {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 1 ? 1 : 0;
}

function normalizeAmountMinor(value: unknown): number | null {
  if (value === null) return null;
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : null;
}

function nonNegativeSafeInteger(value: unknown): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function redactPanCandidates(value: string): string {
  return value.replace(/\b(?:\d[ -]?){11,18}\d\b/g, (candidate) => {
    const digits = candidate.replace(/\D/g, '');
    return isLuhnValid(digits) ? '[redacted-pan]' : candidate;
  });
}

function isLuhnValid(value: string): boolean {
  if (!/^\d{12,19}$/.test(value)) return false;
  let sum = 0;
  let shouldDouble = false;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    let digit = Number(value[index]);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
