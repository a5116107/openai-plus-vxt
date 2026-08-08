import { isIdentitySnapshotReady } from './hosted-resolution';
import { listProbeCountries } from './countries';
import type { ProbeAccount, ProbeHitKind, ProbeHitRecord, ProbeTask } from './types';

export function emptyCheckoutRetryMetrics(): NonNullable<ProbeHitRecord['checkoutRetryMetrics']> {
  return { checkoutAttempts: 0, updateAttempts: 0, fullFlowAttempts: 0, cfRetryCount: 0, cfExitRotations: 0, invalidPromotionRebuilds: 0, pageFallbackAttempts: 0 };
}

export function addCheckoutRetryMetrics(
  total: NonNullable<ProbeHitRecord['checkoutRetryMetrics']>,
  item: ProbeHitRecord['checkoutRetryMetrics'],
): NonNullable<ProbeHitRecord['checkoutRetryMetrics']> {
  if (!item) return total;
  return {
    checkoutAttempts: total.checkoutAttempts + item.checkoutAttempts,
    updateAttempts: total.updateAttempts + item.updateAttempts,
    fullFlowAttempts: total.fullFlowAttempts + item.fullFlowAttempts,
    cfRetryCount: total.cfRetryCount + item.cfRetryCount,
    cfExitRotations: total.cfExitRotations + item.cfExitRotations,
    invalidPromotionRebuilds: total.invalidPromotionRebuilds + item.invalidPromotionRebuilds,
    pageFallbackAttempts: total.pageFallbackAttempts + item.pageFallbackAttempts,
  };
}

export function buildHit(
  task: ProbeTask,
  account: ProbeAccount,
  country: string,
  partial: Partial<ProbeHitRecord> & { ok: boolean; hitKind: ProbeHitKind; message: string },
): ProbeHitRecord {
  const meta = listProbeCountries().find((item) => item.country === country);
  return {
    id: `hit-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    taskId: task.id,
    accountId: account.id,
    email: account.email,
    country,
    currency: meta?.currency || '',
    planName: task.config.planName,
    ok: partial.ok,
    hitKind: partial.hitKind,
    message: partial.message,
    link: partial.link || '',
    longUrl: partial.longUrl || '',
    shortUrl: partial.shortUrl || '',
    channels: partial.channels || [],
    amountHint: partial.amountHint || '',
    promoHint: partial.promoHint || '',
    createdAt: Date.now(),
    rawKeys: partial.rawKeys || [],
    tabId: partial.tabId,
    sniff: partial.sniff,
    finalPaymentUrl: partial.finalPaymentUrl || '',
    paymentMethod: partial.paymentMethod || '',
    finalUrlSource: partial.finalUrlSource || '',
    detectedMethods: partial.detectedMethods || [],
    paymentRunnerStatus: partial.paymentRunnerStatus || '',
    paymentRunnerStage: partial.paymentRunnerStage || '',
    paymentRunnerCode: partial.paymentRunnerCode || '',
    paymentCheckoutSessionMode: partial.paymentCheckoutSessionMode || task.config.paymentCheckoutSessionMode,
    paymentCheckoutStatus: partial.paymentCheckoutStatus || '',
    paymentCheckoutSessionDistinct: Boolean(partial.paymentCheckoutSessionDistinct),
    paymentMethodLinks: partial.paymentMethodLinks || [],
    qualificationVerified: Boolean(partial.qualificationVerified),
    qualificationType: partial.qualificationType || 'unknown',
    qualificationEvidenceLevel: partial.qualificationEvidenceLevel || 'candidate',
    qualificationLedger: partial.qualificationLedger || [],
    qualificationDriftEvents: partial.qualificationDriftEvents || [],
    submittedPaymentMethod: partial.submittedPaymentMethod || '',
    paymentRunnerConfirmSubmitted: Boolean(partial.paymentRunnerConfirmSubmitted),
    paymentRunnerConfirmSucceeded: Boolean(partial.paymentRunnerConfirmSucceeded),
    paymentRunnerApproveSubmitted: Boolean(partial.paymentRunnerApproveSubmitted),
    paymentRunnerApproveSucceeded: Boolean(partial.paymentRunnerApproveSucceeded),
    finalLinkVerified: Boolean(partial.finalLinkVerified),
    checkoutCreated: Boolean(partial.checkoutCreated),
    qualificationGateVersion: partial.qualificationGateVersion || '',
    linkVerificationLevel: partial.linkVerificationLevel || 'candidate',
    linkUsable: Boolean(partial.linkUsable),
    retryOrdinal: Math.max(1, partial.retryOrdinal || 1),
    checkoutUiMode: partial.checkoutUiMode || task.config.checkoutUiMode,
    checkoutVariants: partial.checkoutVariants || [],
    checkoutRetryMetrics: partial.checkoutRetryMetrics || emptyCheckoutRetryMetrics(),
    hostedResolutionStatus: partial.hostedResolutionStatus || 'not_required',
    hostedResolutionMessage: partial.hostedResolutionMessage || '',
    identitySnapshotReady: partial.identitySnapshotReady ?? isIdentitySnapshotReady(account.identitySnapshot),
    resolvedCheckoutSessionType: partial.resolvedCheckoutSessionType || 'unknown',
    hostedResolutionMethods: partial.hostedResolutionMethods || [],
    stripeResourceCount: Math.max(0, partial.stripeResourceCount || 0),
    stripePublishableKeyFound: Boolean(partial.stripePublishableKeyFound),
  };
}
