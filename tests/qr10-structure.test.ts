import assert from 'node:assert/strict';
import test from 'node:test';
import { maskEmail, maskPhone, redactLogUrl, redactOAuthPhoneLogText } from '../src/features/oauth-phone/logging';
import { parseCountryExitText } from '../src/features/probe/country-exit-input';
import { buildCountryMethodRecommendations, exportMethodDetectionsCsv } from '../src/features/probe/method-report';

test('QR-10 extracted OAuth logging helpers redact credentials and preserve identity shape', () => {
  assert.equal(maskPhone('+8613812345678'), '861***5678');
  assert.equal(maskEmail('alice@example.com'), 'al***e@example.com');
  assert.equal(redactLogUrl('https://example.test/path/very-long-secret-segment?code=TOKEN#secret'), 'https://example.test/path/very-l...ment?[REDACTED]#[REDACTED]');
  assert.match(redactOAuthPhoneLogText('access_token=TOKEN api_key=SECRET'), /access_token=\[REDACTED\]/);
  assert.match(redactOAuthPhoneLogText('access_token=TOKEN api_key=SECRET'), /api_key=\[REDACTED\]/);
});

test('QR-10 country exit parser accepts URL and legacy endpoint syntax with strict country validation', () => {
  const rows = parseCountryExitText('us ---- socks5://user:pass@127.0.0.1:1080\ninvalid ---- 127.0.0.1:8080\nJP ---- host:9000');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    country: 'US',
    endpoint: { enabled: true, scheme: 'socks5', host: '127.0.0.1', port: 1080, username: 'user', password: 'pass', label: '出口/US' },
  });
  assert.equal(rows[1].country, 'JP');
});

test('QR-10 method report remains deterministic after state extraction', () => {
  const detections = [
    { id: 'a', accountId: 'acct-a', taskId: 'task', country: 'US', methods: ['card', 'paypal'], interestingMethods: ['paypal'], zeroLikely: true, detectedAt: 2, currency: 'USD', email: '', amountHint: '', source: 'fixture', checkoutSessionId: '', message: '' },
    { id: 'b', accountId: 'acct-b', taskId: 'task', country: 'US', methods: ['card'], interestingMethods: [], zeroLikely: false, detectedAt: 3, currency: 'USD', email: '', amountHint: '', source: 'fixture', checkoutSessionId: '', message: '' },
  ];
  const rows = buildCountryMethodRecommendations(detections);
  assert.deepEqual(rows[0], { country: 'US', methods: ['card', 'paypal'], interestingMethods: ['paypal'], samples: 2, zeroSamples: 1, lastDetectedAt: 3, recommendedPaymentMethod: 'paypal', note: '推荐 paypal（基于 2 次探测到的支持方式）' });
  assert.match(exportMethodDetectionsCsv(detections), /detectedAt,country/);
});
