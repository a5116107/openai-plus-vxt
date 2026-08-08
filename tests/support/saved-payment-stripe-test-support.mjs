import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const CREATE_PATH = '/backend-api/payments/payment_method';
const LIST_PATH = '/backend-api/payments/payment_methods';

export function parseSavedPaymentTestBackend(value) {
  const raw = String(value || '').trim();
  if (!raw) return { ok: false, url: null };
  try {
    const url = new URL(raw);
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
    const protocolAccepted = url.protocol === 'https:' || (url.protocol === 'http:' && loopback);
    const productionHost = url.hostname === 'chatgpt.com' || url.hostname.endsWith('.chatgpt.com');
    return { ok: protocolAccepted && !productionHost, url };
  } catch {
    return { ok: false, url: null };
  }
}

export async function installSavedPaymentTestBackendRoute(context, backendBaseUrl, backendToken) {
  const backendPrefix = backendBaseUrl.toString().replace(/\/+$/, '');
  await context.route('https://chatgpt.com/backend-api/payments/**', async (route) => {
    const request = route.request();
    const sourceUrl = new URL(request.url());
    const allowedPath = sourceUrl.pathname === CREATE_PATH || sourceUrl.pathname === LIST_PATH;
    if (!allowedPath) {
      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'E2E_ROUTE_NOT_FOUND' }) });
      return;
    }

    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'x-spm-e2e-mode': 'test',
    };
    if (backendToken) headers.Authorization = `Bearer ${backendToken}`;

    try {
      const response = await fetch(`${backendPrefix}${sourceUrl.pathname}${sourceUrl.search}`, {
        method: request.method(),
        headers,
        body: request.method() === 'POST' ? request.postData() : undefined,
        redirect: 'error',
      });
      await route.fulfill({
        status: response.status,
        contentType: response.headers.get('content-type') || 'application/json',
        body: Buffer.from(await response.arrayBuffer()),
      });
    } catch {
      await route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'E2E_TEST_BACKEND_UNAVAILABLE' }),
      });
    }
  });
}

