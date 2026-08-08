import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = process.cwd();
const extensionDir = path.join(repoRoot, '.output', 'chrome-mv3');
const playwrightModule = 'C:/Users/Administrator/AppData/Roaming/npm/node_modules/agent-browser/node_modules/playwright-core/index.js';
const executableCandidates = [
  'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe',
  'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1217/chrome-win64/chrome.exe',
];
const executablePath = executableCandidates.find(existsSync);
const evidenceDir = path.join(repoRoot, '.context-snapshots', 'plus-checkout-closure');
const profileDir = await mkdtemp(path.join(os.tmpdir(), 'opx-pcc-fixture-'));
const closureRunId = String(process.env.PCC_CLOSURE_RUN_ID || 'closure-fixture').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 96);
const expectedLast4 = /^\d{4}$/.test(String(process.env.PCC_EXPECTED_LAST4 || '')) ? String(process.env.PCC_EXPECTED_LAST4) : '4242';
const checkoutSessionId = `oaics_${closureRunId.replace(/[^A-Za-z0-9]/g, '').slice(0, 48) || 'fixture'}`;
const checkoutUrl = `https://chatgpt.com/checkout/openai_llc/${checkoutSessionId}`;

if (!existsSync(path.join(extensionDir, 'manifest.json'))) throw new Error('Chrome extension build is missing');
if (!existsSync(playwrightModule) || !executablePath) throw new Error('Playwright Chromium fixture is missing');

