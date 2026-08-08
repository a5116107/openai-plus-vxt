import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  installSavedPaymentTestBackendRoute,
  parseSavedPaymentTestBackend,
  startSavedPaymentStripeTestBackend,
} from './saved-payment-stripe-test-support.mjs';

const PLAYWRIGHT_MODULE = 'C:/Users/Administrator/AppData/Roaming/npm/node_modules/agent-browser/node_modules/playwright-core/index.js';
const BROWSER_CANDIDATES = [
  'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe',
  'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1217/chrome-win64/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const REQUIRED_ENVIRONMENT = [
  'SPM_E2E_PROFILE_DIR',
  'SPM_E2E_PUBLISHABLE_KEY',
  'SPM_E2E_BILLING_NAME',
  'SPM_E2E_CARD_NUMBER',
  'SPM_E2E_CARD_EXPIRY',
  'SPM_E2E_CARD_CVC',
];

export function createSavedPaymentLiveE2eRuntime(options = {}) {
  const env = options.env || process.env;
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const playwrightModule = options.playwrightModule || PLAYWRIGHT_MODULE;
  const executablePath = options.executablePath || BROWSER_CANDIDATES.find(existsSync);
  const externalTestBackend = parseSavedPaymentTestBackend(env.SPM_E2E_BACKEND_BASE_URL);
  const embeddedTestBackendConfigured = /^sk_test_[A-Za-z0-9_-]+$/.test(String(env.SPM_E2E_STRIPE_SECRET_KEY || ''));
  const testBackendMode = externalTestBackend.ok ? 'external' : embeddedTestBackendConfigured ? 'embedded' : 'missing';
  const browserProxy = parseBrowserProxy(env.SPM_E2E_BROWSER_PROXY_URL, env.SPM_E2E_BROWSER_PROXY_BYPASS);
  const missingEnvironment = [
    ...REQUIRED_ENVIRONMENT.filter((name) => !String(env[name] || '').trim()),
    ...(testBackendMode === 'missing' ? ['SPM_E2E_BACKEND_BASE_URL|SPM_E2E_STRIPE_SECRET_KEY'] : []),
  ];
  const extensionDir = path.resolve(repoRoot, '.output/chrome-mv3');
  const profileDir = String(env.SPM_E2E_PROFILE_DIR || '').trim();
  const preflight = {
    extensionBuilt: existsSync(extensionDir),
    playwrightAvailable: existsSync(playwrightModule),
    browserAvailable: Boolean(executablePath),
    profileConfigured: Boolean(profileDir),
    profileExists: Boolean(profileDir && existsSync(profileDir)),
    testBackendMode,
    externalTestBackendConfigured: Boolean(env.SPM_E2E_BACKEND_BASE_URL),
    externalTestBackendAccepted: externalTestBackend.ok,
    embeddedTestBackendConfigured,
    browserProxyConfigured: Boolean(env.SPM_E2E_BROWSER_PROXY_URL),
    browserProxyAccepted: Boolean(browserProxy),
    browserProxyBypassConfigured: Boolean(env.SPM_E2E_BROWSER_PROXY_BYPASS),
    inputsConfigured: missingEnvironment.length === 0,
    missingEnvironment,
  };
  return {
    env,
    repoRoot,
    extensionDir,
    evidenceDir: path.resolve(repoRoot, '.context-snapshots/saved-payment-live-e2e'),
    playwrightModule,
    executablePath,
    externalTestBackend,
    browserProxy,
    testBackendMode,
    missingEnvironment,
    preflight,
    preflightOk: preflight.extensionBuilt && preflight.playwrightAvailable && preflight.browserAvailable &&
      preflight.profileExists && testBackendMode !== 'missing' && preflight.inputsConfigured,
  };
}

export function createSavedPaymentPreflightEvidence(runtime) {
  return {
    schemaVersion: 1,
    kind: 'saved_payment_live_e2e_preflight',
    generatedAt: new Date().toISOString(),
    ok: runtime.preflightOk,
    preflight: runtime.preflight,
  };
}

