import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkoutSessionId,
  isCheckoutPageUrl,
  isCheckoutSuccessUrl,
  isCheckoutVerifyUrl,
  isLiveCheckoutPageUrl,
  parseCheckoutReference,
} from '../src/features/link-extractor/checkout-reference';

test('parses OpenAI oaics checkout references', () => {
  const result = parseCheckoutReference('https://chatgpt.com/checkout/openai_llc/oaics_fixture_1');
  assert.deepEqual(result, {
    kind: 'openai',
    sessionId: 'oaics_fixture_1',
    processorEntity: 'openai_llc',
    canonicalUrl: 'https://chatgpt.com/checkout/openai_llc/oaics_fixture_1',
    page: 'checkout',
  });
});

test('parses legacy ChatGPT and pay.openai.com Stripe checkout references', () => {
  const chatgpt = parseCheckoutReference('https://chatgpt.com/checkout/openai_llc/cs_live_fixture');
  const hosted = parseCheckoutReference('https://pay.openai.com/c/pay/cs_test_fixture?processor_entity=openai_ie');
  assert.equal(chatgpt?.kind, 'stripe');
  assert.equal(chatgpt?.sessionId, 'cs_live_fixture');
  assert.equal(hosted?.processorEntity, 'openai_ie');
  assert.equal(isCheckoutPageUrl(new URL(hosted!.canonicalUrl)), true);
  assert.equal(isLiveCheckoutPageUrl(chatgpt!.canonicalUrl), true);
  assert.equal(isLiveCheckoutPageUrl(hosted!.canonicalUrl), false);
});

test('parses verify references without treating them as checkout pages', () => {
  const url = 'https://chatgpt.com/checkout/verify?stripe_session_id=oaics_verify_1&processor_entity=openai_llc';
  const result = parseCheckoutReference(url);
  assert.equal(result?.page, 'verify');
  assert.equal(result?.kind, 'openai');
  assert.equal(result?.sessionId, 'oaics_verify_1');
  assert.equal(isCheckoutVerifyUrl(url), true);
  assert.equal(isCheckoutPageUrl(url), false);
});

test('recognizes success and rejects malformed or unrelated URLs', () => {
  assert.equal(isCheckoutSuccessUrl('https://chatgpt.com/payments/success'), true);
  assert.equal(checkoutSessionId('https://chatgpt.com/checkout/openai_llc/not-a-session'), '');
  assert.equal(parseCheckoutReference('not a url'), null);
  assert.equal(parseCheckoutReference('https://example.com/c/pay/cs_fixture'), null);
});
