import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFactorAnalysis, exportFactorAnalysisCsv } from '../src/features/probe/analysis';
import { buildExperimentReadiness } from '../src/features/probe/readiness';
import { buildExperimentCoverage } from '../src/features/probe/experiment';
import { DEFAULT_PROBE_TASK_CONFIG, expandCheckoutVariantsForPersistence, exportHitDatabaseCsv, normalizeTaskConfig, queryHitDatabase } from '../src/features/probe/state';
import { isQualifiedProbeHit } from '../src/features/probe/service';
import { billingDetailsForCountry } from '../src/features/link-extractor/checkout';
import { selectPaymentProbeCandidates } from '../src/features/probe/payment-evidence';
import type { ProbeAccount, ProbeDriftAlert, ProbeHitDatabaseRecord, ProbeHitRecord, ProbeObservation, ProbeProxyHealthItem } from '../src/features/probe/types';

function account(id: string): ProbeAccount {
  return {
    id,
    email: `${id}@example.com`,
    tokenRaw: `opaque-${id}`,
    source: 'session',
    enabled: true,
    lastHitAt: 0,
    lastProbeAt: 0,
    lastProbeCountry: '',
    tokenUpdatedAt: Date.now(),
    lastMessage: '',
    successCount: 0,
    failCount: 0,
    createdAt: Date.now(),
    batchId: 'batch-a',
    identitySnapshot: { deviceId: `device-${id}`, sessionId: `session-${id}`, cookies: [], capturedAt: Date.now() },
  };
}

test('支付终链默认复用资格 Checkout，并保留独立会话实验开关', () => {
  const defaults = normalizeTaskConfig({});
  assert.equal(defaults.paymentCheckoutSessionMode, 'reuse_eligibility_session');
  assert.equal(defaults.extractAllDetectedMethods, true);
  assert.equal(defaults.forceUnlistedPaymentMethodProbe, false);
  assert.equal(defaults.planName, 'chatgptplusplan');
  assert.equal(defaults.stagedPipelineEnabled, true);
  assert.equal(defaults.requireZero, true);
  assert.equal(defaults.extractFinalPaymentUrl, true);
  assert.equal(defaults.detectPaymentMethods, true);
  assert.equal(defaults.checkoutUiMode, 'hosted');

  const comparison = normalizeTaskConfig({
    paymentCheckoutSessionMode: 'independent_checkout',
    extractAllDetectedMethods: false,
  });
  assert.equal(comparison.paymentCheckoutSessionMode, 'independent_checkout');
  assert.equal(comparison.extractAllDetectedMethods, false);
  assert.equal(normalizeTaskConfig({ checkoutUiMode: 'both' }).checkoutUiMode, 'both');
});

test('双模式命中按 Hosted 与 Custom 两条独立记录持久化', () => {
  const metrics = { checkoutAttempts: 1, updateAttempts: 1, fullFlowAttempts: 1, cfRetryCount: 0, cfExitRotations: 0, invalidPromotionRebuilds: 0, pageFallbackAttempts: 0 };
  const base = {
    id: 'dual', taskId: 'task', accountId: 'account', email: 'dual@example.test', country: 'PH', currency: 'PHP',
    planName: 'chatgptplusplan', ok: true, hitKind: 'zero', message: 'qualified', link: 'https://hosted.test',
    longUrl: 'https://hosted.test', shortUrl: 'https://custom.test', channels: ['hosted'], amountHint: '0', promoHint: 'trial',
    createdAt: Date.now(), rawKeys: [], qualificationVerified: true, checkoutCreated: true, linkUsable: true,
    checkoutUiMode: 'both', checkoutVariants: [
      { uiMode: 'hosted', ok: true, message: 'hosted', link: 'https://hosted.test', longUrl: 'https://hosted.test', shortUrl: '', checkoutSessionId: 'oaics_h', processorEntity: 'openai_ie', amount: { amountMinor: 0, amountHint: '0', currency: 'PHP', source: 'update-response', path: 'total_summary.due', verification: 'verified-zero' }, retryMetrics: metrics },
      { uiMode: 'custom', ok: true, message: 'custom', link: 'https://custom.test', longUrl: '', shortUrl: 'https://custom.test', checkoutSessionId: 'oaics_c', processorEntity: 'openai_ie', amount: { amountMinor: 0, amountHint: '0', currency: 'PHP', source: 'checkout-page', path: 'total_summary.due', verification: 'verified-zero' }, retryMetrics: { ...metrics, fullFlowAttempts: 2, invalidPromotionRebuilds: 1 } },
    ], checkoutRetryMetrics: metrics,
  } satisfies ProbeHitRecord;
  const rows = expandCheckoutVariantsForPersistence(base);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((item) => item.checkoutUiMode), ['hosted', 'custom']);
  assert.deepEqual(rows.map((item) => item.link), ['https://hosted.test', 'https://custom.test']);
  assert.equal(rows[1].checkoutRetryMetrics?.invalidPromotionRebuilds, 1);
});

