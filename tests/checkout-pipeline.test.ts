import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  checkoutStateFromHtml,
  parseStructuredCheckoutAmount,
  payloadHasInvalidPromotion,
} from '../src/features/link-extractor/checkout-amount';
import {
  enforceCheckoutCreationPolicy,
  normalizeCheckoutCreationPolicy,
  parseServerNetworkEvidence,
  runStagedCheckoutPipeline,
} from '../src/features/link-extractor/checkout';
import type { CheckoutRetryEvent } from '../src/features/link-extractor/types';

const TOKEN = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJmaXh0dXJlIn0.signature';
const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/checkout-react-router-zero.html', import.meta.url));

test('结构化金额解析覆盖 wrapper、invoice 和 lineItems', () => {
  assert.deepEqual(parseStructuredCheckoutAmount({ data: { invoice: { amount_due: { minorUnitsAmount: '0' } }, currency: 'php' } }), {
    amountMinor: 0,
    recurringAmountMinor: null,
    amountHint: '0',
    currency: 'PHP',
    path: 'data.invoice.amount_due',
    recurringPath: '',
    zeroLikely: true,
    promoLikely: false,
    trialLikely: false,
  });
  const lines = parseStructuredCheckoutAmount({ checkoutState: { lineItems: [{ total: 1200 }, { subtotal: '300' }], currencyCode: 'usd' } });
  assert.equal(lines.amountMinor, 1500);
  assert.equal(lines.path, 'checkoutState.lineItems.sum');
  assert.equal(lines.currency, 'USD');
});

test('生产 React Router 解码器从流式 HTML 提取零金额', async () => {
  const html = await readFile(FIXTURE_PATH, 'utf8');
  const state = checkoutStateFromHtml(html);
  const amount = parseStructuredCheckoutAmount(state);
  assert.equal(amount.amountMinor, 0);
  assert.equal(amount.currency, 'PHP');
  assert.equal(amount.path, 'total_summary.due');
});

