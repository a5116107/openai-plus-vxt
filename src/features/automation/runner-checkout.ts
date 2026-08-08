import type { BrowserTabInfo } from '../../app/active-tab';
import { loadAutomationState, saveLinkExtractorState } from '../../app/state';
import type { ActionResult } from '../../app/types';
import { DEFAULT_CHECKOUT_OPTIONS, normalizeCheckoutExtractMode, normalizeCheckoutOptions } from '../link-extractor/checkout';
import { createCheckoutLinkFromCurrentSession, readCurrentChatGptSession } from '../link-extractor/service';
import { importSessionToProbePool } from '../probe/service';
import { appendProbeHitAndMaybePersist, loadProbeState } from '../probe/state';
import type { ProbeHitRecord } from '../probe/types';
import { loadProxySettings } from '../proxy/state';
import { logRun } from '../run-log/service';
import { updateAutomationRun, appendAutomationLog } from './state';
import {
  delay,
  isRecord,
  shortUrl,
  summarizeActionData,
} from './runner-format';
import { isOpenAiCheckoutUrl } from './runner-url';
import { checkoutCurrencyFromAmount, isZeroCheckoutAmount } from './checkout-qualification';

const CHATGPT_HOME_TIMEOUT_MS = 120_000;
const PAYMENT_PAGE_LOAD_TIMEOUT_MS = 45_000;
const READ_SESSION_ATTEMPTS = 5;
const READ_SESSION_RETRY_DELAY_MS = 3_000;
const CHECKOUT_LINK_ATTEMPTS = 5;
const CHECKOUT_LINK_RETRY_DELAY_MS = 3_000;
const AUTOMATION_QUALIFICATION_TASK_ID = 'automation-checkout-qualification';

type PaymentReadyKind = 'openai-checkout' | 'paypal-account-entry' | 'paypal-email' | 'paypal-profile';

interface CheckoutStepContext {
  automationTargetTabId(): Promise<number>;
  bindAutomationTargetTab(tab: BrowserTabInfo | null, reason: string): Promise<number>;
  waitForAutomationTabUrl(predicate: (url: URL) => boolean, timeoutMs: number): Promise<URL>;
  waitForAutomationTabComplete(timeoutMs: number): Promise<ActionResult>;
  waitForChatGptHomeReady(timeoutMs: number): Promise<ActionResult>;
  waitForPaymentPageReady(kind: PaymentReadyKind, timeoutMs: number): Promise<ActionResult>;
  isStopRequested(): boolean;
}

