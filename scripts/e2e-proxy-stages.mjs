import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = process.cwd();
const extensionDir = path.resolve(repoRoot, process.env.OPX_EXTENSION_DIR || '.output/chrome-mv3');
const evidenceDir = path.resolve(repoRoot, process.env.OPX_E2E_OUTPUT || '.context-snapshots/e2e-proxy-stages');
const playwrightModule = process.env.OPX_PLAYWRIGHT_MODULE
  || 'C:/Users/Administrator/AppData/Roaming/npm/node_modules/agent-browser/node_modules/playwright-core/index.js';
const chromiumCandidates = [
  process.env.OPX_CHROMIUM_PATH,
  'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean);
const chromiumPath = chromiumCandidates.find((candidate) => existsSync(candidate));
if (!chromiumPath || !existsSync(extensionDir) || !existsSync(playwrightModule)) {
  throw new Error('三阶段 E2E 所需的 Chromium、扩展构建或 Playwright 不完整');
}

const playwrightImport = await import(pathToFileURL(playwrightModule).href);
const { chromium } = playwrightImport.default || playwrightImport;
const profileDir = await mkdtemp(path.join(tmpdir(), 'opx-proxy-stages-'));
const authPortOverride = Number(process.env.OPX_E2E_AUTH_PORT || 0);
const checkoutPortOverride = Number(process.env.OPX_E2E_CHECKOUT_PORT || 0);
const billingPortOverride = Number(process.env.OPX_E2E_BILLING_PORT || 0);
const explicitSingleSeedStages = Boolean(authPortOverride && checkoutPortOverride && billingPortOverride);
await mkdir(evidenceDir, { recursive: true });
let context;
const result = { startedAt: new Date().toISOString(), checks: {}, stages: {}, errors: [] };

try {
  context = await chromium.launchPersistentContext(profileDir, {
    executablePath: chromiumPath,
    headless: false,
    viewport: { width: 1440, height: 1000 },
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run'],
  });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/automation-settings.html`, { waitUntil: 'domcontentloaded' });
  await page.locator('#proxy-auto-routing-enabled').waitFor({ state: 'visible', timeout: 20_000 });
  await page.evaluate(() => new Promise((resolve) => chrome.storage.local.clear(resolve)));
  if (authPortOverride || checkoutPortOverride || billingPortOverride) {
    if (!authPortOverride || !checkoutPortOverride || !billingPortOverride) {
      throw new Error('显式三阶段 E2E 需要同时设置 OPX_E2E_AUTH_PORT、OPX_E2E_CHECKOUT_PORT、OPX_E2E_BILLING_PORT');
    }
    await seedExplicitStagePorts(page, {
      auth: authPortOverride,
      checkout: checkoutPortOverride,
      billing: billingPortOverride,
    });
  }

  const cycleId = `e2e-${Date.now()}`;
  const apply = (stage, forceRotate) => page.evaluate(
    ({ stageName, cycle, force }) => chrome.runtime.sendMessage({
      type: 'opx:proxy-automation-stage',
      stage: stageName,
      cycleId: cycle,
      forceRotate: force,
    }),
    { stageName: stage, cycle: cycleId, force: forceRotate },
  );

  const auth = await apply('auth', true);
  const authSticky = await apply('auth', false);
  const checkout = await apply('checkout', true);
  const billing = await apply('billing', true);
  const secondCycleId = `e2e-next-${Date.now()}`;
  const applySecond = (stage) => page.evaluate(
    ({ stageName, cycle }) => chrome.runtime.sendMessage({
      type: 'opx:proxy-automation-stage',
      stage: stageName,
      cycleId: cycle,
      forceRotate: true,
    }),
    { stageName: stage, cycle: secondCycleId },
  );
  const authNext = await applySecond('auth');
  const checkoutNext = await applySecond('checkout');
  const billingNext = await applySecond('billing');
  const summarize = (status) => ({
    ok: status?.ok === true,
    message: status?.message || '',
    stage: status?.applied?.businessStage || '',
    endpoint: status?.applied?.summary || '',
    evidence: status?.applied?.evidence || null,
  });
  result.stages = Object.fromEntries(Object.entries({
    auth, authSticky, checkout, billing, authNext, checkoutNext, billingNext,
  }).map(([key, status]) => [key, summarize(status)]));
  const evidence = [auth, checkout, billing].map((status) => status?.applied?.evidence).filter(Boolean);
  const nextEvidence = [authNext, checkoutNext, billingNext].map((status) => status?.applied?.evidence).filter(Boolean);
  const ips = evidence.map((row) => row.ip);
  const countries = evidence.map((row) => row.country);
  result.checks.allStagesApplied = [auth, checkout, billing].every((status) => status?.ok === true);
  result.checks.allStagesVerified = evidence.length === 3 && evidence.every((row) => row.verified);
  result.checks.stageIpsDistinct = new Set(ips).size === 3;
  result.checks.stageCountriesDistinct = new Set(countries).size === 3;
  result.checks.authStickyWithinStage = auth?.applied?.evidence?.ip === authSticky?.applied?.evidence?.ip;
  result.checks.distinctFlags = evidence.every((row) => row.distinct);
  result.checks.nextCycleApplied = [authNext, checkoutNext, billingNext].every((status) => status?.ok === true);
  result.checks.nextCycleDistinct = nextEvidence.length === 3 && new Set(nextEvidence.map((row) => row.ip)).size === 3;
  if (explicitSingleSeedStages) {
    result.checks.nextCycleSingleSeedStable = nextEvidence.length === 3
      && nextEvidence.every((row, index) => row.ip === evidence[index]?.ip);
  } else {
    result.checks.nextCycleRotated = nextEvidence.length === 3
      && nextEvidence.every((row, index) => row.ip !== evidence[index]?.ip);
  }

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#proxy-auto-evidence').waitFor({ state: 'visible', timeout: 20_000 });
  result.evidenceBoard = await page.locator('#proxy-auto-evidence').innerText();
  await page.locator('#proxy-auto-evidence').screenshot({ path: path.join(evidenceDir, 'three-stage-evidence-board.png') });
} catch (error) {
  result.errors.push(error instanceof Error ? `${error.message}\n${error.stack || ''}` : String(error));
} finally {
  result.finishedAt = new Date().toISOString();
  await writeFile(path.join(evidenceDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  if (context) await context.close().catch(() => undefined);
  await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
}

console.log(JSON.stringify(result, null, 2));
if (result.errors.length || Object.values(result.checks).some((value) => value !== true)) process.exitCode = 1;

async function seedExplicitStagePorts(page, ports) {
  await page.evaluate(async (stagePorts) => {
    const endpoint = (port, label) => ({
      enabled: true,
      scheme: 'http',
      host: '127.0.0.1',
      port,
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
          requireDistinctExits: true,
          maxSwitchAttempts: 3,
          activeBusinessStage: '',
          auth: { enabled: true, fallbackStage: 'exit1', poolRaw: `http://127.0.0.1:${stagePorts.auth}`, poolIndex: 0, rotateOnEnter: true },
          checkout: { enabled: true, fallbackStage: 'exit1', poolRaw: `http://127.0.0.1:${stagePorts.checkout}`, poolIndex: 0, rotateOnEnter: true },
          billing: { enabled: true, fallbackStage: 'exit2', poolRaw: `http://127.0.0.1:${stagePorts.billing}`, poolIndex: 0, rotateOnEnter: true },
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