export function assertSavedPaymentLiveE2eReady(runtime) {
  if (!runtime.preflightOk) {
    throw new Error(`saved payment live E2E prerequisites missing: ${runtime.missingEnvironment.join(', ') || 'local browser/build/profile'}`);
  }
  if (!/^pk_test_[A-Za-z0-9_-]+$/.test(String(runtime.env.SPM_E2E_PUBLISHABLE_KEY || ''))) {
    throw new Error('SPM_E2E_PUBLISHABLE_KEY must be a Stripe test publishable key');
  }
}

export async function writeSavedPaymentE2eEvidence(runtime, filename, evidence) {
  await mkdir(runtime.evidenceDir, { recursive: true });
  const evidencePath = path.join(runtime.evidenceDir, filename);
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  return path.relative(runtime.repoRoot, evidencePath).replaceAll('\\', '/');
}

export async function runSavedPaymentLiveE2e(runtime) {
  const { chromium } = await loadChromium(runtime.playwrightModule);
  let context;
  let embeddedTestBackend;
  try {
    embeddedTestBackend = await startEmbeddedBackend(runtime);
    const testBackendUrl = embeddedTestBackend?.baseUrl || runtime.externalTestBackend.url;
    context = await chromium.launchPersistentContext(path.resolve(runtime.env.SPM_E2E_PROFILE_DIR), {
      executablePath: runtime.executablePath,
      headless: false,
      ...(runtime.browserProxy ? { proxy: runtime.browserProxy } : {}),
      args: [
        `--disable-extensions-except=${runtime.extensionDir}`,
        `--load-extension=${runtime.extensionDir}`,
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });
    await installSavedPaymentTestBackendRoute(
      context,
      testBackendUrl,
      embeddedTestBackend?.accessToken || String(runtime.env.SPM_E2E_BACKEND_TOKEN || '').trim(),
    );
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
    const page = context.pages()[0] || await context.newPage();
    await gotoChatGptWithRetry(page);
    await page.bringToFront();
    const session = await readChatGptSession(page);
    if (!session.ok || !session.accountId) throw new Error('dedicated Chrome profile has no ready ChatGPT account session');
    const closureRunId = normalizeClosureRunId(runtime.env.PCC_CLOSURE_RUN_ID);
    const authNetworkEvidence = await readBrowserNetworkEvidence(page, 'browser-auth', closureRunId);
    await page.bringToFront();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(300);
    const stripePreflight = await preflightStripeRuntime(page);
    if (!stripePreflight.ok) {
      throw new Error(`Stripe.js preflight failed before payment setup: ${stripePreflight.reason}`);
    }
    const stripeNetwork = installStripeNetworkDiagnostics(page);
    await installBridgeDiagnostics(page);

    const message = {
      type: 'opx:saved-payment:start',
      publishableKey: runtime.env.SPM_E2E_PUBLISHABLE_KEY,
      billingName: runtime.env.SPM_E2E_BILLING_NAME,
      setAsDefault: runtime.env.SPM_E2E_SET_DEFAULT !== 'false',
    };
    const responsePromise = startSavedPaymentAttempt(worker, message);
    const fillPromise = fillCardElement(page, runtime.env).then(
      (diagnostics) => ({ kind: 'filled', diagnostics }),
      (error) => ({ kind: 'fill-error', error }),
    );
    const first = await Promise.race([
      fillPromise,
      responsePromise.then((response) => ({ kind: 'response', response })),
    ]);
    if (first.kind === 'fill-error') throw first.error;
    if (first.kind === 'response') {
      throw new Error(`saved payment attempt ended before card input: ${String(first.response?.code || 'UNKNOWN')}: ${String(first.response?.message || '').slice(0, 180)}`);
    }
    const response = await responsePromise;
    const stored = await readStoredAttempt(worker, session.accountId, response?.attemptId || '');
    const serverList = await readLivePaymentMethodEvidence(page, session.accountId, response?.paymentMethodId || '');
    const stripeIntent = await inspectEmbeddedStripeIntent(runtime, stored.attempt?.setupIntentId || '');
    await stripeNetwork.flush();
    const bridgeDiagnostics = await readBridgeDiagnostics(page);
    const billingNetworkEvidence = await readBrowserNetworkEvidence(page, 'browser-billing', closureRunId);
    return buildLiveEvidence(
      runtime,
      session.accountId,
      message,
      response,
      stored,
      serverList,
      stripeIntent,
      stripeNetwork.entries,
      bridgeDiagnostics,
      first.diagnostics,
      [authNetworkEvidence, billingNetworkEvidence],
      stripePreflight,
      closureRunId,
    );
  } finally {
    await closeRuntimeResources(context, embeddedTestBackend);
  }
}

export async function probeSavedPaymentProfile(runtime) {
  const profileDir = String(runtime.env.SPM_E2E_PROFILE_DIR || '').trim();
  const base = createProfileProbeEvidence(runtime, profileDir);
  if (!base.profileExists || !base.browserAvailable || !existsSync(runtime.playwrightModule)) return base;

  const { chromium } = await loadChromium(runtime.playwrightModule);
  let context;
  let embeddedTestBackend;
  try {
    context = await launchProfileProbeContext(chromium, runtime, profileDir);
    if (runtime.env.SPM_E2E_SKIP_AUTH_PROXY !== 'true') {
      await applyProfileAuthProxy(context);
    }
    embeddedTestBackend = await startEmbeddedBackend(runtime);
    await installProfileProbeBackendRoute(context, runtime, embeddedTestBackend);
    const page = context.pages()[0] || await context.newPage();
    await gotoChatGptWithRetry(page);
    return applyProfileProbeResult(base, await probeSessionAndPaymentList(page));
  } catch (error) {
    return applyProfileProbeError(base, error);
  } finally {
    await closeRuntimeResources(context, embeddedTestBackend);
  }
}

async function applyProfileAuthProxy(context) {
  let worker = context.serviceWorkers().find((candidate) => candidate.url().startsWith('chrome-extension://'));
  if (!worker) {
    worker = await context.waitForEvent('serviceworker', {
      predicate: (candidate) => candidate.url().startsWith('chrome-extension://'),
      timeout: 20_000,
    });
  }
  const extensionPage = await context.newPage();
  try {
    const extensionId = new URL(worker.url()).host;
    await extensionPage.goto(`chrome-extension://${extensionId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
    await extensionPage.evaluate(() => chrome.runtime.sendMessage({
      type: 'opx:proxy-automation-stage',
      stage: 'auth',
      cycleId: `saved-payment-profile-${Date.now()}`,
      forceRotate: false,
      reason: 'saved-payment-profile-probe',
    }));
  } finally {
    await extensionPage.close().catch(() => undefined);
  }
}

function createProfileProbeEvidence(runtime, profileDir) {
  return {
    schemaVersion: 1,
    kind: 'saved_payment_profile_probe',
    generatedAt: new Date().toISOString(),
    ok: false,
    profileConfigured: Boolean(profileDir),
    profileExists: Boolean(profileDir && existsSync(profileDir)),
    browserAvailable: Boolean(runtime.executablePath),
    session: { httpStatus: 0, accountPresent: false, accessTokenPresent: false, accountDigest: '' },
    serverList: { httpStatus: 0, paymentMethodCount: 0, defaultPresent: false },
  };
}

function launchProfileProbeContext(chromium, runtime, profileDir) {
  return chromium.launchPersistentContext(path.resolve(profileDir), {
    executablePath: runtime.executablePath,
    headless: runtime.env.SPM_E2E_HEADLESS !== 'false',
    ...(runtime.browserProxy ? { proxy: runtime.browserProxy } : {}),
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      `--disable-extensions-except=${runtime.extensionDir}`,
      `--load-extension=${runtime.extensionDir}`,
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
}

function parseBrowserProxy(value, bypassValue) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:', 'socks5:'].includes(parsed.protocol) || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      return null;
    }
    const proxy = { server: `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}` };
    if (parsed.username) proxy.username = decodeURIComponent(parsed.username);
    if (parsed.password) proxy.password = decodeURIComponent(parsed.password);
    const bypass = String(bypassValue || '').split(',').map((entry) => entry.trim()).filter((entry) =>
      /^(?:[A-Za-z0-9-]+\.)*[A-Za-z0-9-]+$/.test(entry)
    );
    if (bypass.length) proxy.bypass = bypass.join(',');
    return proxy;
  } catch {
    return null;
  }
}

async function installProfileProbeBackendRoute(context, runtime, embeddedTestBackend) {
  const backendUrl = embeddedTestBackend?.baseUrl || runtime.externalTestBackend.url;
  if (!backendUrl) return;
  await installSavedPaymentTestBackendRoute(
    context,
    backendUrl,
    embeddedTestBackend?.accessToken || String(runtime.env.SPM_E2E_BACKEND_TOKEN || '').trim(),
  );
}

function applyProfileProbeResult(base, result) {
  base.session.httpStatus = result.sessionStatus;
  base.session.accountPresent = Boolean(result.accountId);
  base.session.accessTokenPresent = result.accessTokenPresent;
  base.session.accountDigest = result.accountId ? digest(result.accountId) : '';
  base.serverList.httpStatus = result.listStatus;
  base.serverList.paymentMethodCount = result.paymentMethodCount;
  base.serverList.defaultPresent = result.defaultPresent;
  base.ok = result.sessionStatus === 200 && Boolean(result.accountId) && result.accessTokenPresent && result.listStatus === 200;
  return base;
}

function applyProfileProbeError(base, error) {
  return {
    ...base,
    errorCode: String(error?.name || 'PROFILE_PROBE_FAILED'),
    errorMessage: String(error?.message || error).replace(/[\r\n]+/g, ' ').slice(0, 240),
  };
}

async function closeRuntimeResources(context, embeddedTestBackend) {
  await context?.close().catch(() => undefined);
  await embeddedTestBackend?.close().catch(() => undefined);
}

async function loadChromium(playwrightModule) {
  const imported = await import(pathToFileURL(playwrightModule).href);
  return imported.default || imported;
}

function startEmbeddedBackend(runtime) {
  return runtime.testBackendMode === 'embedded'
    ? startSavedPaymentStripeTestBackend({ stripeSecretKey: runtime.env.SPM_E2E_STRIPE_SECRET_KEY })
    : null;
}

function readChatGptSession(page) {
  return page.evaluate(async () => {
    const response = await fetch('/api/auth/session', { credentials: 'include' });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, accountId: String(data?.account?.id || data?.account?.accountId || '') };
  });
}

async function gotoChatGptWithRetry(page, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
      return;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 750 * attempt));
    }
  }
  throw lastError || new Error('ChatGPT navigation failed');
}

function startSavedPaymentAttempt(worker, message) {
  return worker.evaluate(async ({ featureKey, startMessage }) => {
    await chrome.storage.local.set({
      [featureKey]: { enabled: true, environment: 'test', allowedMethods: ['card'], updatedAt: Date.now() },
    });
    const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
    const target = tabs.find((tab) => tab.active) || tabs[0];
    if (!target?.id) return { ok: false, code: 'CHATGPT_TAB_REQUIRED', message: 'ChatGPT tab is missing' };
    return chrome.tabs.sendMessage(target.id, startMessage);
  }, { featureKey: 'opx.savedPaymentMethods.feature', startMessage: message });
}

async function fillCardElement(page, env) {
  const dialog = page.locator('[role="dialog"][id^="opx-saved-payment-"]');
  await dialog.waitFor({ state: 'visible', timeout: 60_000 });
  const frame = dialog.locator('iframe[src*="js.stripe.com"], iframe[title*="payment" i], iframe').first();
  await frame.waitFor({ state: 'attached', timeout: 30_000 });
  const hostFrame = frame.contentFrame();
  const nestedFrame = hostFrame.locator('iframe[src*="js.stripe.com"], iframe[title*="payment" i], iframe').first();
  const directCardInput = hostFrame.locator('input[name="cardnumber"], input[autocomplete="cc-number"]');
  const inputOwner = await Promise.any([
    directCardInput.waitFor({ state: 'attached', timeout: 30_000 }).then(() => 'host'),
    nestedFrame.waitFor({ state: 'attached', timeout: 30_000 }).then(() => 'nested'),
  ]);
  const cardFrame = inputOwner === 'nested' ? nestedFrame.contentFrame() : hostFrame;
  await cardFrame.locator('input[name="cardnumber"], input[autocomplete="cc-number"]').fill(env.SPM_E2E_CARD_NUMBER);
  await cardFrame.locator('input[name="exp-date"], input[autocomplete="cc-exp"]').fill(env.SPM_E2E_CARD_EXPIRY);
  const cvc = cardFrame.locator('input[name="cvc"], input[autocomplete="cc-csc"]');
  await cvc.fill(env.SPM_E2E_CARD_CVC);
  const postal = cardFrame.locator('input[name="postal"], input[autocomplete="postal-code"]');
  if (env.SPM_E2E_POSTAL_CODE && await postal.count()) await postal.fill(env.SPM_E2E_POSTAL_CODE);
  await cvc.press('Tab');
  await hostFrame.locator('.StripeElement--complete').waitFor({ state: 'attached', timeout: 15_000 });
  const diagnostics = await dialog.evaluate((root, selectedFrame) => ({
    iframeCount: root.querySelectorAll('iframe').length,
    selectedTitle: selectedFrame?.getAttribute('title') || '',
    selectedNamePrefix: (selectedFrame?.getAttribute('name') || '').slice(0, 24),
    selectedSrcPath: (() => {
      try {
        const url = new URL(selectedFrame?.getAttribute('src') || '');
        return `${url.hostname}${url.pathname}`.slice(0, 160);
      } catch {
        return '';
      }
    })(),
    completeElementCount: 0,
  }), await frame.elementHandle());
  diagnostics.completeElementCount = await hostFrame.locator('.StripeElement--complete').count();
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  return diagnostics;
}

function readStoredAttempt(worker, accountId, attemptId) {
  return worker.evaluate(async ({ accountId: id, attemptId: targetAttemptId }) => {
    const data = await chrome.storage.local.get('opx.savedPaymentMethods.state');
    const account = data['opx.savedPaymentMethods.state']?.accounts?.[id];
    const attempt = account?.attempts?.find((item) => item.id === targetAttemptId);
    return {
      attempt: attempt ? {
        id: attempt.id,
        state: attempt.state,
        setupIntentId: attempt.setupIntentId || '',
        paymentMethodId: attempt.paymentMethodId || '',
        confirmSubmitted: attempt.confirmSubmitted === true,
        attachedVerified: attempt.attachedVerified === true,
        reusableVerified: attempt.reusableVerified === true,
        defaultVerified: attempt.defaultVerified === true,
        trace: Array.isArray(attempt.trace) ? attempt.trace.map(String).slice(0, 16) : [],
      } : null,
    };
  }, { accountId, attemptId });
}

function readLivePaymentMethodEvidence(page, accountId, expectedPaymentMethodId) {
  return page.evaluate(async ({ accountId: id, expectedId }) => {
    const sessionResponse = await fetch('/api/auth/session', { credentials: 'include', cache: 'no-store' });
    const session = await sessionResponse.json().catch(() => ({}));
    const accessToken = String(session?.accessToken || '');
    if (!sessionResponse.ok || !accessToken) {
      return { httpStatus: sessionResponse.status, paymentMethodCount: 0, containsExpected: false, defaultMatches: false };
    }
    const response = await fetch(`/backend-api/payments/payment_methods?account_id=${encodeURIComponent(id)}`, {
      credentials: 'include',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'chatgpt-account-id': id,
        'x-openai-target-path': '/backend-api/payments/payment_methods',
        'x-openai-target-route': '/backend-api/payments/payment_methods',
      },
    });
    const body = await response.json().catch(() => ({}));
    const methods = Array.isArray(body?.payment_methods) ? body.payment_methods : [];
    return {
      httpStatus: response.status,
      paymentMethodCount: methods.length,
      containsExpected: Boolean(expectedId && methods.some((item) => item?.id === expectedId)),
      defaultMatches: Boolean(expectedId && body?.default_payment_method_id === expectedId),
    };
  }, { accountId, expectedId: expectedPaymentMethodId });
}

async function inspectEmbeddedStripeIntent(runtime, setupIntentId) {
  if (runtime.testBackendMode !== 'embedded' || !/^seti_[A-Za-z0-9]+$/.test(setupIntentId)) return null;
  const response = await fetch(`https://api.stripe.com/v1/setup_intents/${encodeURIComponent(setupIntentId)}`, {
    headers: { Authorization: `Bearer ${runtime.env.SPM_E2E_STRIPE_SECRET_KEY}` },
  });
  const body = await response.json().catch(() => ({}));
  return {
    httpStatus: response.status,
    status: String(body?.status || ''),
    paymentMethodPresent: Boolean(body?.payment_method),
    customerPresent: Boolean(body?.customer),
    lastPaymentErrorCode: String(body?.last_setup_error?.code || body?.last_payment_error?.code || '').slice(0, 80),
  };
}

