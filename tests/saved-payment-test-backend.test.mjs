import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';

import {
  assertSavedPaymentLiveE2eReady,
  createSavedPaymentLiveE2eRuntime,
  createSavedPaymentPreflightEvidence,
  probeSavedPaymentProfile,
} from './support/saved-payment-live-e2e-runner.mjs';
import { startSavedPaymentStripeTestBackend } from './support/saved-payment-stripe-test-support.mjs';

test('live E2E preflight and missing-profile probe keep payment inputs out of evidence', async () => {
  const env = {
    SPM_E2E_PROFILE_DIR: 'H:/missing-profile-fixture',
    SPM_E2E_PUBLISHABLE_KEY: 'pk_test_fixture',
    SPM_E2E_BILLING_NAME: 'Fixture User',
    SPM_E2E_CARD_NUMBER: 'CARD_FIXTURE_VALUE',
    SPM_E2E_CARD_EXPIRY: 'EXPIRY_FIXTURE_VALUE',
    SPM_E2E_CARD_CVC: 'CVC_FIXTURE_VALUE',
    SPM_E2E_STRIPE_SECRET_KEY: 'sk_test_fixture',
  };
  const runtime = createSavedPaymentLiveE2eRuntime({
    env,
    repoRoot: process.cwd(),
    executablePath: 'C:/browser-fixture.exe',
    playwrightModule: 'C:/playwright-fixture.js',
  });
  const evidence = createSavedPaymentPreflightEvidence(runtime);
  const serialized = JSON.stringify(evidence);

  assert.equal(evidence.ok, false);
  assert.equal(evidence.preflight.testBackendMode, 'embedded');
  assert.equal(evidence.preflight.inputsConfigured, true);
  assert.equal(serialized.includes(env.SPM_E2E_CARD_NUMBER), false);
  assert.equal(serialized.includes(env.SPM_E2E_CARD_EXPIRY), false);
  assert.equal(serialized.includes(env.SPM_E2E_CARD_CVC), false);
  assert.throws(() => assertSavedPaymentLiveE2eReady(runtime), /prerequisites missing/);

  const profileProbe = await probeSavedPaymentProfile(runtime);
  assert.equal(profileProbe.ok, false);
  assert.equal(profileProbe.profileConfigured, true);
  assert.equal(profileProbe.profileExists, false);
  assert.equal(JSON.stringify(profileProbe).includes(env.SPM_E2E_CARD_NUMBER), false);
});

test('profile probe supports an explicit direct-session mode without changing the default proxy path', async () => {
  const source = await readFile(new URL('./support/saved-payment-live-e2e-runner.mjs', import.meta.url), 'utf8');
  assert.match(source, /SPM_E2E_SKIP_AUTH_PROXY !== 'true'/);
  assert.match(source, /applyProfileAuthProxy\(context\)/);
});

test('embedded Stripe test backend creates SetupIntent and reconciles attached/default card', async () => {
  const calls = [];
  let defaultPaymentMethodId = '';
  const stripe = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const body = await readBody(request);
    calls.push({ method: request.method, path: url.pathname, query: url.search, body, authorization: request.headers.authorization });
    if (request.method === 'POST' && url.pathname === '/v1/customers') {
      json(response, 200, { id: 'cus_fixture' });
    } else if (request.method === 'POST' && url.pathname === '/v1/setup_intents') {
      json(response, 200, { id: 'seti_fixture', client_secret: 'seti_fixture_secret_fixture' });
    } else if (request.method === 'GET' && url.pathname === '/v1/payment_methods') {
      json(response, 200, { data: [{ id: 'pm_fixture', type: 'card', card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 } }] });
    } else if (request.method === 'GET' && url.pathname === '/v1/customers/cus_fixture') {
      json(response, 200, { id: 'cus_fixture', invoice_settings: { default_payment_method: defaultPaymentMethodId } });
    } else if (request.method === 'POST' && url.pathname === '/v1/customers/cus_fixture') {
      defaultPaymentMethodId = new URLSearchParams(body).get('invoice_settings[default_payment_method]') || '';
      json(response, 200, { id: 'cus_fixture', invoice_settings: { default_payment_method: defaultPaymentMethodId } });
    } else {
      json(response, 404, { error: 'fixture route missing' });
    }
  });

  await listen(stripe);
  const address = stripe.address();
  const backend = await startSavedPaymentStripeTestBackend({
    stripeSecretKey: 'sk_test_fixture',
    stripeApiBaseUrl: `http://127.0.0.1:${address.port}`,
  });

  try {
    const created = await fetch(new URL('/backend-api/payments/payment_method', backend.baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${backend.accessToken}` },
      body: JSON.stringify({ account_id: 'account-fixture' }),
    });
    assert.equal(created.status, 200);
    assert.deepEqual(await created.json(), { client_secret: 'seti_fixture_secret_fixture' });

    const listed = await fetch(new URL('/backend-api/payments/payment_methods?account_id=account-fixture', backend.baseUrl), {
      headers: { Authorization: `Bearer ${backend.accessToken}` },
    });
    assert.equal(listed.status, 200);
    assert.deepEqual(await listed.json(), {
      payment_methods: [{ id: 'pm_fixture', type: 'card', card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 } }],
      default_payment_method_id: 'pm_fixture',
    });
    assert.equal(calls.every((call) => call.authorization === 'Bearer sk_test_fixture'), true);
    assert.match(calls.find((call) => call.path === '/v1/customers').body, /metadata%5Bopx_account_digest%5D=[a-f0-9]{64}/);
    assert.equal(calls.some((call) => call.body.includes('account-fixture')), false);

    const rejected = await fetch(new URL('/health', backend.baseUrl));
    assert.equal(rejected.status, 401);
  } finally {
    await backend.close();
    await close(stripe);
  }
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}