test('invalid_promotion 会丢弃 Session、完整重建并通过页面回退验证零金额', async (context) => {
  const html = await readFile(FIXTURE_PATH, 'utf8');
  let createCalls = 0;
  let updateCalls = 0;
  const bodies: unknown[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (chunks.length) bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    response.setHeader('content-type', request.url === '/page' ? 'text/html' : 'application/json');
    if (request.url === '/create') {
      createCalls += 1;
      response.end(JSON.stringify({
        checkout_session_id: `oaics_flow_${createCalls}`,
        processor_entity: 'openai_ie',
        url: `https://checkout.stripe.test/c/pay/oaics_flow_${createCalls}`,
      }));
      return;
    }
    if (request.url === '/update') {
      updateCalls += 1;
      response.end(updateCalls === 1
        ? JSON.stringify({ success: false, error: { code: 'invalid_promotion' } })
        : JSON.stringify({ success: true, promo_campaign: { id: 'plus-1-month-free' }, currency: 'PHP' }));
      return;
    }
    if (request.url === '/page') {
      response.end(html);
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const retryEvents: CheckoutRetryEvent[] = [];
  const result = await runStagedCheckoutPipeline(TOKEN, {
    planName: 'chatgptplusplan',
    uiMode: 'hosted',
    bootstrapCountry: 'PH',
    promotionCountry: 'VN',
    providerCountry: 'PH',
    enablePromotionUpdate: true,
    requireZero: true,
    checkoutAttempts: 2,
    updateAttempts: 2,
    fullFlowAttempts: 2,
    endpoints: { create: `${base}/create`, update: `${base}/update`, page: `${base}/page` },
    identitySnapshot: { deviceId: 'device-fixture', sessionId: 'session-fixture', cookies: [], capturedAt: Date.now() },
    onRetry: (event) => { retryEvents.push(event); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.checkoutSessionId, 'oaics_flow_2');
  assert.equal(result.amountMinor, 0);
  assert.equal(result.amountCurrency, 'PHP');
  assert.equal(result.amountSource, 'checkout-page');
  assert.equal(result.amountVerification, 'verified-zero');
  assert.equal(result.retryMetrics?.checkoutAttempts, 2);
  assert.equal(result.retryMetrics?.updateAttempts, 2);
  assert.equal(result.retryMetrics?.fullFlowAttempts, 2);
  assert.equal(result.retryMetrics?.invalidPromotionRebuilds, 1);
  assert.equal(result.retryMetrics?.pageFallbackAttempts, 1);
  assert.equal(retryEvents.filter((event) => event.stage === 'full-flow').length, 1);
  assert.match(result.stageTrace?.join('|') || '', /discard:oaics_flow_1/);
  assert.equal(createCalls, 2);
  assert.equal(updateCalls, 2);
  assert.equal(bodies.length, 4);
});

test('Cloudflare 层重试独立计数并触发出口轮换事件', async (context) => {
  let createCalls = 0;
  const server = createServer((_request, response) => {
    createCalls += 1;
    if (createCalls === 1) {
      response.statusCode = 403;
      response.setHeader('content-type', 'text/html');
      response.end('<html><title>Just a moment...</title><div>Cloudflare challenge</div></html>');
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      checkout_session_id: 'oaics_cf_recovered',
      processor_entity: 'openai_llc',
      url: 'https://checkout.stripe.test/c/pay/oaics_cf_recovered',
      total_summary: { due: { minorUnitsAmount: '0' } },
      currency: 'USD',
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const events: CheckoutRetryEvent[] = [];
  const result = await runStagedCheckoutPipeline(TOKEN, {
    bootstrapCountry: 'US', promotionCountry: 'US', providerCountry: 'US',
    enablePromotionUpdate: false, requireZero: true, checkoutAttempts: 2, fullFlowAttempts: 1, cfSameIdentityAttempts: 1,
    endpoints: { create: `http://127.0.0.1:${address.port}/create` },
    onRetry: (event) => { events.push(event); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.retryMetrics?.checkoutAttempts, 2);
  assert.equal(result.retryMetrics?.cfRetryCount, 1);
  assert.equal(result.retryMetrics?.cfExitRotations, 1);
  assert.equal(events[0]?.stage, 'cloudflare');
  assert.equal(events[0]?.rotateExit, true);
});

test('invalid_promotion 递归识别对象、数组和错误文案', () => {
  assert.equal(payloadHasInvalidPromotion({ error: { reasons: [{ code: 'invalid_promotion' }] } }), true);
  assert.equal(payloadHasInvalidPromotion({ message: 'checkout/update returned invalid promotion' }), true);
  assert.equal(payloadHasInvalidPromotion({ success: true, promotion: 'plus-1-month-free' }), false);
});

test('Checkout 创建策略统一 direct/staged/server 默认值', () => {
  const defaults = normalizeCheckoutCreationPolicy(undefined, { region: 'PH' });
  assert.equal(defaults.transport, 'browser-direct');
  assert.equal(defaults.pipeline, 'direct');
  assert.equal(defaults.bootstrapCountry, 'PH');
  const staged = normalizeCheckoutCreationPolicy({
    transport: 'server', pipeline: 'staged', requireZero: true,
    promotionCountry: 'vn', providerCountry: 'ph', previousSessionId: 'oaics_a',
  }, { region: 'US' });
  assert.equal(staged.transport, 'server');
  assert.equal(staged.pipeline, 'staged');
  assert.equal(staged.promotionCountry, 'VN');
  assert.equal(staged.previousSessionId, 'oaics_a');
});

test('Checkout B distinct、zero 和 network 门逐项阻断', () => {
  const policy = normalizeCheckoutCreationPolicy({
    pipeline: 'staged', requireZero: true, requireVerifiedNetwork: true,
    previousSessionId: 'oaics_a',
  }, { region: 'PH' });
  const reused = enforceCheckoutCreationPolicy({
    ok: true, message: 'fixture', checkoutSessionId: 'oaics_a', amountVerification: 'verified-zero',
  }, policy);
  assert.equal(reused.errorCode, 'CHECKOUT_NOT_DISTINCT');
  const missingNetwork = enforceCheckoutCreationPolicy({
    ok: true, message: 'fixture', checkoutSessionId: 'oaics_b', amountVerification: 'verified-zero',
  }, policy);
  assert.equal(missingNetwork.errorCode, 'NETWORK_EVIDENCE_MISSING');
});

test('server trace 与请求国家分离并只信任显式 verified', () => {
  const evidence = parseServerNetworkEvidence({
    requestId: 'req-fixture',
    networkEvidence: { ip: '203.0.113.7', country: 'ph', colo: 'MNL', asn: 'AS64500', verified: true, capturedAt: 123 },
  });
  assert.deepEqual(evidence, {
    plane: 'server-checkout', requestId: 'req-fixture', ip: '203.0.113.7', country: 'PH',
    colo: 'MNL', asn: 'AS64500', verified: true, capturedAt: 123,
  });
  assert.equal(parseServerNetworkEvidence({ network: { country: 'PH' } }), undefined);
});
