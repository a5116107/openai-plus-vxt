import { loadAutomationState } from '../../app/state';
import type { ActionResult } from '../../app/types';
import {
  fillCurrentOpenAiBillingAddress,
  selectCurrentOpenAiSavedCard,
  submitCurrentQualifiedOpenAiCheckout,
  verifyCurrentOpenAiBillingAddress,
} from '../address-autofill/service';
import type { AddressProfile, RandomAddressResponse } from '../address-autofill/types';
import { normalizeCheckoutOptions } from '../link-extractor/checkout';
import { parseCheckoutReference } from '../link-extractor/checkout-reference';
import { readCurrentChatGptSession } from '../link-extractor/service';
import type { ChatGptSessionInfo, CheckoutLinkResponse } from '../link-extractor/types';
import { digestSavedPaymentAccountId } from '../saved-payment-methods/element-bridge';
import { loadSavedPaymentFeatureSettings, loadSavedPaymentState } from '../saved-payment-methods/state';
import type { SavedPaymentStartResponse } from '../saved-payment-methods/content-driver';
import { loadProxySettings } from '../proxy/state';
import { applyAutomationProxyStage } from '../proxy/service';
import { updateAutomationRun } from './state';
import {
  createPlusCheckoutClosureOrchestrator,
  normalizePlusCheckoutClosureSettings,
  type ClosureCheckoutEvidence,
  type ClosureNetworkEvidence,
  type ClosureSavedMethodEvidence,
  type PlusCheckoutClosureDependencies,
  type PlusCheckoutClosureRun,
  type PlusCheckoutClosureSettings,
} from './plus-checkout-closure';

const PAGE_WAIT_MS = 45_000;

type AutomationSnapshot = Awaited<ReturnType<typeof loadAutomationState>>;

interface BrowserClosureContext {
  session?: ChatGptSessionInfo;
  billingAddress?: AddressProfile;
}

export async function runPlusCheckoutClosureInBrowser(tabId: number, isCancelled: () => boolean = () => false): Promise<ActionResult> {
  const automation = await loadAutomationState();
  const settings = normalizePlusCheckoutClosureSettings(automation.settings.plusCheckoutClosure);
  if (!settings.enabled) return { ok: false, message: 'Plus 双 Checkout 闭环未启用' };

  const context: BrowserClosureContext = {};
  const checkpoint = async (run: PlusCheckoutClosureRun) => {
    await updateAutomationRun({ plusCheckoutClosure: await withBrowserEvidence(run) });
  };
  const dependencies = createBrowserClosureDependencies(tabId, automation, settings, context, isCancelled, checkpoint);
  const orchestrator = createPlusCheckoutClosureOrchestrator(dependencies, settings);

  const result = await orchestrator.run(automation.run.plusCheckoutClosure);
  const enriched = await withBrowserEvidence(result);
  const final = enforceRequiredNetworkPlanes(enriched, settings.requireVerifiedNetwork);
  await updateAutomationRun({ plusCheckoutClosure: final });
  return {
    ok: final.phase === 'subscription_verified',
    code: final.errorCode,
    message: final.message || `closure: ${final.phase}`,
    data: final,
  };
}

function createBrowserClosureDependencies(
  tabId: number,
  automation: AutomationSnapshot,
  settings: PlusCheckoutClosureSettings,
  context: BrowserClosureContext,
  isCancelled: () => boolean,
  onCheckpoint: (run: PlusCheckoutClosureRun) => Promise<void>,
): PlusCheckoutClosureDependencies {
  return {
    readSession: () => readClosureSession(tabId, context),
    createCheckout: ({ previousSessionId }) => createClosureCheckout(tabId, automation, settings, context, previousSessionId),
    saveCard: () => saveClosureCard(tabId, settings, context),
    selectSavedCard: ({ expectedLast4 }) => selectClosureSavedCard(tabId, expectedLast4),
    fillAndVerifyBilling: ({ country }) => fillClosureBilling(tabId, country, context),
    submitQualifiedCheckout: () => submitClosureCheckout(tabId, settings, context),
    verifySubscription: ({ verifyReference }) => verifyClosureSubscription(tabId, verifyReference),
    isCancelled,
    onCheckpoint,
  };
}