function installStripeNetworkDiagnostics(page) {
  const entries = [];
  const pending = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.hostname !== 'api.stripe.com' || !/^\/v1\/(?:payment_methods|tokens|setup_intents)(?:\/|$)/.test(url.pathname)) return;
    const capture = (async () => {
      const request = response.request();
      const fieldNames = [...new URLSearchParams(request.postData() || '').keys()]
        .filter((value, index, list) => list.indexOf(value) === index)
        .sort()
        .slice(0, 40);
      const body = await response.json().catch(() => ({}));
      entries.push({
        endpoint: url.pathname.replace(/\/(?:seti|pm|tok)_[A-Za-z0-9_]+/g, '/OBJECT_ID'),
        method: request.method(),
        httpStatus: response.status(),
        requestFieldNames: fieldNames,
        object: String(body?.object || ''),
        status: String(body?.status || ''),
        paymentMethodPresent: Boolean(body?.payment_method),
        errorType: String(body?.error?.type || '').slice(0, 80),
        errorCode: String(body?.error?.code || '').slice(0, 80),
        declineCode: String(body?.error?.decline_code || '').slice(0, 80),
      });
    })();
    pending.push(capture);
  });
  return {
    entries,
    flush: () => Promise.allSettled(pending),
  };
}

function installBridgeDiagnostics(page) {
  return page.evaluate(() => {
    globalThis.__opxSpmE2eBridgeDiagnostics = [];
    window.addEventListener('message', (event) => {
      const value = event.data;
      if (event.source !== window || value?.type !== 'opx:saved-payment:response') return;
      globalThis.__opxSpmE2eBridgeDiagnostics.push({
        command: String(value.command || ''),
        ok: value.result?.ok === true,
        code: String(value.result?.code || '').slice(0, 80),
        message: String(value.result?.message || '').replace(/[\r\n]+/g, ' ').slice(0, 180),
        sideEffect: String(value.result?.sideEffect || '').slice(0, 20),
        status: String(value.result?.data?.status || '').slice(0, 40),
        paymentMethodPresent: Boolean(value.result?.data?.paymentMethodId),
      });
    });
  });
}

