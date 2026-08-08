import { tryExtractAccessToken } from '../link-extractor/checkout';
import type {
  ProbeAccount,
  ProbeDriftAlert,
  ProbeExperimentReadiness,
  ProbeIdentifiabilityFactor,
  ProbeIdentifiabilityItem,
  ProbeObservation,
  ProbeProxyHealthItem,
  ProbeTaskConfig,
} from './types';
import { isObservationAttributionEligible } from './validity';

interface ReadinessInput {
  accounts: ProbeAccount[];
  proxyHealth: ProbeProxyHealthItem[];
  observations: ProbeObservation[];
  config: ProbeTaskConfig;
  driftAlerts?: ProbeDriftAlert[];
}

export function buildExperimentReadiness(input: ReadinessInput): ProbeExperimentReadiness {
  const now = Date.now();
  const attributionObservations = input.observations.filter(isObservationAttributionEligible);
  const routeObservations = attributionObservations.filter((item) => item.routeTreatmentApplied);
  const paymentObservations = attributionObservations.filter((item) => item.paymentMethodTreatmentApplied && Boolean(item.submittedPaymentMethod));
  const enabledAccounts = input.accounts.filter((item) => item.enabled);
  const latestByAccount = new Map<string, ProbeObservation>();
  for (const item of input.observations) {
    const previous = latestByAccount.get(item.accountId);
    if (!previous || item.observedAt >= previous.observedAt) latestByAccount.set(item.accountId, item);
  }
  const rejectedCredentials = new Set(
    [...latestByAccount.values()].filter((item) => item.errorClass === 'account-auth').map((item) => item.accountId),
  );
  const usableCredentials = enabledAccounts.filter((item) => item.serverCredentialStatus !== 'invalid'
    && credentialUsable(item.tokenRaw, now)
    && !rejectedCredentials.has(item.id));
  const healthy = latestHealthyExits(input.proxyHealth);
  const observedExits = attributionObservations
    .filter((item) => item.checkout.verified)
    .map((item) => ({
      country: item.checkout.country,
      ip: item.checkout.ip,
      asn: item.checkout.asn,
    }));
  const actualCountries = unique([...healthy.map((item) => item.actualCountry || item.country), ...observedExits.map((item) => item.country)]);
  const actualIps = unique([...healthy.map((item) => item.actualIp || ''), ...observedExits.map((item) => item.ip)]);
  const actualAsns = unique([...healthy.map((item) => item.asn || ''), ...observedExits.map((item) => item.asn)]);
  const minMatchedSamples = Math.max(4, input.config.factorMinSamples * 2);

  const accountMatch = matchedVariation(attributionObservations, exitIdentity, (item) => item.accountId);
  const countryMatch = matchedVariation(attributionObservations, (item) => item.accountId, actualCountry);
  const ipMatch = matchedVariation(attributionObservations, (item) => item.accountId, (item) => item.checkout.ip);
  const asnMatch = matchedVariation(attributionObservations, (item) => item.accountId, (item) => item.checkout.asn);
  const routeMatch = matchedVariation(routeObservations, accountCountryIdentity, (item) => item.routeVariantId);
  const paymentMatch = matchedVariation(paymentObservations, accountCountryIdentity, (item) => item.submittedPaymentMethod || '');
  const repeated = repeatedCrossTimeCells(attributionObservations, input.config.researchTargetSamplesPerCell, input.config.researchMinRepeatIntervalMinutes);

  const items: ProbeIdentifiabilityItem[] = [
    readinessItem('account', usableCredentials.length, accountMatch, usableCredentials.length >= 2 && (healthy.length > 0 || actualIps.length > 0), minMatchedSamples,
      usableCredentials.length < 2 ? '至少需要 2 个有效账号' : '需在同一实际出口下比较多个账号'),
    readinessItem('country', actualCountries.length, countryMatch, usableCredentials.length > 0 && actualCountries.length >= 2, minMatchedSamples,
      actualCountries.length < 2 ? '至少需要 2 个健康且实际国家不同的出口' : '需让同一账号跨实际国家重复'),
    readinessItem('exit-ip', actualIps.length, ipMatch, usableCredentials.length > 0 && actualIps.length >= 2, minMatchedSamples,
      actualIps.length < 2 ? '至少需要 2 个已验证实际出口 IP' : '需让同一账号跨实际 IP 重复'),
    readinessItem('exit-asn', actualAsns.length, asnMatch, usableCredentials.length > 0 && actualAsns.length >= 2, minMatchedSamples,
      actualAsns.length < 2 ? '至少需要 2 个已验证 ASN' : '需让同一账号跨 ASN 重复'),
    {
      factor: 'time-randomness',
      status: repeated.identifiable ? 'identifiable' : attributionObservations.length ? 'observing' : 'ready',
      levels: repeated.cells,
      matchedStrata: repeated.cells,
      samples: repeated.samples,
      message: repeated.identifiable
        ? `已有 ${repeated.cells} 个同账号×同出口跨时段重复单元`
        : `每个同账号×同出口单元至少重复 ${Math.max(3, input.config.researchTargetSamplesPerCell)} 次，并跨 ${input.config.researchMinRepeatIntervalMinutes} 分钟`,
    },
    readinessItem('route', unique(input.config.routeVariants.map((item) => item.id)).length, routeMatch, input.config.routeVariants.length >= 2, minMatchedSamples,
      input.config.routeVariants.length < 2 ? '至少配置 2 个三阶段路由变体' : '需在同账号×国家内轮换路由'),
    readinessItem('payment-method', unique(input.config.paymentMethodVariants).length, paymentMatch, input.config.paymentMethodVariants.length >= 2, minMatchedSamples,
      input.config.paymentMethodVariants.length < 2 ? '至少需要 2 个已探测支持的支付方式' : '需在同账号×国家内轮换已支持方式'),
  ];

  const latest = [...input.observations].sort((a, b) => b.observedAt - a.observedAt)[0];
  const currentRuleEpochId = latest?.ruleEpochId || '';
  const currentRuleEpochSamples = currentRuleEpochId
    ? attributionObservations.filter((item) => item.ruleEpochId === currentRuleEpochId).length
    : 0;
  const baseExploration = clamp(input.config.adaptiveExplorationPercent, 5, 50);
  const ruleDrift = (input.driftAlerts || []).some((item) => item.kind === 'protocol-schema' || item.kind === 'offer-set');
  const criticalDrift = (input.driftAlerts || []).some((item) => item.level === 'critical');
  const driftBoostedExplorationPercent = criticalDrift ? Math.max(baseExploration, 50) : ruleDrift ? Math.max(baseExploration, 35) : baseExploration;
  const blockers = items.filter((item) => item.status === 'blocked').map((item) => `${factorLabel(item.factor)}：${item.message}`);
  if (!usableCredentials.length) blockers.unshift('没有可用且未过期的账号凭证');
  if (!healthy.length && !actualIps.length) blockers.unshift('没有通过健康检查的实际出口');
  const invalidTreatmentObservationCount = input.observations.filter((item) => item.experimentValidityStatus === 'invalid').length;
  const partialTreatmentObservationCount = input.observations.filter((item) => item.experimentValidityStatus === 'partial').length;

  return {
    generatedAt: now,
    enabledAccountCount: enabledAccounts.length,
    usableCredentialCount: usableCredentials.length,
    healthyExitCount: healthy.length,
    healthyActualCountryCount: actualCountries.length,
    healthyActualIpCount: actualIps.length,
    healthyActualAsnCount: actualAsns.length,
    observationCount: input.observations.length,
    attributionEligibleObservationCount: attributionObservations.length,
    invalidTreatmentObservationCount,
    partialTreatmentObservationCount,
    currentRuleEpochId,
    currentRuleEpochSamples,
    adaptiveExplorationPercent: baseExploration,
    driftBoostedExplorationPercent,
    items,
    blockers: unique(blockers),
  };
}

