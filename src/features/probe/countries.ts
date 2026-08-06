import { listCheckoutRegions } from '../link-extractor/checkout';
import type { ProbeCountryOption } from './types';

const COUNTRY_LABELS: Record<string, string> = {
  AE: '阿联酋', AR: '阿根廷', AT: '奥地利', AU: '澳大利亚', BE: '比利时', BG: '保加利亚',
  BH: '巴林', BO: '玻利维亚', BR: '巴西', CA: '加拿大', CH: '瑞士', CL: '智利', CN: '中国',
  CO: '哥伦比亚', CR: '哥斯达黎加', CY: '塞浦路斯', CZ: '捷克', DE: '德国', DK: '丹麦',
  DO: '多米尼加', EE: '爱沙尼亚', EG: '埃及', ES: '西班牙', FI: '芬兰', FR: '法国',
  GB: '英国', GE: '格鲁吉亚', GR: '希腊', HK: '香港', HR: '克罗地亚', HU: '匈牙利',
  ID: '印尼', IE: '爱尔兰', IL: '以色列', IN: '印度', IT: '意大利', JP: '日本',
  KR: '韩国', KW: '科威特', LT: '立陶宛', LU: '卢森堡', LV: '拉脱维亚', MX: '墨西哥',
  MY: '马来西亚', NL: '荷兰', NO: '挪威', NZ: '新西兰', PE: '秘鲁', PH: '菲律宾',
  PL: '波兰', PT: '葡萄牙', QA: '卡塔尔', RO: '罗马尼亚', SA: '沙特', SE: '瑞典',
  SG: '新加坡', SI: '斯洛文尼亚', SK: '斯洛伐克', TH: '泰国', TR: '土耳其', TW: '台湾',
  UA: '乌克兰', US: '美国', VN: '越南', ZA: '南非',
};

export const PROBE_CHANNELS = ['hosted', 'paypal', 'momo', 'gopay', 'ideal', 'upi', 'pix', 'blik', 'twint', 'kakao'] as const;

export function listProbeCountries(): ProbeCountryOption[] {
  return listCheckoutRegions()
    .map((item) => ({
      country: item.country,
      currency: item.currency,
      label: COUNTRY_LABELS[item.country] || item.country,
    }))
    .sort((a, b) => a.country.localeCompare(b.country));
}

export function defaultProbeCountries(): string[] {
  const available = new Set(listProbeCountries().map((item) => item.country));
  const preferred = ['PH', 'ID', 'TR', 'AR', 'BR', 'IN', 'EG', 'US', 'JP', 'DE', 'GB', 'MX', 'VN', 'TH'];
  return preferred.filter((code) => available.has(code));
}