export async function readSessionStep(context: Pick<CheckoutStepContext, 'automationTargetTabId' | 'waitForChatGptHomeReady' | 'isStopRequested'>): Promise<ActionResult> {
  await appendAutomationLog('info', '等待 ChatGPT 首页加载完成后读取 session', 'read-chatgpt-session');
  const home = await context.waitForChatGptHomeReady(CHATGPT_HOME_TIMEOUT_MS);
  if (!home.ok) {
    return home;
  }
  const debug = summarizeActionData(home.data);
  await appendAutomationLog('info', debug ? `${home.message}：${debug}` : home.message, 'read-chatgpt-session');
  const tabId = await context.automationTargetTabId();
  let lastResponse: Awaited<ReturnType<typeof readCurrentChatGptSession>> | null = null;
  for (let attempt = 1; attempt <= READ_SESSION_ATTEMPTS; attempt += 1) {
    if (context.isStopRequested()) {
      return { ok: false, message: '读取 Session 已停止' };
    }
    const response = await readCurrentChatGptSession(tabId);
    lastResponse = response;
    if (response.ok && response.session?.accessToken) {
      const state = await loadAutomationState();
      const sessionEmail = response.session.email ||
        (state.settings.registrationMode === 'phone' ? state.run.sessionEmail : '');
      await updateAutomationRun({ sessionEmail });
      const handoff = await importSessionToProbePool({
        email: sessionEmail || response.session.email || '',
        chatgptAccountId: response.session.accountId,
        tokenRaw: response.session.accessToken,
        source: 'automation',
        identitySnapshot: response.session.identitySnapshot,
      }).catch((error) => ({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }));
      if (handoff?.ok) {
        await appendAutomationLog('success', handoff.message || '已同步到撞资格探测池', 'read-chatgpt-session');
        await logRun('success', handoff.message || '注册 session 已同步探测池', {
          stage: 'account',
          code: 'HANDOFF_PROBE',
          email: sessionEmail || response.session.email || '',
          accountLabel: sessionEmail || response.session.email || 'session',
          action: '可直接启动优惠资格探测',
        }).catch(() => undefined);
      } else if (handoff?.message) {
        await appendAutomationLog('warn', `探测池同步失败：${handoff.message}`, 'read-chatgpt-session');
      }
      return {
        ok: true,
        message: attempt > 1
          ? `已读取 ChatGPT session：${sessionEmail || '未知账号'}（第 ${attempt} 次尝试成功）${handoff?.ok ? ' · 已同步探测池' : ''}`
          : `已读取 ChatGPT session：${sessionEmail || '未知账号'}${handoff?.ok ? ' · 已同步探测池' : ''}`,
      };
    }
    await appendAutomationLog('warn', `读取 Session 尝试 ${attempt}/${READ_SESSION_ATTEMPTS} 失败：${response.message}`, 'read-chatgpt-session');
    if (attempt < READ_SESSION_ATTEMPTS) {
      await delay(READ_SESSION_RETRY_DELAY_MS);
    }
  }
  return {
    ok: false,
    message: `读取 Session 重试 ${READ_SESSION_ATTEMPTS} 次后失败：${lastResponse?.message || '未读取到登录 session'}`,
  };
}

export async function createCheckoutLinkStep(context: Pick<CheckoutStepContext, 'automationTargetTabId' | 'isStopRequested'>): Promise<ActionResult> {
  const state = await loadAutomationState();
  const checkoutOptions = normalizeCheckoutOptions({
    ...DEFAULT_CHECKOUT_OPTIONS,
    ...state.settings.checkoutOptions,
  });
  const tabId = await context.automationTargetTabId();
  await saveLinkExtractorState({
    checkoutOptions,
    checkoutExtractMode: normalizeCheckoutExtractMode(state.settings.checkoutExtractMode),
  });
  let lastMessage = '生成订阅链接失败';
  for (let attempt = 1; attempt <= CHECKOUT_LINK_ATTEMPTS; attempt += 1) {
    if (context.isStopRequested()) {
      return { ok: false, message: '生成订阅链接已停止' };
    }
    try {
      const response = await createCheckoutLinkFromCurrentSession(tabId);
      const link = response.link || response.url || '';
      if (response.ok && link) {
        await updateAutomationRun({ checkoutUrl: link });
        return {
          ok: true,
          message: attempt > 1
            ? `订阅链接已生成：${shortUrl(link)}（第 ${attempt} 次尝试成功）`
            : `订阅链接已生成：${shortUrl(link)}`,
          url: link,
        };
      }
      lastMessage = response.message || '生成订阅链接失败';
    } catch (error) {
      lastMessage = error instanceof Error ? error.message : String(error);
    }
    await appendAutomationLog('warn', `生成订阅链接尝试 ${attempt}/${CHECKOUT_LINK_ATTEMPTS} 失败：${lastMessage}`, 'create-checkout-link');
    if (attempt < CHECKOUT_LINK_ATTEMPTS) {
      await delay(CHECKOUT_LINK_RETRY_DELAY_MS);
    }
  }
  return {
    ok: false,
    message: `生成订阅链接重试 ${CHECKOUT_LINK_ATTEMPTS} 次后失败：${lastMessage}`,
  };
}