test('未暴露方式仅在实验开关开启时进入资格筛查候选', () => {
  assert.deepEqual(selectPaymentProbeCandidates({
    detectedMethods: ['upi'], requestedMethods: ['paypal'], forceUnlisted: false,
  }), [{ method: 'upi', forcedProbe: false }]);
  assert.deepEqual(selectPaymentProbeCandidates({
    detectedMethods: ['upi'], requestedMethods: ['paypal'], forceUnlisted: true,
  }), [
    { method: 'paypal', forcedProbe: true },
    { method: 'upi', forcedProbe: false },
  ]);
});

function health(country: string, ip: string, asn: string): ProbeProxyHealthItem {
  return {
    country,
    status: 'ok',
    latencyMs: 10,
    endpointSummary: `fixture-${country}`,
    message: 'ok',
    checkedAt: Date.now(),
    actualCountry: country,
    actualIp: ip,
    asn,
    networkType: 'residential',
  };
}

function observation(input: {
  id: string;
  accountId: string;
  country?: string;
  ip?: string;
  asn?: string;
  epoch?: string;
  at?: number;
  outcome?: 'hit' | 'miss' | 'error';
}): ProbeObservation {
  const country = input.country || 'HK';
  const ip = input.ip || '198.51.100.1';
  const epoch = input.epoch || 'epoch-a';
  const stage = {
    cycleId: 'cycle', configuredCountry: country, country, ip, asn: input.asn || 'AS100', colo: '', latencyMs: 10,
    checkedAt: input.at || Date.now(), endpointSummary: `fixture-${country}`, source: 'fixture', verified: true, message: 'ok',
  };
  return {
    id: input.id,
    observedAt: input.at || Date.now(),
    taskId: 'task', runId: 'run', cycleId: 'cycle', unitId: input.id, attemptId: input.id, round: 1, sequence: 1,
    researchMode: true, experimentMode: 'attribution', experimentArm: 'balanced', designCellKey: `${input.accountId}|${country}`,
    routeVariantId: 'same', plannedAuthCountry: country, plannedCheckoutCountry: country, plannedBillingCountry: country,
    plannedPaymentMethod: 'paypal', plannedSeedOrdinal: 1, scheduleBlock: 1, scheduleCellAttempt: 1,
    accountId: input.accountId, accountBatchId: 'batch-a', accountSource: 'session', accountAgeHours: 24,
    tokenAgeHours: 1, tokenExpiryHorizonHours: 48, emailDomainCohort: 'example.com', browserProfileCohort: 'private:firefox',
    deviceCohort: 'windows:desktop', probeCountry: country, bootstrapCountry: country, promotionCountry: country,
    providerCountry: country, channels: ['hosted'], planName: 'chatgptplusplan', paymentMethod: 'paypal', currency: 'USD',
    campaignId: '', productId: 'chatgptplusplan', checkoutMode: 'staged', outcome: input.outcome || 'miss', hitKind: 'none',
    amountHint: '', promoHint: '', detectedMethods: ['paypal'], paymentRunnerStatus: '', paymentRunnerStage: '', paymentRunnerCode: '',
    paymentCheckoutSessionMode: 'independent_checkout', paymentCheckoutStatus: '',
    paymentCheckoutSessionDistinct: false, paymentMethodLinkCount: 0,
    qualificationVerified: false, submittedPaymentMethod: 'paypal', paymentRunnerConfirmSubmitted: false,
    paymentRunnerConfirmSucceeded: false, paymentRunnerApproveSubmitted: false, paymentRunnerApproveSucceeded: false,
    finalLinkVerified: false, errorClass: '', durationMs: 100, configuredRetries: 1, retryOrdinal: 1,
    checkoutUiMode: 'hosted', checkoutAttempts: 1, updateAttempts: 1, fullFlowAttempts: 1,
    cfRetryCount: 0, cfExitRotations: 0, invalidPromotionRebuilds: 0, pageFallbackAttempts: 0,
    checkoutCreated: false, qualificationGateVersion: '', linkVerificationLevel: 'candidate', linkUsable: false,
    credentialStatus: 'unchecked',
    actualAuthCountry: country, actualCheckoutCountry: country, actualBillingCountry: country,
    countryTreatmentApplied: true, routeTreatmentApplied: true, paymentMethodTreatmentApplied: true,
    experimentValidityStatus: 'valid', experimentValidForAttribution: true, experimentValidityReasons: [],
    cooldownElapsedMinutes: 240, stagedPipelineEnabled: true, entryProxyMode: 'front', exitProxyMode: 'follow-country',
    frontProxySummary: 'fixture-front', auth: stage, checkout: stage, billing: stage, bootstrapSeedSummary: '',
    promotionSeedSummary: '', providerSeedSummary: '', extensionVersion: '0.0.31', browserFamily: 'firefox', locale: 'zh-CN',
    timeZone: 'Asia/Shanghai', localeExitAlignment: 'mismatch', timeZoneExitAlignment: 'mismatch',
    checkoutSubnet: `${ip.split('.').slice(0, 3).join('.')}.0/24`, checkoutNetworkType: 'residential',
    checkoutSchemaFingerprint: `schema-${epoch}`, offerSetFingerprint: 'offers-a', upstreamProtocolFingerprint: `protocol-${epoch}`,
    ruleEpochId: epoch,
  };
}

