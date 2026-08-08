import type {
  ProbeCountryMethodRecommendation,
  ProbeMethodDetectionRecord,
} from './types';

export function buildCountryMethodRecommendations(
  detections: ProbeMethodDetectionRecord[],
): ProbeCountryMethodRecommendation[] {
  const map = new Map<string, ProbeMethodDetectionRecord[]>();
  for (const item of detections || []) {
    if (!item?.country) continue;
    const list = map.get(item.country) || [];
    list.push(item);
    map.set(item.country, list);
  }
  const rows: ProbeCountryMethodRecommendation[] = [];
  for (const [country, list] of map.entries()) {
    const methodCount = new Map<string, number>();
    const interestingCount = new Map<string, number>();
    let zeroSamples = 0;
    let lastDetectedAt = 0;
    for (const item of list) {
      if (item.zeroLikely) zeroSamples += 1;
      lastDetectedAt = Math.max(lastDetectedAt, item.detectedAt || 0);
      for (const method of item.methods || []) methodCount.set(method, (methodCount.get(method) || 0) + 1);
      for (const method of item.interestingMethods || []) interestingCount.set(method, (interestingCount.get(method) || 0) + 1);
    }
    const methods = [...methodCount.entries()].sort((a, b) => b[1] - a[1]).map(([method]) => method);
    const interestingMethods = [...interestingCount.entries()].sort((a, b) => b[1] - a[1]).map(([method]) => method);
    const recommendedPaymentMethod = interestingMethods[0] || methods[0] || '';
    rows.push({
      country,
      methods,
      interestingMethods,
      samples: list.length,
      zeroSamples,
      lastDetectedAt,
      recommendedPaymentMethod,
      note: recommendedPaymentMethod
        ? `推荐 ${recommendedPaymentMethod}（基于 ${list.length} 次探测到的支持方式）`
        : '尚无可用方式',
    });
  }
  return rows.sort((a, b) => b.samples - a.samples || a.country.localeCompare(b.country));
}

export function recommendMethodsForCountry(
  detections: ProbeMethodDetectionRecord[],
  country: string,
): ProbeCountryMethodRecommendation | null {
  const code = String(country || '').toUpperCase();
  return buildCountryMethodRecommendations(detections).find((item) => item.country === code) || null;
}

export function exportMethodDetectionsCsv(detections: ProbeMethodDetectionRecord[]): string {
  const header = ['detectedAt','country','currency','email','methods','interestingMethods','amountHint','zeroLikely','source','checkoutSessionId','message'];
  const lines = [header.join(',')];
  for (const item of detections || []) {
    const row = [
      new Date(item.detectedAt || 0).toISOString(), item.country, item.currency, item.email,
      (item.methods || []).join('|'), (item.interestingMethods || []).join('|'), item.amountHint,
      item.zeroLikely ? '1' : '0', item.source, item.checkoutSessionId,
      String(item.message || '').replace(/[\r\n,]/g, ' '),
    ];
    lines.push(row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(','));
  }
  return lines.join('\n');
}

export function exportCountryMethodRecommendationsCsv(rows: ProbeCountryMethodRecommendation[]): string {
  const header = ['country','recommendedPaymentMethod','methods','interestingMethods','samples','zeroSamples','lastDetectedAt','note'];
  const lines = [header.join(',')];
  for (const item of rows || []) {
    const row = [
      item.country, item.recommendedPaymentMethod, (item.methods || []).join('|'),
      (item.interestingMethods || []).join('|'), item.samples, item.zeroSamples,
      item.lastDetectedAt ? new Date(item.lastDetectedAt).toISOString() : '', item.note,
    ];
    lines.push(row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(','));
  }
  return lines.join('\n');
}