async function readClosureSession(tabId: number, context: BrowserClosureContext) {
  const response = await readCurrentChatGptSession(tabId);
  if (!response.ok || !response.session?.accountId || !response.session.accessToken) {
    throw new Error(response.message || 'ChatGPT session 未就绪');
  }
  context.session = response.session;
  return {
    accountDigest: await digestSavedPaymentAccountId(response.session.accountId),
    planType: response.session.planType,
  };
}

async function createClosureCheckout(
  tabId: number,
  automation: AutomationSnapshot,
  settings: PlusCheckoutClosureSettings,
  context: BrowserClosureContext,
  previousSessionId?: string,
): Promise<ClosureCheckoutEvidence> {
  const session = requireClosureSession(context);
  const options = normalizeCheckoutOptions({ ...automation.settings.checkoutOptions, region: settings.targetCountry });
  const response = await browser.runtime.sendMessage({
    type: 'opx:create-checkout-link',
    raw: session.accessToken,
    options,
    extractMode: automation.settings.checkoutExtractMode,
    creationPolicy: {
      transport: automation.settings.checkoutExtractMode === 'server' ? 'server' : 'browser-direct',
      pipeline: 'staged',
      requireZero: true,
      bootstrapCountry: settings.targetCountry,
      promotionCountry: settings.targetCountry,
      providerCountry: settings.targetCountry,
      requireVerifiedNetwork: settings.requireVerifiedNetwork,
      ...(previousSessionId ? { previousSessionId } : {}),
    },
  }) as CheckoutLinkResponse;
  const url = response.link || response.url || response.longUrl || '';
  if (!response.ok || !url || !response.checkoutSessionId) throw new Error(response.message || 'Checkout 创建失败');
  if (previousSessionId) {
    await applyAutomationProxyStage('billing', `pcc-billing-${Date.now().toString(36)}`, false, {
      reason: 'Plus closure Checkout B + billing',
    });
  }
  await navigateTab(tabId, url);
  return checkoutEvidence(response, options.planName, settings.targetCountry, settings.expectedCurrency);
}

async function saveClosureCard(
  tabId: number,
  settings: PlusCheckoutClosureSettings,
  context: BrowserClosureContext,
): ReturnType<PlusCheckoutClosureDependencies['saveCard']> {
  const session = requireClosureSession(context);
  const existing = await reconciledSavedMethod(session.accountId);
  if (existing) return { status: 'reconciled', evidence: existing };
  if (settings.liveEnabled) return { status: 'paused', message: 'SPM_LIVE_GATE_CLOSED：需先完成 SPM-16 test E2E' };
  const feature = await loadSavedPaymentFeatureSettings();
  if (!feature.enabled) return { status: 'paused', message: '请先启用测试卡保存并继续 closure' };
  if (!String((await browser.tabs.get(tabId)).url || '').startsWith('https://chatgpt.com/')) {
    await navigateTab(tabId, 'https://chatgpt.com/');
  }
  const candidates = await discoverStripeKeyCandidates(tabId);
  const publishableKey = candidates.find((key) => settings.liveEnabled ? key.startsWith('pk_live_') : key.startsWith('pk_test_'));
  if (!publishableKey) return { status: 'paused', message: '当前页面未发现可验证的 Stripe PK 候选' };
  const response = await browser.tabs.sendMessage(tabId, {
    type: 'opx:saved-payment:start',
    publishableKey,
    billingName: session.email || 'ChatGPT Customer',
    setAsDefault: true,
  }) as SavedPaymentStartResponse;
  if (!response?.ok) {
    const unknown = /SIDE_EFFECT_UNKNOWN|RETRIEVE_FAILED|NETWORK/i.test(String(response?.code || ''));
    return { status: unknown ? 'side-effect-unknown' : 'paused', message: response?.message || '保存卡流程需要用户处理' };
  }
  const saved = await reconciledSavedMethod(session.accountId, response.paymentMethodId);
  return saved
    ? { status: 'reconciled', evidence: saved }
    : { status: 'side-effect-unknown', message: 'SetupIntent 已返回，但保存卡列表复核尚未收敛' };
}

async function selectClosureSavedCard(tabId: number, expectedLast4: string) {
  await ensureCheckoutBPage(tabId);
  const result = await selectCurrentOpenAiSavedCard(expectedLast4, tabId);
  const data = record(result.data);
  return { selected: result.ok && data.selected === true, last4: result.ok ? expectedLast4 : '' };
}