test('单一健康出口只让账号因素具备开跑条件', () => {
  const result = buildExperimentReadiness({
    accounts: [account('a1'), account('a2')],
    proxyHealth: [health('HK', '198.51.100.1', 'AS100')],
    observations: [],
    config: DEFAULT_PROBE_TASK_CONFIG,
  });
  assert.equal(result.usableCredentialCount, 2);
  assert.equal(result.healthyActualCountryCount, 1);
  assert.equal(result.items.find((item) => item.factor === 'account')?.status, 'ready');
  assert.equal(result.items.find((item) => item.factor === 'country')?.status, 'blocked');
  assert.equal(result.items.find((item) => item.factor === 'exit-ip')?.status, 'blocked');
});

test('同一出口下多账号匹配样本只识别账号效应', () => {
  const observations = Array.from({ length: 10 }, (_, index) => observation({
    id: `o-${index}`,
    accountId: index % 2 ? 'a1' : 'a2',
  }));
  const result = buildExperimentReadiness({
    accounts: [account('a1'), account('a2')],
    proxyHealth: [health('HK', '198.51.100.1', 'AS100')],
    observations,
    config: DEFAULT_PROBE_TASK_CONFIG,
  });
  assert.equal(result.items.find((item) => item.factor === 'account')?.status, 'identifiable');
  assert.equal(result.items.find((item) => item.factor === 'country')?.status, 'blocked');
});