export async function openCheckoutLinkStep(context: CheckoutStepContext): Promise<ActionResult> {
  const state = await loadAutomationState();
  const url = state.run.checkoutUrl;
  if (!url) {
    return { ok: false, message: '没有可打开的订阅链接，请先执行“提取订阅链接”' };
  }
  if (state.settings.autoOpenCheckout) {
    const tab = await browser.tabs.create({ url, active: true });
    await context.bindAutomationTargetTab(tab, '打开订阅链接');
    await context.waitForAutomationTabUrl((currentUrl) => isOpenAiCheckoutUrl(currentUrl), 30_000);
    await context.waitForAutomationTabComplete(PAYMENT_PAGE_LOAD_TIMEOUT_MS);
    const ready = await context.waitForPaymentPageReady('openai-checkout', 45_000);
    return { ok: ready.ok, message: ready.ok ? '已打开 OpenAI 订阅页' : ready.message, data: ready.data };
  }
  return { ok: true, message: '已生成订阅链接，设置为不自动打开' };
}

export async function captureAutomationCheckoutQualification(data: unknown): Promise<ActionResult | null> {
  const amountText = isRecord(data) ? String(data.amountText || '').trim() : '';
  if (!isZeroCheckoutAmount(amountText)) {
    return null;
  }

  const state = await loadAutomationState();
  const link = state.run.checkoutUrl.trim();
  if (!link) {
    return { ok: false, message: `检测到 ${amountText}，但当前运行没有可保存的 Checkout 链接` };
  }

  const email = (state.run.sessionEmail || currentAutomationEmail(state)).trim().toLowerCase();
  const [probe, proxy] = await Promise.all([loadProbeState(), loadProxySettings()]);
  const account = probe.accounts.find((item) => item.email.trim().toLowerCase() === email);
  const checkoutExit = proxy.automationRouting.evidence.checkout;
  const billingExit = proxy.automationRouting.evidence.billing;
  const country = String(checkoutExit?.country || billingExit?.country || state.settings.checkoutOptions.region || '').toUpperCase();
  const now = Date.now();
  const exitSummary = [
    checkoutExit?.verified ? `Checkout=${checkoutExit.country || '?'} ${checkoutExit.ip || '?'}` : '',
    billingExit?.verified ? `Billing=${billingExit.country || '?'} ${billingExit.ip || '?'}` : '',
  ].filter(Boolean).join(' · ');
  const message = `自动化检测到 0 元资格：${amountText}${exitSummary ? ` · ${exitSummary}` : ''}`;
  const hit: ProbeHitRecord = {
    id: `automation-hit-${now}-${Math.random().toString(36).slice(2, 8)}`,
    taskId: AUTOMATION_QUALIFICATION_TASK_ID,
    accountId: account?.id || email || `automation-${now}`,
    email,
    country,
    currency: checkoutCurrencyFromAmount(amountText),
    planName: state.settings.checkoutOptions.planName === 'chatgptteamplan' ? 'chatgptteamplan' : 'chatgptplusplan',
    ok: true,
    hitKind: 'zero',
    message,
    link,
    longUrl: link,
    shortUrl: '',
    channels: ['hosted'],
    amountHint: amountText,
    promoHint: '0 元资格',
    createdAt: now,
    rawKeys: isRecord(data) ? Object.keys(data) : [],
    sniff: {
      checked: true,
      ok: true,
      amountText,
      trialText: '0 元资格',
      zeroLikely: true,
      trialLikely: true,
      pageUrl: link,
      message,
      checkedAt: now,
    },
    note: exitSummary,
  };
  const persisted = await appendProbeHitAndMaybePersist(hit, {
    saveToDb: true,
    taskName: '智能自动化资格采集',
  });
  const stored = persisted.hit;
  return {
    ok: true,
    message: `检测到 ${amountText}，资格链接已保存到命中数据库`,
    url: link,
    data: {
      qualificationCaptured: true,
      paymentRequired: false,
      hitKind: stored.hitKind,
      hitId: stored.id,
      dbId: stored.dbId || '',
      amountText,
      country,
      currency: hit.currency,
      checkoutExitCountry: checkoutExit?.country || '',
      checkoutExitIp: checkoutExit?.ip || '',
      billingExitCountry: billingExit?.country || '',
      billingExitIp: billingExit?.ip || '',
    },
  };
}

function currentAutomationEmail(state: Awaited<ReturnType<typeof loadAutomationState>>): string {
  return state.emails.find((item) => item.id === state.run.selectedEmailId)?.email || '';
}
