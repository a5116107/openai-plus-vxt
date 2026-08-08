import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = process.cwd();
const extensionDir = path.resolve(repoRoot, process.env.OPX_EXTENSION_DIR || '.output/chrome-mv3');
const evidenceDir = path.resolve(repoRoot, process.env.OPX_E2E_OUTPUT || '.context-snapshots/e2e-auth-exit-rotation');
const proxyPort = Number(process.env.OPX_E2E_AUTH_PORT || 10808);
const playwrightModule = process.env.OPX_PLAYWRIGHT_MODULE
  || 'C:/Users/Administrator/AppData/Roaming/npm/node_modules/agent-browser/node_modules/playwright-core/index.js';
const chromiumPath = [
  process.env.OPX_CHROMIUM_PATH,
  'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean).find((candidate) => existsSync(candidate));

if (!chromiumPath || !existsSync(extensionDir) || !existsSync(playwrightModule)) {
  throw new Error('Auth 出口轮换 E2E 所需的 Chromium、扩展构建或 Playwright 不完整');
}

const playwrightImport = await import(pathToFileURL(playwrightModule).href);
const { chromium } = playwrightImport.default || playwrightImport;
const profileDir = await mkdtemp(path.join(tmpdir(), 'opx-auth-exit-'));
await mkdir(evidenceDir, { recursive: true });
let context;
const result = { startedAt: new Date().toISOString(), proxyPort, checks: {}, initial: null, rotation: null, evidenceBoard: '', errors: [] };

try {
  context = await chromium.launchPersistentContext(profileDir, {
    executablePath: chromiumPath,
    headless: false,
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run'],
  });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/automation-settings.html`, { waitUntil: 'domcontentloaded' });
  await page.locator('#proxy-auto-evidence').waitFor({ state: 'visible', timeout: 20_000 });
  await page.evaluate(async (port) => {
    const endpoint = { enabled: true, scheme: 'http', host: '127.0.0.1', port, username: '', password: '', label: 'Auth 单 seed' };
    await chrome.storage.local.clear();
    await chrome.storage.local.set({
      'opx.proxy.settings': {
        enabled: true,
        chainMode: 'direct-exit',
        front: endpoint,
        exit1: endpoint,
        exit2: endpoint,
        countryExits: [],
        methodPools: [],
        preferMethodPools: false,
        automationRouting: {
          enabled: true,
          stickyWithinStage: true,
          verifyExitOnSwitch: true,
          requireDistinctExits: false,
          maxSwitchAttempts: 3,
          activeBusinessStage: '',
          auth: { enabled: true, fallbackStage: 'exit1', poolRaw: `http://127.0.0.1:${port}`, poolIndex: 0, rotateOnEnter: true },
          checkout: { enabled: true, fallbackStage: 'exit1', poolRaw: '', poolIndex: 0, rotateOnEnter: true },
          billing: { enabled: true, fallbackStage: 'exit2', poolRaw: '', poolIndex: 0, rotateOnEnter: true },
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
  }, proxyPort);

  const initial = await page.evaluate(() => chrome.runtime.sendMessage({
    type: 'opx:proxy-automation-stage',
    stage: 'auth',
    cycleId: `initial-${Date.now()}`,
    forceRotate: true,
  }));
  const failedIp = initial?.applied?.evidence?.ip || '';
  const rotation = await page.evaluate(({ ip }) => chrome.runtime.sendMessage({
    type: 'opx:proxy-automation-stage',
    stage: 'auth',
    cycleId: `recovery-${Date.now()}`,
    forceRotate: true,
    excludeIps: [ip],
    requireDifferentIp: true,
    reason: 'auth-cloudflare-challenge-e2e',
  }), { ip: failedIp });

  result.initial = summarize(initial);
  result.rotation = summarize(rotation);
  result.checks.initialExitVerified = initial?.ok === true && Boolean(failedIp);
  result.checks.repeatedIpStopped = rotation?.ok === false && rotation?.code === 'AUTH_EXIT_NOT_ROTATED';
  result.checks.failedIpStayedSame = rotation?.applied?.evidence?.ip === failedIp;
  result.checks.repeatedAttemptsRecorded = Number(rotation?.applied?.evidence?.repeatedIpRejected || 0) === 3;

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#proxy-auto-evidence').waitFor({ state: 'visible', timeout: 20_000 });
  result.evidenceBoard = await page.locator('#proxy-auto-evidence').innerText();
  result.checks.evidenceBoardVisible = /失败 IP 重复，已拒绝 3 次/.test(result.evidenceBoard);
  await page.locator('#proxy-auto-evidence').screenshot({ path: path.join(evidenceDir, 'auth-repeated-ip-board.png') });
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

function summarize(status) {
  return {
    ok: status?.ok === true,
    code: status?.code || '',
    message: status?.message || '',
    evidence: status?.applied?.evidence || null,
  };
}