function readBridgeDiagnostics(page) {
  return page.evaluate(() => Array.isArray(globalThis.__opxSpmE2eBridgeDiagnostics)
    ? globalThis.__opxSpmE2eBridgeDiagnostics.slice(0, 16)
    : []);
}

function buildLiveEvidence(
  runtime,
  accountId,
  message,
  response,
  stored,
  serverList,
  stripeIntent,
  stripeNetwork,
  bridgeDiagnostics,
  cardInputDiagnostics,
  networkEvidence,
  stripePreflight,
  closureRunId,
) {
  const expectedDefault = message.setAsDefault;
  const ok = response?.ok === true && stored.attempt?.attachedVerified === true &&
    stored.attempt?.reusableVerified === true && serverList.containsExpected === true &&
    (!expectedDefault || (stored.attempt?.defaultVerified === true && serverList.defaultMatches === true));
  return {
    schemaVersion: 1,
    kind: 'saved_payment_live_e2e',
    generatedAt: new Date().toISOString(),
    ok,
    ...(closureRunId ? { closureRunId } : {}),
    accountDigest: digest(accountId),
    result: {
      code: String(response?.code || 'EMPTY_RESPONSE'),
      message: String(response?.message || '').replace(/[\r\n]+/g, ' ').slice(0, 180),
      attemptId: String(response?.attemptId || ''),
      paymentMethodId: String(response?.paymentMethodId || ''),
      expectedDefault,
      ...stored,
      serverList,
      stripeIntent,
      stripeNetwork,
      bridgeDiagnostics,
      cardInputDiagnostics,
      networkEvidence,
      stripePreflight,
    },
    guarantees: {
      browserProfile: 'dedicated-existing-profile',
      paymentBackend: `${runtime.testBackendMode}-test-backend`,
      chatgptCredentialsForwardedToPaymentBackend: false,
      cardInputOwner: 'Stripe Element iframe',
      rawCardDataPersisted: false,
      publishableKeyPersisted: false,
    },
  };
}

