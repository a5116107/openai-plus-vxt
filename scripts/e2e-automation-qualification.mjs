import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = process.cwd();
const extensionDir = path.resolve(repoRoot, '.output/chrome-mv3');
const evidenceDir = path.resolve(repoRoot, '.context-snapshots/e2e-automation-qualification-0.0.34');
const playwrightModule = 'C:/Users/Administrator/AppData/Roaming/npm/node_modules/agent-browser/node_modules/playwright-core/index.js';
const browserCandidates = [
  'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const executablePath = browserCandidates.find(existsSync);
if (!executablePath || !existsSync(extensionDir) || !existsSync(playwrightModule)) {
  throw new Error('资格入库 E2E 所需的 Chromium、扩展构建或 Playwright 不完整');
}

const playwrightImport = await import(pathToFileURL(playwrightModule).href);
const { chromium } = playwrightImport.default || playwrightImport;
const profileDir = await mkdtemp(path.join(tmpdir(), 'opx-qualification-'));
const checkoutUrl = 'https://chatgpt.com/checkout/openai_llc/cs_live_qualification_e2e';
const testEmail = 'qualification-e2e@example.test';
const result = { version: '0.0.34', checks: {}, errors: [], pageErrors: [], consoleErrors: [] };
let context;

await mkdir(evidenceDir, { recursive: true });

try {
  context = await chromium.launchPersistentContext(profileDir, {
    executablePath,
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  context.on('page', attachDiagnostics);
  await context.route('https://chatgpt.com/checkout/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html><head><title>Qualification fixture</title></head><body>
        <main>
          <h1>ChatGPT Plus</h1>
          <section id="OrderDetails-TotalAmount"><span>Total today</span><span class="CurrencyAmount">US$0.00</span></section>
          <button type="submit">Subscribe</button>
        </main>
      </body></html>`,
    });
  });

  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
  const extensionId = new URL(worker.url()).host;
  result.extensionId = extensionId;

  const checkoutPage = await context.newPage();
  attachDiagnostics(checkoutPage);
  await checkoutPage.goto(checkoutUrl, { waitUntil: 'domcontentloaded' });
  await checkoutPage.locator('.CurrencyAmount').waitFor({ state: 'visible', timeout: 20_000 });

  const sidepanel = await context.newPage();
  attachDiagnostics(sidepanel);
  await sidepanel.goto(`chrome-extension://${extensionId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await sidepanel.locator('[data-tab="automation"]').click();
  await sidepanel.locator('.opx-automation-stages').waitFor({ state: 'visible', timeout: 20_000 });

  await sidepanel.evaluate(async ({ targetUrl, email }) => {
    const appKey = 'opx.registerAssist.state';
    const stored = await chrome.storage.local.get(appKey);
    const app = stored[appKey];
    const [tab] = await chrome.tabs.query({ url: `${new URL(targetUrl).origin}/checkout/*` });
    if (!app?.automation || typeof tab?.id !== 'number') {
      throw new Error('没有取得自动化默认状态或 Checkout 标签页');
    }
    app.activeTab = 'automation';
    app.automation.settings.checkoutOptions = { planName: 'chatgptplusplan', uiMode: 'hosted', region: 'US' };
    app.automation.emails = [{
      id: 'qualification-email', rawInput: email, email, status: 'idle', useCount: 0, lastUsedAt: 0, lastMessage: '',
    }];
    app.automation.run = {
      ...app.automation.run,
      running: false,
      paused: false,
      currentStepId: 'submit-openai-checkout',
      selectedEmailId: 'qualification-email',
      checkoutUrl: targetUrl,
      sessionEmail: email,
      targetTabId: tab.id,
      targetWindowId: tab.windowId || 0,
    };
    await chrome.storage.local.set({
      [appKey]: app,
      'opx.proxy.settings': {
        enabled: false,
        updatedAt: Date.now(),
        automationRouting: {
          evidence: {
            checkout: { stage: 'checkout', cycleId: 'fixture', source: 'fixture', endpointSummary: 'fixture-checkout', ip: '203.0.113.20', country: 'US', colo: 'IAD', verified: true, distinct: true, checkedAt: Date.now(), message: 'fixture' },
            billing: { stage: 'billing', cycleId: 'fixture', source: 'fixture', endpointSummary: 'fixture-billing', ip: '198.51.100.30', country: 'IN', colo: 'MAA', verified: true, distinct: true, checkedAt: Date.now(), message: 'fixture' },
          },
        },
      },
    });
  }, { targetUrl: checkoutUrl, email: testEmail });

  await sidepanel.reload({ waitUntil: 'domcontentloaded' });
  const paymentStage = sidepanel.locator('.opx-automation-stage').filter({ hasText: '支付' });
  await paymentStage.locator('.opx-automation-stage-header').click();
  const submitRow = paymentStage.locator('.opx-automation-step').filter({ hasText: '10. 提交 OpenAI 订阅页' });
  await submitRow.locator('button').click();

  const deadline = Date.now() + 90_000;
  let stored;
  while (Date.now() <= deadline) {
    stored = await readQualificationStorage(sidepanel);
    const hitCount = stored.probe?.hitDatabase?.length || 0;
    const step = stored.automation?.steps?.find((item) => item.id === 'submit-openai-checkout');
    if ((hitCount > 0 && step?.status === 'success') || ['error', 'skipped'].includes(step?.status || '')) {
      break;
    }
    await sidepanel.waitForTimeout(500);
  }
  stored ||= await readQualificationStorage(sidepanel);
  const hit = stored.probe?.hitDatabase?.[0];
  const step = stored.automation?.steps?.find((item) => item.id === 'submit-openai-checkout');
  result.logs = (stored.automation?.logs || []).slice(0, 20);
  if (!hit || step?.status !== 'success') {
    result.errors.push(`资格命中步骤未完成：status=${step?.status || 'missing'}；message=${step?.message || ''}`);
  }
  result.hit = hit ? {
    email: hit.email,
    country: hit.country,
    currency: hit.currency,
    hitKind: hit.hitKind,
    amountHint: hit.amountHint,
    link: hit.link,
    savedToDb: hit.savedToDb,
    tags: hit.tags,
  } : null;
  result.step = step || null;
  result.checks = {
    contentScriptReady: true,
    stepSucceeded: step?.status === 'success',
    hitPersisted: Boolean(hit?.savedToDb),
    zeroClassified: hit?.hitKind === 'zero' && hit?.amountHint === 'US$0.00',
    accountLinked: hit?.email === testEmail,
    countryLinked: hit?.country === 'US',
    currencyLinked: hit?.currency === 'USD',
    checkoutLinkPreserved: hit?.link === checkoutUrl,
    noPageErrors: result.pageErrors.length === 0,
    noConsoleErrors: result.consoleErrors.length === 0,
  };
  await sidepanel.screenshot({ path: path.join(evidenceDir, 'qualification-hitdb.png'), fullPage: true });
} catch (error) {
  result.errors.push(error instanceof Error ? `${error.message}\n${error.stack || ''}` : String(error));
} finally {
  result.finishedAt = new Date().toISOString();
  result.ok = result.errors.length === 0 && Object.values(result.checks).every(Boolean);
  await writeFile(path.join(evidenceDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  if (context) await context.close().catch(() => undefined);
  await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
}

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;

function attachDiagnostics(page) {
  page.on('pageerror', (error) => result.pageErrors.push(`${page.url()}: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && page.url().startsWith(`chrome-extension://${result.extensionId || ''}`)) {
      result.consoleErrors.push(`${page.url()}: ${message.text()}`);
    }
  });
}

async function readQualificationStorage(page) {
  return page.evaluate(async () => {
    const data = await chrome.storage.local.get(['opx.probe.state', 'opx.registerAssist.state']);
    return {
      probe: data['opx.probe.state'],
      automation: data['opx.registerAssist.state']?.automation,
    };
  });
}
