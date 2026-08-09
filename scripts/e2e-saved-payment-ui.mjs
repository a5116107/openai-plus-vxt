import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = process.cwd();
const extensionDir = path.resolve(repoRoot, '.output/chrome-mv3');
const outputDir = path.resolve(repoRoot, '.context-snapshots/saved-payment-ui');
const imageDir = path.resolve(repoRoot, 'image');
const screenshotDir = process.env.OPX_SAVED_PAYMENT_UPDATE_BASELINES === '1' ? imageDir : outputDir;
const playwrightModule = 'C:/Users/Administrator/AppData/Roaming/npm/node_modules/agent-browser/node_modules/playwright-core/index.js';
const browserCandidates = [
  'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe',
  'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1217/chrome-win64/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const executablePath = browserCandidates.find(existsSync);
if (!executablePath || !existsSync(playwrightModule) || !existsSync(extensionDir)) {
  throw new Error('saved-payment UI browser prerequisites are missing');
}

const imported = await import(pathToFileURL(playwrightModule).href);
const { chromium } = imported.default || imported;
await mkdir(outputDir, { recursive: true });
await mkdir(screenshotDir, { recursive: true });
const profileDir = await mkdtemp(path.join(tmpdir(), 'opx-saved-payment-ui-'));
let context;

try {
  context = await chromium.launchPersistentContext(profileDir, {
    executablePath,
    headless: false,
    viewport: { width: 420, height: 900 },
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  const paymentTab = page.getByRole('button', { name: '支付', exact: true });
  await paymentTab.waitFor({ state: 'visible', timeout: 20_000 });
  await paymentTab.click();
  await page.getByRole('button', { name: '添加卡', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
  await page.waitForTimeout(500);

  const desktop = await inspect(page);
  await page.screenshot({ path: path.join(screenshotDir, 'saved-payment-panel-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 360, height: 760 });
  await page.waitForTimeout(200);
  const narrow = await inspect(page);
  await page.screenshot({ path: path.join(screenshotDir, 'saved-payment-panel-narrow.png'), fullPage: true });

  const identityGate = classifyIdentityGate(desktop.status, narrow.status);
  const expectedErrors = identityGate.blocked
    ? errors.filter((error) => isExpectedIdentityGateError(error, identityGate.httpStatus))
    : [];
  const unexpectedErrors = errors.filter((error) => !expectedErrors.includes(error));
  const result = {
    extensionId,
    desktop,
    narrow,
    identityGate,
    errors,
    expectedErrors,
    unexpectedErrors,
    screenshots: [
      path.relative(repoRoot, path.join(screenshotDir, 'saved-payment-panel-desktop.png')).replaceAll('\\', '/'),
      path.relative(repoRoot, path.join(screenshotDir, 'saved-payment-panel-narrow.png')).replaceAll('\\', '/'),
    ],
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (
    unexpectedErrors.length
    || desktop.overflow
    || narrow.overflow
    || desktop.outOfBounds
    || narrow.outOfBounds
    || desktop.clippedTabs.length
    || narrow.clippedTabs.length
  ) {
    process.exitCode = 1;
  }
} finally {
  await context?.close().catch(() => undefined);
  await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
}

function classifyIdentityGate(...messages) {
  const text = messages.join(' ');
  const match = /ChatGPT session HTTP\s+(401|403)/i.exec(text);
  return {
    blocked: Boolean(match),
    httpStatus: match ? Number(match[1]) : 0,
  };
}

function isExpectedIdentityGateError(message, httpStatus) {
  if (![401, 403].includes(httpStatus)) return false;
  return new RegExp(`Failed to load resource: the server responded with a status of ${httpStatus}\\b`, 'i').test(message);
}

async function inspect(page) {
  return page.evaluate(() => {
    const shadow = document.querySelector('#app')?.shadowRoot;
    if (!shadow) throw new Error('sidepanel shadow root is missing');
    const panel = shadow.querySelector('.opx-panel');
    if (!(panel instanceof HTMLElement)) throw new Error('sidepanel is missing');
    const controls = [...shadow.querySelectorAll('.opx-view:not([hidden]) button, .opx-view:not([hidden]) input')];
    const tabs = [...shadow.querySelectorAll('.opx-tab')];
    const viewportWidth = document.documentElement.clientWidth;
    const outOfBounds = controls.some((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left < -0.5 || rect.right > viewportWidth + 0.5 || rect.width < 1 || rect.height < 1;
    });
    return {
      viewportWidth,
      panelWidth: Math.round(panel.getBoundingClientRect().width),
      controlCount: controls.length,
      overflow: panel.scrollWidth > panel.clientWidth + 1,
      outOfBounds,
      clippedTabs: tabs
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.left < -0.5 || rect.right > viewportWidth + 0.5 || element.scrollWidth > element.clientWidth + 1;
        })
        .map((element) => element.textContent || ''),
      activeHeading: shadow.querySelector('.opx-view:not([hidden]) h3')?.textContent || '',
      status: shadow.querySelector('.opx-view:not([hidden]) .opx-status')?.textContent || '',
    };
  });
}