async function readBrowserNetworkEvidence(page, plane, closureRunId) {
  const probePage = await page.context().newPage();
  const result = { trace: { status: 0, text: '' }, insight: { status: 0, data: {} } };
  try {
    const traceResponse = await probePage.goto('https://www.cloudflare.com/cdn-cgi/trace', {
      waitUntil: 'domcontentloaded', timeout: 20_000,
    });
    result.trace = { status: traceResponse?.status() || 0, text: await probePage.locator('body').innerText().catch(() => '') };
  } catch {
    // The returned unverified record preserves the failed plane without exposing raw responses.
  }
  const fields = Object.fromEntries(String(result.trace.text || '').split(/\r?\n/).map((line) => {
    const index = line.indexOf('=');
    return index > 0 ? [line.slice(0, index), line.slice(index + 1)] : ['', ''];
  }).filter(([key]) => key));
  const traceIp = String(fields.ip || '').trim();
  if (traceIp) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const insightResponse = await probePage.goto(`https://ipwho.is/${encodeURIComponent(traceIp)}`, {
          waitUntil: 'domcontentloaded', timeout: 20_000,
        });
        const insightText = await probePage.locator('body').innerText().catch(() => '');
        const data = JSON.parse(insightText || '{}');
        result.insight = { status: insightResponse?.status() || 0, data };
        if (result.insight.status === 200 && data?.success !== false && data?.ip === traceIp && data?.connection?.asn) break;
      } catch {
        // Retry bounded attribution lookups; trace remains the source for the observed exit.
      }
      if (attempt < 3) await probePage.waitForTimeout(300 * attempt);
    }
  }
  await probePage.close().catch(() => undefined);
  const trace = result.trace;
  const insightMatchesTrace = result.insight?.data?.ip === traceIp;
  return {
    plane,
    requestId: `${closureRunId || 'spm'}-${plane}`.slice(0, 120),
    ip: String(fields.ip || '').slice(0, 80),
    country: String(fields.loc || '').toUpperCase().slice(0, 2),
    colo: String(fields.colo || '').toUpperCase().slice(0, 12),
    asn: String(result.insight?.data?.connection?.asn || '').slice(0, 24),
    verified: trace.status === 200 && result.insight?.status === 200 && insightMatchesTrace && Boolean(
      fields.ip && fields.loc && fields.colo && result.insight?.data?.connection?.asn,
    ),
    capturedAt: Date.now(),
  };
}