test('同账号跨国家和实际 IP 的交叉样本形成国家与出口可识别性', () => {
  const observations = Array.from({ length: 12 }, (_, index) => observation({
    id: `o-${index}`,
    accountId: 'a1',
    country: index % 2 ? 'HK' : 'JP',
    ip: index % 2 ? '198.51.100.1' : '203.0.113.2',
    asn: index % 2 ? 'AS100' : 'AS200',
  }));
  const result = buildExperimentReadiness({
    accounts: [account('a1')],
    proxyHealth: [health('HK', '198.51.100.1', 'AS100'), health('JP', '203.0.113.2', 'AS200')],
    observations,
    config: DEFAULT_PROBE_TASK_CONFIG,
  });
  assert.equal(result.items.find((item) => item.factor === 'country')?.status, 'identifiable');
  assert.equal(result.items.find((item) => item.factor === 'exit-ip')?.status, 'identifiable');
  assert.equal(result.items.find((item) => item.factor === 'exit-asn')?.status, 'identifiable');
});

test('规则指纹变化后分析只使用最新纪元', () => {
  const oldRows = Array.from({ length: 20 }, (_, index) => observation({ id: `old-${index}`, accountId: 'a1', epoch: 'epoch-old', at: index + 1 }));
  const currentRows = Array.from({ length: 5 }, (_, index) => observation({ id: `new-${index}`, accountId: 'a1', epoch: 'epoch-new', at: 100 + index }));
  const report = buildFactorAnalysis([...oldRows, ...currentRows], 2);
  assert.equal(report.sampleSize, 5);
  assert.equal(report.quality.epochCount, 2);
  assert.equal(report.quality.latestEpochSamples, 5);
  const csv = exportFactorAnalysisCsv(report, undefined, currentRows);
  assert.match(csv, /checkoutSchemaFingerprint/);
  assert.match(csv, /ruleEpochId/);
});

test('上游结构漂移自动提高探索比例', () => {
  const alert: ProbeDriftAlert = {
    id: 'drift', kind: 'protocol-schema', level: 'critical', dimension: 'checkoutSchema', value: 'schema-new',
    baselineSamples: 10, recentSamples: 10, baselineValue: 100, recentValue: 100, delta: 0, zScore: 0,
    detectedAt: Date.now(), message: 'changed',
  };
  const result = buildExperimentReadiness({
    accounts: [account('a1')], proxyHealth: [health('HK', '198.51.100.1', 'AS100')], observations: [],
    config: { ...DEFAULT_PROBE_TASK_CONFIG, adaptiveExplorationPercent: 20 }, driftAlerts: [alert],
  });
  assert.equal(result.driftBoostedExplorationPercent, 50);
});

test('香港 Checkout 使用上游当前接受的 USD 结算枚举', () => {
  assert.deepEqual(billingDetailsForCountry('HK'), { country: 'HK', currency: 'USD' });
});

test('真实 401 会把仅 JWT 未过期的账号从可用凭证中剔除', () => {
  const rejected = { ...observation({ id: 'rejected', accountId: 'a1', outcome: 'error' }), errorClass: 'account-auth' };
  const result = buildExperimentReadiness({
    accounts: [account('a1'), account('a2')],
    proxyHealth: [health('HK', '198.51.100.1', 'AS100')],
    observations: [rejected],
    config: DEFAULT_PROBE_TASK_CONFIG,
  });
  assert.equal(result.enabledAccountCount, 2);
  assert.equal(result.usableCredentialCount, 1);
});

test('服务端预检失效账号在形成实验计划前被剔除', () => {
  const invalid = { ...account('a1'), serverCredentialStatus: 'invalid' as const, credentialCheckedAt: Date.now() };
  const result = buildExperimentReadiness({
    accounts: [invalid, account('a2')],
    proxyHealth: [health('HK', '198.51.100.1', 'AS100')],
    observations: [],
    config: DEFAULT_PROBE_TASK_CONFIG,
  });
  assert.equal(result.usableCredentialCount, 1);
});