const playwrightImport = await import(pathToFileURL(playwrightModule).href);
const { chromium } = playwrightImport.default || playwrightImport;
let context;
try {
  context = await chromium.launchPersistentContext(profileDir, {
    executablePath,
    headless: false,
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check'],
  });
  await context.route(checkoutUrl, (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: fixtureHtml(expectedLast4),
  }));
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
  const settingsUpdatedAt = Date.now();
  await worker.evaluate(async ({ updatedAt }) => {
    await chrome.storage.local.set({
      'opx.extension.settings': {
        addressAutofill: {
          payOpenAiEnabled: false,
          payPalSignupEnabled: false,
          countryCode: 'US',
          city: '',
          lastAddress: null,
          updatedAt,
        },
        updatedAt,
      },
    });
  }, { updatedAt: settingsUpdatedAt });
  const page = context.pages()[0] || await context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(checkoutUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
  const send = (message) => worker.evaluate(({ tabId: id, message: payload }) => chrome.tabs.sendMessage(id, payload), { tabId, message });

  const missing = await send({ type: 'opx:openai-select-saved-card', expectedLast4: '9999' });
  const selected = await send({ type: 'opx:openai-select-saved-card', expectedLast4 });
  const address = {
    fullName: 'Fixture User', line1: '1 Test St', line2: '', city: 'Seattle', state: 'WA', stateFull: 'Washington',
    postalCode: '98101', countryCode: 'US', countryLabel: 'United States', phone: '2065550100', source: 'fixture',
  };
  const filled = await send({ type: 'opx:openai-fill-billing', address });
  await page.waitForFunction(() => [
    '#billingName', '#billingAddressLine1', '#billingLocality', '#billingAdministrativeArea', '#billingPostalCode',
  ].every((selector) => Boolean(document.querySelector(selector)?.value)), { timeout: 10_000 });
  const billingFieldValues = await page.evaluate(() => ({
    fullName: document.querySelector('#billingName')?.value || '',
    line1: document.querySelector('#billingAddressLine1')?.value || '',
    city: document.querySelector('#billingLocality')?.value || '',
    state: document.querySelector('#billingAdministrativeArea')?.value || '',
    postalCode: document.querySelector('#billingPostalCode')?.value || '',
  }));
  const billingFieldPresence = Object.fromEntries(
    Object.entries(billingFieldValues).map(([key, value]) => [key, Boolean(value)]),
  );
  const verified = await send({ type: 'opx:openai-verify-billing', address });
  const submitMessage = {
    type: 'opx:openai-submit-qualified-checkout', expectedLast4, billingCountry: 'US',
    selectionVerified: true, billingVerified: true, submitKey: closureRunId,
  };
  const submitted = await send(submitMessage);
  const firstSubmitClicks = await page.evaluate(() => window.__fixtureSubmitClicks || 0);
  const repeated = await send(submitMessage);
  const submitClicks = await page.evaluate(() => window.__fixtureSubmitClicks || 0);
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({ path: path.join(evidenceDir, 'checkout-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 760 });
  await page.screenshot({ path: path.join(evidenceDir, 'checkout-mobile.png'), fullPage: true });
  const extensionId = new URL(worker.url()).host;
  const settingsPage = await context.newPage();
  await settingsPage.setViewportSize({ width: 1280, height: 800 });
  await settingsPage.goto(`chrome-extension://${extensionId}/automation-settings.html`, { waitUntil: 'domcontentloaded' });
  await settingsPage.waitForFunction(() => document.documentElement.dataset.automationSettingsReady === 'true');
  const settingsDefaults = await settingsPage.evaluate(() => ({
    enabled: document.querySelector('#plus-closure-enabled')?.checked,
    liveEnabled: document.querySelector('#plus-closure-live-enabled')?.checked,
    requireNetwork: document.querySelector('#plus-closure-require-network')?.checked,
  }));
  await settingsPage.locator('#plus-closure-enabled').check();
  await settingsPage.locator('#btn-save').click();
  await settingsPage.waitForTimeout(600);
  const settingsSaved = await settingsPage.evaluate(() => ({
    enabled: document.querySelector('#plus-closure-enabled')?.checked,
    liveEnabled: document.querySelector('#plus-closure-live-enabled')?.checked,
    requireNetwork: document.querySelector('#plus-closure-require-network')?.checked,
  }));
  await settingsPage.screenshot({ path: path.join(evidenceDir, 'settings-desktop.png'), fullPage: true });
  await settingsPage.setViewportSize({ width: 390, height: 760 });
  await settingsPage.screenshot({ path: path.join(evidenceDir, 'settings-mobile.png'), fullPage: true });
  const evidence = {
    schemaVersion: 1,
    kind: 'plus_checkout_closure_browser_fixture',
    generatedAt: new Date().toISOString(),
    closureRunId,
    ok: missing?.ok === false && selected?.selected === true && filled?.ok === true && verified?.verified === true && verified?.matchedFields === 4 &&
      Object.values(billingFieldPresence).every(Boolean) && submitted?.submitted === true && repeated?.submitted === true && submitClicks === 1 &&
      settingsDefaults.enabled === false && settingsDefaults.liveEnabled === false && settingsDefaults.requireNetwork === true && settingsSaved.enabled === true,
    missing: { ok: missing?.ok, message: missing?.message },
    selected: { ok: selected?.ok, selected: selected?.selected, last4: selected?.last4 },
    billing: {
      filled: filled?.filled,
      verified: verified?.verified,
      country: verified?.country,
      matchedFields: verified?.matchedFields,
      fieldPresence: billingFieldPresence,
      fieldValues: billingFieldValues,
    },
    submit: {
      first: submitted?.submitted, firstMessage: submitted?.message, firstError: submitted?.paymentError,
      repeated: repeated?.submitted, repeatedMessage: repeated?.message, repeatedError: repeated?.paymentError,
      firstClickCount: firstSubmitClicks, clickCount: submitClicks,
    },
    settings: { defaults: settingsDefaults, saved: settingsSaved },
    screenshots: [
      '.context-snapshots/plus-checkout-closure/checkout-desktop.png',
      '.context-snapshots/plus-checkout-closure/checkout-mobile.png',
      '.context-snapshots/plus-checkout-closure/settings-desktop.png',
      '.context-snapshots/plus-checkout-closure/settings-mobile.png',
    ],
  };
  await writeFile(path.join(evidenceDir, 'browser-fixture.latest.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(evidence, null, 2));
  if (!evidence.ok) process.exitCode = 1;
} finally {
  await context?.close().catch(() => undefined);
  await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
}

function fixtureHtml(expectedLast4) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Checkout fixture</title><style>
  body{font-family:Arial,sans-serif;margin:0;padding:24px;color:#172033;background:#f5f7fa}main{max-width:680px;margin:auto;background:white;border:1px solid #d8dee8;border-radius:6px;padding:24px}fieldset{margin:16px 0;padding:16px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}label{display:grid;gap:4px}input,select,button{font:inherit;padding:10px}button{background:#087f5b;color:white;border:0;border-radius:5px}@media(max-width:520px){body{padding:10px}main{padding:14px}.grid{grid-template-columns:1fr}}
  </style></head><body><main><h1>ChatGPT Plus</h1><div id="OrderDetails-TotalAmount">Total due <span>PHP 0.00</span></div>
  <fieldset><legend>Saved cards</legend><label id="saved-card" role="radio" aria-checked="false"><input type="radio" name="payment" value="pm_fixture">Saved Visa •••• ${expectedLast4}</label></fieldset>
  <div class="grid"><label>Name<input id="billingName"></label><label>Country<select id="billingCountry"><option value="US">United States</option></select></label><label>Address<input id="billingAddressLine1"></label><label>City<input id="billingLocality"></label><label>State<input id="billingAdministrativeArea"></label><label>Postal<input id="billingPostalCode"></label></div>
  <button data-testid="hosted-payment-submit-button" type="submit">Subscribe</button></main><script>
  window.__fixtureSubmitClicks=0;document.querySelector('#saved-card').onclick=()=>{document.querySelector('input[name=payment]').checked=true;document.querySelector('#saved-card').setAttribute('aria-checked','true')};document.querySelector('button[type=submit]').onclick=(event)=>{event.preventDefault();window.__fixtureSubmitClicks++};
  </script></body></html>`;
}