async function preflightStripeRuntime(page) {
  const events = [];
  const onRequestFailed = (request) => {
    if (request.url().startsWith('https://js.stripe.com/')) {
      events.push(String(request.failure()?.errorText || 'request-failed').slice(0, 120));
    }
  };
  page.on('requestfailed', onRequestFailed);
  try {
    const result = await page.evaluate(async () => {
      const load = (documentImpl, windowImpl) => new Promise((resolve) => {
        if (windowImpl.Stripe) {
          resolve({ ok: true, reason: 'cached' });
          return;
        }
        const script = documentImpl.createElement('script');
        const timeout = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), 20_000);
        script.addEventListener('load', () => {
          clearTimeout(timeout);
          resolve({ ok: Boolean(windowImpl.Stripe), reason: windowImpl.Stripe ? 'loaded' : 'not-initialized' });
        }, { once: true });
        script.addEventListener('error', () => {
          clearTimeout(timeout);
          script.remove();
          resolve({ ok: false, reason: 'script-error' });
        }, { once: true });
        script.src = 'https://js.stripe.com/v3/';
        script.async = true;
        (documentImpl.head || documentImpl.documentElement).appendChild(script);
      });
      const top = await load(document, window);
      if (!top.ok) return { ok: false, reason: `top-${top.reason}`, top, isolated: null };
      const frame = document.createElement('iframe');
      frame.style.display = 'none';
      const frameLoaded = new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
      frame.srcdoc = '<!doctype html><html><head></head><body></body></html>';
      document.documentElement.appendChild(frame);
      await frameLoaded;
      const isolated = frame.contentDocument && frame.contentWindow
        ? await load(frame.contentDocument, frame.contentWindow)
        : { ok: false, reason: 'iframe-unavailable' };
      frame.remove();
      return { ok: top.ok && isolated.ok, reason: isolated.reason, top, isolated };
    });
    return { ...result, requestFailures: events.slice(0, 4) };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160),
      requestFailures: events.slice(0, 4),
    };
  } finally {
    page.off('requestfailed', onRequestFailed);
  }
}

