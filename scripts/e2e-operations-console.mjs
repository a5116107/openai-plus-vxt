import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = process.cwd();
const extensionDir = path.resolve(repoRoot, '.output/chrome-mv3');
const evidenceDir = path.resolve(repoRoot, '.context-snapshots/e2e-operations-console-0.0.37');
const playwrightModule = 'C:/Users/Administrator/AppData/Roaming/npm/node_modules/agent-browser/node_modules/playwright-core/index.js';
const browserCandidates = [
  'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe',
  'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1217/chrome-win64/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const executablePath = browserCandidates.find(existsSync);
if (!executablePath) throw new Error('Chromium not found');

const playwrightImport = await import(pathToFileURL(playwrightModule).href);
const { chromium } = playwrightImport.default || playwrightImport;
await mkdir(evidenceDir, { recursive: true });
const profileDir = await mkdtemp(path.join(tmpdir(), 'opx-operations-console-'));
const errors = [];
const consoleErrors = [];
const result = { extensionId: '', checks: {}, errors, consoleErrors };
let context;

try {
  context = await chromium.launchPersistentContext(profileDir, {
    executablePath,
    headless: false,
    acceptDownloads: true,
    viewport: { width: 1440, height: 900 },
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  context.on('page', attachDiagnostics);
  context.pages().forEach(attachDiagnostics);
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
  result.extensionId = new URL(worker.url()).host;

  await worker.evaluate(async (state) => {
    await chrome.storage.local.set({ 'opx.probe.state': state });
  }, legacyState());
  const bootstrapPage = await context.newPage();
  attachDiagnostics(bootstrapPage);
  await bootstrapPage.goto(`chrome-extension://${result.extensionId}/automation-settings.html`, { waitUntil: 'domcontentloaded' });
  await bootstrapPage.waitForFunction(() => document.documentElement.dataset.automationSettingsReady === 'true', null, { timeout: 20_000 });
  const migration = await bootstrapPage.evaluate(() => chrome.runtime.sendMessage({ type: 'opx:probe-get-state' }));
  result.checks.migrationStatus = migration?.state?.archiveStatus?.backend === 'indexeddb'
    && migration.state.archiveStatus.observationCount === 65
    && migration.state.archiveStatus.hitCount === 2
    && migration.state.archiveStatus.runCount === 1;
  await bootstrapPage.close();

  const page = await context.newPage();
  attachDiagnostics(page);
  await page.goto(`chrome-extension://${result.extensionId}/operations-console.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#backend')?.textContent?.includes('IndexedDB'), null, { timeout: 20_000 });
  result.checks.summary = await page.locator('#observation-count').innerText() === '65'
    && await page.locator('#hit-count').innerText() === '2'
    && await page.locator('#run-count').innerText() === '1';
  result.checks.firstPage = await page.locator('#records tr').count() === 50
    && /65 条 · 第 1\/2 页/.test(await page.locator('#page-summary').innerText());
  await page.locator('#next').click();
  await page.waitForFunction(() => document.querySelector('#page-summary')?.textContent?.includes('第 2/2 页'));
  result.checks.secondPage = await page.locator('#records tr').count() === 15;

  await page.locator('#query').fill('account-1');
  await page.locator('#apply').click();
  await page.waitForFunction(() => !document.querySelector('#status-message')?.textContent?.includes('正在'));
  result.checks.search = /16 条/.test(await page.locator('#page-summary').innerText());

  await page.locator('[data-entity="hits"]').click();
  await page.waitForFunction(() => document.querySelector('#page-summary')?.textContent?.startsWith('1 条'));
  result.checks.crossEntityFilter = await page.locator('#records tr').count() === 1;
  await page.locator('#query').fill('');
  await page.locator('#apply').click();
  await page.waitForFunction(() => document.querySelector('#page-summary')?.textContent?.startsWith('2 条'));
  result.checks.hits = await page.locator('#records tr').count() === 2;
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#export').click();
  const download = await downloadPromise;
  result.checks.export = (await download.suggestedFilename()).startsWith('probe-hits-');

  await page.locator('[data-entity="runs"]').click();
  await page.waitForFunction(() => document.querySelector('#page-summary')?.textContent?.startsWith('1 条'));
  result.checks.runs = await page.locator('#records tr').count() === 1
    && /fixture task/.test(await page.locator('#records').innerText());
  await page.locator('#retention-days').fill('30');
  await page.locator('#prune').click();
  await page.waitForFunction(() => document.querySelector('#observation-count')?.textContent === '64');
  result.checks.retention = await page.locator('#retention-days').inputValue() === '30';
  await page.screenshot({ path: path.join(evidenceDir, 'desktop.png'), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  result.checks.mobileNoOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  await page.screenshot({ path: path.join(evidenceDir, 'mobile.png'), fullPage: true });
  result.checks.consoleClean = consoleErrors.length === 0 && errors.length === 0;
} catch (error) {
  errors.push(error instanceof Error ? error.stack || error.message : String(error));
} finally {
  await context?.close().catch(() => undefined);
  await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
}

const failed = Object.entries(result.checks).filter(([, passed]) => !passed).map(([name]) => name);
await writeFile(path.join(evidenceDir, 'result.json'), JSON.stringify({ ...result, failed }, null, 2), 'utf8');
console.log(JSON.stringify({ ...result, failed }, null, 2));
if (errors.length || failed.length || consoleErrors.length) process.exitCode = 1;

function attachDiagnostics(page) {
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
}

function legacyState() {
  const now = Date.now();
  const observations = Array.from({ length: 65 }, (_, index) => ({
    id: `archive-observation-${index}`,
    observedAt: index === 64 ? now - 100 * 86_400_000 : now - index * 1000,
    taskId: 'archive-task',
    runId: 'archive-run',
    cycleId: `cycle-${index}`,
    accountId: `account-${index % 4}`,
    probeCountry: index % 2 ? 'JP' : 'US',
    outcome: index % 3 === 0 ? 'hit' : index % 3 === 1 ? 'miss' : 'error',
    hitKind: index % 3 === 0 ? 'trial' : index % 3 === 1 ? 'none' : 'error',
    message: `fixture observation ${index}`,
  }));
  const hit = (id, country, offset) => ({
    id, dbId: `db-${id}`, savedAt: now - offset, createdAt: now - offset,
    taskId: 'archive-task', accountId: `account-${offset % 4}`, email: `${id}@example.test`,
    country, currency: 'USD', planName: 'chatgptplusplan', ok: true, hitKind: 'trial',
    message: 'fixture trial', link: `https://example.test/${id}`, longUrl: '', shortUrl: '',
    channels: ['hosted'], amountHint: '0', promoHint: 'trial', rawKeys: [],
    sourceTaskName: 'fixture task', archived: false, qualificationVerified: true, linkUsable: true,
  });
  const runtime = {
    status: 'completed', runId: 'archive-run', cycleId: 'cycle-64', startedAt: now - 70_000,
    finishedAt: now, nextRunAt: 0, currentAccountId: '', currentCountry: '', currentUnitId: '',
    currentAttemptId: '', totalUnits: 65, completedUnits: 65, skippedUnits: 0, processed: 65,
    hits: 22, errors: 21, lastMessage: 'fixture complete', round: 1, unitStates: [],
  };
  return {
    accounts: [], rawAccounts: '', hits: [], hitDatabase: [hit('trial-us', 'US', 1), hit('trial-jp', 'JP', 2)],
    stats: [], proxyHealth: [], methodDetections: [], paymentOperationReceipts: [], observations,
    tasks: [{ id: 'archive-task', config: { name: 'fixture task', countries: ['US', 'JP'] }, runtime, createdAt: now - 70_000, updatedAt: now }],
    activeTaskId: 'archive-task', updatedAt: now,
  };
}
