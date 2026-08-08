import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = process.cwd();
const extensionDir = path.resolve(repoRoot, '.output/chrome-mv3');
const EXPECTED_VERSION = '0.0.37';
const evidenceDir = path.resolve(repoRoot, '.context-snapshots/e2e-eligibility-dashboard-' + EXPECTED_VERSION);
const playwrightModule = 'C:/Users/Administrator/AppData/Roaming/npm/node_modules/agent-browser/node_modules/playwright-core/index.js';
const browserCandidates = [
  'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe',
  'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1217/chrome-win64/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const executablePath = browserCandidates.find(existsSync);
if (!executablePath) throw new Error('未找到 Chromium');

const playwrightImport = await import(pathToFileURL(playwrightModule).href);
const { chromium } = playwrightImport.default || playwrightImport;
await mkdir(evidenceDir, { recursive: true });
const profileDir = await mkdtemp(path.join(tmpdir(), 'opx-factor-e2e-'));
const errors = [];
const consoleErrors = [];
const result = { version: '', extensionId: '', checks: {}, errors, consoleErrors };
let context;

async function captureEvidence(page, targetPath, fullPage) {
  try {
    await page.screenshot({ path: targetPath, fullPage });
  } catch (error) {
    if (!fullPage) throw error;
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: targetPath, fullPage: false });
  }
}

