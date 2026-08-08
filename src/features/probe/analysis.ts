import type {
  ProbeAdaptiveRecommendation,
  ProbeConfoundingFinding,
  ProbeControlledEffect,
  ProbeDriftAlert,
  ProbeExperimentCoverage,
  ProbeFactorConclusion,
  ProbeFactorDimension,
  ProbeFactorReport,
  ProbeFactorRow,
  ProbeObservation,
} from './types';

const DAY_MS = 24 * 60 * 60 * 1000;
const isObservationAttributionEligible = (item: ProbeObservation): boolean => item.experimentValidForAttribution !== false
  && item.outcome !== 'error'
  && item.credentialStatus !== 'invalid'
  && item.countryTreatmentApplied !== false;
const ANALYSIS_DIMENSIONS: ProbeFactorDimension[] = [
  'account',
  'accountBatch',
  'accountSource',
  'probeCountry',
  'authCountry',
  'checkoutCountry',
  'billingCountry',
  'authIp',
  'checkoutIp',
  'billingIp',
  'authAsn',
  'checkoutAsn',
  'billingAsn',
  'paymentMethod',
  'plan',
  'currency',
  'clientVersion',
  'accountAge',
  'tokenAge',
  'tokenExpiryHorizon',
  'emailDomain',
  'browserProfile',
  'deviceCohort',
  'localeExitAlignment',
  'timeZoneExitAlignment',
  'sequencePosition',
  'scheduleBlock',
  'configuredRetries',
  'checkoutIpVersion',
  'localHour',
  'weekday',
  'routeSignature',
  'accountByCountry',
  'accountByCheckoutIp',
  'countryByPaymentMethod',
  'experimentMode',
  'experimentArm',
  'routeVariant',
  'plannedPaymentMethod',
  'submittedPaymentMethod',
  'qualificationGate',
  'linkVerificationLevel',
  'seedOrdinal',
  'designCell',
  'checkoutSubnet',
  'checkoutNetworkType',
  'checkoutSchema',
  'offerSet',
  'upstreamProtocol',
  'ruleEpoch',
  'campaign',
  'product',
  'checkoutMode',
  'retryOrdinal',
  'cooldownBucket',
];

export function wilsonInterval(successes: number, attempts: number, z = 1.96): { low: number; high: number } {
  if (attempts <= 0) return { low: 0, high: 100 };
  const n = attempts;
  const p = Math.max(0, Math.min(1, successes / n));
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p) / n) + (z2 / (4 * n * n)))) / denominator;
  return {
    low: roundPercent(Math.max(0, center - margin) * 100),
    high: roundPercent(Math.min(1, center + margin) * 100),
  };
}

export function buildFactorAnalysis(
  observations: ProbeObservation[],
  minSamples = 5,
  options: { driftAlerts?: ProbeDriftAlert[] } = {},
): ProbeFactorReport {
  const historicalSamples = observations.filter((item) => item && item.observedAt > 0).sort((a, b) => a.observedAt - b.observedAt);
  const epoch = selectCurrentEpoch(historicalSamples, options.driftAlerts || [], minSamples);
  const samples = epoch.samples;
  const attributionSamples = samples.filter(isObservationAttributionEligible);
  const hits = attributionSamples.filter((item) => item.outcome === 'hit').length;
  const errors = samples.filter((item) => item.outcome === 'error').length;
  const resolvedSamples = attributionSamples.length;
  const overallRate = resolvedSamples ? roundPercent((hits / resolvedSamples) * 100) : 0;
  const errorRate = samples.length ? roundPercent((errors / samples.length) * 100) : 0;
  const overallCi = wilsonInterval(hits, resolvedSamples);
  const rows: ProbeFactorRow[] = [];

  for (const dimension of ANALYSIS_DIMENSIONS) {
    const groups = new Map<string, ProbeObservation[]>();
    for (const observation of attributionSamples) {
      const value = factorValue(observation, dimension);
      if (!value) continue;
      const group = groups.get(value) || [];
      group.push(observation);
      groups.set(value, group);
    }
    for (const [value, group] of groups) {
      const groupHits = group.filter((item) => item.outcome === 'hit').length;
      const groupErrors = group.filter((item) => item.outcome === 'error').length;
      const groupResolved = group.length - groupErrors;
      const rate = groupResolved ? roundPercent((groupHits / groupResolved) * 100) : 0;
      const ci = wilsonInterval(groupHits, groupResolved);
      rows.push({
        dimension,
        value,
        attempts: group.length,
        resolved: groupResolved,
        hits: groupHits,
        errors: groupErrors,
        rate,
        confidenceLow: ci.low,
        confidenceHigh: ci.high,
        liftPercentPoints: roundPercent(rate - overallRate),
        confidence: confidenceLevel(groupResolved, ci.high - ci.low, minSamples),
        lastObservedAt: group.reduce((max, item) => Math.max(max, item.observedAt), 0),
      });
    }
  }

  rows.sort((a, b) => {
    const dimensionOrder = ANALYSIS_DIMENSIONS.indexOf(a.dimension) - ANALYSIS_DIMENSIONS.indexOf(b.dimension);
    if (dimensionOrder) return dimensionOrder;
    return (b.confidenceLow - a.confidenceLow) || (b.attempts - a.attempts) || a.value.localeCompare(b.value);
  });

  const quality = buildEvidenceQuality(samples, {
    epochCount: epoch.epochCount,
    latestEpochStartedAt: epoch.startedAt,
    historicalSampleSize: historicalSamples.length,
    attributionCurrentSampleSize: attributionSamples.length,
    driftAlerts: options.driftAlerts || [],
  });
  const conclusions = buildConclusions(rows, attributionSamples.length, minSamples);
  const controlledEffects = buildControlledEffects(attributionSamples, minSamples);
  const confoundingFindings = buildConfoundingFindings(attributionSamples);
  return {
    generatedAt: Date.now(),
    sampleSize: samples.length,
    resolvedSamples,
    hits,
    errors,
    errorRate,
    overallRate,
    overallConfidenceLow: overallCi.low,
    overallConfidenceHigh: overallCi.high,
    minSamples,
    rows,
    conclusions: quality.blockers.length
      ? conclusions.map((item) => ({
          ...item,
          evidence: 'insufficient' as const,
          score: 0,
          message: `${item.message}；数据质量门未满足：${quality.blockers[0] || '有效观测不足'}`,
        }))
      : conclusions,
    controlledEffects,
    confoundingFindings,
    powerPlan: buildPowerPlan(resolvedSamples, overallRate),
    repeatStability: buildRepeatStability(attributionSamples),
    caveats: buildCaveats(attributionSamples, minSamples, confoundingFindings),
    quality,
  };
}

export function detectEligibilityDrift(
  observations: ProbeObservation[],
  options: { minSamples?: number; recentWindowMs?: number; baselineWindowMs?: number; minRateDelta?: number } = {},
): ProbeDriftAlert[] {
  const minSamples = Math.max(2, options.minSamples || 10);
  const recentWindowMs = options.recentWindowMs || 7 * DAY_MS;
  const baselineWindowMs = options.baselineWindowMs || 30 * DAY_MS;
  const minRateDelta = options.minRateDelta || 15;
  const sorted = observations.filter((item) => item.observedAt > 0).sort((a, b) => a.observedAt - b.observedAt);
  if (sorted.length < minSamples * 2) return [];

  const maxAt = sorted[sorted.length - 1].observedAt;
  let recent = sorted.filter((item) => item.observedAt > maxAt - recentWindowMs);
  let baseline = sorted.filter((item) => item.observedAt <= maxAt - recentWindowMs && item.observedAt > maxAt - recentWindowMs - baselineWindowMs);
  if (recent.length < minSamples || baseline.length < minSamples) {
    const split = Math.floor(sorted.length / 2);
    baseline = sorted.slice(0, split);
    recent = sorted.slice(split);
  }

  const alerts: ProbeDriftAlert[] = [];
  compareRate(alerts, 'global', 'all', baseline, recent, 'eligibility-rate', minSamples, minRateDelta, maxAt);
  compareRate(alerts, 'global', 'all', baseline, recent, 'error-rate', minSamples, minRateDelta, maxAt);

  const driftDimensions: ProbeFactorDimension[] = [
    'probeCountry', 'account', 'authCountry', 'checkoutCountry', 'billingCountry',
    'authIp', 'checkoutIp', 'billingIp', 'paymentMethod', 'routeSignature',
    'accountAge', 'sequencePosition', 'scheduleBlock', 'configuredRetries', 'clientVersion',
  ];
  for (const dimension of driftDimensions) {
    const values = new Set([
      ...baseline.map((item) => factorValue(item, dimension)),
      ...recent.map((item) => factorValue(item, dimension)),
    ].filter(Boolean));
    for (const value of values) {
      const baseGroup = baseline.filter((item) => factorValue(item, dimension) === value);
      const recentGroup = recent.filter((item) => factorValue(item, dimension) === value);
      compareRate(alerts, dimension, value, baseGroup, recentGroup, 'eligibility-rate', minSamples, minRateDelta, maxAt);
      compareRate(alerts, dimension, value, baseGroup, recentGroup, 'error-rate', minSamples, minRateDelta, maxAt);
    }
  }

  comparePriceDrift(alerts, baseline, recent, minSamples, maxAt);
  compareMethodDrift(alerts, baseline, recent, minSamples, maxAt);
  compareCategoricalDrift(alerts, baseline, recent, minSamples, maxAt, 'protocol-schema', (item) => item.checkoutSchemaFingerprint);
  compareCategoricalDrift(alerts, baseline, recent, minSamples, maxAt, 'offer-set', (item) => item.offerSetFingerprint);
  return alerts
    .sort((a, b) => levelWeight(b.level) - levelWeight(a.level) || Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 200);
}