function readinessItem(
  factor: ProbeIdentifiabilityFactor,
  levels: number,
  match: { strata: number; samples: number },
  ready: boolean,
  minMatchedSamples: number,
  pendingMessage: string,
): ProbeIdentifiabilityItem {
  const identifiable = match.strata > 0 && match.samples >= minMatchedSamples;
  return {
    factor,
    status: identifiable ? 'identifiable' : match.samples > 0 ? 'observing' : ready ? 'ready' : 'blocked',
    levels,
    matchedStrata: match.strata,
    samples: match.samples,
    message: identifiable ? `已有 ${match.strata} 个匹配层、${match.samples} 条交叉样本` : pendingMessage,
  };
}

function matchedVariation(
  observations: ProbeObservation[],
  stratumOf: (item: ProbeObservation) => string,
  treatmentOf: (item: ProbeObservation) => string,
): { strata: number; samples: number } {
  const groups = new Map<string, ProbeObservation[]>();
  for (const item of observations.filter((value) => value.outcome !== 'error')) {
    const stratum = stratumOf(item);
    const treatment = treatmentOf(item);
    if (!stratum || !treatment) continue;
    const group = groups.get(stratum) || [];
    group.push(item);
    groups.set(stratum, group);
  }
  const matched = [...groups.values()].filter((group) => unique(group.map(treatmentOf)).length >= 2);
  return { strata: matched.length, samples: matched.reduce((sum, group) => sum + group.length, 0) };
}