async function fillClosureBilling(tabId: number, country: string, context: BrowserClosureContext) {
  await ensureCheckoutBPage(tabId);
  const address = await fetchBillingAddress(country);
  context.billingAddress = address;
  const fill = await fillCurrentOpenAiBillingAddress(address, tabId);
  if (!fill.ok) return { verified: false, country: '' };
  const verified = await verifyCurrentOpenAiBillingAddress(address, tabId);
  return { verified: verified.ok, country: verified.ok ? address.countryCode.toUpperCase() : '' };
}

async function submitClosureCheckout(
  tabId: number,
  settings: PlusCheckoutClosureSettings,
  context: BrowserClosureContext,
) {
  await ensureCheckoutBPage(tabId);
  if (!context.billingAddress) {
    const address = await fetchBillingAddress(settings.billingCountry);
    const fill = await fillCurrentOpenAiBillingAddress(address, tabId);
    const verified = fill.ok ? await verifyCurrentOpenAiBillingAddress(address, tabId) : fill;
    if (!fill.ok || !verified.ok) return { submitted: false };
    context.billingAddress = address;
  }
  const state = await loadAutomationState();
  const run = state.run.plusCheckoutClosure;
  const result = await submitCurrentQualifiedOpenAiCheckout({
    expectedLast4: run?.savedMethod?.last4 || '',
    address: context.billingAddress,
    submitKey: run?.id || `pcc-${Date.now().toString(36)}`,
    tabId,
  });
  const raw = record(result);
  return {
    submitted: result.ok && raw.submitted !== false,
    sideEffectUnknown: !result.ok && !raw.paymentError,
    verifyReference: await waitForVerifyReference(tabId, 20_000),
  };
}

async function verifyClosureSubscription(tabId: number, verifyReference: string) {
  if (verifyReference) await waitForTabSettled(tabId, 20_000).catch(() => undefined);
  let planType = '';
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await readCurrentChatGptSession(tabId);
    planType = response.session?.planType || '';
    if (response.ok && isPlusPlan(planType)) return { verified: true, planType };
    await delay(2_000);
  }
  return { verified: false, planType };
}

function requireClosureSession(context: BrowserClosureContext): ChatGptSessionInfo {
  if (!context.session) throw new Error('ChatGPT session 未就绪');
  return context.session;
}

function checkoutEvidence(response: CheckoutLinkResponse, planName: string, country: string, currency: string): ClosureCheckoutEvidence {
  const network = response.networkEvidence;
  const sourceUrl = response.canonicalUrl || response.link || response.url || response.longUrl || response.providerUrl || '';
  const reference = parseCheckoutReference(sourceUrl);
  return {
    sessionId: String(response.checkoutSessionId || ''),
    processorEntity: String(response.processorEntity || ''),
    canonicalUrl: reference?.canonicalUrl || '',
    planName,
    country: String(response.billingDetails?.country || response.requestedCountry || country).toUpperCase(),
    currency: String(response.amountCurrency || response.billingDetails?.currency || currency).toUpperCase(),
    amountMinor: response.amountMinor ?? null,
    zeroVerified: response.amountVerification === 'verified-zero' && response.amountMinor === 0,
    ...(network ? { networkEvidence: { ...network } } : {}),
  };
}

async function ensureCheckoutBPage(tabId: number): Promise<void> {
  const state = await loadAutomationState();
  const checkout = state.run.plusCheckoutClosure?.checkoutB;
  if (!checkout?.sessionId) throw new Error('Checkout B checkpoint 缺失');
  const tab = await browser.tabs.get(tabId);
  const current = parseCheckoutReference(String(tab.url || ''));
  if (current?.page === 'checkout' && current.sessionId === checkout.sessionId) return;
  if (!checkout.canonicalUrl) throw new Error('Checkout B 页面引用缺失');
  await navigateTab(tabId, checkout.canonicalUrl);
  const reopened = parseCheckoutReference(String((await browser.tabs.get(tabId)).url || ''));
  if (reopened?.page !== 'checkout' || reopened.sessionId !== checkout.sessionId) {
    throw new Error('Checkout B 页面恢复校验失败');
  }
}

export function enforceRequiredNetworkPlanes(
  run: PlusCheckoutClosureRun,
  required: boolean,
): PlusCheckoutClosureRun {
  if (!required || run.phase !== 'subscription_verified') return run;
  const verified = new Set(run.networkEvidence.filter((item) => item.verified).map((item) => item.plane));
  const missing = (['browser-auth', 'server-checkout', 'browser-billing'] as const)
    .filter((plane) => !verified.has(plane));
  if (missing.length === 0) return run;
  return {
    ...run,
    phase: 'failed_terminal',
    subscriptionVerified: false,
    errorCode: 'NETWORK_EVIDENCE_MISSING',
    message: `network evidence missing: ${missing.join(', ')}`,
    updatedAt: Date.now(),
  };
}