export function recommendAdaptiveExperiments(
  report: ProbeFactorReport,
  alerts: ProbeDriftAlert[],
  explorationPercent = 20,
  coverage?: ProbeExperimentCoverage,
): ProbeAdaptiveRecommendation[] {
  const recommendations: ProbeAdaptiveRecommendation[] = [];
  const seen = new Set<string>();
  for (const alert of alerts) {
    const key = `${alert.dimension}|${alert.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    recommendations.push({
      id: `adaptive-drift-${stableKey(key)}`,
      priority: alert.level === 'critical' ? 'urgent' : 'high',
      dimension: alert.dimension,
      value: alert.value,
      currentSamples: alert.recentSamples,
      targetSamples: Math.max(report.minSamples * 2, alert.recentSamples + report.minSamples),
      reason: `近期发生${driftKindLabel(alert.kind)}变化，优先复测以确认新规则`,
    });
  }

  for (const row of report.rows) {
    if (!['probeCountry', 'account', 'checkoutIp', 'billingIp', 'paymentMethod'].includes(row.dimension)) continue;
    if (row.attempts >= report.minSamples) continue;
    const key = `${row.dimension}|${row.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    recommendations.push({
      id: `adaptive-sample-${stableKey(key)}`,
      priority: 'normal',
      dimension: row.dimension,
      value: row.value,
      currentSamples: row.attempts,
      targetSamples: report.minSamples,
      reason: '样本不足，保留在实验流量中避免过早淘汰',
    });
  }

  for (const cell of coverage?.cells || []) {
    if (cell.status === 'complete') continue;
    const key = `accountByCountry|${cell.accountId}@${cell.country}`;
    if (seen.has(key)) continue;
    seen.add(key);
    recommendations.push({
      id: `adaptive-matrix-${stableKey(key)}`,
      priority: cell.status === 'ready' || cell.status === 'missing' ? 'high' : 'normal',
      dimension: 'accountByCountry',
      value: `${cell.accountId}@${cell.country}`,
      currentSamples: cell.samples,
      targetSamples: cell.targetSamples,
      reason: cell.status === 'cooldown'
        ? `平衡矩阵单元等待跨时段复测，最早 ${new Date(cell.nextEligibleAt).toLocaleString()}`
        : '平衡矩阵覆盖不足，优先补齐同账号换出口与同出口换账号对照',
    });
  }

  for (const effect of report.controlledEffects.filter((item) => item.evidence === 'insufficient')) {
    const key = `controlled|${effect.treatmentDimension}`;
    if (seen.has(key)) continue;
    seen.add(key);
    recommendations.push({
      id: `adaptive-controlled-${stableKey(key)}`,
      priority: 'high',
      dimension: effect.treatmentDimension,
      value: effect.levelA && effect.levelB ? `${effect.levelA}↔${effect.levelB}` : 'cross-over',
      currentSamples: effect.matchedSamples,
      targetSamples: Math.max(report.minSamples * 4, 20),
      reason: effect.message,
    });
  }
  for (const finding of report.confoundingFindings.filter((item) => item.level !== 'info')) {
    const key = `confounding|${finding.dimensionA}|${finding.dimensionB}`;
    if (seen.has(key)) continue;
    seen.add(key);
    recommendations.push({
      id: `adaptive-confounding-${stableKey(key)}`,
      priority: finding.level === 'critical' ? 'urgent' : 'high',
      dimension: finding.dimensionA,
      value: `${finding.dimensionA}×${finding.dimensionB}`,
      currentSamples: finding.samples,
      targetSamples: finding.samples + Math.max(report.minSamples * 2, 10),
      reason: `变量绑定 ${finding.dependencyPercent}%；安排同国家换 IP、同 IP 跨账号或随机顺序的交叉样本`,
    });
  }

  recommendations.push({
    id: 'adaptive-global-exploration',
    priority: 'normal',
    dimension: 'global',
    value: `${Math.max(5, Math.min(50, explorationPercent))}%`,
    currentSamples: report.sampleSize,
    targetSamples: Math.max(report.sampleSize + report.minSamples, report.minSamples * 4),
    reason: `每轮保留 ${Math.max(5, Math.min(50, explorationPercent))}% 给未知国家、低样本组和漂移组`,
  });
  return recommendations.slice(0, 120);
}

export function gateFactorReportByCoverage(
  report: ProbeFactorReport,
  coverage: ProbeExperimentCoverage,
): ProbeFactorReport {
  const matrixBalancePercent = matrixBalance(coverage.cells.map((item) => item.samples));
  if (coverage.evidenceReady) {
    return {
      ...report,
      quality: {
        ...report.quality,
        conclusionState: report.quality.conclusionState === 'drifting'
          ? 'drifting'
          : report.quality.blockers.length
            ? 'insufficient'
            : 'stable-association',
        matrixBalancePercent,
        score: Math.min(100, report.quality.score + 20),
      },
    };
  }
  const blocker = coverage.blockers[0] || '平衡实验覆盖不足';
  return {
    ...report,
    conclusions: report.conclusions.map((conclusion) => {
      if (!['account', 'country', 'exit', 'interaction', 'unexplained'].includes(conclusion.factor)) return conclusion;
      const subject = ({
        account: '账号主效应',
        country: '国家主效应',
        exit: '出口 IP/ASN 主效应',
        interaction: '账号与出口交互',
        unexplained: '随机分配或未观测规则',
      } as Record<string, string>)[conclusion.factor];
      const correlation = conclusion.factor === 'country' ? '；当前国家命中率只表示相关性' : '';
      return {
        ...conclusion,
        evidence: 'insufficient' as const,
        score: 0,
        message: `${subject}证据不足：${blocker}${correlation}`,
      };
    }),
    caveats: [
      ...coverage.blockers.map((item) => `平衡实验：${item}`),
      ...report.caveats,
    ].filter((item, index, values) => values.indexOf(item) === index),
    quality: {
      ...report.quality,
      conclusionState: report.quality.conclusionState === 'drifting' ? 'drifting' : 'insufficient',
      matrixBalancePercent,
      blockers: [...coverage.blockers, ...report.quality.blockers].filter((item, index, values) => values.indexOf(item) === index),
    },
  };
}

export function exportFactorAnalysisCsv(
  report: ProbeFactorReport,
  coverage?: ProbeExperimentCoverage,
  observations?: ProbeObservation[],
): string {
  if (observations) return exportObservationsCsv(observations);
  const lines = [
    ['qualityState', 'qualityScore', 'resolvedSamples', 'errorRate', 'protocolCount', 'dominantProtocolPercent', 'verifiedAuthPercent', 'verifiedCheckoutPercent', 'verifiedBillingPercent', 'matrixBalancePercent', 'minimumDetectableEffectPp', 'epochCount', 'latestEpochSamples'].join(','),
    [
      report.quality.conclusionState, report.quality.score, report.resolvedSamples, report.errorRate,
      report.quality.protocolCount, report.quality.dominantProtocolPercent, report.quality.verifiedAuthPercent,
      report.quality.verifiedCheckoutPercent, report.quality.verifiedBillingPercent, report.quality.matrixBalancePercent,
      report.quality.minimumDetectableEffectPp, report.quality.epochCount, report.quality.latestEpochSamples,
    ].map(csvEscape).join(','),
    '',
    ['dimension', 'value', 'attempts', 'resolved', 'hits', 'errors', 'ratePercent', 'ciLow', 'ciHigh', 'liftPp', 'confidence', 'lastObservedAt'].join(','),
  ];
  for (const row of report.rows) {
    lines.push([
      row.dimension, row.value, row.attempts, row.resolved, row.hits, row.errors, row.rate,
      row.confidenceLow, row.confidenceHigh, row.liftPercentPoints, row.confidence,
      new Date(row.lastObservedAt).toISOString(),
    ].map(csvEscape).join(','));
  }
  lines.push('');
  lines.push(['controlledFactor', 'treatmentDimension', 'controls', 'levelA', 'levelB', 'matchedStrata', 'matchedSamples', 'effectPp', 'directionConsistencyPercent', 'zScore', 'evidence', 'generalizable', 'message'].join(','));
  for (const effect of report.controlledEffects) {
    lines.push([
      effect.factor, effect.treatmentDimension, effect.controlDimensions.join('+'), effect.levelA, effect.levelB,
      effect.matchedStrata, effect.matchedSamples, effect.effectPercentPoints, effect.directionConsistencyPercent,
      effect.zScore, effect.evidence, effect.generalizable, effect.message,
    ].map(csvEscape).join(','));
  }
  lines.push('');
  lines.push(['confoundingDimensionA', 'confoundingDimensionB', 'relationship', 'dependencyPercent', 'samples', 'level', 'message'].join(','));
  for (const finding of report.confoundingFindings) {
    lines.push([
      finding.dimensionA, finding.dimensionB, finding.relationship, finding.dependencyPercent,
      finding.samples, finding.level, finding.message,
    ].map(csvEscape).join(','));
  }
  lines.push('');
  lines.push(['targetEffectPp', 'requiredPerGroup', 'requiredTotal', 'currentResolved', 'progressPercent', 'remainingSamples'].join(','));
  for (const target of report.powerPlan.targets) {
    lines.push([
      target.effectPercentPoints, target.requiredPerGroup, target.requiredTotal, target.currentResolved,
      target.progressPercent, target.remainingSamples,
    ].map(csvEscape).join(','));
  }
  lines.push('');
  lines.push(['repeatedCells', 'stableCells', 'variableCells', 'repeatedObservations', 'transitions', 'transitionOpportunities', 'stabilityPercent', 'transitionRatePercent', 'message'].join(','));
  lines.push([
    report.repeatStability.repeatedCells, report.repeatStability.stableCells, report.repeatStability.variableCells,
    report.repeatStability.repeatedObservations, report.repeatStability.transitions, report.repeatStability.transitionOpportunities,
    report.repeatStability.stabilityPercent, report.repeatStability.transitionRatePercent, report.repeatStability.message,
  ].map(csvEscape).join(','));
  if (coverage) {
    lines.push('');
    lines.push(['armExploit', 'armBalanced', 'armExplore', 'routeVariantCount', 'paymentMethodCount', 'seedOrdinalCount', 'designCellCount'].join(','));
    lines.push([
      coverage.armCounts.exploit, coverage.armCounts.balanced, coverage.armCounts.explore,
      coverage.routeVariantCount, coverage.paymentMethodCount, coverage.seedOrdinalCount, coverage.designCellCount,
    ].map(csvEscape).join(','));
    lines.push('');
    lines.push(['matrixAccountId', 'matrixCountry', 'samples', 'targetSamples', 'spanMinutes', 'status', 'lastObservedAt', 'nextEligibleAt'].join(','));
    for (const cell of coverage.cells) {
      lines.push([
        cell.accountId,
        cell.country,
        cell.samples,
        cell.targetSamples,
        cell.spanMinutes,
        cell.status,
        cell.lastObservedAt ? new Date(cell.lastObservedAt).toISOString() : '',
        cell.nextEligibleAt ? new Date(cell.nextEligibleAt).toISOString() : '',
      ].map(csvEscape).join(','));
    }
  }
  return lines.join('\n');
}

function exportObservationsCsv(observations: ProbeObservation[]): string {
  const headers = [
    'id', 'observedAt', 'taskId', 'runId', 'cycleId', 'unitId', 'attemptId', 'round', 'sequence', 'researchMode',
    'experimentMode', 'experimentArm', 'designCellKey', 'routeVariantId', 'plannedAuthCountry', 'plannedCheckoutCountry',
    'plannedBillingCountry', 'plannedPaymentMethod', 'plannedSeedOrdinal', 'scheduleBlock', 'scheduleCellAttempt',
    'accountId', 'accountBatchId', 'accountSource', 'accountAgeHours', 'tokenAgeHours', 'tokenExpiryHorizonHours',
    'emailDomainCohort', 'browserProfileCohort', 'deviceCohort', 'probeCountry', 'bootstrapCountry',
    'promotionCountry', 'providerCountry', 'channels', 'planName', 'paymentMethod', 'currency', 'campaignId', 'productId',
    'checkoutMode', 'outcome', 'hitKind',
    'amountHint', 'promoHint', 'detectedMethods', 'paymentRunnerStatus', 'paymentRunnerStage', 'paymentRunnerCode',
    'paymentCheckoutSessionMode', 'paymentCheckoutStatus', 'paymentCheckoutSessionDistinct', 'paymentMethodLinkCount',
    'qualificationVerified', 'submittedPaymentMethod', 'paymentRunnerConfirmSubmitted', 'paymentRunnerConfirmSucceeded',
    'paymentRunnerApproveSubmitted', 'paymentRunnerApproveSucceeded', 'finalLinkVerified', 'checkoutCreated',
    'qualificationGateVersion', 'linkVerificationLevel', 'linkUsable', 'credentialStatus',
    'actualAuthCountry', 'actualCheckoutCountry', 'actualBillingCountry', 'countryTreatmentApplied',
    'routeTreatmentApplied', 'paymentMethodTreatmentApplied', 'experimentValidityStatus',
    'experimentValidForAttribution', 'experimentValidityReasons',
    'errorClass', 'durationMs', 'configuredRetries', 'retryOrdinal', 'checkoutUiMode', 'checkoutAttempts', 'updateAttempts',
    'fullFlowAttempts', 'cfRetryCount', 'cfExitRotations', 'invalidPromotionRebuilds', 'pageFallbackAttempts',
    'cooldownElapsedMinutes', 'stagedPipelineEnabled',
    'entryProxyMode', 'exitProxyMode', 'frontProxySummary',
    ...['auth', 'checkout', 'billing'].flatMap((stage) => [
      `${stage}ConfiguredCountry`, `${stage}Country`, `${stage}Ip`, `${stage}Asn`, `${stage}Colo`, `${stage}LatencyMs`,
      `${stage}CheckedAt`, `${stage}CycleId`, `${stage}Endpoint`, `${stage}Source`, `${stage}Verified`, `${stage}Message`,
    ]),
    'bootstrapSeedSummary', 'promotionSeedSummary', 'providerSeedSummary', 'extensionVersion', 'browserFamily', 'locale', 'timeZone',
    'localeExitAlignment', 'timeZoneExitAlignment', 'checkoutSubnet', 'checkoutNetworkType', 'checkoutSchemaFingerprint',
    'offerSetFingerprint', 'upstreamProtocolFingerprint', 'ruleEpochId',
  ];
  const rows = observations.map((item) => {
    const stageValues = (stage: ProbeObservation['auth']) => [
      stage.configuredCountry, stage.country, stage.ip, stage.asn, stage.colo, stage.latencyMs,
      stage.checkedAt, stage.cycleId, stage.endpointSummary, stage.source, stage.verified, stage.message,
    ];
    return [
      item.id, item.observedAt, item.taskId, item.runId, item.cycleId, item.unitId, item.attemptId, item.round, item.sequence, item.researchMode,
      item.experimentMode, item.experimentArm, item.designCellKey, item.routeVariantId, item.plannedAuthCountry, item.plannedCheckoutCountry,
      item.plannedBillingCountry, item.plannedPaymentMethod, item.plannedSeedOrdinal, item.scheduleBlock, item.scheduleCellAttempt,
      item.accountId, item.accountBatchId, item.accountSource, item.accountAgeHours, item.tokenAgeHours, item.tokenExpiryHorizonHours,
      item.emailDomainCohort, item.browserProfileCohort, item.deviceCohort, item.probeCountry, item.bootstrapCountry,
      item.promotionCountry, item.providerCountry, item.channels.join('|'), item.planName, item.paymentMethod, item.currency,
      item.campaignId, item.productId, item.checkoutMode, item.outcome,
      item.hitKind, item.amountHint, item.promoHint, item.detectedMethods.join('|'), item.paymentRunnerStatus,
      item.paymentRunnerStage, item.paymentRunnerCode, item.paymentCheckoutSessionMode, item.paymentCheckoutStatus,
      item.paymentCheckoutSessionDistinct, item.paymentMethodLinkCount, item.qualificationVerified, item.submittedPaymentMethod,
      item.paymentRunnerConfirmSubmitted, item.paymentRunnerConfirmSucceeded, item.paymentRunnerApproveSubmitted,
      item.paymentRunnerApproveSucceeded, item.finalLinkVerified, item.checkoutCreated, item.qualificationGateVersion,
      item.linkVerificationLevel, item.linkUsable, item.credentialStatus,
      item.actualAuthCountry, item.actualCheckoutCountry, item.actualBillingCountry, item.countryTreatmentApplied,
      item.routeTreatmentApplied, item.paymentMethodTreatmentApplied, item.experimentValidityStatus,
      item.experimentValidForAttribution, item.experimentValidityReasons.join('|'), item.errorClass, item.durationMs,
      item.configuredRetries, item.retryOrdinal, item.checkoutUiMode, item.checkoutAttempts, item.updateAttempts,
      item.fullFlowAttempts, item.cfRetryCount, item.cfExitRotations, item.invalidPromotionRebuilds, item.pageFallbackAttempts,
      item.cooldownElapsedMinutes, item.stagedPipelineEnabled,
      item.entryProxyMode, item.exitProxyMode, item.frontProxySummary,
      ...stageValues(item.auth), ...stageValues(item.checkout), ...stageValues(item.billing),
      item.bootstrapSeedSummary, item.promotionSeedSummary, item.providerSeedSummary, item.extensionVersion,
      item.browserFamily, item.locale, item.timeZone, item.localeExitAlignment, item.timeZoneExitAlignment,
      item.checkoutSubnet, item.checkoutNetworkType, item.checkoutSchemaFingerprint, item.offerSetFingerprint,
      item.upstreamProtocolFingerprint, item.ruleEpochId,
    ].map(csvEscape).join(',');
  });
  return [headers.join(','), ...rows].join('\n');
}

function buildConclusions(rows: ProbeFactorRow[], sampleSize: number, minSamples: number): ProbeFactorConclusion[] {
  const definitions: Array<{ factor: ProbeFactorConclusion['factor']; dimensions: ProbeFactorDimension[]; label: string }> = [
    { factor: 'account', dimensions: ['account', 'accountBatch', 'accountSource'], label: '账号' },
    { factor: 'country', dimensions: ['probeCountry', 'authCountry', 'checkoutCountry', 'billingCountry'], label: '国家/阶段国家' },
    { factor: 'exit', dimensions: ['authIp', 'checkoutIp', 'billingIp', 'authAsn', 'checkoutAsn', 'billingAsn'], label: '出口 IP/ASN' },
    { factor: 'interaction', dimensions: ['accountByCountry', 'accountByCheckoutIp', 'countryByPaymentMethod', 'routeSignature', 'routeVariant', 'plannedPaymentMethod', 'seedOrdinal', 'designCell'], label: '变量交互' },
    { factor: 'time', dimensions: ['localHour', 'weekday', 'clientVersion'], label: '时间/客户端版本' },
  ];
  const conclusions: ProbeFactorConclusion[] = definitions.map((definition) => {
    const result = strongestDimensionEffect(rows, definition.dimensions, minSamples);
    if (!result) {
      return {
        factor: definition.factor,
        evidence: 'insufficient',
        score: 0,
        message: `${definition.label}样本不足，暂不下结论`,
        dimensions: definition.dimensions,
      };
    }
    const evidence = effectEvidence(result.spread, result.nonOverlap, result.minGroupSamples);
    return {
      factor: definition.factor,
      evidence,
      score: roundPercent(result.score),
      message: `${definition.label}最大组间差 ${roundPercent(result.spread)} 个百分点，最强维度 ${result.dimension}，证据 ${evidenceLabel(evidence)}`,
      dimensions: [result.dimension],
    };
  });
  const identified = conclusions.some((item) => item.evidence === 'moderate' || item.evidence === 'strong');
  conclusions.push({
    factor: 'unexplained',
    evidence: sampleSize < minSamples * 4 ? 'insufficient' : identified ? 'weak' : 'moderate',
    score: identified ? 20 : sampleSize < minSamples * 4 ? 0 : 55,
    message: sampleSize < minSamples * 4
      ? '总样本不足，随机性与未观测变量尚未区分'
      : identified
        ? '已观察到部分稳定因素，剩余波动仍可能来自随机分配或未采集变量'
        : '当前变量未识别出稳定主效应，剩余波动更符合随机性或未观测规则，但仍需扩大交叉样本',
    dimensions: [],
  });
  return conclusions;
}

function buildControlledEffects(samples: ProbeObservation[], minSamples: number): ProbeControlledEffect[] {
  const definitions: Array<{
    factor: ProbeControlledEffect['factor'];
    treatment: ProbeFactorDimension;
    controls: ProbeFactorDimension[];
  }> = [
    { factor: 'country', treatment: 'checkoutCountry', controls: ['account'] },
    { factor: 'country', treatment: 'authCountry', controls: ['account', 'checkoutCountry'] },
    { factor: 'country', treatment: 'billingCountry', controls: ['account', 'checkoutCountry'] },
    { factor: 'account', treatment: 'account', controls: ['checkoutCountry'] },
    { factor: 'exit-ip', treatment: 'checkoutIp', controls: ['account', 'checkoutCountry'] },
    { factor: 'exit-ip', treatment: 'authIp', controls: ['account', 'authCountry'] },
    { factor: 'exit-ip', treatment: 'billingIp', controls: ['account', 'billingCountry'] },
    { factor: 'exit-asn', treatment: 'checkoutAsn', controls: ['account', 'checkoutCountry'] },
    { factor: 'route', treatment: 'routeSignature', controls: ['account', 'probeCountry'] },
    { factor: 'route', treatment: 'routeVariant', controls: ['account', 'probeCountry'] },
    { factor: 'payment-method', treatment: 'submittedPaymentMethod', controls: ['account', 'probeCountry'] },
    { factor: 'seed', treatment: 'seedOrdinal', controls: ['account', 'probeCountry', 'routeVariant'] },
    { factor: 'time', treatment: 'localHour', controls: ['account', 'checkoutCountry'] },
    { factor: 'sequence', treatment: 'sequencePosition', controls: ['account', 'checkoutCountry'] },
    { factor: 'retry', treatment: 'retryOrdinal', controls: ['account', 'checkoutCountry'] },
  ];
  const resolved = samples.filter((item) => item.outcome !== 'error');
  return definitions.map((definition) => strongestMatchedEffect(resolved, definition, minSamples));
}

function strongestMatchedEffect(
  samples: ProbeObservation[],
  definition: { factor: ProbeControlledEffect['factor']; treatment: ProbeFactorDimension; controls: ProbeFactorDimension[] },
  minSamples: number,
): ProbeControlledEffect {
  const strata = new Map<string, Map<string, ProbeObservation[]>>();
  for (const sample of samples) {
    const treatment = factorValue(sample, definition.treatment);
    const control = definition.controls.map((dimension) => factorValue(sample, dimension)).join('|');
    if (!treatment || !control || control.includes('||')) continue;
    const groups = strata.get(control) || new Map<string, ProbeObservation[]>();
    const group = groups.get(treatment) || [];
    group.push(sample);
    groups.set(treatment, group);
    strata.set(control, groups);
  }

  const pairs = new Map<string, {
    levelA: string; levelB: string; strata: number; samples: number; weight: number;
    weightedDifference: number; directions: number[]; aHits: number; aTotal: number; bHits: number; bTotal: number;
  }>();
  for (const groups of strata.values()) {
    const levels = [...groups.keys()].sort();
    for (let left = 0; left < levels.length; left += 1) {
      for (let right = left + 1; right < levels.length; right += 1) {
        const levelA = levels[left];
        const levelB = levels[right];
        const groupA = groups.get(levelA) || [];
        const groupB = groups.get(levelB) || [];
        if (!groupA.length || !groupB.length) continue;
        const aHits = groupA.filter((item) => item.outcome === 'hit').length;
        const bHits = groupB.filter((item) => item.outcome === 'hit').length;
        const difference = ((bHits / groupB.length) - (aHits / groupA.length)) * 100;
        const weight = Math.min(groupA.length, groupB.length);
        const key = `${levelA}\u0000${levelB}`;
        const pair = pairs.get(key) || {
          levelA, levelB, strata: 0, samples: 0, weight: 0, weightedDifference: 0, directions: [],
          aHits: 0, aTotal: 0, bHits: 0, bTotal: 0,
        };
        pair.strata += 1;
        pair.samples += groupA.length + groupB.length;
        pair.weight += weight;
        pair.weightedDifference += difference * weight;
        pair.directions.push(Math.sign(difference));
        pair.aHits += aHits;
        pair.aTotal += groupA.length;
        pair.bHits += bHits;
        pair.bTotal += groupB.length;
        pairs.set(key, pair);
      }
    }
  }
  const candidates = [...pairs.values()].map((pair) => {
    const effect = pair.weight ? pair.weightedDifference / pair.weight : 0;
    const nonZero = pair.directions.filter(Boolean);
    const positive = nonZero.filter((value) => value > 0).length;
    const consistency = nonZero.length ? Math.max(positive, nonZero.length - positive) / nonZero.length * 100 : 0;
    return { ...pair, effect, consistency, z: twoProportionZ(pair.aHits, pair.aTotal, pair.bHits, pair.bTotal) };
  }).sort((a, b) => evidenceRank(matchedEvidence(b, minSamples)) - evidenceRank(matchedEvidence(a, minSamples))
    || b.strata - a.strata || Math.abs(b.effect) - Math.abs(a.effect));
  const best = candidates[0];
  if (!best) {
    return {
      id: `controlled-${definition.factor}-${definition.treatment}`, factor: definition.factor, treatmentDimension: definition.treatment,
      controlDimensions: definition.controls, levelA: '', levelB: '', matchedStrata: 0, matchedSamples: 0,
      effectPercentPoints: 0, directionConsistencyPercent: 0, zScore: 0, evidence: 'insufficient',
      generalizable: false, message: `缺少在相同${definition.controls.join('+')}内切换${definition.treatment}的交叉样本`,
    };
  }
  const evidence = matchedEvidence(best, minSamples);
  const generalizable = best.strata >= 3 && best.samples >= Math.max(20, minSamples * 4);
  return {
    id: `controlled-${definition.factor}-${definition.treatment}-${stableKey(`${best.levelA}|${best.levelB}`)}`,
    factor: definition.factor, treatmentDimension: definition.treatment, controlDimensions: definition.controls,
    levelA: best.levelA, levelB: best.levelB, matchedStrata: best.strata, matchedSamples: best.samples,
    effectPercentPoints: roundPercent(best.effect), directionConsistencyPercent: roundPercent(best.consistency),
    zScore: roundPercent(best.z), evidence, generalizable,
    message: evidence === 'insufficient'
      ? `已有 ${best.strata} 个匹配层，但样本或方向一致性仍不足`
      : `控制 ${definition.controls.join('+')} 后，${best.levelB} 相对 ${best.levelA} 差 ${roundPercent(best.effect)}pp`,
  };
}

function matchedEvidence(
  effect: { strata: number; samples: number; effect: number; consistency: number; z: number },
  minSamples: number,
): ProbeControlledEffect['evidence'] {
  const absoluteEffect = Math.abs(effect.effect);
  const absoluteZ = Math.abs(effect.z);
  if (effect.strata >= 5 && effect.samples >= Math.max(30, minSamples * 6) && absoluteEffect >= 15 && absoluteZ >= 2.58 && effect.consistency >= 70) return 'strong';
  if (effect.strata >= 3 && effect.samples >= Math.max(20, minSamples * 4) && absoluteEffect >= 10 && absoluteZ >= 1.96 && effect.consistency >= 60) return 'moderate';
  if (effect.strata >= 2 && effect.samples >= Math.max(10, minSamples * 2) && absoluteEffect >= 10) return 'weak';
  return 'insufficient';
}

function buildConfoundingFindings(samples: ProbeObservation[]): ProbeConfoundingFinding[] {
  const resolved = samples.filter((item) => item.outcome !== 'error');
  const pairs: Array<[ProbeFactorDimension, ProbeFactorDimension]> = [
    ['checkoutCountry', 'checkoutIp'],
    ['checkoutCountry', 'checkoutAsn'],
    ['probeCountry', 'sequencePosition'],
    ['account', 'probeCountry'],
    ['checkoutIp', 'account'],
    ['routeSignature', 'checkoutCountry'],
  ];
  const findings: ProbeConfoundingFinding[] = [];
  for (const [dimensionA, dimensionB] of pairs) {
    const values = resolved.map((item) => [factorValue(item, dimensionA), factorValue(item, dimensionB)] as const)
      .filter(([a, b]) => Boolean(a && b));
    if (values.length < 4) continue;
    const aToB = dependencyPercent(values, 0);
    const bToA = dependencyPercent(values, 1);
    if (Math.max(aToB, bToA) < 95) continue;
    const relationship = aToB >= 95 && bToA >= 95 ? 'one-to-one' : aToB >= 95 ? 'a-determines-b' : 'b-determines-a';
    const dependency = relationship === 'one-to-one' ? Math.min(aToB, bToA) : Math.max(aToB, bToA);
    findings.push({
      id: `confounding-${dimensionA}-${dimensionB}`, dimensionA, dimensionB, relationship,
      dependencyPercent: roundPercent(dependency), samples: values.length,
      level: relationship === 'one-to-one' ? 'critical' : 'warning',
      message: relationship === 'one-to-one'
        ? `${dimensionA} 与 ${dimensionB} 近似一一绑定，当前样本中两者效应不可区分`
        : `${relationship === 'a-determines-b' ? dimensionA : dimensionB} 几乎决定 ${relationship === 'a-determines-b' ? dimensionB : dimensionA}，需增加交叉路线`,
    });
  }
  return findings;
}

function dependencyPercent(values: ReadonlyArray<readonly [string, string]>, keyIndex: 0 | 1): number {
  const mapping = new Map<string, Set<string>>();
  for (const value of values) {
    const set = mapping.get(value[keyIndex]) || new Set<string>();
    set.add(value[keyIndex === 0 ? 1 : 0]);
    mapping.set(value[keyIndex], set);
  }
  const deterministic = values.filter((value) => mapping.get(value[keyIndex])?.size === 1).length;
  return values.length ? deterministic / values.length * 100 : 0;
}

function buildPowerPlan(currentResolved: number, overallRate: number): ProbeFactorReport['powerPlan'] {
  const baseline = Math.max(5, Math.min(95, overallRate || 50)) / 100;
  const targets = [10, 15, 20].map((effectPercentPoints) => {
    const effect = effectPercentPoints / 100;
    const comparison = baseline + effect <= 0.95 ? baseline + effect : baseline - effect;
    const midpoint = (baseline + comparison) / 2;
    const numerator = 1.96 * Math.sqrt(2 * midpoint * (1 - midpoint))
      + 0.84 * Math.sqrt(baseline * (1 - baseline) + comparison * (1 - comparison));
    const requiredPerGroup = Math.max(2, Math.ceil((numerator * numerator) / (effect * effect)));
    const requiredTotal = requiredPerGroup * 2;
    return {
      effectPercentPoints, requiredPerGroup, requiredTotal, currentResolved,
      progressPercent: roundPercent(Math.min(100, currentResolved / requiredTotal * 100)),
      remainingSamples: Math.max(0, requiredTotal - currentResolved),
    };
  });
  return {
    baselineRate: roundPercent(baseline * 100), alpha: 0.05, power: 0.8, targets,
    message: `按双侧 5% 显著性、80% 功效估算；匹配实验仍需保证每组和每层均衡`,
  };
}

function buildRepeatStability(samples: ProbeObservation[]): ProbeFactorReport['repeatStability'] {
  const cells = new Map<string, ProbeObservation[]>();
  for (const item of samples.filter((sample) => sample.outcome !== 'error')) {
    const key = `${item.accountId}|${item.checkout.country || item.probeCountry}`;
    const cell = cells.get(key) || [];
    cell.push(item);
    cells.set(key, cell);
  }
  const repeated = [...cells.values()].filter((cell) => cell.length >= 2);
  let stableCells = 0;
  let transitions = 0;
  let transitionOpportunities = 0;
  for (const cell of repeated) {
    const sorted = [...cell].sort((a, b) => a.observedAt - b.observedAt);
    if (new Set(sorted.map((item) => item.outcome)).size === 1) stableCells += 1;
    for (let index = 1; index < sorted.length; index += 1) {
      transitionOpportunities += 1;
      if (sorted[index].outcome !== sorted[index - 1].outcome) transitions += 1;
    }
  }
  const repeatedObservations = repeated.reduce((sum, cell) => sum + cell.length, 0);
  const stabilityPercent = repeated.length ? roundPercent(stableCells / repeated.length * 100) : 0;
  const transitionRatePercent = transitionOpportunities ? roundPercent(transitions / transitionOpportunities * 100) : 0;
  const variableCells = repeated.length - stableCells;
  const message = !repeated.length
    ? '尚无重复账号×Checkout国家单元，逐请求随机性未形成检验'
    : transitionRatePercent <= 10 && repeated.length >= 10
      ? '重复结果高度稳定，完全逐请求随机解释较弱；仍需跨时段复测排除慢速规则变化'
      : transitionRatePercent >= 35
        ? '重复结果频繁反转，随机分配或未观测时变因素的解释增强'
        : '存在部分结果反转，需按时间、顺序、IP 与客户端版本继续分层';
  return {
    repeatedCells: repeated.length, stableCells, variableCells, repeatedObservations, transitions,
    transitionOpportunities, stabilityPercent, transitionRatePercent, message,
  };
}

function evidenceRank(value: ProbeControlledEffect['evidence']): number {
  return value === 'strong' ? 4 : value === 'moderate' ? 3 : value === 'weak' ? 2 : 1;
}

function strongestDimensionEffect(
  rows: ProbeFactorRow[],
  dimensions: ProbeFactorDimension[],
  minSamples: number,
): { dimension: ProbeFactorDimension; spread: number; nonOverlap: boolean; minGroupSamples: number; score: number } | null {
  let best: { dimension: ProbeFactorDimension; spread: number; nonOverlap: boolean; minGroupSamples: number; score: number } | null = null;
  for (const dimension of dimensions) {
    const eligible = rows.filter((row) => row.dimension === dimension && row.attempts >= minSamples);
    if (eligible.length < 2) continue;
    const high = [...eligible].sort((a, b) => b.rate - a.rate)[0];
    const low = [...eligible].sort((a, b) => a.rate - b.rate)[0];
    const spread = Math.max(0, high.rate - low.rate);
    const nonOverlap = high.confidenceLow > low.confidenceHigh;
    const minGroupSamples = Math.min(high.resolved, low.resolved);
    const score = Math.min(100, spread * (nonOverlap ? 1.35 : 0.75) * Math.min(1.5, Math.sqrt(minGroupSamples / minSamples)));
    if (!best || score > best.score) best = { dimension, spread, nonOverlap, minGroupSamples, score };
  }
  return best;
}

function compareRate(
  alerts: ProbeDriftAlert[],
  dimension: ProbeFactorDimension | 'global',
  value: string,
  baseline: ProbeObservation[],
  recent: ProbeObservation[],
  kind: 'eligibility-rate' | 'error-rate',
  minSamples: number,
  minDelta: number,
  detectedAt: number,
): void {
  if (baseline.length < minSamples || recent.length < minSamples) return;
  const predicate = kind === 'eligibility-rate'
    ? (item: ProbeObservation) => item.outcome === 'hit'
    : (item: ProbeObservation) => item.outcome === 'error';
  const baseCount = baseline.filter(predicate).length;
  const recentCount = recent.filter(predicate).length;
  const baseRate = (baseCount / baseline.length) * 100;
  const recentRate = (recentCount / recent.length) * 100;
  const delta = recentRate - baseRate;
  const zScore = twoProportionZ(baseCount, baseline.length, recentCount, recent.length);
  if (Math.abs(delta) < minDelta || Math.abs(zScore) < 1.64) return;
  const level = Math.abs(zScore) >= 2.58 || Math.abs(delta) >= 30 ? 'critical' : 'warning';
  alerts.push({
    id: `drift-${kind}-${stableKey(`${dimension}|${value}|${detectedAt}`)}`,
    kind,
    level,
    dimension,
    value,
    baselineSamples: baseline.length,
    recentSamples: recent.length,
    baselineValue: roundPercent(baseRate),
    recentValue: roundPercent(recentRate),
    delta: roundPercent(delta),
    zScore: roundPercent(zScore),
    detectedAt,
    message: `${dimension}:${value} ${driftKindLabel(kind)} ${roundPercent(baseRate)}% -> ${roundPercent(recentRate)}% (${delta >= 0 ? '+' : ''}${roundPercent(delta)}pp)`,
  });
}

function comparePriceDrift(alerts: ProbeDriftAlert[], baseline: ProbeObservation[], recent: ProbeObservation[], minSamples: number, detectedAt: number): void {
  const keys = new Set([...baseline, ...recent].map((item) => `${item.probeCountry}|${item.currency}`).filter((item) => !item.endsWith('|')));
  for (const key of keys) {
    const baseValues = baseline.filter((item) => `${item.probeCountry}|${item.currency}` === key).map((item) => parseAmount(item.amountHint)).filter(Number.isFinite);
    const recentValues = recent.filter((item) => `${item.probeCountry}|${item.currency}` === key).map((item) => parseAmount(item.amountHint)).filter(Number.isFinite);
    if (baseValues.length < minSamples || recentValues.length < minSamples) continue;
    const base = median(baseValues);
    const current = median(recentValues);
    const delta = current - base;
    const relative = base === 0 ? (current === 0 ? 0 : 1) : Math.abs(delta / base);
    if (relative < 0.1 && !(base === 0 || current === 0)) continue;
    alerts.push({
      id: `drift-price-${stableKey(`${key}|${detectedAt}`)}`,
      kind: 'price',
      level: relative >= 0.3 || base === 0 || current === 0 ? 'critical' : 'warning',
      dimension: 'currency',
      value: key,
      baselineSamples: baseValues.length,
      recentSamples: recentValues.length,
      baselineValue: roundPercent(base),
      recentValue: roundPercent(current),
      delta: roundPercent(delta),
      zScore: 0,
      detectedAt,
      message: `${key} 金额中位数 ${roundPercent(base)} -> ${roundPercent(current)}`,
    });
  }
}

function compareMethodDrift(alerts: ProbeDriftAlert[], baseline: ProbeObservation[], recent: ProbeObservation[], minSamples: number, detectedAt: number): void {
  const countries = new Set([...baseline, ...recent].map((item) => item.probeCountry).filter(Boolean));
  for (const country of countries) {
    const baseGroup = baseline.filter((item) => item.probeCountry === country);
    const recentGroup = recent.filter((item) => item.probeCountry === country);
    if (baseGroup.length < minSamples || recentGroup.length < minSamples) continue;
    const baseMethods = new Set(baseGroup.flatMap((item) => item.detectedMethods || []).filter(Boolean));
    const recentMethods = new Set(recentGroup.flatMap((item) => item.detectedMethods || []).filter(Boolean));
    if (!baseMethods.size && !recentMethods.size) continue;
    const added = [...recentMethods].filter((item) => !baseMethods.has(item));
    const removed = [...baseMethods].filter((item) => !recentMethods.has(item));
    if (!added.length && !removed.length) continue;
    alerts.push({
      id: `drift-method-${stableKey(`${country}|${detectedAt}`)}`,
      kind: 'payment-method',
      level: removed.length ? 'warning' : 'info',
      dimension: 'probeCountry',
      value: country,
      baselineSamples: baseGroup.length,
      recentSamples: recentGroup.length,
      baselineValue: baseMethods.size,
      recentValue: recentMethods.size,
      delta: recentMethods.size - baseMethods.size,
      zScore: 0,
      detectedAt,
      message: `${country} 支付方式变化：新增 ${added.join('|') || '-'}，移除 ${removed.join('|') || '-'}`,
    });
  }
}

function compareCategoricalDrift(
  alerts: ProbeDriftAlert[],
  baseline: ProbeObservation[],
  recent: ProbeObservation[],
  minSamples: number,
  detectedAt: number,
  kind: 'protocol-schema' | 'offer-set',
  valueOf: (item: ProbeObservation) => string,
): void {
  if (baseline.length < minSamples || recent.length < minSamples) return;
  const dominant = (items: ProbeObservation[]): { value: string; count: number } => {
    const counts = new Map<string, number>();
    for (const item of items) {
      const value = valueOf(item);
      if (value) counts.set(value, (counts.get(value) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
      ? { value: [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0], count: [...counts.entries()].sort((a, b) => b[1] - a[1])[0][1] }
      : { value: '', count: 0 };
  };
  const before = dominant(baseline);
  const after = dominant(recent);
  if (!before.value || !after.value || before.value === after.value) return;
  const beforePercent = roundPercent(before.count / baseline.length * 100);
  const afterPercent = roundPercent(after.count / recent.length * 100);
  if (beforePercent < 60 || afterPercent < 60) return;
  alerts.push({
    id: `drift-${kind}-${stableKey(`${before.value}|${after.value}|${detectedAt}`)}`,
    kind,
    level: beforePercent >= 80 && afterPercent >= 80 ? 'critical' : 'warning',
    dimension: kind === 'protocol-schema' ? 'checkoutSchema' : 'offerSet',
    value: after.value,
    baselineSamples: baseline.length,
    recentSamples: recent.length,
    baselineValue: beforePercent,
    recentValue: afterPercent,
    delta: roundPercent(afterPercent - beforePercent),
    zScore: 0,
    detectedAt,
    message: `${driftKindLabel(kind)}由 ${before.value} 切换为 ${after.value}，已开启新规则纪元并提高探索流量`,
  });
}

function factorValue(item: ProbeObservation, dimension: ProbeFactorDimension): string {
  const values: Record<ProbeFactorDimension, string> = {
    account: item.accountId,
    accountBatch: item.accountBatchId,
    accountSource: item.accountSource,
    probeCountry: item.probeCountry,
    authCountry: item.auth.country,
    checkoutCountry: item.checkout.country || item.bootstrapCountry,
    billingCountry: item.billing.country || item.providerCountry,
    authIp: item.auth.ip,
    checkoutIp: item.checkout.ip || endpointIdentity(item.checkout.endpointSummary),
    billingIp: item.billing.ip || endpointIdentity(item.billing.endpointSummary),
    authAsn: item.auth.asn,
    checkoutAsn: item.checkout.asn,
    billingAsn: item.billing.asn,
    paymentMethod: item.paymentMethod,
    plan: item.planName,
    currency: item.currency,
    clientVersion: item.extensionVersion,
    accountAge: accountAgeBucket(item.accountAgeHours),
    tokenAge: accountAgeBucket(item.tokenAgeHours),
    tokenExpiryHorizon: expiryHorizonBucket(item.tokenExpiryHorizonHours),
    emailDomain: item.emailDomainCohort,
    browserProfile: item.browserProfileCohort,
    deviceCohort: item.deviceCohort,
    localeExitAlignment: item.localeExitAlignment,
    timeZoneExitAlignment: item.timeZoneExitAlignment,
    sequencePosition: sequenceBucket(item.sequence),
    scheduleBlock: String(item.scheduleBlock || 0),
    configuredRetries: String(item.configuredRetries || 0),
    checkoutIpVersion: ipVersion(item.checkout.ip),
    localHour: localHourBucket(item.observedAt, item.timeZone),
    weekday: weekdayValue(item.observedAt, item.timeZone),
    routeSignature: item.routeTreatmentApplied
      ? [item.auth.country, item.checkout.country || item.bootstrapCountry, item.billing.country || item.providerCountry].map((value) => value || '?').join('>')
      : '',
    accountByCountry: `${item.accountId}@${item.probeCountry}`,
    accountByCheckoutIp: `${item.accountId}@${item.checkout.ip || endpointIdentity(item.checkout.endpointSummary)}`,
    countryByPaymentMethod: item.paymentMethodTreatmentApplied && item.submittedPaymentMethod
      ? `${item.probeCountry}@${item.submittedPaymentMethod}`
      : '',
    experimentMode: item.experimentMode,
    experimentArm: item.experimentArm,
    routeVariant: item.routeTreatmentApplied ? item.routeVariantId : '',
    plannedPaymentMethod: item.paymentMethodTreatmentApplied ? (item.plannedPaymentMethod || 'auto') : '',
    submittedPaymentMethod: item.paymentMethodTreatmentApplied ? item.submittedPaymentMethod : '',
    qualificationGate: item.qualificationGateVersion || 'none',
    linkVerificationLevel: item.linkVerificationLevel || 'candidate',
    seedOrdinal: String(item.plannedSeedOrdinal || 1),
    designCell: item.designCellKey,
    checkoutSubnet: item.checkoutSubnet,
    checkoutNetworkType: item.checkoutNetworkType,
    checkoutSchema: item.checkoutSchemaFingerprint,
    offerSet: item.offerSetFingerprint,
    upstreamProtocol: item.upstreamProtocolFingerprint,
    ruleEpoch: item.ruleEpochId,
    campaign: item.campaignId,
    product: item.productId,
    checkoutMode: item.checkoutMode,
    retryOrdinal: String(item.retryOrdinal || 1),
    cooldownBucket: cooldownBucket(item.cooldownElapsedMinutes),
  };
  const value = String(values[dimension] || '').trim();
  return value && !value.endsWith('@') ? value : '';
}

function buildCaveats(samples: ProbeObservation[], minSamples: number, confounding: ProbeConfoundingFinding[]): string[] {
  const caveats: string[] = [];
  if (samples.length < minSamples * 4) caveats.push(`总样本 ${samples.length}，低于建议起步量 ${minSamples * 4}`);
  if (new Set(samples.map((item) => item.accountId)).size < 2) caveats.push('账号少于 2 个，账号效应与其他变量混杂');
  if (new Set(samples.map((item) => item.probeCountry)).size < 2) caveats.push('国家少于 2 个，国家效应尚未形成对照');
  if (new Set(samples.map((item) => item.checkout.ip || endpointIdentity(item.checkout.endpointSummary)).filter(Boolean)).size < 2) caveats.push('Checkout 出口少于 2 个，出口效应尚未形成对照');
  if (samples.some((item) => item.outcome === 'error')) caveats.push('原始命中率包含请求错误；请同时观察错误率漂移，避免把网络故障误判为无资格');
  for (const finding of confounding.filter((item) => item.level !== 'info')) caveats.push(`混杂审计：${finding.message}`);
  caveats.push('当前结论是观测相关性；同账号换出口、同出口换账号的平衡交叉实验可提升因果可信度');
  return caveats;
}

function accountAgeBucket(hours: number): string {
  if (!Number.isFinite(hours) || hours < 0) return 'unknown';
  if (hours < 24) return '<24h';
  if (hours < 24 * 7) return '1-7d';
  if (hours < 24 * 30) return '7-30d';
  return '30d+';
}

function expiryHorizonBucket(hours: number): string {
  if (!Number.isFinite(hours) || hours === 0) return 'unknown';
  if (hours < 0) return 'expired';
  if (hours < 24) return '<24h';
  if (hours < 24 * 7) return '1-7d';
  if (hours < 24 * 30) return '7-30d';
  return '30d+';
}

function cooldownBucket(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return 'first';
  if (minutes < 15) return '<15m';
  if (minutes < 60) return '15-60m';
  if (minutes < 240) return '1-4h';
  if (minutes < 1440) return '4-24h';
  return '24h+';
}

function sequenceBucket(sequence: number): string {
  const value = Math.max(1, Math.floor(Number(sequence) || 1));
  const start = Math.floor((value - 1) / 5) * 5 + 1;
  return `${start}-${start + 4}`;
}

function ipVersion(value: string): string {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.includes(':') ? 'IPv6' : /^\d{1,3}(?:\.\d{1,3}){3}$/.test(text) ? 'IPv4' : 'unknown';
}

function selectCurrentEpoch(
  samples: ProbeObservation[],
  alerts: ProbeDriftAlert[],
  minSamples: number,
): { samples: ProbeObservation[]; epochCount: number; startedAt: number } {
  const explicitEpochs = [...new Set(samples.map((item) => item.ruleEpochId).filter(Boolean))];
  if (explicitEpochs.length) {
    const latestEpochId = [...samples].reverse().find((item) => item.ruleEpochId)?.ruleEpochId || explicitEpochs[explicitEpochs.length - 1];
    const current = samples.filter((item) => item.ruleEpochId === latestEpochId);
    return { samples: current, epochCount: explicitEpochs.length, startedAt: current[0]?.observedAt || 0 };
  }
  const hasGlobalRuleDrift = alerts.some((item) => item.dimension === 'global' && item.kind === 'eligibility-rate');
  if (!hasGlobalRuleDrift || samples.length < minSamples * 2) {
    return { samples, epochCount: samples.length ? 1 : 0, startedAt: samples[0]?.observedAt || 0 };
  }
  let bestSplit = -1;
  let bestScore = 0;
  for (let split = minSamples; split <= samples.length - minSamples; split += 1) {
    const before = samples.slice(0, split);
    const after = samples.slice(split);
    const beforeResolved = before.filter((item) => item.outcome !== 'error');
    const afterResolved = after.filter((item) => item.outcome !== 'error');
    if (beforeResolved.length < minSamples || afterResolved.length < minSamples) continue;
    const beforeRate = beforeResolved.filter((item) => item.outcome === 'hit').length / beforeResolved.length;
    const afterRate = afterResolved.filter((item) => item.outcome === 'hit').length / afterResolved.length;
    const score = Math.abs(afterRate - beforeRate) * Math.sqrt(Math.min(beforeResolved.length, afterResolved.length));
    if (score > bestScore) {
      bestScore = score;
      bestSplit = split;
    }
  }
  if (bestSplit < 0) return { samples, epochCount: 1, startedAt: samples[0]?.observedAt || 0 };
  const current = samples.slice(bestSplit);
  return { samples: current, epochCount: 2, startedAt: current[0]?.observedAt || 0 };
}

function buildEvidenceQuality(
  samples: ProbeObservation[],
  context: {
    epochCount: number;
    latestEpochStartedAt: number;
    historicalSampleSize: number;
    attributionCurrentSampleSize: number;
    driftAlerts: ProbeDriftAlert[];
  },
): ProbeFactorReport['quality'] {
  const protocols = new Map<string, number>();
  for (const item of samples) {
    const signature = [
      item.planName,
      item.stagedPipelineEnabled ? 'staged' : 'direct',
      item.entryProxyMode,
      item.exitProxyMode,
      item.paymentMethod || 'auto',
      [...item.channels].sort().join('+'),
      item.extensionVersion || 'unknown-version',
      item.browserFamily || 'unknown-browser',
      item.upstreamProtocolFingerprint || 'unknown-upstream',
      item.ruleEpochId || 'unknown-epoch',
    ].join('|');
    protocols.set(signature, (protocols.get(signature) || 0) + 1);
  }
  const percentOf = (count: number) => samples.length ? roundPercent((count / samples.length) * 100) : 0;
  const dominantProtocol = Math.max(0, ...protocols.values());
  const resolved = samples.filter((item) => item.outcome !== 'error').length;
  const verifiedAuthPercent = percentOf(samples.filter((item) => item.auth.verified && Boolean(item.auth.country)).length);
  const verifiedCheckoutPercent = percentOf(samples.filter((item) => item.checkout.verified && Boolean(item.checkout.country) && Boolean(item.checkout.ip || item.checkout.endpointSummary)).length);
  const verifiedBillingPercent = percentOf(samples.filter((item) => item.billing.verified && Boolean(item.billing.country)).length);
  const resolvedOutcomePercent = percentOf(resolved);
  const errorRate = percentOf(samples.length - resolved);
  const dominantProtocolPercent = percentOf(dominantProtocol);
  const blockers: string[] = [];
  if (samples.length < 20) blockers.push(`当前分析纪元样本 ${samples.length}/20`);
  const treatmentAppliedPercent = samples.length
    ? roundPercent(context.attributionCurrentSampleSize / samples.length * 100)
    : 0;
  if (treatmentAppliedPercent < 80) {
    blockers.push(`当前纪元可归因观测 ${treatmentAppliedPercent}% < 80%`);
  }
  if (resolvedOutcomePercent < 80) blockers.push(`明确资格结果覆盖 ${resolvedOutcomePercent}% < 80%`);
  if (verifiedCheckoutPercent < 80) blockers.push(`Checkout 实际出口验证覆盖 ${verifiedCheckoutPercent}% < 80%`);
  if (dominantProtocolPercent < 80) blockers.push(`主实验协议占比 ${dominantProtocolPercent}% < 80%，存在协议混杂`);
  const drifting = context.driftAlerts.some((item) => item.level === 'critical' || (item.dimension === 'global' && item.kind === 'eligibility-rate'));
  const score = Math.max(0, Math.min(100, Math.round((
    Math.min(1, samples.length / 100) * 25
    + (resolvedOutcomePercent / 100) * 20
    + (verifiedCheckoutPercent / 100) * 25
    + (dominantProtocolPercent / 100) * 20
    + (Math.min(verifiedAuthPercent, verifiedBillingPercent) / 100) * 10
  ))));
  return {
    conclusionState: drifting ? 'drifting' : blockers.length ? 'insufficient' : 'correlation',
    score,
    protocolCount: protocols.size,
    dominantProtocolPercent,
    verifiedAuthPercent,
    verifiedCheckoutPercent,
    verifiedBillingPercent,
    resolvedOutcomePercent,
    errorRate,
    matrixBalancePercent: 0,
    minimumDetectableEffectPp: resolved > 0 ? roundPercent(Math.min(100, (1.96 / Math.sqrt(resolved)) * 100)) : 100,
    epochCount: context.epochCount,
    latestEpochStartedAt: context.latestEpochStartedAt,
    latestEpochSamples: samples.length,
    rawObservationCount: samples.length,
    attributionEligibleSamples: context.attributionCurrentSampleSize,
    excludedTreatmentSamples: Math.max(0, samples.length - context.attributionCurrentSampleSize),
    treatmentAppliedPercent,
    blockers,
  };
}

function matrixBalance(values: number[]): number {
  const nonEmpty = values.filter((value) => value > 0);
  if (!values.length || !nonEmpty.length) return 0;
  const max = Math.max(...values);
  const min = Math.min(...values);
  return max ? roundPercent((min / max) * 100) : 0;
}

function confidenceLevel(attempts: number, width: number, minSamples: number): ProbeFactorRow['confidence'] {
  if (attempts < minSamples) return 'insufficient';
  if (attempts >= Math.max(30, minSamples * 4) && width <= 30) return 'high';
  if (attempts >= Math.max(12, minSamples * 2) && width <= 45) return 'medium';
  return 'low';
}

function effectEvidence(spread: number, nonOverlap: boolean, minGroupSamples: number): ProbeFactorConclusion['evidence'] {
  if (nonOverlap && spread >= 25 && minGroupSamples >= 10) return 'strong';
  if ((nonOverlap && spread >= 15) || (spread >= 30 && minGroupSamples >= 5)) return 'moderate';
  if (spread >= 10) return 'weak';
  return 'insufficient';
}

function twoProportionZ(aSuccess: number, aTotal: number, bSuccess: number, bTotal: number): number {
  if (!aTotal || !bTotal) return 0;
  const pooled = (aSuccess + bSuccess) / (aTotal + bTotal);
  const denominator = Math.sqrt(pooled * (1 - pooled) * ((1 / aTotal) + (1 / bTotal)));
  return denominator ? ((bSuccess / bTotal) - (aSuccess / aTotal)) / denominator : 0;
}

function localHourBucket(timestamp: number, timeZone: string): string {
  try {
    const hour = Number(new Intl.DateTimeFormat('en-US', { hour: '2-digit', hour12: false, timeZone: timeZone || 'UTC' }).format(new Date(timestamp)));
    const start = Math.floor((hour % 24) / 4) * 4;
    return `${String(start).padStart(2, '0')}-${String((start + 3) % 24).padStart(2, '0')}`;
  } catch {
    return `${String(new Date(timestamp).getUTCHours()).padStart(2, '0')}:00Z`;
  }
}

function weekdayValue(timestamp: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: timeZone || 'UTC' }).format(new Date(timestamp));
  } catch {
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(timestamp).getUTCDay()];
  }
}

function endpointIdentity(summary: string): string {
  return String(summary || '').replace(/\/\/[^@/]+@/, '//***@').trim();
}

function parseAmount(value: string): number {
  const match = String(value || '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : Number.NaN;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function levelWeight(level: ProbeDriftAlert['level']): number {
  return level === 'critical' ? 3 : level === 'warning' ? 2 : 1;
}

function driftKindLabel(kind: ProbeDriftAlert['kind']): string {
  if (kind === 'eligibility-rate') return '资格命中率';
  if (kind === 'error-rate') return '错误率';
  if (kind === 'price') return '价格';
  if (kind === 'payment-method') return '支付方式';
  if (kind === 'protocol-schema') return '上游结构指纹';
  return '优惠集合指纹';
}

function evidenceLabel(evidence: ProbeFactorConclusion['evidence']): string {
  if (evidence === 'strong') return '强';
  if (evidence === 'moderate') return '中';
  if (evidence === 'weak') return '弱';
  return '不足';
}

function stableKey(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function csvEscape(value: unknown): string {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function roundPercent(value: number): number {
  return Math.round(value * 10) / 10;
}
