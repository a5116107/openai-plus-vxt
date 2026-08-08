export function isZeroCheckoutAmount(value: string): boolean {
  const normalized = String(value || '').trim();
  if (!normalized) return false;
  const numbers = normalized.match(/-?\d+(?:[.,]\d+)?/g) || [];
  return numbers.length === 1 && Number(numbers[0].replace(',', '.')) === 0;
}

export function checkoutCurrencyFromAmount(value: string): string {
  const normalized = String(value || '').toUpperCase();
  if (/US\$|USD/.test(normalized)) return 'USD';
  if (/CA\$|CAD/.test(normalized)) return 'CAD';
  if (/AU\$|AUD/.test(normalized)) return 'AUD';
  if (/EUR|€/.test(normalized)) return 'EUR';
  if (/GBP|£/.test(normalized)) return 'GBP';
  if (/INR|₹/.test(normalized)) return 'INR';
  if (/JPY|¥|￥/.test(normalized)) return 'JPY';
  if (/BRL|R\$/.test(normalized)) return 'BRL';
  if (/\$/.test(normalized)) return 'USD';
  return '';
}