test('严格实验中普通 checkout 候选不计为资格命中', () => {
  const base: ProbeHitRecord = {
    id: 'hit', taskId: 'task', accountId: 'a1', email: 'a1@example.com', country: 'HK', currency: 'USD',
    planName: 'chatgptplusplan', ok: true, hitKind: 'link', message: 'checkout created',
    link: 'https://chatgpt.com/checkout/test', longUrl: '', shortUrl: '', channels: ['hosted'], amountHint: '',
    promoHint: '', createdAt: Date.now(), rawKeys: [], checkoutCreated: true, qualificationVerified: false,
    linkVerificationLevel: 'candidate', linkUsable: false,
  };
  assert.equal(isQualifiedProbeHit({ config: { ...DEFAULT_PROBE_TASK_CONFIG, requireZero: true } }, base), false);
  assert.equal(isQualifiedProbeHit({ config: { ...DEFAULT_PROBE_TASK_CONFIG, requireZero: true } }, {
    ...base, hitKind: 'zero', qualificationVerified: true, linkVerificationLevel: 'strict-response', linkUsable: true,
  }), true);
});

test('有效链接看板默认可排除仅创建 checkout 的候选记录', () => {
  const record = (id: string, linkUsable: boolean): ProbeHitDatabaseRecord => ({
    id, dbId: `db-${id}`, savedAt: Date.now(), sourceTaskName: 'fixture', archived: false,
    taskId: 'task', accountId: 'a1', email: 'a1@example.com', country: 'HK', currency: 'USD',
    planName: 'chatgptplusplan', ok: true, hitKind: linkUsable ? 'zero' : 'link', message: id,
    link: `https://chatgpt.com/checkout/${id}`, longUrl: '', shortUrl: '', channels: ['hosted'], amountHint: '',
    promoHint: '', createdAt: Date.now(), rawKeys: [], checkoutCreated: true, qualificationVerified: linkUsable,
    linkVerificationLevel: linkUsable ? 'strict-response' : 'candidate', linkUsable,
  });
  const result = queryHitDatabase([record('candidate', false), record('verified', true)], {
    onlyWithLink: true, onlyUsableLinks: true,
  });
  assert.equal(result.records.length, 1);
  assert.equal(result.summary.usableLinks, 1);
  assert.equal(result.summary.qualified, 1);
});

test('命中库 CSV 保留方式资格保持证据', () => {
  const record: ProbeHitDatabaseRecord = {
    id: 'preserved', dbId: 'db-preserved', savedAt: Date.now(), sourceTaskName: 'fixture', archived: false,
    taskId: 'task', accountId: 'a1', email: 'a1@example.com', country: 'IN', currency: 'INR',
    planName: 'chatgptplusplan', ok: true, hitKind: 'zero', message: 'fixture',
    link: 'https://checkout.stripe.com/c/pay/cs_preserved', longUrl: '', shortUrl: '', channels: ['upi'], amountHint: '0',
    promoHint: '', createdAt: Date.now(), rawKeys: [], checkoutCreated: true, qualificationVerified: true,
    linkVerificationLevel: 'provider-final', linkUsable: true,
    hostedResolutionStatus: 'resolved_hosted', hostedResolutionMessage: 'fixture resolved',
    identitySnapshotReady: true, resolvedCheckoutSessionType: 'stripe',
    hostedResolutionMethods: ['upi'], stripeResourceCount: 3, stripePublishableKeyFound: true,
    paymentMethodLinks: [{
      method: 'upi', url: 'https://payments.stripe.com/upi/instructions/preserved', status: 'forced_probe',
      message: 'fixture', checkoutCountry: 'IN', currency: 'inr', sessionMode: 'reuse_eligibility_session',
      sessionDistinct: false, sourceQualificationVerified: true, forcedProbe: true, sourceSessionReused: true,
      methodOffered: true, qualificationPreserved: true, qualificationVerified: true,
      finalLinkVerified: true, aggregateStatus: 'probe_required',
      runnerStatus: 'link_ready', runnerCode: 'LINK_READY', createdAt: Date.now(),
    }],
  };
  const csv = exportHitDatabaseCsv([record]);
  assert.match(csv, /forced=true\|sourceQualified=true\|reused=true\|offered=true\|preserved=true/);
  assert.match(csv, /forced_probe/);
  assert.match(csv, /hostedResolutionStatus,hostedResolutionMessage,identitySnapshotReady,resolvedCheckoutSessionType,hostedResolutionMethods,stripeResourceCount,stripePublishableKeyFound/);
  assert.match(csv, /resolved_hosted,fixture resolved,true,stripe,upi,3,true/);
  assert.doesNotMatch(csv, /pk_(?:live|test)_/);
});

