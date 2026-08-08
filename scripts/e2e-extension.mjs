import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = process.cwd();
const extensionDir = path.resolve(repoRoot, process.env.OPX_EXTENSION_DIR || '.output/chrome-mv3');
const evidenceDir = path.resolve(repoRoot, process.env.OPX_E2E_OUTPUT || '.context-snapshots/e2e-extension');
const playwrightModule = process.env.OPX_PLAYWRIGHT_MODULE ||
  'C:/Users/Administrator/AppData/Roaming/npm/node_modules/agent-browser/node_modules/playwright-core/index.js';
const chromiumCandidates = [
  process.env.OPX_CHROMIUM_PATH,
  'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe',
  'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1217/chrome-win64/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean);

const chromiumPath = chromiumCandidates.find((candidate) => existsSync(candidate));
if (!chromiumPath) throw new Error('未找到 Chromium，可通过 OPX_CHROMIUM_PATH 指定');
if (!existsSync(extensionDir)) throw new Error(`扩展目录不存在：${extensionDir}`);
if (!existsSync(playwrightModule)) throw new Error(`Playwright 模块不存在：${playwrightModule}`);

const playwrightImport = await import(pathToFileURL(playwrightModule).href);
const { chromium } = playwrightImport.default || playwrightImport;
await mkdir(evidenceDir, { recursive: true });
const profileDirOverride = String(process.env.OPX_E2E_PROFILE_DIR || '').trim();
const profileDir = profileDirOverride
  ? path.resolve(repoRoot, profileDirOverride)
  : await mkdtemp(path.join(tmpdir(), 'opx-e2e-'));
const preserveProfile = Boolean(profileDirOverride) || process.env.OPX_E2E_PRESERVE_PROFILE === '1';
if (profileDirOverride) await mkdir(profileDir, { recursive: true });
const fullFlowTimeoutMs = Number(process.env.OPX_FULL_FLOW_TIMEOUT_MS || 720_000);
const authPortOverride = Number(process.env.OPX_E2E_AUTH_PORT || process.env.OPX_E2E_EXIT1_PORT || 0);
const checkoutPortOverride = Number(process.env.OPX_E2E_CHECKOUT_PORT || 0);
const billingPortOverride = Number(process.env.OPX_E2E_BILLING_PORT || process.env.OPX_E2E_EXIT2_PORT || 0);
const otpWaitSecondsOverride = Number(process.env.OPX_E2E_OTP_WAIT_SECONDS || 0);
const emailOverride = String(process.env.OPX_E2E_EMAIL || '').trim().toLowerCase();
const mailboxUrlOverride = normalizeMailboxUrl(process.env.OPX_E2E_MAILBOX_URL, emailOverride);
const skipManualAcicaSync = process.env.OPX_E2E_SKIP_ACICA_SYNC === '1';
const forceMissingCleanupTarget = process.env.OPX_E2E_FORCE_MISSING_CLEANUP_TARGET === '1';
const startedAt = new Date().toISOString();
const errors = [];
const consoleErrors = [];
const extensionConsoleErrors = [];
const networkFailures = [];
let context;
let storageRuntime;

const result = {
  startedAt,
  browser: chromiumPath,
  extensionDir,
  extensionId: '',
  checks: {},
  runtime: {},
  errors,
  consoleErrors,
  extensionConsoleErrors,
  networkFailures,
};
result.runtime.profilePreserved = preserveProfile;

try {
  context = await chromium.launchPersistentContext(profileDir, {
    executablePath: chromiumPath,
    headless: false,
    ignoreDefaultArgs: ['--enable-automation'],
    viewport: { width: 1440, height: 1000 },
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  context.on('page', attachPageDiagnostics);
  for (const page of context.pages()) attachPageDiagnostics(page);

  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
  storageRuntime = worker;
  worker.on('console', (message) => {
    if (message.type() === 'error') {
      const entry = `service-worker: ${message.text()}`;
      consoleErrors.push(entry);
      extensionConsoleErrors.push(entry);
    }
  });
  result.extensionId = new URL(worker.url()).host;
  result.checks.extensionLoaded = Boolean(result.extensionId);

  const settingsPage = await context.newPage();
  await settingsPage.goto(`chrome-extension://${result.extensionId}/automation-settings.html`, { waitUntil: 'domcontentloaded' });
  result.runtime.navigatorWebdriver = await settingsPage.evaluate(() => navigator.webdriver);
  await settingsPage.locator('#btn-sync-acica-emails').waitFor({ state: 'visible', timeout: 20_000 });
  await settingsPage.waitForFunction(
    () => document.documentElement.dataset.automationSettingsReady === 'true',
    null,
    { timeout: 20_000 },
  );
  result.checks.settingsPageLoaded = await settingsPage.locator('h1, h2').first().isVisible().catch(() => false);
  result.runtime.initialEmailSummary = await settingsPage.locator('#email-summary').innerText();

  if (!skipManualAcicaSync) {
    await settingsPage.locator('#btn-sync-acica-emails').click();
    await settingsPage.waitForFunction(() => {
      const text = document.querySelector('#email-summary')?.textContent || '';
      return /总数\s+[1-9]\d*/.test(text);
    }, null, { timeout: 120_000 });

    const manualSyncState = await waitForStoredState(
      settingsPage,
      (state) => Boolean(state?.automation?.emails?.length),
      120_000,
    );
    result.runtime.manualSyncEmailSummary = await settingsPage.locator('#email-summary').innerText();
    result.runtime.manualSyncEmailCount = manualSyncState?.automation?.emails?.length || 0;
    result.checks.acicaOneClickSync = result.runtime.manualSyncEmailCount > 0;
    result.checks.acicaOneClickPersisted = Boolean(manualSyncState?.automation?.settings?.rawEmails);
    await captureScreenshot(settingsPage, path.join(evidenceDir, 'chrome-settings-acica-synced.png'), 'settings-acica-synced');
  } else {
    result.runtime.manualSyncSkipped = true;
  }

  await clearStoredState(settingsPage);
  if (mailboxUrlOverride) {
    await seedMailboxUrl(settingsPage, mailboxUrlOverride);
  }
  if (authPortOverride > 0) {
    await seedProxyStages(settingsPage, {
      auth: authPortOverride,
      checkout: checkoutPortOverride || authPortOverride,
      billing: billingPortOverride || (authPortOverride === 18093 ? 18092 : 18093),
    });
  }
  const sidepanelPage = await context.newPage();
  await sidepanelPage.goto(`chrome-extension://${result.extensionId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  const automationTab = sidepanelPage.getByRole('button', { name: '自动化', exact: true });
  await automationTab.waitFor({ state: 'visible', timeout: 20_000 });
  await automationTab.click();
  const runButton = sidepanelPage.getByRole('button', { name: '自动执行', exact: true });
  await runButton.waitFor({ state: 'visible', timeout: 20_000 });
  if (otpWaitSecondsOverride > 0 || emailOverride) {
    if (otpWaitSecondsOverride > 0) {
      await seedOtpWaitSeconds(sidepanelPage, otpWaitSecondsOverride);
    }
    if (emailOverride) {
      await seedEmailPool(sidepanelPage, emailOverride);
    }
    await sidepanelPage.reload({ waitUntil: 'domcontentloaded' });
    await automationTab.waitFor({ state: 'visible', timeout: 20_000 });
    await automationTab.click();
    await runButton.waitFor({ state: 'visible', timeout: 20_000 });
  }
  result.runtime.e2eOtpWaitSeconds = otpWaitSecondsOverride || null;
  result.runtime.e2eEmailOverride = emailOverride || null;
  result.runtime.e2eMailboxUrlConfigured = Boolean(mailboxUrlOverride);
  result.checks.sidepanelAutomationEntry = true;
  result.runtime.cleanupTargetWindowId = await createCleanupTargetWindow(sidepanelPage);
  if (forceMissingCleanupTarget) {
    await seedMissingCleanupTarget(sidepanelPage);
    result.runtime.cleanupTargetForcedMissing = true;
  }
  await runButton.click();

  let autoState = await waitForStoredState(
    worker,
    (state) => Boolean(
      state?.automation?.emails?.length &&
      state?.automation?.run?.selectedEmailId &&
      state?.automation?.steps?.some((step) => step.id === 'cleanup-environment' && step.status === 'success')
    ),
    120_000,
  );
  autoState = await waitForStoredState(
    worker,
    (state) => state?.automation?.steps?.some((step) => step.id === 'open-register' && ['success', 'error'].includes(step.status)),
    45_000,
  ).catch(() => autoState);
  result.runtime.autoSyncEmailCount = autoState?.automation?.emails?.length || 0;
  result.runtime.emailSelectionMode = autoState?.automation?.settings?.emailSelectionMode || '';
  result.runtime.selectedEmailId = autoState?.automation?.run?.selectedEmailId || '';
  result.runtime.selectedEmailIndex = (autoState?.automation?.emails || []).findIndex((email) => email.id === result.runtime.selectedEmailId);
  result.runtime.currentStepId = autoState?.automation?.run?.currentStepId || '';
  const proxyState = await readStorageKey(worker, 'opx.proxy.settings');
  result.runtime.proxyEnabled = Boolean(proxyState?.enabled);
  result.runtime.proxyActiveStage = proxyState?.activeStage || '';
  result.runtime.proxyExit1 = proxyState?.exit1 ? `${proxyState.exit1.host}:${proxyState.exit1.port}` : '';
  result.runtime.proxyExit1Expected = `127.0.0.1:${authPortOverride || 18092}`;
  result.runtime.proxyStagePorts = {
    auth: authPortOverride || null,
    checkout: checkoutPortOverride || authPortOverride || null,
    billing: billingPortOverride || null,
  };
  result.runtime.steps = (autoState?.automation?.steps || []).map(({ id, status, message }) => ({ id, status, message }));
  result.runtime.logs = (autoState?.automation?.logs || []).slice(-20);
  result.checks.emptyPoolAutoSync = result.runtime.autoSyncEmailCount > 0;
  result.checks.randomEmailMode = result.runtime.emailSelectionMode === 'random';
  result.checks.emailAutoSelected = Boolean(result.runtime.selectedEmailId);
  result.checks.cleanupDidNotBlock = stepPassed(autoState, 'cleanup-environment');
  result.checks.registrationChainProxyApplied = Boolean(
    result.runtime.proxyEnabled &&
    result.runtime.proxyActiveStage === 'exit1' &&
    result.runtime.proxyExit1 === result.runtime.proxyExit1Expected
  );
  result.checks.registerPageAdvanced = stepPassed(autoState, 'open-register') || ['fill-register-email', 'wait-register-email-code'].includes(result.runtime.currentStepId);
  await captureScreenshot(sidepanelPage, path.join(evidenceDir, 'chrome-sidepanel-auto-run.png'), 'sidepanel-auto-run');

  const terminal = await waitForAutomationTerminal(worker, fullFlowTimeoutMs);
  autoState = terminal.state;
  result.runtime.fullFlowOutcome = terminal.outcome;
  result.runtime.fullFlowMessage = terminal.message;
  result.runtime.progressTrace = terminal.progressTrace;
  result.runtime.finalCurrentStepId = autoState?.automation?.run?.currentStepId || '';
  result.runtime.finalSteps = (autoState?.automation?.steps || []).map(({ id, status, message }) => ({ id, status, message }));
  result.runtime.finalLogs = (autoState?.automation?.logs || []).slice(0, 60);
  result.runtime.openPages = context.pages().map((page) => page.url());
  result.checks.fullAutomationCompleted = terminal.outcome === 'success';
  result.checks.fullAutomationReachedTerminal = terminal.outcome === 'success' || terminal.outcome === 'failed';

  const flowPages = context.pages().filter((page) => /^https:\/\/(chatgpt|auth\.openai)\.com\//.test(page.url()));
  result.runtime.flowPages = [];
  for (const [index, page] of flowPages.entries()) {
    if (page.isClosed()) continue;
    const pageState = {
      url: page.url(),
      text: await page.locator('body').innerText().catch(() => ''),
    };
    result.runtime.flowPages.push(pageState);
    await captureScreenshot(page, path.join(evidenceDir, `chrome-flow-page-${index + 1}.png`), `flow-page-${index + 1}`);
  }
  const targetPage = flowPages.find((page) => /^https:\/\/auth\.openai\.com\//.test(page.url())) || flowPages[0];
  if (targetPage && !targetPage.isClosed()) {
    result.runtime.targetPageUrl = targetPage.url();
    result.runtime.targetPageText = await targetPage.locator('body').innerText().catch(() => '');
    await captureScreenshot(targetPage, path.join(evidenceDir, 'chrome-full-flow-target.png'), 'full-flow-target');
  }

  const probe = await readProbeState(worker);
  result.runtime.probeAccountCount = probe?.accounts?.length || 0;
  result.runtime.probeHitCount = probe?.hits?.length || 0;
  result.runtime.hitDatabaseCount = probe?.hitDatabase?.length || 0;
  result.checks.sessionHandoffToProbe = result.runtime.probeAccountCount > 0;
  result.checks.hitPersistedToDatabase = result.runtime.hitDatabaseCount > 0;
  if (!sidepanelPage.isClosed()) {
    await captureScreenshot(sidepanelPage, path.join(evidenceDir, 'chrome-sidepanel-full-terminal.png'), 'sidepanel-full-terminal');
  }

  result.checks.noPageErrors = errors.length === 0;
  result.checks.noConsoleErrors = extensionConsoleErrors.length === 0;
} catch (error) {
  result.fatalError = error instanceof Error ? `${error.message}\n${error.stack || ''}` : String(error);
  const timeoutState = getTimeoutState(error);
  if (timeoutState) {
    result.runtime.timeoutState = timeoutState;
  } else if (storageRuntime) {
    result.runtime.failureState = summarizeAutomationState(await readStoredState(storageRuntime).catch(() => null));
  }
} finally {
  result.finishedAt = new Date().toISOString();
  await writeFile(path.join(evidenceDir, 'chrome-e2e-result.json'), `${JSON.stringify(sanitizeEvidence(result), null, 2)}\n`, 'utf8');
  if (context) await context.close().catch(() => undefined);
  if (!preserveProfile) {
    await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

console.log(JSON.stringify(sanitizeEvidence(result), null, 2));
if (result.fatalError || Object.values(result.checks).some((value) => value === false)) process.exitCode = 1;

function attachPageDiagnostics(page) {
  page.on('pageerror', (error) => errors.push(`${page.url() || 'page'}: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const entry = `${page.url() || 'page'}: ${message.text()}`;
    consoleErrors.push(entry);
    if (page.url().startsWith('chrome-extension://')) extensionConsoleErrors.push(entry);
  });
  page.on('requestfailed', (request) => {
    networkFailures.push({
      kind: 'requestfailed',
      url: redactUrl(request.url()),
      method: request.method(),
      resourceType: request.resourceType(),
      error: request.failure()?.errorText || '',
    });
  });
  page.on('response', (response) => {
    if (response.status() < 400) return;
    const request = response.request();
    const failure = {
      kind: 'http',
      url: redactUrl(response.url()),
      status: response.status(),
      method: request.method(),
      resourceType: request.resourceType(),
      contentType: response.headers()['content-type'] || '',
    };
    networkFailures.push(failure);
    if (/\/api\/accounts\/(?:create_account|email-otp\/validate)/.test(response.url())) {
      void response.text()
        .then((body) => { failure.body = sanitizeResponseBody(body); })
        .catch(() => undefined);
    }
  });
}

async function captureScreenshot(page, outputPath, label) {
  try {
    await page.screenshot({ path: outputPath, fullPage: true, timeout: 15_000 });
  } catch (error) {
    result.runtime.screenshotWarnings ||= [];
    result.runtime.screenshotWarnings.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readStoredState(page) {
  return readStorageKey(page, 'opx.registerAssist.state');
}

async function readStorageKey(runtime, key) {
  return runtime.evaluate((storageKey) => new Promise((resolve) => {
    chrome.storage.local.get(storageKey, (data) => resolve(data[storageKey] || null));
  }), key);
}

async function clearStoredState(page) {
  await page.evaluate(() => new Promise((resolve) => chrome.storage.local.clear(resolve)));
}

async function seedProxyStages(page, ports) {
  await page.evaluate(async (stagePorts) => {
    const endpoint = (targetPort, label) => ({
      enabled: true,
      scheme: 'http',
      host: '127.0.0.1',
      port: targetPort,
      username: '',
      password: '',
      label,
    });
    await chrome.storage.local.set({
      'opx.proxy.settings': {
        enabled: true,
        chainMode: 'direct-exit',
        front: endpoint(10808, 'E2E 前置代理'),
        exit1: endpoint(stagePorts.auth, 'E2E Auth 出口'),
        exit2: endpoint(stagePorts.billing, 'E2E Billing 出口'),
        countryExits: [],
        methodPools: [],
        preferMethodPools: false,
        automationRouting: {
          enabled: true,
          stickyWithinStage: true,
          verifyExitOnSwitch: true,
          requireDistinctExits: new Set([stagePorts.auth, stagePorts.checkout, stagePorts.billing]).size === 3,
          maxSwitchAttempts: 3,
          activeBusinessStage: '',
          auth: {
            enabled: true,
            fallbackStage: 'exit1',
            poolRaw: `http://127.0.0.1:${stagePorts.auth}`,
            poolIndex: 0,
            rotateOnEnter: true,
          },
          checkout: {
            enabled: true,
            fallbackStage: 'exit1',
            poolRaw: `http://127.0.0.1:${stagePorts.checkout}`,
            poolIndex: 0,
            rotateOnEnter: true,
          },
          billing: {
            enabled: true,
            fallbackStage: 'exit2',
            poolRaw: `http://127.0.0.1:${stagePorts.billing}`,
            poolIndex: 0,
            rotateOnEnter: true,
          },
          evidence: {},
        },
        seedHealthEnabled: true,
        seedFailCooldownSec: 180,
        seedRemoveAfterFails: 3,
        seedFailSkipAfter: 1,
        seedHealth: [],
        activeStage: 'none',
        updatedAt: Date.now(),
      },
    });
  }, ports);
}

async function seedOtpWaitSeconds(page, seconds) {
  await page.evaluate(async (waitSeconds) => {
    const key = 'opx.registerAssist.state';
    const data = await chrome.storage.local.get(key);
    const state = data[key];
    if (!state?.automation?.settings?.acicaMailbox) {
      throw new Error('Acica 自动化设置尚未初始化');
    }
    state.automation.settings.acicaMailbox.otpWaitSeconds = waitSeconds;
    await chrome.storage.local.set({ [key]: state });
  }, seconds);
}

async function seedEmailPool(page, email) {
  await page.evaluate(async (targetEmail) => {
    const key = 'opx.registerAssist.state';
    const data = await chrome.storage.local.get(key);
    const state = data[key];
    if (!state?.automation?.settings) {
      throw new Error('自动化设置尚未初始化');
    }
    const account = {
      id: `e2e-${targetEmail}`,
      rawInput: targetEmail,
      email: targetEmail,
      status: 'idle',
      useCount: 0,
      lastUsedAt: 0,
      lastMessage: '',
    };
    state.automation.settings.rawEmails = targetEmail;
    state.automation.emails = [account];
    await chrome.storage.local.set({ [key]: state });
  }, email);
}

async function seedMailboxUrl(page, mailboxUrl) {
  await page.evaluate(async (value) => {
    await chrome.storage.local.set({ 'opx.e2e.mailboxUrl': value });
  }, mailboxUrl);
}

async function seedMissingCleanupTarget(page) {
  await page.evaluate(async () => {
    const key = 'opx.registerAssist.state';
    const data = await chrome.storage.local.get(key);
    const state = data[key];
    if (!state?.automation?.run) {
      throw new Error('自动化运行状态尚未初始化');
    }
    state.automation.run.targetTabId = 999_999_999;
    await chrome.storage.local.set({ [key]: state });
  });
}

async function createCleanupTargetWindow(page) {
  return page.evaluate(async () => {
    const cleanupWindow = await chrome.windows.create({ url: 'about:blank', focused: false });
    const key = 'opx.registerAssist.state';
    const data = await chrome.storage.local.get(key);
    const state = data[key];
    if (!state?.automation?.run || typeof cleanupWindow.id !== 'number') {
      throw new Error('测试目标窗口或自动化状态未就绪');
    }
    state.automation.run.targetWindowId = cleanupWindow.id;
    await chrome.storage.local.set({ [key]: state });
    return cleanupWindow.id;
  });
}

async function waitForStoredState(page, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let state = null;
  while (Date.now() < deadline) {
    state = await readStoredState(page);
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const error = new Error(`等待扩展持久化状态超时（${timeoutMs}ms）`);
  error.timeoutState = summarizeAutomationState(state);
  throw error;
}

function getTimeoutState(error) {
  if (!error || typeof error !== 'object' || !('timeoutState' in error)) return null;
  return error.timeoutState || null;
}

function summarizeAutomationState(state) {
  const automation = state?.automation;
  if (!automation) return { available: false };
  return {
    available: true,
    emailCount: Array.isArray(automation.emails) ? automation.emails.length : 0,
    selectedEmail: Boolean(automation.run?.selectedEmailId),
    running: Boolean(automation.run?.running),
    paused: Boolean(automation.run?.paused),
    currentStepId: automation.run?.currentStepId || '',
    steps: (automation.steps || []).map(({ id, status, message }) => ({
      id,
      status,
      message: sanitizeResponseBody(message),
    })),
  };
}

async function waitForAutomationTerminal(runtime, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const progressTrace = [];
  let lastSignature = '';
  let state = null;
  while (Date.now() < deadline) {
    state = await readStoredState(runtime);
    const automation = state?.automation;
    const current = automation?.steps?.find((step) => step.id === automation?.run?.currentStepId);
    const signature = `${automation?.run?.currentStepId || ''}|${current?.status || ''}|${current?.message || ''}`;
    if (signature !== lastSignature) {
      lastSignature = signature;
      const item = {
        time: new Date().toISOString(),
        stepId: automation?.run?.currentStepId || '',
        status: current?.status || '',
        message: current?.message || '',
      };
      progressTrace.push(item);
      console.log(`[E2E] ${item.stepId || 'flow'} ${item.status}: ${item.message}`);
    }
    const successLog = automation?.logs?.find((entry) => entry.level === 'success' && /^自动执行完成/.test(entry.message));
    if (successLog) return { outcome: 'success', message: successLog.message, state, progressTrace };
    const failedStep = automation?.steps?.find((step) => step.status === 'error');
    if (failedStep && automation?.run?.running === false) {
      return { outcome: 'failed', message: `${failedStep.id}: ${failedStep.message}`, state, progressTrace };
    }
    const latestError = automation?.logs?.find((entry) => entry.level === 'error');
    if (automation?.run?.running === false && latestError) {
      return {
        outcome: 'failed',
        message: `${latestError.stepId || 'flow'}: ${latestError.message}`,
        state,
        progressTrace,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return { outcome: 'timeout', message: `全流程等待超时（${timeoutMs}ms）`, state, progressTrace };
}

async function readProbeState(runtime) {
  return runtime.evaluate(async () => {
    const data = await chrome.storage.local.get('opx.probe.state');
    return data['opx.probe.state'] || null;
  });
}

function stepPassed(state, id) {
  return state?.automation?.steps?.some((step) => step.id === id && step.status === 'success') || false;
}

function redactUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (/^\/messages\/[^/]+\/[^/]+/i.test(url.pathname)) {
      url.pathname = '/messages/TOKEN_REDACTED/EMAIL_REDACTED';
    }
    if (/^\/checkout\/[^/]+\/[^/]+/i.test(url.pathname)) {
      url.pathname = '/checkout/PROVIDER_REDACTED/SESSION_REDACTED';
    }
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, 'REDACTED');
    return url.href;
  } catch {
    return rawUrl;
  }
}

function normalizeMailboxUrl(value, email) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const url = new URL(raw);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('OPX_E2E_MAILBOX_URL 仅支持 HTTP(S)');
  if (!email) throw new Error('设置 OPX_E2E_MAILBOX_URL 时必须同时设置 OPX_E2E_EMAIL');
  const decodedPath = decodeURIComponent(url.pathname).toLowerCase();
  if (!decodedPath.includes(email.toLowerCase())) throw new Error('邮件 URL 与 OPX_E2E_EMAIL 不匹配');
  url.hash = '';
  return url.href;
}

function sanitizeResponseBody(body) {
  return String(body || '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, 'EMAIL_REDACTED')
    .replace(/(验证码|OTP|code)[^\n]{0,48}?\b\d{4,8}\b/gi, '$1 CODE_REDACTED')
    .slice(0, 1200);
}

function sanitizeEvidence(value) {
  if (Array.isArray(value)) return value.map(sanitizeEvidence);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeEvidence(item)]));
  }
  if (typeof value !== 'string') return value;
  return value
    .replace(/https?:\/\/[^\s"']+/g, (url) => redactUrl(url))
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, 'EMAIL_REDACTED')
    .replace(/(验证码|OTP|code)[^\n]{0,48}?\b\d{4,8}\b/gi, '$1 CODE_REDACTED')
    .replace(/\b(?:eyJ[a-zA-Z0-9_-]{10,}|sk-[a-zA-Z0-9_-]{10,}|sess_[a-zA-Z0-9_-]{10,})\b/g, 'TOKEN_REDACTED');
}