export async function startSavedPaymentStripeTestBackend(options = {}) {
  const stripeSecretKey = String(options.stripeSecretKey || '').trim();
  if (!/^sk_test_[A-Za-z0-9_-]+$/.test(stripeSecretKey)) {
    throw new Error('SPM_E2E_STRIPE_SECRET_KEY must be a Stripe test secret key');
  }

  const stripeApiBaseUrl = String(options.stripeApiBaseUrl || 'https://api.stripe.com').replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl || fetch;
  const accessToken = randomBytes(32).toString('hex');
  const customersByAccountDigest = new Map();
  const server = createServer((request, response) => {
    handleRequest(request, response, {
      customersByAccountDigest,
      fetchImpl,
      stripeApiBaseUrl,
      stripeSecretKey,
      accessToken,
    }).catch((error) => {
      sendJson(response, error?.httpStatus || 502, { error: String(error?.code || 'STRIPE_TEST_BACKEND_FAILED') });
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('embedded Stripe test backend did not bind a TCP port');

  return {
    baseUrl: new URL(`http://127.0.0.1:${address.port}`),
    accessToken,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function handleRequest(request, response, dependencies) {
  const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
  if (request.headers.authorization !== `Bearer ${dependencies.accessToken}`) {
    sendJson(response, 401, { error: 'TEST_BACKEND_AUTH_REQUIRED' });
    return;
  }
  if (request.method === 'GET' && requestUrl.pathname === '/health') {
    sendJson(response, 200, { ok: true, mode: 'stripe-test' });
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === CREATE_PATH) {
    const body = await readJsonBody(request);
    const accountId = requiredAccountId(body.account_id);
    const accountDigest = digestAccountId(accountId);
    const customerId = await getOrCreateCustomer(accountDigest, dependencies);
    const setupIntent = await stripeRequest(dependencies, '/v1/setup_intents', {
      method: 'POST',
      form: {
        customer: customerId,
        usage: 'off_session',
        'payment_method_types[]': 'card',
        'metadata[opx_account_digest]': accountDigest,
      },
    });
    if (!/^seti_[A-Za-z0-9]+_secret_[A-Za-z0-9]+$/.test(String(setupIntent.client_secret || ''))) {
      throw backendError('STRIPE_SETUP_INTENT_MALFORMED', 502);
    }
    sendJson(response, 200, { client_secret: setupIntent.client_secret });
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === LIST_PATH) {
    const accountId = requiredAccountId(requestUrl.searchParams.get('account_id'));
    const accountDigest = digestAccountId(accountId);
    const customerId = dependencies.customersByAccountDigest.get(accountDigest);
    if (!customerId) {
      sendJson(response, 200, { payment_methods: [], default_payment_method_id: '' });
      return;
    }

    const listed = await stripeRequest(dependencies, '/v1/payment_methods', {
      query: { customer: customerId, type: 'card', limit: '20' },
    });
    const paymentMethods = Array.isArray(listed.data) ? listed.data.map(normalizePaymentMethod).filter(Boolean) : [];
    const customer = await stripeRequest(dependencies, `/v1/customers/${encodeURIComponent(customerId)}`);
    let defaultPaymentMethodId = defaultPaymentMethod(customer);
    if (!defaultPaymentMethodId && paymentMethods[0]?.id) {
      await stripeRequest(dependencies, `/v1/customers/${encodeURIComponent(customerId)}`, {
        method: 'POST',
        form: { 'invoice_settings[default_payment_method]': paymentMethods[0].id },
      });
      defaultPaymentMethodId = paymentMethods[0].id;
    }
    sendJson(response, 200, {
      payment_methods: paymentMethods,
      default_payment_method_id: defaultPaymentMethodId,
    });
    return;
  }

  sendJson(response, 404, { error: 'ROUTE_NOT_FOUND' });
}

async function getOrCreateCustomer(accountDigest, dependencies) {
  const existing = dependencies.customersByAccountDigest.get(accountDigest);
  if (existing) return existing;
  const customer = await stripeRequest(dependencies, '/v1/customers', {
    method: 'POST',
    form: {
      description: 'OpenAI Plus VXT saved-payment E2E',
      'metadata[opx_account_digest]': accountDigest,
    },
  });
  const customerId = String(customer.id || '');
  if (!/^cus_[A-Za-z0-9]+$/.test(customerId)) throw backendError('STRIPE_CUSTOMER_MALFORMED', 502);
  dependencies.customersByAccountDigest.set(accountDigest, customerId);
  return customerId;
}

async function stripeRequest(dependencies, pathname, options = {}) {
  const url = new URL(`${dependencies.stripeApiBaseUrl}${pathname}`);
  for (const [key, value] of Object.entries(options.query || {})) url.searchParams.set(key, value);
  const response = await dependencies.fetchImpl(url, {
    method: options.method || 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${dependencies.stripeSecretKey}`,
      ...(options.form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: options.form ? new URLSearchParams(options.form) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw backendError('STRIPE_API_REJECTED', response.status >= 500 ? 502 : 400);
  return data;
}

function normalizePaymentMethod(value) {
  const id = String(value?.id || '');
  if (!/^pm_[A-Za-z0-9]+$/.test(id) || value?.type !== 'card') return null;
  return {
    id,
    type: 'card',
    card: {
      brand: String(value.card?.brand || ''),
      last4: String(value.card?.last4 || ''),
      exp_month: Number(value.card?.exp_month || 0),
      exp_year: Number(value.card?.exp_year || 0),
    },
  };
}

function defaultPaymentMethod(customer) {
  const value = customer?.invoice_settings?.default_payment_method;
  return typeof value === 'string' ? value : String(value?.id || '');
}

function requiredAccountId(value) {
  const accountId = String(value || '').trim();
  if (!accountId || accountId.length > 200) throw backendError('ACCOUNT_ID_REQUIRED', 400);
  return accountId;
}

function digestAccountId(accountId) {
  return createHash('sha256').update(accountId).digest('hex');
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16_384) throw backendError('REQUEST_BODY_TOO_LARGE', 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw backendError('REQUEST_JSON_INVALID', 400);
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

function backendError(code, httpStatus) {
  return Object.assign(new Error(code), { code, httpStatus });
}