test('支付方式可识别性只使用实际提交方式，不使用计划标签', () => {
  const plannedOnly = [
    { ...observation({ id: 'p1', accountId: 'a1' }), plannedPaymentMethod: 'paypal', submittedPaymentMethod: '' },
    { ...observation({ id: 'p2', accountId: 'a1' }), plannedPaymentMethod: 'upi', submittedPaymentMethod: '' },
  ];
  const config = { ...DEFAULT_PROBE_TASK_CONFIG, paymentMethodVariants: ['paypal', 'upi'] };
  const pending = buildExperimentReadiness({ accounts: [account('a1')], proxyHealth: [health('HK', '198.51.100.1', 'AS100')], observations: plannedOnly, config });
  assert.notEqual(pending.items.find((item) => item.factor === 'payment-method')?.status, 'identifiable');

  const submitted = Array.from({ length: 10 }, (_, index) => ({
    ...observation({ id: `s-${index}`, accountId: 'a1' }),
    submittedPaymentMethod: index % 2 ? 'paypal' : 'upi',
  }));
  const ready = buildExperimentReadiness({ accounts: [account('a1')], proxyHealth: [health('HK', '198.51.100.1', 'AS100')], observations: submitted, config });
  assert.equal(ready.items.find((item) => item.factor === 'payment-method')?.status, 'identifiable');
});

test('计划国家未真实生效的观测不进入因素归因', () => {
  const valid = observation({ id: 'valid', accountId: 'a1', country: 'HK' });
  const mismatched = {
    ...observation({ id: 'mismatch', accountId: 'a1', country: 'JP', ip: '203.0.113.9' }),
    plannedCheckoutCountry: 'JP',
    actualCheckoutCountry: 'HK',
    countryTreatmentApplied: false,
    routeTreatmentApplied: false,
    experimentValidityStatus: 'invalid' as const,
    experimentValidForAttribution: false,
    experimentValidityReasons: ['checkout-country-mismatch'],
  };
  const report = buildFactorAnalysis([valid, mismatched], 2);
  assert.equal(report.sampleSize, 2);
  assert.equal(report.resolvedSamples, 1);
  assert.equal(report.quality.rawObservationCount, 2);
  assert.equal(report.quality.attributionEligibleSamples, 1);
  assert.equal(report.quality.excludedTreatmentSamples, 1);

  const readiness = buildExperimentReadiness({
    accounts: [account('a1')],
    proxyHealth: [health('HK', '198.51.100.1', 'AS100'), health('JP', '203.0.113.9', 'AS200')],
    observations: [valid, mismatched],
    config: DEFAULT_PROBE_TASK_CONFIG,
  });
  assert.equal(readiness.observationCount, 2);
  assert.equal(readiness.attributionEligibleObservationCount, 1);
  assert.equal(readiness.invalidTreatmentObservationCount, 1);
  assert.notEqual(readiness.items.find((item) => item.factor === 'country')?.status, 'identifiable');

  const coverage = buildExperimentCoverage({
    observations: [valid, mismatched], accountIds: ['a1'], countries: ['HK', 'JP'],
    targetSamplesPerCell: 1, minRepeatIntervalMinutes: 0, minTotalSamples: 20,
  });
  assert.equal(coverage.matrixSampleSize, 1);
  assert.equal(coverage.coveredCells, 1);
});