function repeatedCrossTimeCells(
  observations: ProbeObservation[],
  configuredTarget: number,
  minMinutes: number,
): { cells: number; samples: number; identifiable: boolean } {
  const target = Math.max(3, configuredTarget);
  const groups = new Map<string, ProbeObservation[]>();
  for (const item of observations.filter((value) => value.outcome !== 'error')) {
    const key = `${item.accountId}|${exitIdentity(item)}`;
    if (!item.accountId || !exitIdentity(item)) continue;
    const group = groups.get(key) || [];
    group.push(item);
    groups.set(key, group);
  }
  const repeated = [...groups.values()].filter((group) => {
    if (group.length < target) return false;
    const times = group.map((item) => item.observedAt).sort((a, b) => a - b);
    return times[times.length - 1] - times[0] >= Math.max(0, minMinutes) * 60000;
  });
  return {
    cells: repeated.length,
    samples: repeated.reduce((sum, group) => sum + group.length, 0),
    identifiable: repeated.length >= 2,
  };
}

function latestHealthyExits(items: ProbeProxyHealthItem[]): ProbeProxyHealthItem[] {
  const latest = new Map<string, ProbeProxyHealthItem>();
  for (const item of items) {
    const key = String(item.country || '').toUpperCase();
    const previous = latest.get(key);
    if (!previous || item.checkedAt >= previous.checkedAt) latest.set(key, item);
  }
  return [...latest.values()].filter((item) => item.status === 'ok' && Boolean(item.actualIp || item.actualCountry));
}

function credentialUsable(raw: string, now: number): boolean {
  const token = tryExtractAccessToken(raw) || String(raw || '').trim();
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length < 2) return true;
  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
    const payload = JSON.parse(atob(padded)) as { exp?: number };
    return !payload.exp || payload.exp * 1000 > now;
  } catch {
    return true;
  }
}

function actualCountry(item: ProbeObservation): string {
  return item.checkout.country || item.bootstrapCountry || item.probeCountry;
}

function exitIdentity(item: ProbeObservation): string {
  return item.checkout.ip || item.checkoutSubnet || item.checkout.endpointSummary;
}

function accountCountryIdentity(item: ProbeObservation): string {
  return `${item.accountId}|${actualCountry(item)}`;
}

function factorLabel(value: ProbeIdentifiabilityFactor): string {
  return ({
    account: '账号', country: '国家', 'exit-ip': '出口 IP', 'exit-asn': '出口 ASN',
    'time-randomness': '跨时段随机性', route: '三阶段路由', 'payment-method': '支付方式',
  } as Record<ProbeIdentifiabilityFactor, string>)[value];
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((item) => String(item || '').trim()).filter(Boolean))];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number(value) || min));
}