function normalizeClosureRunId(value) {
  return String(value || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 96);
}

function probeSessionAndPaymentList(page) {
  return page.evaluate(async () => {
    const sessionResponse = await fetch('/api/auth/session', { credentials: 'include', cache: 'no-store' });
    const session = await sessionResponse.json().catch(() => ({}));
    const accountId = String(session?.account?.id || session?.account?.accountId || '');
    const accessToken = String(session?.accessToken || '');
    const output = {
      sessionStatus: sessionResponse.status,
      accountId,
      accessTokenPresent: Boolean(accessToken),
      listStatus: 0,
      paymentMethodCount: 0,
      defaultPresent: false,
    };
    if (!sessionResponse.ok || !accountId || !accessToken) return output;
    const listPath = `/backend-api/payments/payment_methods?account_id=${encodeURIComponent(accountId)}`;
    const listResponse = await fetch(listPath, {
      credentials: 'include',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'chatgpt-account-id': accountId,
        'x-openai-target-path': '/backend-api/payments/payment_methods',
        'x-openai-target-route': '/backend-api/payments/payment_methods',
      },
    });
    const list = await listResponse.json().catch(() => ({}));
    output.listStatus = listResponse.status;
    output.paymentMethodCount = Array.isArray(list?.payment_methods) ? list.payment_methods.length : 0;
    output.defaultPresent = Boolean(list?.default_payment_method_id);
    return output;
  });
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}