async function reconciledSavedMethod(accountId: string, expectedId = ''): Promise<ClosureSavedMethodEvidence | undefined> {
  const account = (await loadSavedPaymentState()).accounts[accountId];
  if (!account) return undefined;
  const method = account.paymentMethods.find((item) => item.type === 'card' && item.card?.last4 && (!expectedId || item.id === expectedId));
  if (!method?.card) return undefined;
  const attempt = account.attempts.find((item) => item.paymentMethodId === method.id && item.state === 'completed');
  if (!attempt?.attachedVerified || !attempt.reusableVerified) return undefined;
  return {
    paymentMethodDigest: await digestSavedPaymentAccountId(method.id),
    brand: method.card.brand,
    last4: method.card.last4,
    intentSucceeded: true,
    attached: attempt.attachedVerified,
    reusable: attempt.reusableVerified,
    defaultVerified: attempt.defaultVerified || account.defaultPaymentMethodId === method.id,
  };
}

async function discoverStripeKeyCandidates(tabId: number): Promise<string[]> {
  const results = await browser.scripting.executeScript({ target: { tabId, allFrames: true }, func: collectStripeKeyCandidates });
  return [...new Set(results.flatMap((item) => Array.isArray(item.result) ? item.result : []))];
}

function collectStripeKeyCandidates(): string[] {
  const sources = [
    document.documentElement?.innerHTML || '',
    ...performance.getEntriesByType('resource').map((entry) => entry.name),
    ...Array.from(document.scripts).map((script) => `${script.src} ${script.textContent || ''}`),
  ];
  return [...new Set(sources.flatMap((source) => source.match(/pk_(?:live|test)_[A-Za-z0-9_-]{8,}/g) || []))].slice(0, 12);
}

async function fetchBillingAddress(country: string): Promise<AddressProfile> {
  const response = await browser.runtime.sendMessage({ type: 'opx:fetch-random-address', countryCode: country, city: '' }) as RandomAddressResponse;
  if (!response?.ok || !response.address) throw new Error(response?.message || 'billing address 获取失败');
  return response.address;
}

async function navigateTab(tabId: number, url: string): Promise<void> {
  await browser.tabs.update(tabId, { url, active: true });
  await waitForTabSettled(tabId, PAGE_WAIT_MS);
}

async function waitForTabSettled(tabId: number, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const tab = await browser.tabs.get(tabId);
    if (tab.status === 'complete' && tab.url) return;
    await delay(150);
  }
  throw new Error('支付页加载超时');
}

async function waitForVerifyReference(tabId: number, timeoutMs: number): Promise<string> {
  const started = Date.now();
  let last = '';
  while (Date.now() - started <= timeoutMs) {
    const tab = await browser.tabs.get(tabId);
    last = String(tab.url || '');
    const reference = parseCheckoutReference(last);
    if (reference?.page === 'verify' || reference?.page === 'success') return reference.canonicalUrl;
    await delay(180);
  }
  return last;
}

async function withBrowserEvidence(run: PlusCheckoutClosureRun): Promise<PlusCheckoutClosureRun> {
  const evidence = (await loadProxySettings()).automationRouting.evidence;
  const additions: ClosureNetworkEvidence[] = [];
  for (const [stage, plane] of [['auth', 'browser-auth'], ['billing', 'browser-billing']] as const) {
    const item = evidence[stage];
    if (!item?.ip || !item.country) continue;
    additions.push({
      plane, requestId: item.cycleId, ip: item.ip, country: item.country, colo: item.colo,
      asn: item.asn || '', verified: item.verified, capturedAt: item.checkedAt,
    });
  }
  const merged = [...run.networkEvidence];
  for (const item of additions) {
    const index = merged.findIndex((current) => current.plane === item.plane && current.requestId === item.requestId);
    if (index >= 0) merged[index] = item;
    else merged.push(item);
  }
  return { ...run, networkEvidence: merged.slice(-12) };
}

function isPlusPlan(value: string): boolean {
  return /(?:^|[-_\s])plus(?:$|[-_\s])/i.test(value) || value.toLowerCase() === 'chatgptplusplan';
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' ? value as Record<string, any> : {};
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