try {
  context = await chromium.launchPersistentContext(profileDir, {
    executablePath,
    headless: false,
    acceptDownloads: true,
    viewport: { width: 1440, height: 1000 },
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  context.on('page', attachDiagnostics);
  for (const page of context.pages()) attachDiagnostics(page);
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
  result.extensionId = new URL(worker.url()).host;
  result.version = await worker.evaluate(() => chrome.runtime.getManifest().version);
  result.checks.version = result.version === EXPECTED_VERSION;

  const page = await context.newPage();
  attachDiagnostics(page);
  await page.goto(`chrome-extension://${result.extensionId}/automation-settings.html`, { waitUntil: 'domcontentloaded' });
  await page.locator('#probe-factor-tracking').waitFor({ state: 'attached', timeout: 20000 });
  await seedObservations(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#probe-factor-summary').waitFor({ state: 'visible', timeout: 20000 });
  await page.waitForFunction(() => /当前纪元观测\s+40/.test(document.querySelector('#probe-factor-summary')?.textContent || ''), null, { timeout: 20000 });

  result.checks.configControls = await Promise.all([
    '#probe-factor-tracking', '#probe-drift-detection', '#probe-adaptive-percent',
    '#probe-factor-min-samples', '#probe-drift-min-samples', '#probe-observation-limit',
    '#probe-experiment-mode', '#probe-balanced-order', '#probe-research-target-cell',
    '#probe-research-repeat-minutes', '#probe-research-min-total', '#probe-route-variants',
    '#probe-payment-variants', '#probe-seed-replicates',
    '#probe-checkout-ui-mode',
  ].map((selector) => page.locator(selector).isVisible())).then((values) => values.every(Boolean));
  result.checks.identitySessionControl = await page.locator('#btn-probe-sync-session').isVisible()
    && /Cookie 身份就绪/.test(await page.locator('#probe-account-summary').innerText())
    && /仅 AT/.test(await page.locator('#probe-account-summary').innerText());
  result.checks.identityRequiredPath = await page.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ type: 'opx:probe-sync-current-session' });
    return response?.ok === false
      && /登录会话同步失败/.test(String(response?.message || ''))
      && Array.isArray(response?.state?.accounts);
  });
  result.checks.importControl = await page.locator('#btn-probe-factor-import').isVisible();
  result.checks.observationsRendered = /当前纪元观测\s+40/.test(await page.locator('#probe-factor-summary').innerText());
  result.checks.qualityRendered = /错误率/.test(await page.locator('#probe-factor-summary').innerText())
    && /规则纪元\s+2/.test(await page.locator('#probe-quality-summary').innerText())
    && /矩阵平衡/.test(await page.locator('#probe-quality-summary').innerText());
  const runnerSummary = await page.locator('#probe-runner-summary').innerText();
  result.checks.runnerMetricsRendered = /Runner\s+80/.test(runnerSummary)
    && /流程转化 创建\s+80\/80/.test(runnerSummary)
    && /模式资格 hosted\s+20\/40.*custom\s+20\/40/.test(runnerSummary)
    && /分层重试 Checkout\s+120.*Update\s+80.*完整流程\s+88.*CF\s+8/.test(runnerSummary)
    && /资格通过\s+40\/80/.test(runnerSummary)
    && /方式提供\s+80\/80/.test(runnerSummary)
    && /confirm\s+40\/40/.test(runnerSummary)
    && /approve\s+20\/20/.test(runnerSummary)
    && /终链验证\s+40\/80/.test(runnerSummary)
    && /协议失败\s+0\/80/.test(runnerSummary);
  result.checks.strictControlsRendered = await Promise.all([
    '#probe-require-zero', '#probe-staged-pipeline', '#probe-extract-final-url', '#probe-enable-stripe-confirm',
    '#probe-payment-checkout-mode', '#probe-extract-all-methods', '#probe-force-unlisted-methods',
    '#probe-checkout-ui-mode',
    '#probe-hitdb-only-usable',
  ].map((selector) => page.locator(selector).isVisible())).then((values) => values.every(Boolean));
  result.checks.usableLinkBoard = /有效链接\s+2/.test(await page.locator('#probe-hitdb-summary').innerText())
    && await page.locator('#probe-hitdb-table tbody tr').count() === 2
    && /hosted/.test(await page.locator('#probe-hitdb-table').innerText())
    && /custom/.test(await page.locator('#probe-hitdb-table').innerText());
  result.checks.checkoutModeLoaded = await page.locator('#probe-checkout-ui-mode').inputValue() === 'both';
  result.checks.readinessRendered = await page.locator('#probe-readiness-table tbody tr').count() === 7
    && /有效账号/.test(await page.locator('#probe-readiness-summary').innerText())
    && /探索/.test(await page.locator('#probe-readiness-summary').innerText());
  result.checks.factorRowsRendered = await page.locator('#probe-factor-table tbody tr').count() > 0;
  result.checks.controlledEffectsRendered = await page.locator('#probe-controlled-table tbody tr').count() >= 8;
  result.checks.confoundingAuditRendered = await page.locator('#probe-confounding-table tbody tr').count() > 0;
  result.checks.powerPlanRendered = await page.locator('#probe-power-table tbody tr').count() === 3;
  result.checks.repeatStabilityRendered = /重复稳定/.test(await page.locator('#probe-quality-summary').innerText());
  result.checks.conclusionsRendered = await page.locator('.probe-factor-conclusion').count() === 6;
  result.checks.driftRendered = await page.locator('#probe-drift-table tbody tr').count() > 0;
  result.checks.recommendationsRendered = await page.locator('#probe-adaptive-table tbody tr').count() > 0;
  result.checks.matrixRendered = await page.locator('#probe-matrix-table tbody tr').count() > 0;
  result.checks.matrixCoverage = /矩阵\s+52账号\s+×\s+5出口/.test(await page.locator('#probe-matrix-summary').innerText());
  result.checks.evidenceGate = /证据不足/.test(await page.locator('#probe-matrix-summary').innerText())
    && (await page.locator('.probe-factor-conclusion[data-evidence="insufficient"]').count()) >= 5;
  result.checks.runCenterProgress = /进度\s+8\/10/.test(await page.locator('#probe-run-summary').innerText())
    && /请求\s+7/.test(await page.locator('#probe-run-summary').innerText())
    && /跳过\s+1/.test(await page.locator('#probe-run-summary').innerText());
  result.checks.runCenterAccounts = await page.locator('#probe-run-board details.probe-run-account').count() === 2;
  const firstRunAccount = page.locator('#probe-run-board details.probe-run-account').first();
  await firstRunAccount.locator('summary').click();
  result.checks.runCenterUnits = await firstRunAccount.locator('tbody tr').count() === 5
    && await firstRunAccount.getAttribute('open') !== null;

  const accountSummary = await page.locator('#probe-account-report-summary').innerText();
  result.checks.accountAssetsRendered = /账号\s+52/.test(accountSummary)
    && /凭据过期\s+1/.test(accountSummary)
    && /有链接\s+1/.test(accountSummary);
  result.checks.accountPagination = /第\s+1\/2\s+页/.test(await page.locator('#probe-account-page-summary').innerText())
    && await page.locator('#probe-account-report-table tbody tr').count() === 50;
  await page.locator('#btn-probe-account-next').click();
  result.checks.accountNextPage = /第\s+2\/2\s+页/.test(await page.locator('#probe-account-page-summary').innerText())
    && await page.locator('#probe-account-report-table tbody tr').count() === 2;
  await page.locator('#probe-account-filter-status').selectOption('expired');
  result.checks.accountCredentialFilter = await page.locator('#probe-account-report-table tbody tr').count() === 1
    && /expired/.test(await page.locator('#probe-account-report-table').innerText());
  await page.locator('#probe-account-filter-status').selectOption('all');
  await page.locator('#probe-account-filter-query').fill('asset-051@example.test');
  result.checks.accountSearch = await page.locator('#probe-account-report-table tbody tr').count() === 1
    && /asset-051@example\.test/.test(await page.locator('#probe-account-report-table').innerText());
  await page.locator('#probe-account-filter-query').fill('');
  await page.locator('#btn-probe-account-select-page').click();
  await page.locator('#btn-probe-account-disable').click();
  await page.waitForFunction(() => /启用\s+2/.test(document.querySelector('#probe-account-report-summary')?.textContent || ''), null, { timeout: 10000 });
  result.checks.accountBatchDisable = await page.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ type: 'opx:probe-account-report' });
    return response?.ok === true && response.report.filter((row) => row.enabled).length === 2;
  });
  await page.locator('#btn-probe-account-select-page').click();
  await page.locator('#btn-probe-account-enable').click();
  await page.waitForFunction(() => /启用\s+52/.test(document.querySelector('#probe-account-report-summary')?.textContent || ''), null, { timeout: 10000 });
  result.checks.accountBatchEnable = await page.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ type: 'opx:probe-account-report' });
    return response?.ok === true && response.report.every((row) => row.enabled);
  });

  const importPayload = await page.evaluate(async () => {
    const data = await chrome.storage.local.get('opx.probe.state');
    const source = data['opx.probe.state'].observations[0];
    return JSON.stringify({ observations: [{ ...source, id: 'ui-imported-observation', observedAt: Date.now() }] });
  });
  await page.locator('#btn-probe-factor-import').click();
  await page.locator('.import-textarea').fill(importPayload);
  await page.getByRole('button', { name: '合并导入', exact: true }).click();
  await page.waitForFunction(() => /合并观测\s+1/.test(document.querySelector('#probe-factor-summary')?.textContent || ''), null, { timeout: 10000 });
  result.checks.importRecomputed = await page.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ type: 'opx:probe-factor-query' });
    return response?.state?.observations?.length === 81 && response?.report?.quality?.latestEpochSamples > 0;
  });
  result.checks.csvImport = await page.evaluate(async () => {
    const csv = [
      'id,observedAt,taskId,accountId,accountBatchId,accountSource,probeCountry,outcome,hitKind,checkoutCountry,checkoutIp,checkoutVerified,paymentMethod,currency,planName,extensionVersion,browserFamily,locale,timeZone',
      `ui-imported-csv,${Date.now()},ui-factor-task,probe-acc-ui-1,automation-2026-07-01,automation,JP,miss,none,JP,203.0.113.20,true,hosted,JPY,chatgptplusplan,0.0.27,chromium,zh-CN,Asia/Shanghai`,
    ].join('\n');
    const response = await chrome.runtime.sendMessage({ type: 'opx:probe-factor-import', text: csv, format: 'csv', mode: 'merge' });
    return response?.ok === true && response?.imported === 1 && response?.state?.observations?.length === 82;
  });

  await page.locator('#btn-probe-factor-refresh').click();
  await page.waitForFunction(() => /观测\s+82/.test(document.querySelector('#probe-factor-summary')?.textContent || ''), null, { timeout: 10000 });
  result.checks.refreshMessage = /观测\s+82/.test(await page.locator('#probe-factor-summary').innerText());

  const csvDownloadPromise = page.waitForEvent('download');
  await page.locator('#btn-probe-factor-export-csv').click();
  const csvDownload = await csvDownloadPromise;
  const csvText = await readFile(await csvDownload.path(), 'utf8');
  result.checks.csvExport = (await csvDownload.suggestedFilename()).endsWith('.csv')
    && /^id,observedAt,taskId,/.test(csvText)
    && /experimentMode,experimentArm,designCellKey,routeVariantId/.test(csvText)
    && /paymentRunnerStatus,paymentRunnerStage,paymentRunnerCode,paymentCheckoutSessionMode,paymentCheckoutStatus,paymentCheckoutSessionDistinct,paymentMethodLinkCount,qualificationVerified,submittedPaymentMethod/.test(csvText)
    && /paymentRunnerConfirmSubmitted,paymentRunnerConfirmSucceeded,paymentRunnerApproveSubmitted,paymentRunnerApproveSucceeded,finalLinkVerified,checkoutCreated,qualificationGateVersion,linkVerificationLevel,linkUsable,credentialStatus/.test(csvText)
    && /retryOrdinal,checkoutUiMode,checkoutAttempts,updateAttempts,fullFlowAttempts,cfRetryCount,cfExitRotations,invalidPromotionRebuilds,pageFallbackAttempts/.test(csvText);
  result.checks.csvRoundTrip = await page.evaluate(async (text) => {
    const response = await chrome.runtime.sendMessage({ type: 'opx:probe-factor-import', text, format: 'csv', mode: 'replace' });
    const sample = response?.state?.observations?.find((item) => item.id === 'ui-observation-0');
    return response?.ok === true && response?.imported === 82 && response?.rejected === 0
      && response?.state?.observations?.length === 82
      && sample?.qualificationVerified === true
      && sample?.paymentRunnerConfirmSubmitted === true
      && sample?.paymentRunnerConfirmSucceeded === true
      && sample?.paymentRunnerApproveSubmitted === true
      && sample?.paymentRunnerApproveSucceeded === true
      && sample?.finalLinkVerified === true;
  }, csvText);

  const jsonDownloadPromise = page.waitForEvent('download');
  await page.locator('#btn-probe-factor-export-json').click();
  const jsonDownload = await jsonDownloadPromise;
  const jsonText = await readFile(await jsonDownload.path(), 'utf8');
  const jsonPayload = JSON.parse(jsonText);
  result.checks.jsonExport = (await jsonDownload.suggestedFilename()).endsWith('.json')
    && Array.isArray(jsonPayload.observations)
    && jsonPayload.observations.length === 82
    && Object.prototype.hasOwnProperty.call(jsonPayload.observations[0], 'experimentArm')
    && Object.prototype.hasOwnProperty.call(jsonPayload.observations[0], 'paymentRunnerConfirmSucceeded')
    && Object.prototype.hasOwnProperty.call(jsonPayload.observations[0], 'linkVerificationLevel')
    && Object.prototype.hasOwnProperty.call(jsonPayload.observations[0], 'checkoutAttempts');
  result.checks.exportHasNoToken = !/accessToken|tokenRaw|identitySnapshot|deviceId|sessionId|"cookies"/i.test(jsonText);

  await page.locator('#probe-factor-summary').scrollIntoViewIfNeeded();
  await captureEvidence(page, path.join(evidenceDir, 'desktop-factor-dashboard.png'), true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#probe-factor-summary').scrollIntoViewIfNeeded();
  await captureEvidence(page, path.join(evidenceDir, 'mobile-factor-dashboard.png'), false);
  result.checks.mobileNoHorizontalPageOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#btn-probe-factor-clear').click();
  await page.waitForFunction(() => /已清空/.test(document.querySelector('#probe-factor-summary')?.textContent || ''), null, { timeout: 10000 });
  const storedAfterClear = await page.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ type: 'opx:probe-factor-query' });
    return response?.state?.observations?.length;
  });
  result.checks.clearIsolated = storedAfterClear === 0;
  result.checks.noPageErrors = errors.length === 0;
  result.checks.noConsoleErrors = consoleErrors.length === 0;
} catch (error) {
  result.fatalError = error instanceof Error ? `${error.message}\n${error.stack || ''}` : String(error);
} finally {
  result.finishedAt = new Date().toISOString();
  result.ok = !result.fatalError && Object.values(result.checks).every(Boolean);
  await writeFile(path.join(evidenceDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  if (context) await context.close().catch(() => undefined);
  await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
}

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;

function attachDiagnostics(page) {
  page.on('pageerror', (error) => errors.push(`${page.url()}: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(`${page.url()}: ${message.text()}`);
  });
}

async function seedObservations(page) {
  await page.evaluate(async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const observations = [];
    for (let index = 0; index < 80; index += 1) {
      const recent = index >= 40;
      const within = index % 40;
      const country = within % 2 ? 'JP' : 'US';
      const hit = within < (recent ? 32 : 8);
      const ip = country === 'JP' ? '203.0.113.20' : '203.0.113.10';
      observations.push({
        id: `ui-observation-${index}`,
        observedAt: now - (recent ? DAY : 20 * DAY) + within * 1000,
        taskId: 'ui-factor-task', round: recent ? 2 : 1, sequence: index + 1,
        researchMode: true, scheduleBlock: recent ? 2 : 1, scheduleCellAttempt: recent ? 2 : 1,
        accountId: `probe-acc-ui-${within % 4}`, accountBatchId: 'automation-2026-07-01', accountSource: 'automation', accountAgeHours: 120,
        probeCountry: country, bootstrapCountry: country, promotionCountry: 'VN', providerCountry: country,
        channels: ['hosted'], planName: 'chatgptplusplan', paymentMethod: 'hosted', currency: country === 'JP' ? 'JPY' : 'USD',
        outcome: hit ? 'hit' : 'miss', hitKind: hit ? 'trial' : 'none', amountHint: hit ? '0' : '20', promoHint: hit ? 'trial' : '',
        detectedMethods: recent ? ['card', 'paypal'] : ['card'],
        paymentRunnerStatus: hit ? 'link_ready' : 'not_qualified', paymentRunnerStage: hit ? 'finalize' : 'screen',
        paymentRunnerCode: hit ? 'LINK_READY' : 'STRICT_GATE_NOT_QUALIFIED', qualificationVerified: hit,
        submittedPaymentMethod: hit ? 'paypal' : '', paymentRunnerConfirmSubmitted: hit,
        paymentRunnerConfirmSucceeded: hit, paymentRunnerApproveSubmitted: hit && index % 2 === 0,
        paymentRunnerApproveSucceeded: hit && index % 2 === 0, finalLinkVerified: hit,
        checkoutCreated: true, linkUsable: hit, checkoutUiMode: index % 2 ? 'custom' : 'hosted',
        checkoutAttempts: index % 2 ? 2 : 1, updateAttempts: 1, fullFlowAttempts: index % 10 === 0 ? 2 : 1,
        cfRetryCount: index % 10 === 0 ? 1 : 0, cfExitRotations: index % 20 === 0 ? 1 : 0,
        invalidPromotionRebuilds: index % 10 === 0 ? 1 : 0, pageFallbackAttempts: index % 4 === 0 ? 1 : 0,
        errorClass: '', durationMs: 300, configuredRetries: 1,
        stagedPipelineEnabled: true, entryProxyMode: 'front', exitProxyMode: 'follow-country', frontProxySummary: 'http://127.0.0.1:7890',
        auth: { country: 'US', ip: '198.51.100.1', asn: 'AS64500', colo: 'SJC', endpointSummary: 'auth', source: 'e2e', verified: true },
        checkout: { country, ip, asn: country === 'JP' ? 'AS64520' : 'AS64510', colo: '', endpointSummary: ip, source: 'e2e', verified: true },
        billing: { country, ip: `${ip}-billing`, asn: '', colo: '', endpointSummary: `${ip}-billing`, source: 'e2e', verified: true },
        bootstrapSeedSummary: ip, promotionSeedSummary: '203.0.113.30', providerSeedSummary: `${ip}-billing`,
        extensionVersion: '0.0.30', browserFamily: 'chromium', locale: 'zh-CN', timeZone: 'Asia/Shanghai',
      });
    }
    const encode = (value) => btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const jwt = (expiresAt) => encode({ alg: 'none', typ: 'JWT' }) + '.' + encode({ exp: Math.floor(expiresAt / 1000) }) + '.e2e';
    const accounts = Array.from({ length: 52 }, (_, index) => ({
      id: 'probe-asset-' + String(index).padStart(3, '0'),
      email: 'asset-' + String(index).padStart(3, '0') + '@example.test',
      tokenRaw: jwt(index === 1 ? now - DAY : index === 2 ? now + 60 * 60 * 1000 : now + 7 * DAY),
      source: index < 2 ? 'automation' : index === 2 ? 'session' : 'manual',
      enabled: true,
      lastHitAt: index === 0 ? now - 5000 : 0,
      lastProbeAt: index < 2 ? now - 3000 : 0,
      lastProbeCountry: index === 0 ? 'JP' : index === 1 ? 'US' : '',
      tokenUpdatedAt: now - DAY,
      lastMessage: index === 0 ? '命中 trial' : index === 1 ? 'checkout miss' : '',
      successCount: index === 0 ? 4 : index === 1 ? 1 : 0,
      failCount: index === 0 ? 1 : index === 1 ? 3 : 0,
      createdAt: now - 10 * DAY,
      batchId: 'e2e-assets',
      identitySnapshot: { deviceId: 'device-' + index, sessionId: 'session-' + index, cookies: [], capturedAt: now },
    }));
    const runId = 'ui-run-20260729';
    const countries = ['US', 'JP', 'IN', 'TH', 'VN'];
    const statuses = ['hit', 'miss', 'error', 'skipped', 'miss', 'miss', 'hit', 'miss', 'planned', 'planned'];
    const unitStates = accounts.slice(0, 2).flatMap((account, accountIndex) => countries.map((country, countryIndex) => {
      const index = accountIndex * countries.length + countryIndex;
      const status = statuses[index];
      return {
        unitId: runId + '-u' + (index + 1), runId, cycleId: 'cycle-' + (index + 1), attemptId: 'attempt-' + (index + 1),
        accountId: account.id, email: account.email, country, status, attempt: status === 'planned' ? 0 : 1,
        startedAt: status === 'planned' ? 0 : now - 20000 + index * 1000,
        finishedAt: ['planned', 'running'].includes(status) ? 0 : now - 19000 + index * 1000,
        durationMs: status === 'planned' ? 0 : 1000,
        hitKind: status === 'hit' ? 'trial' : 'none', errorClass: status === 'error' ? 'checkout' : '', message: country + ' ' + status,
      };
    }));
    const hit = {
      id: 'asset-hit-1', taskId: 'ui-factor-task', accountId: accounts[0].id, email: accounts[0].email,
      country: 'JP', currency: 'JPY', planName: 'chatgptplusplan', ok: true, hitKind: 'trial', message: '7 day trial',
      link: 'https://example.test/checkout/asset-hit-1', longUrl: '', shortUrl: '', channels: ['hosted'], amountHint: '0',
      promoHint: 'trial', createdAt: now - 5000, rawKeys: [], tags: ['trial', '有链接'],
      checkoutCreated: true, qualificationVerified: true, qualificationGateVersion: 'strict-zero-page-v2',
      linkVerificationLevel: 'strict-page', linkUsable: true, finalLinkVerified: false,
      checkoutUiMode: 'hosted', checkoutRetryMetrics: { checkoutAttempts: 1, updateAttempts: 1, fullFlowAttempts: 1, cfRetryCount: 0, cfExitRotations: 0, invalidPromotionRebuilds: 0, pageFallbackAttempts: 1 },
    };
    const customHit = {
      ...hit,
      id: 'asset-hit-1-custom',
      link: 'https://chatgpt.com/checkout/openai_ie/oaics_custom_e2e',
      shortUrl: 'https://chatgpt.com/checkout/openai_ie/oaics_custom_e2e',
      checkoutUiMode: 'custom',
      checkoutRetryMetrics: { checkoutAttempts: 2, updateAttempts: 1, fullFlowAttempts: 2, cfRetryCount: 1, cfExitRotations: 1, invalidPromotionRebuilds: 1, pageFallbackAttempts: 1 },
      tags: ['trial', '有链接', 'checkout-custom'],
    };
    const runtime = {
      status: 'running', runId, cycleId: 'ui-cycle', startedAt: now - 30000, finishedAt: 0, nextRunAt: 0,
      currentAccountId: accounts[1].id, currentCountry: 'VN', currentUnitId: runId + '-u8', currentAttemptId: 'attempt-8',
      totalUnits: 10, completedUnits: 8, skippedUnits: 1, processed: 7, hits: 2, errors: 1,
      lastMessage: '已完成 8/10', round: 2, unitStates,
    };
    await chrome.storage.local.set({
      'opx.probe.state': {
        accounts, rawAccounts: accounts.map((account) => account.email + '----' + account.tokenRaw).join('\n'),
        hits: [hit, customHit], hitDatabase: [
          { ...hit, dbId: 'asset-db-1', savedAt: now - 4000, sourceTaskName: 'UI 因素测试', archived: false },
          { ...customHit, dbId: 'asset-db-2', savedAt: now - 3000, sourceTaskName: 'UI 因素测试', archived: false },
        ],
        stats: [], proxyHealth: [], methodDetections: [],
        tasks: [{ id: 'ui-factor-task', config: { name: 'UI 因素测试', countries, checkoutUiMode: 'both', factorTrackingEnabled: true, driftDetectionEnabled: true, factorMinSamples: 5, driftMinSamples: 10, adaptiveExplorationPercent: 20, observationRetentionLimit: 3000, researchModeEnabled: true, balancedOrderEnabled: true, researchTargetSamplesPerCell: 3, researchMinRepeatIntervalMinutes: 240, researchMinTotalSamples: 100 }, runtime, createdAt: now, updatedAt: now }],
        observations, activeTaskId: 'ui-factor-task', updatedAt: now,
      },
    });
  });
}
