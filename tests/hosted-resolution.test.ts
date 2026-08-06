import assert from 'node:assert/strict';
import test from 'node:test';

import {
  identityResolution,
  isIdentitySnapshotReady,
  resolveHostedArtifacts,
  sessionEmailsMatch,
} from '../src/features/probe/hosted-resolution';

test('AT-only 身份快照标记为未就绪', () => {
  assert.equal(isIdentitySnapshotReady({ deviceId: 'd', sessionId: 's', cookies: [], capturedAt: 1 }), false);
  assert.equal(isIdentitySnapshotReady({
    deviceId: 'd',
    sessionId: 's',
    capturedAt: 1,
    cookies: [{
      name: '__Secure-next-auth.session-token',
      value: 'session-fixture',
      domain: '.chatgpt.com',
      path: '/',
      secure: true,
      httpOnly: true,
    }],
  }), true);
});

test('登录页返回 identity_required 且不从 bundle/resource 误报支付方式', () => {
  const result = resolveHostedArtifacts({
    finalUrl: 'https://chatgpt.com/auth/login?next=%2Fcheckout%2Fopenai_llc%2Foaics_fixture',
    pageText: 'Log in to ChatGPT',
    pageHtml: '<script src="/bundle-paypal-momo-kakaopay.js"></script>',
    resourceUrls: ['https://chatgpt.com/bundle-paypal-momo-kakaopay.js'],
  });
  assert.equal(result.status, 'identity_required');
  assert.deepEqual(result.methods, []);
});

test('从结账页面提取 Hosted URL、Stripe 会话、PK 和可见支付方式', () => {
  const result = resolveHostedArtifacts({
    finalUrl: 'https://chatgpt.com/checkout/openai_llc/oaics_fixture',
    pageText: 'Choose a payment method PayPal MoMo Kakao Pay',
    pageHtml: [
      '<script>window.checkout="https:\\/\\/checkout.stripe.com\\/c\\/pay\\/cs_live_fixture#fidkdWxOYHwnPyd1blpxYHZxWjA0"</script>',
      '<script>window.pk="pk_live_fixture"</script>',
    ].join(''),
    resourceUrls: [
      'https://api.stripe.com/v1/payment_pages/cs_live_fixture/init',
      'https://js.stripe.com/v3/',
    ],
  });
  assert.equal(result.status, 'resolved_hosted');
  assert.equal(result.checkoutSessionId, 'cs_live_fixture');
  assert.equal(result.checkoutSessionType, 'stripe');
  assert.equal(result.stripePublishableKey, 'pk_live_fixture');
  assert.deepEqual(result.methods, ['paypal', 'momo', 'kakao']);
  assert.equal(result.stripeResourceCount, 2);
});

test('oaics 页面只加载 Stripe 资源时保持 checkout_loaded，不伪造长链', () => {
  const result = resolveHostedArtifacts({
    finalUrl: 'https://chatgpt.com/checkout/openai_llc/oaics_fixture',
    pageText: 'Checkout',
    resourceUrls: ['https://js.stripe.com/v3/'],
  });
  assert.equal(result.status, 'checkout_loaded');
  assert.equal(result.hostedUrl, '');
  assert.equal(result.checkoutSessionType, 'oaics');
});

test('会话邮箱使用精确归一化匹配并支持 mismatch 状态', () => {
  assert.equal(sessionEmailsMatch('User@Example.com', 'user@example.com'), true);
  assert.equal(sessionEmailsMatch('one@example.com', 'two@example.com'), false);
  const mismatch = identityResolution('identity_mismatch', 'fixture mismatch', 'https://chatgpt.com/checkout/openai_llc/oaics_fixture');
  assert.equal(mismatch.status, 'identity_mismatch');
  assert.equal(mismatch.checkoutSessionType, 'oaics');
});
