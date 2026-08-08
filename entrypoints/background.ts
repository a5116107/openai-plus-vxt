import { fetchRandomAddress } from '../src/features/address-autofill/address-source';
import { PAGE_ACTION } from '../src/app/page-actions';
import type { ActionResult } from '../src/app/types';
import type { RandomAddressMessage } from '../src/features/address-autofill/types';
import { loadAutomationState, loadOAuthState, saveOAuthState } from '../src/app/state';
import { sendTabMessage } from '../src/app/active-tab';
import {
  createCheckoutLinkWithPolicy,
  normalizeCheckoutCreationPolicy,
} from '../src/features/link-extractor/checkout';
import { fetchChatGptSession } from '../src/features/link-extractor/session';
import type {
  ChatGptSessionMessage,
  ChatGptSessionResponse,
  CheckoutLinkMessage,
  CheckoutLinkResponse,
  CheckoutIdentitySnapshot,
} from '../src/features/link-extractor/types';
import { createCpaJson, createCredentialsFromChatGptSession, createSub2ApiJson } from '../src/features/oauth/export';
import { createOAuthSession, exchangeOAuthCode, OAuthTokenExchangeError, parseOAuthCallbackUrl } from '../src/features/oauth/oauth';
import type {
  OAuthCreateSessionMessage,
  OAuthExchangeMessage,
  OAuthPhoneCancelMessage,
  OAuthPhoneStartMessage,
  OAuthGenerateFromSessionMessage,
  OAuthResultResponse,
} from '../src/features/oauth/types';
import { countryIdToIso } from '../src/features/oauth-phone/country-map';
import {
  DEFAULT_OPENAI_PHONE_CHANNEL_SUPPORT,
  formatOpenAiPhoneChannelLabel,
  isOpenAiPhoneSmsFirst,
  resolveOpenAiPhoneCountrySupport,
  resolveOpenAiPhoneOfferCountryIso,
  type OpenAiPhoneChannelSupportSnapshot,
} from '../src/features/oauth-phone/openai-channel-support';
import { createOAuthPhoneProvider } from '../src/features/oauth-phone/providers';
import { selectOAuthPhoneOfferForRuntime } from '../src/features/oauth-phone/service';
import { appendAutomationLog } from '../src/features/automation/state';
import {
  getAuthNetworkResult,
  installAuthNetworkObserver,
  isAuthNetworkResultRequest,
} from '../src/features/automation/auth-network-observer';
import {
  loadOAuthPhoneSettings,
  saveOAuthPhoneSettings,
  trackedOrderId,
  updateOAuthPhoneTrackedOrder,
  upsertOAuthPhoneOrder,
} from '../src/features/oauth-phone/state';
import type {
  OAuthPhoneApiTarget,
  OAuthPhoneOrder,
  OAuthPhoneProviderSettings,
  OAuthPhoneSelectedOffer,
  OAuthPhoneTrackedOrder,
} from '../src/features/oauth-phone/types';
import { extractSmsPayload } from '../src/features/sms/parser';
import type {
  OutlookApiCheckMessage,
  OutlookOtpCancelMessage,
  OutlookOtpMessage,
  OutlookOtpResponse,
} from '../src/features/register/types';
import {
  DEFAULT_ACICA_MAILBOX_SETTINGS,
  extractEmailFromAccountLine,
  normalizeAcicaMailboxSettings,
  pollAcicaOtp,
  pollMailboxUrlOtp,
  syncAcicaEmailPool,
  type AcicaMailboxSettings,
} from '../src/features/mailbox/acica';
import type {
  AutomationFinishCleanupMessage,
  AutomationFinishCleanupResponse,
  ClearDomainCookiesMessage,
  ClearDomainCookiesResponse,
  CookieClearTarget,
} from '../src/features/settings/types';
import type { SmsRelayFetchMessage, SmsRelayFetchResponse } from '../src/features/sms/types';

import {
  applyProxyStage,
  applyAutomationProxyStage,
  clearProxyStage,
  getProxyRuntimeStatus,
  saveAndMaybeApplyProxy,
} from '../src/features/proxy/service';
import type {
  ProxyApplyRequest,
  ProxyAutomationStageRequest,
  ProxyClearRequest,
  ProxySaveRequest,
  ProxyStatusRequest,
} from '../src/features/proxy/types';

import {
  applyProbeAccountAction,
  clearProbeHits,
  controlProbe,
  deleteProbeHitDatabaseRecord,
  deleteProbeTask,
  exportProbeHitDatabase,
  exportProbeFactorAnalysis,
  exportProbeMethodDetections,
  queryProbeMethodDetections,
  clearProbeMethodDetections,
  getProbeAccountReport,
  queryProbeFactorAnalysis,
  clearProbeFactorAnalysis,
  importProbeFactorObservations,
  getProbeStateResponse,
  handleProbeAlarm,
  ensureSmartProbeBootstrap,
  importSessionToProbePool,
  queryProbeHitDatabase,
  saveProbeAccounts,
  upsertProbeTask,
} from '../src/features/probe/service';
import {
  handleRunLogAppend,
  handleRunLogClear,
  handleRunLogExport,
  handleRunLogList,
} from '../src/features/run-log/service';
import type {
  RunLogAppendMessage,
  RunLogClearMessage,
  RunLogExportMessage,
  RunLogListMessage,
} from '../src/features/run-log/types';
import type {
  ProbeAccountActionMessage,
  ProbeAccountReportMessage,
  ProbeClearHitsMessage,
  ProbeControlMessage,
  ProbeDeleteTaskMessage,
  ProbeHitDbDeleteMessage,
  ProbeHitDbExportMessage,
  ProbeMethodsQueryMessage,
  ProbeMethodsExportMessage,
  ProbeMethodsClearMessage,
  ProbeHitDbQueryMessage,
  ProbeFactorQueryMessage,
  ProbeFactorExportMessage,
  ProbeFactorClearMessage,
  ProbeFactorImportMessage,
  ProbeSaveAccountsMessage,
  ProbeStateMessage,
  ProbeUpsertTaskMessage,
} from '../src/features/probe/types';

type MessageSenderLike = {
  tab?: {
    id?: number;
  };
};

const DEFAULT_OUTLOOK_API_BASE = 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_INTERVAL_MS = 5_000;
const OUTLOOK_OTP_FETCH_LIMIT = 3;
const OUTLOOK_OTP_QUERY = '';
const CONTENT_DRIVER_SCRIPT_FILE = '/content-scripts/content.js';
const CONTENT_DRIVER_URL_PREFIXES = [
  'https://chatgpt.com/',
  'https://auth.openai.com/',
  'https://pay.openai.com/',
  'https://www.paypal.com/',
  'https://paypal.com/',
  'http://localhost:1455/',
  'http://127.0.0.1:1455/',
];
const COOKIE_CLEAR_DOMAINS: Record<CookieClearTarget, string[]> = {
  paypal: ['paypal.com'],
  chatgpt: ['chatgpt.com', 'openai.com'],
};
const outlookOtpAborters = new Map<string, AbortController>();
const oauthExchangeLocks = new Map<string, Promise<OAuthResultResponse>>();
let oauthPhoneAborter: AbortController | null = null;

export default defineBackground(() => {
  configureSidePanel();
  installActionSidePanelFallback();
  installContentDriverInjector();
  installOAuthCallbackWatcher();
  installProbeAlarmListener();
  installAuthNetworkObserver();

  browser.runtime.onMessage.addListener((message: unknown, sender) => {
    if (isAuthNetworkResultRequest(message)) {
      return getAuthNetworkResult(message);
    }
    if (isOutlookOtpMessage(message)) {
      return waitForOutlookOtp(message);
    }
    if (isAcicaSyncEmailsMessage(message)) {
      return handleAcicaSyncEmails(message);
    }
    if (isAcicaOtpMessage(message)) {
      return waitForAcicaOtp(message);
    }
    if (isTrustedFillEmailMessage(message)) {
      return trustedFillEmail(message);
    }
    if (isTrustedFillOtpMessage(message)) {
      return trustedFillOtp(message);
    }
    if (isOutlookOtpCancelMessage(message)) {
      return cancelOutlookOtp(message);
    }
    if (isOutlookApiCheckMessage(message)) {
      return checkOutlookApi(message);
    }
    if (isOAuthCreateSessionMessage(message)) {
      return createOpenAiOAuthSession(message);
    }
    if (isOAuthExchangeMessage(message)) {
      return exchangeCurrentOAuthCodeForMessage(message);
    }
    if (isOAuthGenerateFromSessionMessage(message)) {
      return generateOAuthFilesFromCurrentSession(message);
    }
    if (isOAuthPhoneStartMessage(message)) {
      return startOAuthPhoneVerification(message, sender.tab?.id);
    }
    if (isOAuthPhoneCancelMessage(message)) {
      return cancelOAuthPhoneVerification();
    }

    if (isCheckoutLinkMessage(message)) {
      return createCheckoutLinkByMode(message);
    }
    if (isChatGptSessionMessage(message)) {
      return fetchChatGptSessionForSender(message, sender);
    }
    if (isRandomAddressMessage(message)) {
      return fetchRandomAddress(message.countryCode, message.city);
    }
    if (isSmsRelayFetchMessage(message)) {
      return fetchSmsRelay(message.url);
    }
    if (isClearDomainCookiesMessage(message)) {
      return clearDomainCookies(message.target);
    }
    if (isAutomationFinishCleanupMessage(message)) {
      return finishAutomationCleanup(message);
    }
    if (isProxyApplyMessage(message)) {
      return applyProxyStage(message.stage);
    }
    if (isProxyAutomationStageMessage(message)) {
      return applyAutomationProxyStage(message.stage, message.cycleId, Boolean(message.forceRotate), {
        excludeIps: message.excludeIps,
        requireDifferentIp: message.requireDifferentIp,
        reason: message.reason,
      });
    }
    if (isProxyClearMessage(message)) {
      return clearProxyStage();
    }
    if (isProxyStatusMessage(message)) {
      return getProxyRuntimeStatus();
    }
    if (isProxySaveMessage(message)) {
      return saveAndMaybeApplyProxy(message.settings || {}, message.applyStage);
    }
    if (isProbeSaveAccountsMessage(message)) {
      return saveProbeAccounts(message.rawAccounts || '');
    }
    if (isProbeSyncCurrentSessionMessage(message)) {
      return syncCurrentChatGptSessionToProbePool();
    }
    if (isProbeUpsertTaskMessage(message)) {
      return upsertProbeTask({ id: message.task?.id, config: message.task.config });
    }
    if (isProbeDeleteTaskMessage(message)) {
      return deleteProbeTask(message.taskId);
    }
    if (isProbeControlMessage(message)) {
      return controlProbe(message.action, message.taskId);
    }
    if (isProbeClearHitsMessage(message)) {
      return clearProbeHits(message.scope || 'all');
    }
    if (isProbeHitDbQueryMessage(message)) {
      return queryProbeHitDatabase(message.filter || {});
    }
    if (isProbeHitDbDeleteMessage(message)) {
      return deleteProbeHitDatabaseRecord(message.dbId);
    }
    if (isProbeHitDbExportMessage(message)) {
      return exportProbeHitDatabase(message.filter || {});
    }
    if (isProbeMethodsQueryMessage(message)) {
    return queryProbeMethodDetections();
  }
  if (isProbeMethodsExportMessage(message)) {
    return exportProbeMethodDetections();
  }
  if (isProbeMethodsClearMessage(message)) {
    return clearProbeMethodDetections();
  }
    if (isProbeAccountReportMessage(message)) {
      return getProbeAccountReport();
    }
    if (isProbeAccountActionMessage(message)) {
      return applyProbeAccountAction(message.action, message.accountIds);
    }
    if (isProbeFactorQueryMessage(message)) {
      return queryProbeFactorAnalysis();
    }
    if (isProbeFactorExportMessage(message)) {
      return exportProbeFactorAnalysis(message.format || 'json');
    }
    if (isProbeFactorClearMessage(message)) {
      return clearProbeFactorAnalysis();
    }
    if (isProbeFactorImportMessage(message)) {
      return importProbeFactorObservations(message.text, message.format || 'auto', message.mode || 'merge');
    }
    if (isRunLogListMessage(message)) {
    return handleRunLogList({ limit: message.limit, accountId: message.accountId, level: message.level });
  }
  if (isRunLogAppendMessage(message)) {
    return handleRunLogAppend(message.event);
  }
  if (isRunLogClearMessage(message)) {
    return handleRunLogClear();
  }
  if (isRunLogExportMessage(message)) {
    return handleRunLogExport(message.format || 'csv');
  }
  if (isProbeStateMessage(message)) {
      return getProbeStateResponse();
    }
    if (isProbeSmartStartMessage(message)) {
      return ensureSmartProbeBootstrap({
        runHealthCheck: message.runHealthCheck !== false,
        startScheduled: Boolean(message.startScheduled),
        runOnce: message.runOnce !== false && !message.startScheduled,
      });
    }
    if (isProbeImportSessionMessage(message)) {
      return importSessionToProbePool({
        email: message.email,
        chatgptAccountId: message.chatgptAccountId,
        tokenRaw: message.tokenRaw,
        source: message.source === 'automation' ? 'automation' : 'session',
        identitySnapshot: message.identitySnapshot,
      });
    }
    return undefined;
  });
});

function configureSidePanel(): void {
  const sidePanel = getNativeSidePanelApi();
  if (!sidePanel?.setPanelBehavior) {
    console.debug('[OPX] side panel behavior setup skipped: sidePanel API unavailable');
    return;
  }
  try {
    void Promise.resolve(sidePanel.setPanelBehavior({ openPanelOnActionClick: true })).catch((error) => {
      console.debug('[OPX] side panel behavior setup skipped', error);
    });
  } catch (error) {
    console.debug('[OPX] side panel behavior setup skipped', error);
  }
}

function installActionSidePanelFallback(): void {
  const action = getNativeActionApi();
  if (!action?.onClicked?.addListener) {
    return;
  }
  action.onClicked.addListener((tab) => {
    void openSidePanel(tab);
  });
}

async function openSidePanel(tab: ChromeTab): Promise<void> {
  // 1) Chrome sidePanel API
  const sidePanel = getNativeSidePanelApi();
  if (sidePanel?.open) {
    const options: SidePanelOpenOptions = {};
    if (typeof tab.windowId === 'number') {
      options.windowId = tab.windowId;
    } else if (typeof tab.id === 'number') {
      options.tabId = tab.id;
    }
    if (options.windowId !== undefined || options.tabId !== undefined) {
      try {
        await sidePanel.open(options);
        return;
      } catch (error) {
        console.debug('[OPX] side panel open skipped', error);
      }
    }
  }

  // 2) Firefox/Mullvad sidebarAction
  const sidebarAction = getNativeSidebarActionApi();
  if (sidebarAction?.open) {
    try {
      await Promise.resolve(sidebarAction.open());
      return;
    } catch (error) {
      console.debug('[OPX] sidebarAction open skipped', error);
    }
  }

  // 3) Final fallback: open settings page as tab (always visible)
  try {
    const url = browser.runtime.getURL('/automation-settings.html');
    await browser.tabs.create({
      url,
      active: true,
      ...(typeof tab.windowId === 'number' ? { windowId: tab.windowId } : {}),
    });
  } catch (error) {
    console.debug('[OPX] open automation-settings fallback failed', error);
  }
}

function getNativeSidePanelApi(): NativeSidePanelApi | undefined {
  return getNativeChromeApi().chrome?.sidePanel;
}

function getNativeActionApi(): NativeActionApi | undefined {
  const root = getNativeChromeApi();
  return root.chrome?.action
    || root.browser?.action
    || root.browser?.browserAction
    || root.chrome?.browserAction;
}

function getNativeSidebarActionApi(): NativeSidebarActionApi | undefined {
  const root = getNativeChromeApi();
  return root.browser?.sidebarAction
    || root.chrome?.sidebarAction
    || (browser as typeof browser & { sidebarAction?: NativeSidebarActionApi }).sidebarAction;
}

function getNativeChromeApi(): NativeChromeRoot {
  return globalThis as typeof globalThis & NativeChromeRoot;
}

async function clearDomainCookies(target: CookieClearTarget): Promise<ClearDomainCookiesResponse> {
  const domains = COOKIE_CLEAR_DOMAINS[target];
  let removed = 0;
  let failed = 0;
  const seen = new Set<string>();

  for (const domain of domains) {
    const cookies = await listDomainCookiesForClear(domain);
    for (const cookie of cookies) {
      const key = cookieIdentityKey(cookie);
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        await removeCookieCompatible(cookie);
        removed += 1;
      } catch (error) {
        failed += 1;
        console.debug('[OPX] cookie remove failed', {
          target,
          domain: cookie.domain,
          name: cookie.name,
          firstPartyDomain: (cookie as Browser.cookies.Cookie & { firstPartyDomain?: string }).firstPartyDomain || '',
          error,
        });
      }
    }
  }

  if (removed === 0 || failed > 0) {
    const fallback = await clearDomainsViaBrowsingData(domains).catch((error) => {
      console.debug('[OPX] browsingData cookie fallback failed', error);
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    });
    if (fallback.ok) {
      const label = target === 'paypal' ? 'PayPal' : 'ChatGPT/OpenAI';
      return {
        ok: true,
        target,
        domains,
        removed: Math.max(removed, 1),
        failed: 0,
        message: label + ' cookie 已通过兼容清理完成（FPI/browsingData）· 精确删除 ' + removed + ' 个',
      };
    }
  }

  const label = target === 'paypal' ? 'PayPal' : 'ChatGPT/OpenAI';
  if (failed > 0 && removed === 0) {
    return {
      ok: false,
      target,
      domains,
      removed,
      failed,
      message: label + ' cookie 清理失败（可能是 First-Party Isolation）：精确删除 0，失败 ' + failed,
    };
  }
  if (failed > 0) {
    return {
      ok: true,
      target,
      domains,
      removed,
      failed,
      message: label + ' 已清除 ' + removed + ' 个 cookie（' + failed + ' 个跳过，已尽量兼容 FPI）',
    };
  }
  return {
    ok: true,
    target,
    domains,
    removed,
    failed,
    message: label + ' 已清除 ' + removed + ' 个 cookie',
  };
}

function cookieIdentityKey(cookie: Browser.cookies.Cookie): string {
  const c = cookie as Browser.cookies.Cookie & { firstPartyDomain?: string; partitionKey?: unknown };
  return [c.name, c.domain, c.path, c.storeId || '', c.firstPartyDomain || '', JSON.stringify(c.partitionKey || null)].join('|');
}

async function listDomainCookiesForClear(domain: string): Promise<Browser.cookies.Cookie[]> {
  const variants: Array<Record<string, unknown>> = [
    { domain, firstPartyDomain: '' },
    { domain },
  ];
  for (const host of ['chatgpt.com', 'openai.com', 'pay.openai.com', 'auth.openai.com', 'paypal.com', 'www.paypal.com']) {
    if (host === domain || host.endsWith('.' + domain) || domain.endsWith(host)) {
      variants.push({ domain, firstPartyDomain: host });
      variants.push({ firstPartyDomain: host });
    }
  }

  const all: Browser.cookies.Cookie[] = [];
  for (const query of variants) {
    try {
      const batch = await browser.cookies.getAll(query as any);
      for (const cookie of batch) {
        const host = String(cookie.domain || '').replace(/^\./, '');
        if (host === domain || host.endsWith('.' + domain) || domain.endsWith(host)) {
          all.push(cookie);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/firstPartyDomain/i.test(message) && !Object.prototype.hasOwnProperty.call(query, 'firstPartyDomain')) {
        try {
          const batch = await browser.cookies.getAll({ ...(query as object), firstPartyDomain: '' } as any);
          all.push(...batch);
        } catch (retryError) {
          console.debug('[OPX] cookies.getAll FPI retry failed', { domain, query, retryError });
        }
      } else {
        console.debug('[OPX] cookies.getAll failed', { domain, query, error });
      }
    }
  }
  return all;
}

async function removeCookieCompatible(cookie: Browser.cookies.Cookie): Promise<void> {
  const c = cookie as Browser.cookies.Cookie & { firstPartyDomain?: string; partitionKey?: unknown };
  const base: Record<string, unknown> = {
    name: cookie.name,
    storeId: cookie.storeId,
    url: cookieUrl(cookie),
  };
  if (c.partitionKey) base.partitionKey = c.partitionKey;

  const attempts: Array<Record<string, unknown>> = [
    { ...base, firstPartyDomain: typeof c.firstPartyDomain === 'string' ? c.firstPartyDomain : '' },
    { ...base, firstPartyDomain: '' },
    { ...base },
  ];

  let lastError: unknown;
  for (const details of attempts) {
    try {
      await browser.cookies.remove(details as any);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'cookie remove failed'));
}

async function clearDomainsViaBrowsingData(domains: string[]): Promise<{ ok: boolean; message: string }> {
  const browsingData = (browser as typeof browser & {
    browsingData?: {
      remove?: (options: Record<string, unknown>, dataToRemove: Record<string, unknown>) => Promise<void>;
    };
  }).browsingData;
  if (!browsingData?.remove) {
    return { ok: false, message: 'browsingData API unavailable' };
  }
  const hostnames = [...new Set(domains.flatMap((domain) => {
    const root = domain.replace(/^\./, '');
    return [root, 'www.' + root];
  }))];
  try {
    await browsingData.remove({ hostnames, since: 0 }, { cookies: true });
    return { ok: true, message: 'browsingData removed cookies for ' + hostnames.join(',') };
  } catch (error) {
    try {
      await browsingData.remove({ since: 0 }, { cookies: true });
      return { ok: true, message: 'browsingData removed all cookies (broad fallback)' };
    } catch (broadError) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(broadError || error),
      };
    }
  }
}

async function finishAutomationCleanup(message: AutomationFinishCleanupMessage): Promise<AutomationFinishCleanupResponse> {
  const cookieTargets = normalizeCleanupCookieTargets(message.cookieTargets);
  const cookieResults: ClearDomainCookiesResponse[] = [];
  for (const target of cookieTargets) {
    cookieResults.push(await clearDomainCookies(target));
  }

  const closeTabsScheduled = message.closeTabs !== false;
  if (closeTabsScheduled) {
    const windowId = Number.isFinite(message.windowId) ? message.windowId : undefined;
    const delayMs = Number.isFinite(message.closeDelayMs) ? Math.max(0, Number(message.closeDelayMs)) : 3000;
    globalThis.setTimeout(() => {
      void closeWindowTabsKeepingOne(windowId).catch((error) => {
        console.debug('[OPX] automation cleanup close tabs failed', error);
      });
    }, delayMs);
  }

  const failed = cookieResults.filter((result) => !result.ok);
  const removed = cookieResults.reduce((total, result) => total + result.removed, 0);
  return {
    ok: failed.length === 0,
    cookieResults,
    closeTabsScheduled,
    message: `已清除 ${removed} 个相关 cookie${closeTabsScheduled ? '，标签页将在几秒后关闭' : ''}`,
  };
}

function normalizeCleanupCookieTargets(value: unknown): CookieClearTarget[] {
  const targets = Array.isArray(value) ? value : [];
  const normalized = targets.filter((target): target is CookieClearTarget => target === 'paypal' || target === 'chatgpt');
  return normalized.length ? [...new Set(normalized)] : ['paypal', 'chatgpt'];
}

async function closeWindowTabsKeepingOne(windowId?: number): Promise<void> {
  const targetWindowId = await resolveCleanupWindowId(windowId);
  const blank = await browser.tabs.create({
    url: 'about:blank',
    active: true,
    ...(typeof targetWindowId === 'number' ? { windowId: targetWindowId } : {}),
  });
  if (typeof blank.id !== 'number' || typeof blank.windowId !== 'number') {
    return;
  }

  const tabs = await browser.tabs.query({ windowId: blank.windowId });
  const removableIds = tabs
    .map((tab) => tab.id)
    .filter((id): id is number => typeof id === 'number' && id !== blank.id);
  if (removableIds.length) {
    await browser.tabs.remove(removableIds);
  }
}

async function resolveCleanupWindowId(windowId?: number): Promise<number | undefined> {
  if (typeof windowId === 'number' && Number.isFinite(windowId)) {
    return windowId;
  }
  const activeTabs = await browser.tabs.query({ active: true, currentWindow: true });
  const activeWindowId = activeTabs.find((tab) => typeof tab.windowId === 'number')?.windowId;
  return typeof activeWindowId === 'number' ? activeWindowId : undefined;
}

function cookieUrl(cookie: Browser.cookies.Cookie): string {
  const domain = cookie.domain.replace(/^\./, '');
  const protocol = cookie.secure ? 'https:' : 'http:';
  const path = cookie.path.startsWith('/') ? cookie.path : `/${cookie.path}`;
  return `${protocol}//${domain}${path}`;
}

async function createCheckoutLinkByMode(message: CheckoutLinkMessage): Promise<CheckoutLinkResponse> {
  const creationPolicy = normalizeCheckoutCreationPolicy({
    ...message.creationPolicy,
    transport: message.creationPolicy?.transport || (message.extractMode === 'server' ? 'server' : 'browser-direct'),
  }, message.options);
  return createCheckoutLinkWithPolicy(message.raw, message.options, creationPolicy);
}

async function fetchChatGptSessionForSender(
  message: ChatGptSessionMessage,
  sender: MessageSenderLike,
): Promise<ChatGptSessionResponse> {
  const tabId = typeof message.tabId === 'number' ? message.tabId : sender.tab?.id;
  if (typeof tabId !== 'number') {
    return fetchChatGptSession();
  }

  try {
    const results = await browser.scripting.executeScript({
      target: { tabId },
      func: fetchChatGptSessionInTab,
    });
    const response = results[0]?.result;
    if (isChatGptSessionResponse(response)) {
      return response;
    }
    return {
      ok: false,
      message: '当前标签页返回的 ChatGPT session 结果无效',
    };
  } catch (error) {
    return {
      ok: false,
      message: `无法在当前标签页读取 ChatGPT session：${String(error)}`,
    };
  }
}

async function syncCurrentChatGptSessionToProbePool() {
  const response = await fetchChatGptSession();
  if (!response.ok || !response.session?.accessToken) {
    const current = await getProbeStateResponse();
    return {
      ok: false,
      message: `当前 ChatGPT 登录会话同步失败：${response.message}`,
      state: current.state,
    };
  }
  const imported = await importSessionToProbePool({
    email: response.session.email,
    chatgptAccountId: response.session.accountId,
    tokenRaw: response.session.accessToken,
    source: 'session',
    identitySnapshot: response.session.identitySnapshot,
  });
  const cookieCount = response.session.identitySnapshot?.cookies?.length || 0;
  return {
    ...imported,
    message: imported.ok
      ? `已同步当前 ChatGPT 登录会话，身份 Cookie ${cookieCount} 个`
      : imported.message,
  };
}

async function fetchChatGptSessionInTab(): Promise<ChatGptSessionResponse> {
  const sessionUrl = 'https://chatgpt.com/api/auth/session';
  let response: Response;
  try {
    response = await fetch(sessionUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'include',
      cache: 'no-store',
    });
  } catch (error) {
    return fail(`无法请求 ChatGPT session：${String(error)}`);
  }

  const text = await response.text();
  const data = parseJson(text);
  if (!response.ok) {
    return fail(`ChatGPT session HTTP ${response.status}：${shorten(text || response.statusText)}`);
  }

  if (!isRecord(data)) {
    return fail('ChatGPT session 响应不是 JSON 对象');
  }

  const session = extractSessionInfo(data);
  if (!session.accessToken) {
    return {
      ok: false,
      message: session.email ? '已读取账号信息，但 session 内没有 accessToken' : '未读取到登录 session',
      session,
    };
  }

  return {
    ok: true,
    message: '已从当前标签页读取 ChatGPT session',
    session,
  };

  function extractSessionInfo(data: Record<string, unknown>) {
    const user = isRecord(data.user) ? data.user : {};
    const account = isRecord(data.account) ? data.account : {};
    return {
      email: stringValue(user.email),
      planType: stringValue(account.planType) || stringValue(account.plan_type),
      accessToken: stringValue(data.accessToken),
      sessionToken: stringValue(data.sessionToken) || stringValue(data.session_token),
      accountId: stringValue(account.id) || stringValue(account.accountId) || stringValue(account.account_id),
      userId: stringValue(user.id) || stringValue(user.userId) || stringValue(user.user_id),
      expiresAt: stringValue(data.expires) || stringValue(data.expiresAt) || stringValue(data.expires_at),
      fetchedAt: Date.now(),
    };
  }

  function parseJson(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }

  function stringValue(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  function fail(message: string) {
    return { ok: false, message };
  }

  function shorten(text: string, limit = 400): string {
    return String(text || '').replace(/\s+/g, ' ').slice(0, limit);
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object');
  }
}

function installContentDriverInjector(): void {
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'complete' || !isContentDriverUrl(tab.url)) {
      return;
    }
    setTimeout(() => void injectContentDriver(tabId), 300);
  });

  void browser.tabs.query({}).then((tabs) => {
    for (const tab of tabs) {
      if (typeof tab.id === 'number' && isContentDriverUrl(tab.url)) {
        void injectContentDriver(tab.id);
      }
    }
  }).catch((error) => {
    console.debug('[OPX] initial content driver injection skipped', error);
  });
}

function installOAuthCallbackWatcher(): void {
  browser.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    const url = changeInfo.url || tab.url || '';
    if (isOAuthCallbackUrl(url)) {
      void handleOAuthCallback(url);
      return;
    }
    if (isOAuthAddPhoneUrl(url)) {
      void handleOAuthAddPhone(url);
    }
  });

  void browser.tabs.query({}).then((tabs) => {
    for (const tab of tabs) {
      if (isOAuthAddPhoneUrl(tab.url)) {
        void handleOAuthAddPhone(tab.url || '');
      }
    }
  }).catch((error) => {
    console.debug('[OPX] initial OAuth add-phone check skipped', error);
  });
}

async function injectContentDriver(tabId: number): Promise<void> {
  try {
    await browser.scripting.executeScript({
      target: { tabId },
      files: [CONTENT_DRIVER_SCRIPT_FILE],
    });
  } catch (error) {
    console.debug('[OPX] content driver injection skipped', { tabId, error });
  }
}

function isContentDriverUrl(url: string | undefined): boolean {
  return CONTENT_DRIVER_URL_PREFIXES.some((prefix) => url?.startsWith(prefix));
}

function isOAuthCallbackUrl(url: string | undefined): boolean {
  return Boolean(
    url?.startsWith('http://localhost:1455/auth/callback') ||
      url?.startsWith('http://127.0.0.1:1455/auth/callback'),
  );
}

function isOAuthAddPhoneUrl(url: string | undefined): boolean {
  return Boolean(url?.startsWith('https://auth.openai.com/add-phone'));
}

function isOAuthAuthUrl(url: string | undefined): boolean {
  return Boolean(url?.startsWith('https://auth.openai.com/'));
}

function isOAuthChooseAccountUrl(url: string | undefined): boolean {
  return Boolean(url?.startsWith('https://auth.openai.com/choose-an-account'));
}

function isOAuthPhoneVerificationUrl(url: string | undefined): boolean {
  return Boolean(url?.startsWith('https://auth.openai.com/phone-verification'));
}

function isOAuthConsentUrl(url: string | undefined): boolean {
  return Boolean(url?.startsWith('https://auth.openai.com/sign-in-with-chatgpt/codex/consent'));
}

async function createOpenAiOAuthSession(message: OAuthCreateSessionMessage): Promise<OAuthResultResponse> {
  const email = message.email.trim();
  if (!email) {
    return { ok: false, message: '注册 tab 没有可用邮箱' };
  }

  const session = await createOAuthSession();
  const oauth = await saveOAuthState({
    codeVerifier: session.codeVerifier,
    codeChallenge: session.codeChallenge,
    state: session.state,
    redirectUri: session.redirectUri,
    authUrl: session.authUrl,
    email,
    password: message.password || '',
    startedAt: Date.now(),
    callbackUrl: '',
    codeParam: '',
    exchangeStatus: 'idle',
    exchangeMessage: 'OAuth 链接已生成，等待回调',
    exportSource: 'oauth-code',
    phoneVerification: {
      status: 'idle',
      providerId: '',
      countryId: '',
      countryName: '',
      countryIso: '',
      serviceCode: '',
      cost: 0,
      operator: '',
      activationId: '',
      phoneNumber: '',
      smsCode: '',
      message: '',
      startedAt: 0,
      updatedAt: 0,
      logs: [],
    },
    credentials: null,
    cpaJson: '',
    sub2apiJson: '',
  });
  logOAuthPhone('oauth-session-created', {
    email: maskEmail(email),
    redirectUri: session.redirectUri,
    authUrl: redactLogUrl(session.authUrl),
    stateLength: session.state.length,
    codeVerifierLength: session.codeVerifier.length,
    codeChallengeLength: session.codeChallenge.length,
  });

  try {
    const tab = await browser.tabs.create({ url: session.authUrl, active: true });
    return {
      ok: true,
      message: `已打开 OAuth 登录页：${email}`,
      state: oauth,
      tabId: tab.id,
      windowId: tab.windowId,
    };
  } catch (error) {
    return {
      ok: false,
      message: `OAuth 链接已生成，但打开新标签失败：${String(error)}`,
      state: oauth,
    };
  }
}

async function handleOAuthAddPhone(addPhoneUrl: string): Promise<void> {
  const oauth = await loadOAuthState();
  if (!oauth.authUrl && !oauth.email) {
    return;
  }
  const phoneSettings = await loadOAuthPhoneSettings();
  if (phoneSettings.enabled) {
    await saveOAuthState({
      callbackUrl: addPhoneUrl,
      codeParam: '',
      exchangeStatus: 'idle',
      exchangeMessage: '检测到需要添加手机号，请在 OAuth tab 点击“手机接码继续”。',
      exportSource: 'oauth-code',
      phoneVerification: {
        ...oauth.phoneVerification,
        status: oauth.phoneVerification.status === 'idle' ? 'idle' : oauth.phoneVerification.status,
        message: '检测到手机号验证页，等待接码流程启动',
        updatedAt: Date.now(),
      },
    });
    return;
  }
  if (oauth.exportSource === 'chatgpt-session-add-phone' && oauth.exchangeStatus === 'success') {
    return;
  }

  await saveOAuthState({
    callbackUrl: addPhoneUrl,
    codeParam: '',
    exchangeStatus: 'pending',
    exchangeMessage: '检测到当前账号需要添加手机号，正在读取 ChatGPT session 自动转换文件...',
    exportSource: 'chatgpt-session-add-phone',
  });

  const response = await fetchChatGptSession();
  if (!response.ok || !response.session?.accessToken) {
    await saveOAuthState({
      exchangeStatus: 'error',
      exchangeMessage: `当前账号需要添加手机号，无法获取到 code；读取 ChatGPT session 失败：${response.message}`,
      credentials: null,
      cpaJson: '',
      sub2apiJson: '',
      exportSource: 'chatgpt-session-add-phone',
    });
    return;
  }

  const credentials = createCredentialsFromChatGptSession(response.session, oauth.email);
  const cpaJson = createCpaJson(credentials, oauth.password);
  const sub2apiJson = createSub2ApiJson(credentials);
  await saveOAuthState({
    email: credentials.email || oauth.email,
    credentials,
    cpaJson,
    sub2apiJson,
    codeParam: '',
    exchangeStatus: 'success',
    exchangeMessage: '当前账号需要添加手机号，无法获取到 code，已自动转换文件',
    exportSource: 'chatgpt-session-add-phone',
  });
}

async function generateOAuthFilesFromCurrentSession(message: OAuthGenerateFromSessionMessage): Promise<OAuthResultResponse> {
  const oauth = await loadOAuthState();
  const email = (message.email || oauth.email || '').trim();
  const password = message.password || oauth.password || '';

  await saveOAuthState({
    email,
    password,
    callbackUrl: '',
    codeParam: '',
    exchangeStatus: 'pending',
    exchangeMessage: '正在读取 ChatGPT session，直接生成 sub2api / CPA JSON...',
    exportSource: 'chatgpt-session-direct',
    credentials: null,
    cpaJson: '',
    sub2apiJson: '',
  });

  const response = await fetchChatGptSession();
  if (!response.ok || !response.session?.accessToken) {
    const next = await saveOAuthState({
      exchangeStatus: 'error',
      exchangeMessage: `读取 ChatGPT session 失败：${response.message}`,
      credentials: null,
      cpaJson: '',
      sub2apiJson: '',
      exportSource: 'chatgpt-session-direct',
    });
    return {
      ok: false,
      message: next.exchangeMessage,
      state: next,
    };
  }

  const credentials = createCredentialsFromChatGptSession(response.session, email);
  const cpaJson = createCpaJson(credentials, password);
  const sub2apiJson = createSub2ApiJson(credentials);
  const next = await saveOAuthState({
    email: credentials.email || email,
    password,
    credentials,
    cpaJson,
    sub2apiJson,
    codeParam: '',
    callbackUrl: '',
    exchangeStatus: 'success',
    exchangeMessage: '已从 ChatGPT session 直接生成 sub2api / CPA JSON',
    exportSource: 'chatgpt-session-direct',
  });
  return {
    ok: true,
    message: next.exchangeMessage,
    state: next,
  };
}

async function startOAuthPhoneVerification(message: OAuthPhoneStartMessage, senderTabId?: number): Promise<OAuthResultResponse> {
  const tabId = await resolveOAuthTabId(message.tabId || senderTabId);
  if (!tabId) {
    logOAuthPhone('no-tab', { requestedTabId: message.tabId || senderTabId || 0 });
    return { ok: false, message: '没有找到可操作的 OAuth 页面标签页' };
  }
  await resetOAuthPhoneLogs();
  logOAuthPhone('start', { tabId });
  if (oauthPhoneAborter) {
    logOAuthPhone('abort-previous');
    oauthPhoneAborter.abort();
  }
  const aborter = new AbortController();
  oauthPhoneAborter = aborter;

  try {
    await cleanupExpiredOAuthPhoneOrders('start');
    const chooseResult = await maybeChooseExistingOAuthAccount(tabId);
    logOAuthPhone('choose-account', chooseResult);
    if (!chooseResult.ok && !chooseResult.ignored) {
      await saveOAuthPhoneRunState('error', chooseResult.message);
      return { ok: false, message: chooseResult.message, state: await loadOAuthState() };
    }
    const addPhoneReady = await waitForTabUrl(tabId, (url) => isOAuthAddPhoneUrl(url), 20_000, aborter.signal);
    logOAuthPhone('wait-add-phone', addPhoneReady);
    if (!addPhoneReady.ok) {
      await saveOAuthPhoneRunState('error', addPhoneReady.message);
      return { ok: false, message: addPhoneReady.message, state: await loadOAuthState() };
    }

    const runtimeSettings = await loadOAuthPhoneSettings();
    if (runtimeSettings.sourceMode === 'api') {
      return await startOAuthPhoneApiVerification(tabId, runtimeSettings, aborter.signal);
    }
    const channelSupport = await readOpenAiPhoneChannelSupportFromTab(tabId);
    logOAuthPhone('openai-phone-country-support', {
      source: channelSupport.source,
      smsFirstCount: channelSupport.smsFirstCountries.length,
      whatsappFirstCount: channelSupport.whatsappFirstCountries.length,
      smsFirstCountries: channelSupport.smsFirstCountries,
    });

    const selection = await selectOAuthPhoneOfferForRuntime();
    if (!selection.ok || !selection.provider || !selection.offer) {
      logOAuthPhone('select-offer', { ok: false, message: selection.message });
      await saveOAuthPhoneRunState('error', selection.message);
      return { ok: false, message: selection.message, state: await loadOAuthState() };
    }
    const candidates = selection.candidates?.length
      ? selection.candidates
      : [{ provider: selection.provider, offer: selection.offer }];
    logOAuthPhone('select-offer', {
      providerId: selection.provider.id,
      activeProviderId: selection.settings.activeProviderId,
      providerMode: selection.settings.providerMode,
      sourceMode: selection.settings.sourceMode,
      countryId: selection.offer.countryId,
      countryName: selection.offer.countryName,
      serviceCode: selection.offer.serviceCode,
      cost: selection.offer.cost,
      count: selection.offer.count,
      operator: selection.offer.operator,
      minPrice: selection.settings.minPrice,
      maxPrice: selection.settings.maxPrice,
      timeoutSeconds: selection.settings.smsTimeoutSeconds,
      selectedOfferCount: selection.settings.selectedOffers.length,
      candidateCount: candidates.length,
      enabledProviders: selection.settings.providers
        .filter((provider) => provider.enabled)
        .map((provider) => ({
          providerId: provider.id,
          priority: provider.priority,
          hasApiKey: Boolean(provider.apiKey.trim()),
        })),
      candidateQueue: candidates.map(({ provider, offer }, index) => ({
        index: index + 1,
        providerId: provider.id,
        isActiveProvider: provider.id === selection.settings.activeProviderId,
        priority: provider.priority,
        hasApiKey: Boolean(provider.apiKey.trim()),
        countryId: offer.countryId,
        countryName: offer.countryName,
        serviceCode: offer.serviceCode,
        cost: offer.cost,
        count: offer.count,
        operator: offer.operator,
        channel: formatOpenAiPhoneChannelLabel(resolveOpenAiPhoneCountrySupport(resolveOpenAiPhoneOfferCountryIso(offer), channelSupport)),
      })),
      selectedOffers: selection.settings.selectedOffers.map((offer) => ({
        providerId: offer.providerId,
        isActiveProvider: offer.providerId === selection.settings.activeProviderId,
        countryId: offer.countryId,
        countryName: offer.countryName,
        serviceCode: offer.serviceCode,
        cost: offer.cost,
        count: offer.count,
        operator: offer.operator,
      })),
    });
    const smsTimeoutSeconds = selection.settings.smsTimeoutSeconds || 120;
    const maxSmsAttempts = getMaxOAuthPhoneAttempts(candidates.length);
    const smsErrors: string[] = [];
    let verifiedPhone: {
      client: ReturnType<typeof createOAuthPhoneProvider>;
      selectedProvider: OAuthPhoneProviderSettings;
      order: OAuthPhoneOrder;
      sms: ActionResult & { code?: string; canceled?: boolean };
    } | null = null;

    for (let smsAttempt = 1; smsAttempt <= maxSmsAttempts; smsAttempt += 1) {
      const numberResult = await requestAndSubmitOAuthProviderPhone(
        tabId,
        candidates,
        selection.settings.maxPrice,
        smsTimeoutSeconds,
        channelSupport,
        aborter.signal,
      );
      if (!numberResult.ok || !numberResult.order || !numberResult.provider || !numberResult.offer || !numberResult.client || !numberResult.countryIso) {
        await flushOAuthPhoneLogs();
        await saveOAuthPhoneRunState(numberResult.canceled ? 'canceled' : 'error', numberResult.message);
        return { ok: false, message: numberResult.message, state: await loadOAuthState() };
      }

      const { client, provider: selectedProvider, order } = numberResult;
      await markOAuthPhoneReadyForSms(client, selectedProvider, order);
      await markOAuthPhoneTrackedOrder(order, 'waiting');
      await saveOAuthPhoneRunState('waiting', `正在等待短信 (${smsAttempt}/${maxSmsAttempts})，超时 ${smsTimeoutSeconds} 秒`, order);
      const sms = await waitForOAuthPhoneSms(
        client,
        selectedProvider,
        order,
        smsTimeoutSeconds * 1000,
        aborter.signal,
      );
      logOAuthPhone('sms-result', {
        smsAttempt,
        maxSmsAttempts,
        ok: sms.ok,
        code: sms.code || '',
        canceled: sms.canceled === true,
        message: sms.message,
      });
      if (sms.ok && sms.code) {
        verifiedPhone = {
          client,
          selectedProvider,
          order,
          sms,
        };
        break;
      }

      const cancelResult = await cancelOAuthPhoneOrder(client, selectedProvider, order, { reason: 'sms-timeout' });
      const message = appendCancelResultMessage(sms.message, cancelResult);
      smsErrors.push(`${maskPhone(order.phoneNumber)}: ${message}`);
      await saveOAuthPhoneRunState(sms.canceled ? 'canceled' : 'requested', message, order);
      if (sms.canceled) {
        return { ok: false, message, state: await loadOAuthState() };
      }
      if (smsAttempt >= maxSmsAttempts) {
        break;
      }

      const returned = await resetOAuthPhoneTabToAddPhone(tabId, aborter.signal);
      logOAuthPhone('sms-timeout-reset-add-phone', {
        ...returned,
        smsAttempt,
        maxSmsAttempts,
        activationId: order.activationId,
      });
      if (!returned.ok) {
        const resetMessage = `等待短信超时后无法回到 add-phone 页面：${returned.message}`;
        await saveOAuthPhoneRunState('error', resetMessage, order);
        return { ok: false, message: resetMessage, state: await loadOAuthState() };
      }
    }

    if (!verifiedPhone) {
      const message = `全部号码等待短信超时或不可用：${smsErrors.slice(0, 6).join('；')}`;
      await saveOAuthPhoneRunState('error', message);
      return { ok: false, message, state: await loadOAuthState() };
    }

    const { client, selectedProvider, order, sms } = verifiedPhone;

    await markOAuthPhoneTrackedOrder(order, 'received');
    await saveOAuthPhoneRunState('received', `收到短信验证码 ${sms.code}，正在提交`, order, sms.code);
    const fillCode = await sendTabMessage<ActionResult>({
      type: PAGE_ACTION.oauthFillPhoneCode,
      code: sms.code,
    }, tabId);
    logOAuthPhone('fill-code', fillCode);
    if (!fillCode.ok) {
      await saveOAuthPhoneRunState('error', fillCode.message, order, sms.code);
      return { ok: false, message: fillCode.message, state: await loadOAuthState() };
    }

    await saveOAuthPhoneRunState('submitted', '手机验证码已提交，等待 Codex consent 页面', order, sms.code);
    await client.setStatus(selectedProvider, order, 'complete').catch(() => undefined);
    await markOAuthPhoneTrackedOrder(order, 'completed', '已提交验证码，平台订单标记完成');
    logOAuthPhone('provider-status-complete', { activationId: order.activationId });

    const consentReady = await waitForTabUrl(tabId, (url) => isOAuthConsentUrl(url), 45_000, aborter.signal);
    logOAuthPhone('wait-consent', consentReady);
    if (!consentReady.ok) {
      await saveOAuthPhoneRunState('error', consentReady.message, order, sms.code);
      return { ok: false, message: consentReady.message, state: await loadOAuthState() };
    }
    const consent = await sendTabMessage<ActionResult>({ type: PAGE_ACTION.oauthContinueConsent }, tabId);
    logOAuthPhone('continue-consent', consent);
    if (!consent.ok) {
      await saveOAuthPhoneRunState('error', consent.message, order, sms.code);
      return { ok: false, message: consent.message, state: await loadOAuthState() };
    }

    const callbackReady = await waitForTabUrl(tabId, (url) => isOAuthCallbackUrl(url), 45_000, aborter.signal);
    logOAuthPhone('wait-callback', callbackReady.ok ? { ok: true, url: callbackReady.url ? redactOAuthCallbackUrl(callbackReady.url) : '' } : callbackReady);
    if (!callbackReady.ok) {
      await saveOAuthPhoneRunState('error', callbackReady.message, order, sms.code);
      return { ok: false, message: callbackReady.message, state: await loadOAuthState() };
    }

    const exchangeReady = await handleOAuthCallbackAndWaitForExchange(callbackReady.url || '', 60_000, aborter.signal);
    logOAuthPhone('wait-token-exchange', exchangeReady);
    if (!exchangeReady.ok) {
      await saveOAuthPhoneRunState('error', exchangeReady.message, order, sms.code, { preserveExchangeMessage: true });
      return { ok: false, message: exchangeReady.message, state: await loadOAuthState() };
    }

    await markOAuthPhoneTrackedOrder(order, 'completed', '手机验证完成');
    await saveOAuthPhoneRunState('success', '手机验证完成，OAuth token 已生成', order, sms.code, { preserveExchangeMessage: true });
    logOAuthPhone('success', { activationId: order.activationId });
    return { ok: true, message: '手机验证完成，OAuth token 已生成', state: await loadOAuthState() };
  } catch (error) {
    const message = aborter.signal.aborted ? '已停止 OAuth 手机接码' : `OAuth 手机接码失败：${String(error)}`;
    logOAuthPhone('error', { message });
    await flushOAuthPhoneLogs();
    await saveOAuthPhoneRunState(aborter.signal.aborted ? 'canceled' : 'error', message);
    return { ok: false, message, state: await loadOAuthState() };
  } finally {
    if (oauthPhoneAborter === aborter) {
      oauthPhoneAborter = null;
    }
  }
}

async function cancelOAuthPhoneVerification(): Promise<OAuthResultResponse> {
  if (oauthPhoneAborter) {
    logOAuthPhone('cancel');
    oauthPhoneAborter.abort();
    oauthPhoneAborter = null;
  }
  const cancelResult = await cancelStoredOAuthPhoneOrder();
  const cleanupResult = await cleanupExpiredOAuthPhoneOrders('stop');
  const cleanupMessage = cleanupResult.checked
    ? `；超时订单清理：${cleanupResult.canceled}/${cleanupResult.eligible} 已取消，${cleanupResult.failed} 个失败`
    : '';
  const message = `${cancelResult.message || '已停止 OAuth 手机接码'}${cleanupMessage}`;
  const next = await saveOAuthPhoneRunState('canceled', message);
  return {
    ok: true,
    message: next.phoneVerification.message,
    state: next,
  };
}

async function maybeChooseExistingOAuthAccount(tabId: number): Promise<ActionResult & { ignored?: boolean }> {
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!isOAuthChooseAccountUrl(tab?.url)) {
    return { ok: true, message: '当前不是选择账号页', ignored: true };
  }
  return sendTabMessage<ActionResult>({ type: PAGE_ACTION.oauthChooseAccount }, tabId);
}

async function readOpenAiPhoneChannelSupportFromTab(tabId: number): Promise<OpenAiPhoneChannelSupportSnapshot> {
  try {
    const result = await sendTabMessage<ActionResult>({
      type: PAGE_ACTION.oauthPhoneChannelSupport,
    }, tabId);
    if (result.ok && isOpenAiPhoneChannelSupportSnapshot(result.data)) {
      return result.data;
    }
    logOAuthPhone('openai-phone-country-support-fallback', {
      message: result.message || '页面没有返回渠道表',
    });
  } catch (error) {
    logOAuthPhone('openai-phone-country-support-fallback', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return DEFAULT_OPENAI_PHONE_CHANNEL_SUPPORT;
}

async function resolveOAuthTabId(preferredTabId?: number): Promise<number> {
  if (preferredTabId) {
    const tab = await browser.tabs.get(preferredTabId).catch(() => null);
    if (tab?.id && isContentDriverUrl(tab.url)) {
      return tab.id;
    }
  }
  const tabs = await browser.tabs.query({});
  const target = tabs.find((tab) => (
    isOAuthChooseAccountUrl(tab.url) ||
    isOAuthAddPhoneUrl(tab.url) ||
    isOAuthPhoneVerificationUrl(tab.url) ||
    isOAuthConsentUrl(tab.url) ||
    Boolean(tab.url && tab.url.startsWith('https://auth.openai.com/oauth/authorize'))
  ));
  return target?.id || 0;
}

async function waitForTabUrl(
  tabId: number,
  predicate: (url: string | undefined) => boolean,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ActionResult & { url?: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (signal?.aborted) {
      return { ok: false, message: '已停止 OAuth 手机接码' };
    }
    const tab = await browser.tabs.get(tabId).catch(() => null);
    const url = tab?.url || '';
    if (predicate(url)) {
      return { ok: true, message: '目标页面已就绪', url };
    }
    await delay(500, signal);
  }
  const tab = await browser.tabs.get(tabId).catch(() => null);
  return {
    ok: false,
    message: `等待目标页面超时，当前 URL：${tab?.url || '-'}`,
    url: tab?.url || '',
  };
}

async function handleOAuthCallbackAndWaitForExchange(
  callbackUrl: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ActionResult> {
  logOAuthPhone('oauth-callback-handle-explicit', {
    url: redactOAuthCallbackUrl(callbackUrl),
  });
  await handleOAuthCallback(callbackUrl);
  return waitForOAuthExchangeResult(timeoutMs, signal);
}

async function exchangeCurrentOAuthCodeForMessage(message: OAuthExchangeMessage): Promise<OAuthResultResponse> {
  if (message.callbackUrl) {
    const result = await handleOAuthCallbackAndWaitForExchange(
      message.callbackUrl,
      Math.max(5_000, Math.min(120_000, message.timeoutMs || 60_000)),
    );
    return {
      ok: result.ok,
      message: result.message,
      state: await loadOAuthState(),
    };
  }
  return exchangeCurrentOAuthCode();
}

async function waitForOAuthExchangeResult(timeoutMs: number, signal?: AbortSignal): Promise<ActionResult> {
  const deadline = Date.now() + timeoutMs;
  let lastSnapshot: Record<string, unknown> = {};
  while (Date.now() <= deadline) {
    if (signal?.aborted) {
      return { ok: false, message: '已停止 OAuth 手机接码' };
    }
    const oauth = await loadOAuthState();
    lastSnapshot = summarizeOAuthExchangeState(oauth);
    if (oauth.exchangeStatus === 'success' && (oauth.sub2apiJson || oauth.cpaJson)) {
      return {
        ok: true,
        message: oauth.exchangeMessage || 'OAuth token 已换取完成',
        data: lastSnapshot,
      };
    }
    if (oauth.exchangeStatus === 'error' && (oauth.callbackUrl || oauth.codeParam)) {
      return {
        ok: false,
        message: oauth.exchangeMessage || 'OAuth token 交换失败',
        data: lastSnapshot,
      };
    }
    await delay(500, signal);
  }
  return {
    ok: false,
    message: `等待 OAuth token 交换结果超时：${String(lastSnapshot.exchangeStatus || '-')}/${String(lastSnapshot.exchangeMessage || '-')}`,
    data: lastSnapshot,
  };
}

function summarizeOAuthExchangeState(oauth: Awaited<ReturnType<typeof loadOAuthState>>): Record<string, unknown> {
  return {
    exchangeStatus: oauth.exchangeStatus,
    exchangeMessage: oauth.exchangeMessage,
    exportSource: oauth.exportSource,
    hasCallbackUrl: Boolean(oauth.callbackUrl),
    callbackUrl: oauth.callbackUrl ? redactOAuthCallbackUrl(oauth.callbackUrl) : '',
    hasCodeParam: Boolean(oauth.codeParam),
    codeParamLength: oauth.codeParam.length,
    hasCodeVerifier: Boolean(oauth.codeVerifier),
    codeVerifierLength: oauth.codeVerifier.length,
    redirectUri: oauth.redirectUri,
    email: maskEmail(oauth.email),
    hasSub2ApiJson: Boolean(oauth.sub2apiJson),
    hasCpaJson: Boolean(oauth.cpaJson),
  };
}

async function waitForOAuthPhonePostSubmit(
  tabId: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<OAuthPhonePostSubmitResult> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (signal?.aborted) {
      return { ok: false, kind: 'timeout', canceled: true, message: '已停止 OAuth 手机接码' } as OAuthPhonePostSubmitResult;
    }
    const tab = await browser.tabs.get(tabId).catch(() => null);
    const url = tab?.url || '';
    if (isOAuthAuthUrl(url)) {
      const pageState = await inspectOAuthPhonePageStateFromTab(tabId);
      if (pageState.kind === 'session-expired') {
        return {
          ok: false,
          kind: 'session-expired',
          fatal: true,
          url,
          message: `${pageState.message}，请重新创建 OAuth 授权链接`,
        };
      }
      if (pageState.kind === 'phone-rejected') {
        return {
          ok: false,
          kind: 'phone-rejected',
          retryable: true,
          url,
          message: pageState.details || pageState.message,
        };
      }
      if (isOAuthPhoneVerificationUrl(url)) {
        const message = pageState.kind === 'whatsapp-verification'
          ? '已进入 WhatsApp 手机验证页，等待接码超时后重试'
          : '已进入手机验证码页';
        return { ok: true, kind: 'phone-verification', url, message };
      }
    }
    await delay(500, signal);
  }

  const tab = await browser.tabs.get(tabId).catch(() => null);
  return {
    ok: false,
    kind: 'timeout',
    retryable: true,
    message: `等待手机号提交结果超时，当前 URL：${tab?.url || '-'}`,
    url: tab?.url || '',
  };
}

async function inspectOAuthPhonePageStateFromTab(tabId: number): Promise<OAuthPhonePageState> {
  try {
    const result = await sendTabMessage<ActionResult>({
      type: PAGE_ACTION.oauthPhonePageState,
    }, tabId);
    if (result.ok && isOAuthPhonePageState(result.data)) {
      return result.data;
    }
    return {
      kind: 'none',
      message: result.message || '页面未返回手机号状态',
      url: '',
    };
  } catch (error) {
    return {
      kind: 'none',
      message: error instanceof Error ? error.message : String(error),
      url: '',
    };
  }
}

interface OAuthPhoneCandidate {
  provider: OAuthPhoneProviderSettings;
  offer: OAuthPhoneSelectedOffer;
}

interface OAuthPhoneNumberAttemptResult {
  ok: boolean;
  message: string;
  canceled?: boolean;
  provider?: OAuthPhoneProviderSettings;
  offer?: OAuthPhoneSelectedOffer;
  client?: ReturnType<typeof createOAuthPhoneProvider>;
  order?: OAuthPhoneOrder;
  countryIso?: string;
}

type OAuthPhonePageStateKind =
  | 'none'
  | 'phone-rejected'
  | 'session-expired'
  | 'whatsapp-verification'
  | 'sms-verification';

interface OAuthPhonePageState {
  kind: OAuthPhonePageStateKind;
  message: string;
  url: string;
  details?: string;
}

type OAuthPhonePostSubmitKind =
  | 'phone-verification'
  | 'phone-rejected'
  | 'session-expired'
  | 'whatsapp-verification'
  | 'timeout';

type OAuthPhonePostSubmitResult = ActionResult & {
  kind: OAuthPhonePostSubmitKind;
  retryable?: boolean;
  fatal?: boolean;
  url?: string;
};

async function requestAndSubmitOAuthProviderPhone(
  tabId: number,
  candidates: OAuthPhoneCandidate[],
  configuredMaxPrice: number,
  timeoutSeconds: number,
  channelSupport: OpenAiPhoneChannelSupportSnapshot,
  signal?: AbortSignal,
): Promise<OAuthPhoneNumberAttemptResult> {
  if (!candidates.length) {
    return { ok: false, message: '没有可用的接码候选报价' };
  }

  const errors: string[] = [];
  const maxSubmitAttempts = getMaxOAuthPhoneAttempts(candidates.length);
  for (let submitAttempt = 0; submitAttempt < maxSubmitAttempts; submitAttempt += 1) {
    if (signal?.aborted) {
      return { ok: false, canceled: true, message: '已停止 OAuth 手机接码' };
    }
    const candidateIndex = submitAttempt % candidates.length;
    const numberResult = await requestOAuthPhoneNumberFromCandidate(
      candidates[candidateIndex],
      configuredMaxPrice,
      channelSupport,
      candidateIndex + 1,
      candidates.length,
      signal,
    );
    if (numberResult.canceled) {
      return numberResult;
    }
    if (!numberResult.ok || !numberResult.order || !numberResult.provider || !numberResult.offer || !numberResult.client || !numberResult.countryIso) {
      if (numberResult.message) {
        errors.push(numberResult.message);
      }
      continue;
    }

    const { client, provider, offer, order, countryIso } = numberResult;
    await trackOAuthPhoneOrder(order, offer, countryIso, timeoutSeconds, 'requested');
    await saveOAuthProviderRequestedPhoneState(order, offer, countryIso);

    const fillPhone = await sendTabMessage<ActionResult>({
      type: PAGE_ACTION.oauthFillPhone,
      countryIso,
      phoneNumber: order.phoneNumber,
    }, tabId);
    logOAuthPhone('fill-phone', {
      ...fillPhone,
      submitAttempt: submitAttempt + 1,
      maxSubmitAttempts,
      activationId: order.activationId,
    });
    if (!fillPhone.ok) {
      const cancelResult = await cancelOAuthPhoneOrder(client, provider, order, { retryEarly: false, reason: 'phone-fill-failed' });
      const message = appendCancelResultMessage(fillPhone.message, cancelResult);
      errors.push(formatOAuthPhoneAttemptError(provider, offer, message));
      await saveOAuthPhoneRunState('requested', message, order);
      const returned = await resetOAuthPhoneTabToAddPhone(tabId, signal);
      logOAuthPhone('phone-fill-reset-add-phone', returned);
      if (!returned.ok) {
        return { ok: false, message: `手机号填写失败后无法回到 add-phone 页面：${returned.message}` };
      }
      continue;
    }

    const submitResult = await waitForOAuthPhonePostSubmit(tabId, 20_000, signal);
    logOAuthPhone('phone-submit-result', {
      ...submitResult,
      submitAttempt: submitAttempt + 1,
      maxSubmitAttempts,
      activationId: order.activationId,
      phone: maskPhone(order.phoneNumber),
    });
    if (submitResult.ok) {
      return numberResult;
    }

    const cancelResult = await cancelOAuthPhoneOrder(client, provider, order, { retryEarly: false, reason: 'phone-submit-failed' });
    const message = appendCancelResultMessage(submitResult.message, cancelResult);
    errors.push(formatOAuthPhoneAttemptError(provider, offer, message));
    await saveOAuthPhoneRunState(submitResult.fatal ? 'error' : 'requested', message, order);
    if (submitResult.fatal) {
      return { ok: false, message };
    }

    const returned = await resetOAuthPhoneTabToAddPhone(tabId, signal);
    logOAuthPhone('phone-retry-reset-add-phone', returned);
    if (!returned.ok) {
      return { ok: false, message: `号码不可用后无法回到 add-phone 页面：${returned.message}` };
    }
  }

  return {
    ok: false,
    message: formatOAuthPhoneAllAttemptsFailed(errors),
  };
}

async function saveOAuthProviderRequestedPhoneState(
  order: OAuthPhoneOrder,
  offer: OAuthPhoneSelectedOffer,
  countryIso: string,
): Promise<void> {
  await flushOAuthPhoneLogs();
  const requestedPhoneState = (await loadOAuthState()).phoneVerification;
  await saveOAuthState({
    exchangeMessage: `已获取手机号 ${maskPhone(order.phoneNumber)}，正在填写 add-phone 页面...`,
    phoneVerification: {
      status: 'requested',
      providerId: order.providerId,
      countryId: order.countryId || offer.countryId,
      countryName: offer.countryName,
      countryIso,
      serviceCode: order.serviceCode,
      cost: order.cost || offer.cost,
      operator: order.operator || offer.operator,
      activationId: order.activationId,
      phoneNumber: order.phoneNumber,
      smsCode: '',
      message: `已获取手机号 ${maskPhone(order.phoneNumber)}`,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      logs: requestedPhoneState.logs,
    },
  });
}

async function requestOAuthPhoneNumberFromCandidates(
  candidates: OAuthPhoneCandidate[],
  configuredMaxPrice: number,
  channelSupport: OpenAiPhoneChannelSupportSnapshot = DEFAULT_OPENAI_PHONE_CHANNEL_SUPPORT,
  signal?: AbortSignal,
): Promise<OAuthPhoneNumberAttemptResult> {
  const errors: string[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    if (signal?.aborted) {
      return { ok: false, canceled: true, message: '已停止 OAuth 手机接码' };
    }
    const result = await requestOAuthPhoneNumberFromCandidate(
      candidates[index],
      configuredMaxPrice,
      channelSupport,
      index + 1,
      candidates.length,
      signal,
    );
    if (result.ok || result.canceled) {
      return result;
    }
    errors.push(result.message);
  }

  return {
    ok: false,
    message: formatOAuthPhoneAllAttemptsFailed(errors),
  };
}

async function requestOAuthPhoneNumberFromCandidate(
  candidate: OAuthPhoneCandidate,
  configuredMaxPrice: number,
  channelSupport: OpenAiPhoneChannelSupportSnapshot,
  attempt: number,
  total: number,
  signal?: AbortSignal,
): Promise<OAuthPhoneNumberAttemptResult> {
  const { provider, offer } = candidate;
  const client = createOAuthPhoneProvider(provider.id);
  const useSmsPoolCountryName = provider.id === 'smspool';
  const configuredCountryIso = resolveOpenAiPhoneOfferCountryIso(offer);
  const offerSupport = resolveOpenAiPhoneCountrySupport(configuredCountryIso, channelSupport);
  logOAuthPhone('country-iso-configured', {
    attempt,
    total,
    providerId: provider.id,
    countryId: offer.countryId,
    countryName: offer.countryName,
    countryIso: configuredCountryIso,
    openAiChannel: formatOpenAiPhoneChannelLabel(offerSupport),
    channelSource: offerSupport.source,
  });
  if (!isOpenAiPhoneSmsFirst(offerSupport)) {
    logOAuthPhone('candidate-channel-not-sms-first', {
      attempt,
      total,
      providerId: provider.id,
      countryId: offer.countryId,
      countryName: offer.countryName,
      countryIso: configuredCountryIso,
      channels: offerSupport.channels,
      message: `OpenAI add-phone 为 ${formatOpenAiPhoneChannelLabel(offerSupport)}，先尝试提交；如实际进入 WhatsApp 验证页再换号`,
    });
  }
  await saveOAuthPhoneCandidateRunState(provider, offer, configuredCountryIso, attempt, total);

  const numberRequest = {
    countryId: offer.countryId,
    countryName: offer.countryName,
    serviceCode: offer.serviceCode,
    maxPrice: configuredMaxPrice > 0 ? configuredMaxPrice : offer.cost,
    operator: offer.operator,
    expectedCost: offer.cost,
    debug: (stage: string, data: Record<string, unknown>) => logOAuthPhone(stage, data),
  };
  logOAuthPhone('number-request-attempt', {
    attempt,
    total,
    providerId: provider.id,
    providerLabel: client.definition.label,
    providerSupportsV2: client.definition.supportsV2,
    providerBaseUrl: client.definition.baseUrl,
    providerHasApiKey: Boolean(provider.apiKey.trim()),
    providerPriority: provider.priority,
    offerProviderId: offer.providerId,
    countryId: numberRequest.countryId,
    countryName: numberRequest.countryName,
    serviceCode: numberRequest.serviceCode,
    providerIds: numberRequest.operator,
    expectedCost: numberRequest.expectedCost,
    maxPrice: numberRequest.maxPrice,
    params: {
      action: client.definition.supportsV2 ? 'getNumberV2' : 'getNumber',
      country: numberRequest.countryId,
      service: numberRequest.serviceCode,
      maxPrice: numberRequest.maxPrice,
      providerIds: numberRequest.operator,
    },
  });

  try {
    const order = await client.requestNumber(provider, numberRequest);
    if (signal?.aborted) {
      const cancelResult = await cancelOAuthPhoneOrder(client, provider, order, { retryEarly: false, reason: 'aborted-after-number' });
      return {
        ok: false,
        canceled: true,
        message: appendCancelResultMessage('已停止 OAuth 手机接码', cancelResult),
      };
    }
    const countryIso = configuredCountryIso || (
      useSmsPoolCountryName
        ? countryIdToIso('', offer.countryName, order.phoneNumber)
        : countryIdToIso(offer.countryId, offer.countryName, order.phoneNumber)
    );
    logOAuthPhone('number-requested', {
      attempt,
      total,
      providerId: order.providerId,
      activationId: order.activationId,
      countryId: order.countryId,
      countryIso,
      serviceCode: order.serviceCode,
      cost: order.cost,
      operator: order.operator,
      phone: maskPhone(order.phoneNumber),
    });
    if (!countryIso) {
      const message = `国家 ${offer.countryName || offer.countryId} / ${offer.countryId} 缺少 OpenAI 页面 ISO 映射，也无法从号码区号判断`;
      logOAuthPhone('number-request-failed', {
        attempt,
        total,
        providerId: provider.id,
        countryId: offer.countryId,
        countryName: offer.countryName,
        serviceCode: offer.serviceCode,
        providerIds: offer.operator,
        expectedCost: offer.cost,
        message,
        retryNext: attempt < total,
      });
      const cancelResult = await cancelOAuthPhoneOrder(client, provider, order, { retryEarly: false, reason: 'missing-country-iso' });
      logOAuthPhone('number-request-failed-cancel-result', {
        attempt,
        total,
        providerId: provider.id,
        activationId: order.activationId,
        ok: cancelResult.ok,
        message: cancelResult.message,
      });
      return { ok: false, message: formatOAuthPhoneAttemptError(provider, offer, appendCancelResultMessage(message, cancelResult)) };
    }
    logOAuthPhone('number-request-selected', {
      attempt,
      total,
      providerId: provider.id,
      countryId: offer.countryId,
      countryName: offer.countryName,
      serviceCode: offer.serviceCode,
      providerIds: offer.operator,
      expectedCost: offer.cost,
      activationId: order.activationId,
    });
    return { ok: true, message: '已获取手机号', provider, offer, client, order, countryIso };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logOAuthPhone('number-request-failed', {
      attempt,
      total,
      providerId: provider.id,
      countryId: offer.countryId,
      countryName: offer.countryName,
      serviceCode: offer.serviceCode,
      providerIds: offer.operator,
      expectedCost: offer.cost,
      maxPrice: numberRequest.maxPrice,
      message,
      noNumbers: isNoNumbersError(message),
      retryNext: attempt < total,
    });
    if (signal?.aborted) {
      return { ok: false, canceled: true, message: '已停止 OAuth 手机接码' };
    }
    return { ok: false, message: formatOAuthPhoneAttemptError(provider, offer, message) };
  }
}

async function startOAuthPhoneApiVerification(
  tabId: number,
  settings: Awaited<ReturnType<typeof loadOAuthPhoneSettings>>,
  signal?: AbortSignal,
): Promise<OAuthResultResponse> {
  const targets = settings.apiTargets.filter((target) => !target.disabled);
  logOAuthPhone('api-select-target', {
    targetCount: settings.apiTargets.length,
    availableCount: targets.length,
    timeoutSeconds: settings.smsTimeoutSeconds,
    candidateQueue: targets.map((target, index) => ({
      index: index + 1,
      targetId: target.id,
      phone: maskPhone(target.phone),
      useCount: target.useCount,
    })),
  });
  if (!targets.length) {
    const message = settings.apiTargets.length ? 'OAuth API 接码池没有可用号码' : 'OAuth API 接码池为空';
    await saveOAuthPhoneRunState('error', message);
    return { ok: false, message, state: await loadOAuthState() };
  }

  const errors: string[] = [];
  for (let index = 0; index < targets.length; index += 1) {
    if (signal?.aborted) {
      const message = '已停止 OAuth API 接码';
      await saveOAuthPhoneRunState('canceled', message);
      return { ok: false, message, state: await loadOAuthState() };
    }
    const target = targets[index];
    const result = await runOAuthPhoneApiTarget(tabId, target, settings.smsTimeoutSeconds || 120, index + 1, targets.length, signal);
    if (result.ok) {
      return result;
    }
    errors.push(`${maskPhone(target.phone)}: ${result.message}`);
    if (result.fatal || index === targets.length - 1) {
      break;
    }
    const returned = await resetOAuthPhoneTabToAddPhone(tabId, signal);
    if (!returned.ok) {
      const message = `API 号码失败后无法回到 add-phone 页面：${returned.message}`;
      logOAuthPhone('api-reset-add-phone-failed', { targetId: target.id, phone: maskPhone(target.phone), message });
      await saveOAuthPhoneRunState('error', message, createApiOAuthPhoneOrder(target));
      return { ok: false, message, state: await loadOAuthState() };
    }
    logOAuthPhone('api-next-target', {
      failedTargetId: target.id,
      failedPhone: maskPhone(target.phone),
      nextAttempt: index + 2,
      total: targets.length,
    });
  }

  const message = formatOAuthPhoneApiAllAttemptsFailed(errors);
  await saveOAuthPhoneRunState('error', message);
  return { ok: false, message, state: await loadOAuthState() };
}

async function runOAuthPhoneApiTarget(
  tabId: number,
  target: OAuthPhoneApiTarget,
  timeoutSeconds: number,
  attempt: number,
  total: number,
  signal?: AbortSignal,
): Promise<OAuthResultResponse & { fatal?: boolean }> {
  const countryIso = countryIdToIso('', '', target.phone);
  logOAuthPhone('api-target-attempt', {
    attempt,
    total,
    targetId: target.id,
    phone: maskPhone(target.phone),
    countryIso: countryIso || '',
    timeoutSeconds,
  });
  if (!countryIso) {
    const message = `API 号码 ${maskPhone(target.phone)} 无法根据区号判断 OpenAI 国家`;
    await markOAuthPhoneApiTarget(target.id, 'error', message);
    return { ok: false, message, state: await loadOAuthState() };
  }

  const order = createApiOAuthPhoneOrder(target);
  await markOAuthPhoneApiTarget(target.id, 'used', '已用于 OAuth 手机验证');
  await flushOAuthPhoneLogs();
  const previousPhoneState = (await loadOAuthState()).phoneVerification;
  await saveOAuthState({
    exchangeMessage: `已选择 API 号码 ${maskPhone(target.phone)}，正在填写 add-phone 页面...`,
    phoneVerification: {
      ...previousPhoneState,
      status: 'requested',
      providerId: 'api',
      countryId: '',
      countryName: 'API 接码',
      countryIso,
      serviceCode: 'api',
      cost: 0,
      operator: '',
      activationId: order.activationId,
      phoneNumber: target.phone,
      smsCode: '',
      message: `已选择 API 号码 ${maskPhone(target.phone)}`,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      logs: previousPhoneState.logs,
    },
  });

  const fillPhone = await sendTabMessage<ActionResult>({
    type: PAGE_ACTION.oauthFillPhone,
    countryIso,
    phoneNumber: target.phone,
  }, tabId);
  logOAuthPhone('api-fill-phone', fillPhone);
  if (!fillPhone.ok) {
    await markOAuthPhoneApiTarget(target.id, 'error', fillPhone.message);
    return { ok: false, message: fillPhone.message, state: await loadOAuthState() };
  }

  const submitResult = await waitForOAuthPhonePostSubmit(tabId, 20_000, signal);
  logOAuthPhone('api-phone-submit-result', {
    ...submitResult,
    targetId: target.id,
    phone: maskPhone(target.phone),
  });
  if (!submitResult.ok) {
    if (submitResult.fatal) {
      await saveOAuthPhoneRunState('error', submitResult.message, order);
      return { ok: false, fatal: true, message: submitResult.message, state: await loadOAuthState() };
    }
    await markOAuthPhoneApiTarget(target.id, 'error', submitResult.message);
    await saveOAuthPhoneRunState('error', submitResult.message, order);
    return { ok: false, message: submitResult.message, state: await loadOAuthState() };
  }

  await saveOAuthPhoneRunState('waiting', `正在等待 API 接码短信 (${attempt}/${total})，超时 ${timeoutSeconds} 秒`, order);
  const sms = await waitForOAuthPhoneApiSms(target, timeoutSeconds * 1000, signal);
  logOAuthPhone('api-sms-result', {
    ok: sms.ok,
    code: sms.code || '',
    canceled: sms.canceled === true,
    message: sms.message,
  });
  if (!sms.ok || !sms.code) {
    await markOAuthPhoneApiTarget(target.id, sms.canceled ? 'used' : 'error', sms.message);
    return { ok: false, fatal: sms.canceled === true, message: sms.message, state: await loadOAuthState() };
  }

  await markOAuthPhoneApiTarget(target.id, 'code', sms.message, sms.code);
  await saveOAuthPhoneRunState('received', `收到短信验证码 ${sms.code}，正在提交`, order, sms.code);
  const fillCode = await sendTabMessage<ActionResult>({
    type: PAGE_ACTION.oauthFillPhoneCode,
    code: sms.code,
  }, tabId);
  logOAuthPhone('api-fill-code', fillCode);
  if (!fillCode.ok) {
    await saveOAuthPhoneRunState('error', fillCode.message, order, sms.code);
    await markOAuthPhoneApiTarget(target.id, 'error', fillCode.message);
    return { ok: false, fatal: true, message: fillCode.message, state: await loadOAuthState() };
  }

  await saveOAuthPhoneRunState('submitted', '手机验证码已提交，等待 Codex consent 页面', order, sms.code);
  const consentReady = await waitForTabUrl(tabId, (url) => isOAuthConsentUrl(url), 45_000, signal);
  logOAuthPhone('api-wait-consent', consentReady);
  if (!consentReady.ok) {
    await saveOAuthPhoneRunState('error', consentReady.message, order, sms.code);
    return { ok: false, fatal: true, message: consentReady.message, state: await loadOAuthState() };
  }
  const consent = await sendTabMessage<ActionResult>({ type: PAGE_ACTION.oauthContinueConsent }, tabId);
  logOAuthPhone('api-continue-consent', consent);
  if (!consent.ok) {
    await saveOAuthPhoneRunState('error', consent.message, order, sms.code);
    return { ok: false, fatal: true, message: consent.message, state: await loadOAuthState() };
  }

  const callbackReady = await waitForTabUrl(tabId, (url) => isOAuthCallbackUrl(url), 45_000, signal);
  logOAuthPhone('api-wait-callback', callbackReady.ok ? { ok: true, url: callbackReady.url ? redactOAuthCallbackUrl(callbackReady.url) : '' } : callbackReady);
  if (!callbackReady.ok) {
    await saveOAuthPhoneRunState('error', callbackReady.message, order, sms.code);
    return { ok: false, fatal: true, message: callbackReady.message, state: await loadOAuthState() };
  }

  const exchangeReady = await handleOAuthCallbackAndWaitForExchange(callbackReady.url || '', 60_000, signal);
  logOAuthPhone('api-wait-token-exchange', exchangeReady);
  if (!exchangeReady.ok) {
    await saveOAuthPhoneRunState('error', exchangeReady.message, order, sms.code, { preserveExchangeMessage: true });
    return { ok: false, fatal: true, message: exchangeReady.message, state: await loadOAuthState() };
  }

  await saveOAuthPhoneRunState('success', 'API 手机验证完成，OAuth token 已生成', order, sms.code, { preserveExchangeMessage: true });
  logOAuthPhone('api-success', { activationId: order.activationId });
  return { ok: true, message: 'API 手机验证完成，OAuth token 已生成', state: await loadOAuthState() };
}

async function resetOAuthPhoneTabToAddPhone(tabId: number, signal?: AbortSignal): Promise<ActionResult> {
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (isOAuthAddPhoneUrl(tab?.url)) {
    return { ok: true, message: '当前已在 add-phone 页面' };
  }
  logOAuthPhone('api-reset-add-phone', {
    fromUrl: tab?.url ? redactOAuthCallbackUrl(tab.url) : '',
  });
  await browser.tabs.update(tabId, { url: 'https://auth.openai.com/add-phone' });
  return waitForTabUrl(tabId, (url) => isOAuthAddPhoneUrl(url), 20_000, signal);
}

function formatOAuthPhoneApiAllAttemptsFailed(errors: string[]): string {
  if (!errors.length) {
    return 'OAuth API 接码池全部号码都无法使用';
  }
  const visible = errors.slice(0, 6).join('；');
  const more = errors.length > 6 ? `；另 ${errors.length - 6} 个号码失败，详见接码日志` : '';
  return `OAuth API 接码池全部号码都无法使用：${visible}${more}`;
}

function getMaxOAuthPhoneAttempts(candidateCount: number): number {
  return Math.max(candidateCount, Math.min(8, candidateCount * 3));
}

async function saveOAuthPhoneCandidateRunState(
  provider: OAuthPhoneProviderSettings,
  offer: OAuthPhoneSelectedOffer,
  countryIso: string,
  attempt: number,
  total: number,
): Promise<void> {
  await flushOAuthPhoneLogs();
  const previous = (await loadOAuthState()).phoneVerification;
  await saveOAuthState({
    exchangeStatus: 'idle',
    exchangeMessage: `正在向接码平台索取手机号 (${attempt}/${total})...`,
    exportSource: 'oauth-code',
    phoneVerification: {
      ...previous,
      status: 'requesting',
      providerId: provider.id,
      countryId: offer.countryId,
      countryName: offer.countryName,
      countryIso,
      serviceCode: offer.serviceCode,
      cost: offer.cost,
      operator: offer.operator,
      activationId: '',
      phoneNumber: '',
      smsCode: '',
      message: `正在索取手机号 (${attempt}/${total})：${provider.id}/${offer.countryName || offer.countryId} $${offer.cost}`,
      startedAt: previous.startedAt || Date.now(),
      updatedAt: Date.now(),
      logs: previous.logs,
    },
  });
}

function isNoNumbersError(message: string): boolean {
  return message.includes('NO_NUMBERS') || message.includes('当前条件没有可用号码');
}

function formatOAuthPhoneAttemptError(
  provider: OAuthPhoneProviderSettings,
  offer: OAuthPhoneSelectedOffer,
  message: string,
): string {
  return `${provider.id}/${offer.countryName || offer.countryId}/${offer.countryId}/${offer.operator || '-'} $${offer.cost}: ${message}`;
}

function formatOAuthPhoneAllAttemptsFailed(errors: string[]): string {
  if (!errors.length) {
    return '全部候选报价都无法获取号码';
  }
  const visible = errors.slice(0, 6).join('；');
  const more = errors.length > 6 ? `；另 ${errors.length - 6} 个候选失败，详见接码日志` : '';
  return `全部候选报价都无法获取号码：${visible}${more}`;
}

async function waitForOAuthPhoneSms(
  client: ReturnType<typeof createOAuthPhoneProvider>,
  provider: Parameters<typeof client.getSms>[0],
  order: OAuthPhoneOrder,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ActionResult & { code?: string; canceled?: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let lastLogAt = 0;
  let attempt = 0;
  while (Date.now() <= deadline) {
    if (signal?.aborted) {
      return { ok: false, canceled: true, message: '已停止 OAuth 手机接码' };
    }
    attempt += 1;
    const result = await client.getSms(provider, order).catch((error) => ({
      status: 'waiting' as const,
      code: '',
      message: error instanceof Error ? error.message : String(error),
      error: true,
    }));
    const shouldLog = Boolean(result.code) ||
      Boolean('error' in result && result.error) ||
      Date.now() - lastLogAt >= 10_000;
    if (shouldLog) {
      lastLogAt = Date.now();
      logOAuthPhone('sms-poll', {
        activationId: order.activationId,
        attempt,
        elapsedSeconds: Math.round((Date.now() - (deadline - timeoutMs)) / 1000),
        remainingSeconds: Math.max(0, Math.ceil((deadline - Date.now()) / 1000)),
        status: result.status,
        hasCode: Boolean(result.code),
        code: result.code || '',
        message: result.message,
        error: Boolean('error' in result && result.error),
        raw: summarizeOAuthPhoneSmsRaw('raw' in result ? result.raw : undefined),
      });
    }
    if (result.code) {
      return {
        ok: true,
        code: result.code.replace(/\D/g, '').slice(0, 8) || result.code,
        message: result.message || '已收到手机验证码',
      };
    }
    await saveOAuthPhoneRunState('waiting', result.message || '等待短信验证码中...', order);
    await delay(5_000, signal);
  }
  return { ok: false, message: '等待手机验证码超时' };
}

async function markOAuthPhoneReadyForSms(
  client: ReturnType<typeof createOAuthPhoneProvider>,
  provider: Parameters<typeof client.setStatus>[0],
  order: OAuthPhoneOrder,
): Promise<void> {
  logOAuthPhone('provider-status-ready', {
    activationId: order.activationId,
    providerId: order.providerId,
  });
  try {
    const result = await client.setStatus(provider, order, 'ready');
    logOAuthPhone('provider-status-ready-result', {
      activationId: order.activationId,
      providerId: order.providerId,
      ok: result.ok,
      message: result.message,
      raw: result.raw,
    });
  } catch (error) {
    logOAuthPhone('provider-status-ready-error', {
      activationId: order.activationId,
      providerId: order.providerId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function waitForOAuthPhoneApiSms(
  target: OAuthPhoneApiTarget,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ActionResult & { code?: string; canceled?: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let lastLogAt = 0;
  let attempt = 0;
  while (Date.now() <= deadline) {
    if (signal?.aborted) {
      return { ok: false, canceled: true, message: '已停止 OAuth API 接码' };
    }
    attempt += 1;
    const response: SmsRelayFetchResponse = await fetchSmsRelay(target.url).catch((error): SmsRelayFetchResponse => ({
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      text: '',
      raw: '',
    }));
    const extracted = response.ok
      ? extractSmsPayload({
          raw: response.raw,
          data: response.data,
          text: response.text,
          message: response.message,
        })
      : { code: '', message: response.message };
    const shouldLog = Boolean(extracted.code) ||
      !response.ok ||
      Date.now() - lastLogAt >= 10_000;
    if (shouldLog) {
      lastLogAt = Date.now();
      logOAuthPhone('api-sms-poll', {
        targetId: target.id,
        phone: maskPhone(target.phone),
        attempt,
        elapsedSeconds: Math.round((Date.now() - (deadline - timeoutMs)) / 1000),
        remainingSeconds: Math.max(0, Math.ceil((deadline - Date.now()) / 1000)),
        ok: response.ok,
        hasCode: Boolean(extracted.code),
        code: extracted.code || '',
        message: extracted.message || response.message,
        rawText: response.text || '',
      });
    }
    const order = createApiOAuthPhoneOrder(target);
    if (extracted.code) {
      return {
        ok: true,
        code: extracted.code.replace(/\D/g, '').slice(0, 8) || extracted.code,
        message: extracted.message || '已收到 API 手机验证码',
      };
    }
    await markOAuthPhoneApiTarget(target.id, response.ok ? 'waiting' : 'error-soft', extracted.message || response.message || '暂无短信');
    await saveOAuthPhoneRunState('waiting', extracted.message || response.message || '等待 API 短信验证码中...', order);
    await delay(5_000, signal);
  }
  return { ok: false, message: '等待 API 手机验证码超时' };
}

function createApiOAuthPhoneOrder(target: OAuthPhoneApiTarget): OAuthPhoneOrder {
  return {
    providerId: 'api',
    activationId: target.id,
    phoneNumber: target.phone,
    countryId: '',
    serviceCode: 'api',
    cost: 0,
    operator: '',
    status: 'requested',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    raw: { url: target.url },
  };
}

async function markOAuthPhoneApiTarget(
  targetId: string,
  status: 'used' | 'waiting' | 'code' | 'error' | 'error-soft',
  message: string,
  code = '',
): Promise<void> {
  const settings = await loadOAuthPhoneSettings();
  const now = Date.now();
  await saveOAuthPhoneSettings({
    apiTargets: settings.apiTargets.map((target) => {
      if (target.id !== targetId) {
        return target;
      }
      return {
        ...target,
        disabled: status === 'error' ? true : target.disabled,
        disabledAt: status === 'error' ? now : target.disabledAt,
        disabledReason: status === 'error' ? message : target.disabledReason,
        useCount: status === 'used' ? target.useCount + 1 : target.useCount,
        lastUsedAt: status === 'used' ? now : target.lastUsedAt,
        lastCodeAt: status === 'code' ? now : target.lastCodeAt,
        lastMessage: code ? `${message} / code=${code}` : message,
      };
    }),
  });
}

async function cancelOAuthPhoneOrder(
  client: ReturnType<typeof createOAuthPhoneProvider>,
  provider: Parameters<typeof client.setStatus>[0],
  order: OAuthPhoneOrder,
  options: { retryEarly?: boolean; reason?: string } = {},
): Promise<{ ok: boolean; message: string }> {
  const retryEarly = options.retryEarly !== false;
  const reason = options.reason || 'unspecified';
  const orderSnapshot = {
    providerId: order.providerId,
    activationId: order.activationId,
    countryId: order.countryId,
    serviceCode: order.serviceCode,
    cost: order.cost,
    operator: order.operator,
    status: order.status,
    phone: maskPhone(order.phoneNumber),
  };
  let lastMessage = '';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    logOAuthPhone('provider-status-cancel', {
      reason,
      activationId: order.activationId,
      providerId: order.providerId,
      providerSettingsId: provider.id,
      clientProviderId: client.definition.id,
      providerLabel: client.definition.label,
      providerMatchesOrder: provider.id === order.providerId && client.definition.id === order.providerId,
      attempt,
      retryEarly,
      order: orderSnapshot,
    });
    try {
      const result = await client.setStatus(provider, order, 'cancel');
      lastMessage = result.message;
      logOAuthPhone('provider-status-cancel-result', {
        reason,
        activationId: order.activationId,
        providerId: order.providerId,
        providerSettingsId: provider.id,
        clientProviderId: client.definition.id,
        attempt,
        ok: result.ok,
        message: result.message,
        raw: result.raw,
      });
      if (result.ok) {
        await markOAuthPhoneTrackedOrder(order, 'canceled', result.message || '已取消号码并申请退款', attempt);
        return { ok: true, message: result.message || '已取消号码并申请退款' };
      }
      if (!retryEarly || !shouldRetryOAuthPhoneCancel(result.message) || attempt >= 3) {
        await markOAuthPhoneTrackedOrder(order, 'error', result.message || '取消号码失败', attempt);
        return { ok: false, message: result.message || '取消号码失败' };
      }
    } catch (error) {
      lastMessage = error instanceof Error ? error.message : String(error);
      logOAuthPhone('provider-status-cancel-error', {
        reason,
        activationId: order.activationId,
        providerId: order.providerId,
        providerSettingsId: provider.id,
        clientProviderId: client.definition.id,
        attempt,
        message: lastMessage,
      });
      if (!retryEarly || !shouldRetryOAuthPhoneCancel(lastMessage) || attempt >= 3) {
        await markOAuthPhoneTrackedOrder(order, 'error', lastMessage || '取消号码失败', attempt);
        return { ok: false, message: lastMessage || '取消号码失败' };
      }
    }

    logOAuthPhone('provider-status-cancel-retry', {
      reason,
      activationId: order.activationId,
      providerId: order.providerId,
      providerSettingsId: provider.id,
      clientProviderId: client.definition.id,
      attempt,
      nextDelaySeconds: 20,
      message: lastMessage,
    });
    await delay(20_000);
  }
  return { ok: false, message: lastMessage || '取消号码失败' };
}

async function cleanupExpiredOAuthPhoneOrders(reason: 'start' | 'stop' | 'manual'): Promise<{
  checked: number;
  eligible: number;
  canceled: number;
  failed: number;
}> {
  await syncProviderActiveOrdersToLocalPool();
  const settings = await loadOAuthPhoneSettings();
  const now = Date.now();
  const activeOrders = settings.orders.filter((order) => isTrackedOrderCancelable(order));
  const expiredOrders = activeOrders.filter((order) => order.source === 'local' && now - order.createdAt >= (order.timeoutSeconds || settings.smsTimeoutSeconds || 120) * 1000);
  logOAuthPhone('order-pool-cleanup', {
    reason,
    activeProviderId: settings.activeProviderId,
    providerMode: settings.providerMode,
    enabledProviders: settings.providers
      .filter((provider) => provider.enabled)
      .map((provider) => ({
        providerId: provider.id,
        priority: provider.priority,
        hasApiKey: Boolean(provider.apiKey.trim()),
      })),
    checked: activeOrders.length,
    eligible: expiredOrders.length,
    timeoutSeconds: settings.smsTimeoutSeconds,
    orders: expiredOrders.map((order) => ({
      source: order.source,
      providerId: order.providerId,
      activationId: order.activationId,
      ageSeconds: Math.round((now - order.createdAt) / 1000),
      timeoutSeconds: order.timeoutSeconds,
      status: order.status,
      phone: maskPhone(order.phoneNumber),
    })),
  });

  let canceled = 0;
  let failed = 0;
  for (const tracked of expiredOrders) {
    const provider = settings.providers.find((item) => item.id === tracked.providerId && item.apiKey.trim());
    if (!provider) {
      failed += 1;
      await updateOAuthPhoneTrackedOrder(tracked.providerId, tracked.activationId, {
        status: 'error',
        lastCancelMessage: '缺少接码平台 API key，无法取消号码',
      });
      continue;
    }
    const client = createOAuthPhoneProvider(provider.id);
    const result = await cancelOAuthPhoneOrder(client, provider, trackedOrderToOrder(tracked), { reason: `expired-cleanup-${reason}` });
    if (result.ok) {
      canceled += 1;
    } else {
      failed += 1;
    }
  }
  return {
    checked: activeOrders.length,
    eligible: expiredOrders.length,
    canceled,
    failed,
  };
}

async function syncProviderActiveOrdersToLocalPool(): Promise<void> {
  const settings = await loadOAuthPhoneSettings();
  for (const provider of settings.providers.filter((item) => item.enabled && item.apiKey.trim())) {
    const client = createOAuthPhoneProvider(provider.id);
    if (!client.getActiveOrders) {
      continue;
    }
    try {
      const activeOrders = await client.getActiveOrders(provider);
      logOAuthPhone('provider-active-orders', {
        providerId: provider.id,
        providerLabel: client.definition.label,
        count: activeOrders.length,
        orders: activeOrders.map((order) => ({
          providerId: order.providerId,
          activationId: order.activationId,
          countryId: order.countryId,
          serviceCode: order.serviceCode,
          cost: order.cost,
          operator: order.operator,
          status: order.status,
          phone: maskPhone(order.phoneNumber),
        })),
      });
      for (const order of activeOrders) {
        if (!settings.orders.some((tracked) => tracked.id === trackedOrderId(order.providerId, order.activationId))) {
          await upsertOAuthPhoneOrder(order, {
            source: 'platform',
            status: order.status === 'idle' ? 'waiting' : order.status,
            timeoutSeconds: settings.smsTimeoutSeconds,
          });
        }
      }
    } catch (error) {
      logOAuthPhone('provider-active-orders-error', {
        providerId: provider.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function trackOAuthPhoneOrder(
  order: OAuthPhoneOrder,
  offer: OAuthPhoneSelectedOffer,
  countryIso: string,
  timeoutSeconds: number,
  status: OAuthPhoneTrackedOrder['status'],
): Promise<void> {
  await upsertOAuthPhoneOrder(order, {
    status,
    countryName: offer.countryName,
    countryIso,
    timeoutSeconds,
  });
}

async function markOAuthPhoneTrackedOrder(
  order: Pick<OAuthPhoneOrder, 'providerId' | 'activationId'>,
  status: OAuthPhoneTrackedOrder['status'],
  message = '',
  cancelAttempts?: number,
): Promise<void> {
  if (order.providerId === 'api') {
    return;
  }
  const completedAt = status === 'received' || status === 'completed' || status === 'canceled' ? Date.now() : undefined;
  await updateOAuthPhoneTrackedOrder(order.providerId, order.activationId, {
    status,
    completedAt,
    lastCancelAt: status === 'canceled' || status === 'error' ? Date.now() : undefined,
    cancelAttempts,
    lastCancelMessage: message,
  });
}

function isTrackedOrderCancelable(order: OAuthPhoneTrackedOrder): boolean {
  return order.status === 'requested' || order.status === 'waiting' || order.status === 'error';
}

function isOpenAiPhoneChannelSupportSnapshot(value: unknown): value is OpenAiPhoneChannelSupportSnapshot {
  if (!isRecord(value) || !isRecord(value.countryChannels)) {
    return false;
  }
  return Array.isArray(value.smsFirstCountries) &&
    Array.isArray(value.whatsappFirstCountries) &&
    (value.source === 'default' || value.source === 'page');
}

function isOAuthPhonePageState(value: unknown): value is OAuthPhonePageState {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.kind === 'none' ||
    value.kind === 'phone-rejected' ||
    value.kind === 'session-expired' ||
    value.kind === 'whatsapp-verification' ||
    value.kind === 'sms-verification'
  ) &&
    typeof value.message === 'string' &&
    typeof value.url === 'string';
}

function trackedOrderToOrder(order: OAuthPhoneTrackedOrder): OAuthPhoneOrder {
  return {
    providerId: order.providerId,
    activationId: order.activationId,
    phoneNumber: order.phoneNumber,
    countryId: order.countryId,
    serviceCode: order.serviceCode,
    cost: order.cost,
    operator: order.operator,
    status: order.status,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    raw: null,
  };
}

async function cancelStoredOAuthPhoneOrder(): Promise<{ ok: boolean; message: string }> {
  const state = await loadOAuthState();
  const phone = state.phoneVerification;
  if (!phone.activationId || !phone.providerId || phone.providerId === 'api') {
    logOAuthPhone('provider-status-cancel-skip', {
      reason: phone.providerId === 'api' ? 'api-source-mode' : 'missing-order',
      providerId: phone.providerId,
      activationId: phone.activationId,
    });
    return { ok: false, message: '已停止 OAuth 手机接码，没有可取消的平台订单' };
  }

  const settings = await loadOAuthPhoneSettings();
  const tracked = settings.orders.find((item) => item.id === trackedOrderId(phone.providerId, phone.activationId));
  const createdAt = tracked?.createdAt || phone.startedAt || Date.now();
  const timeoutSeconds = tracked?.timeoutSeconds || settings.smsTimeoutSeconds || 120;
  const ageSeconds = Math.max(0, Math.floor((Date.now() - createdAt) / 1000));
  if (ageSeconds < timeoutSeconds) {
    logOAuthPhone('provider-status-cancel-defer', {
      providerId: phone.providerId,
      activationId: phone.activationId,
      ageSeconds,
      timeoutSeconds,
      reason: 'not-expired',
    });
    return {
      ok: true,
      message: `已停止 OAuth 手机接码，当前号码未超过 ${timeoutSeconds} 秒，暂不退款；超时后会在下次清理时取消`,
    };
  }

  const provider = settings.providers.find((item) => item.id === phone.providerId && item.apiKey.trim());
  if (!provider) {
    logOAuthPhone('provider-status-cancel-skip', {
      reason: 'missing-provider-settings',
      providerId: phone.providerId,
      activationId: phone.activationId,
    });
    return { ok: false, message: '已停止 OAuth 手机接码，但缺少接码平台 API key，无法取消号码' };
  }

  const client = createOAuthPhoneProvider(provider.id);
  logOAuthPhone('provider-status-cancel-state', {
    reason: 'manual-stop',
    phoneProviderId: phone.providerId,
    providerSettingsId: provider.id,
    trackedProviderId: tracked?.providerId || '',
    activationId: phone.activationId,
  });
  const order: OAuthPhoneOrder = {
    providerId: provider.id,
    activationId: phone.activationId,
    phoneNumber: phone.phoneNumber,
    countryId: phone.countryId,
    serviceCode: phone.serviceCode,
    cost: phone.cost,
    operator: phone.operator,
    status: 'requested',
    createdAt: phone.startedAt || Date.now(),
    updatedAt: Date.now(),
    raw: null,
  };
  const result = await cancelOAuthPhoneOrder(client, provider, order, { reason: 'manual-stop' });
  return {
    ok: result.ok,
    message: result.ok
      ? `已停止 OAuth 手机接码，${result.message}`
      : `已停止 OAuth 手机接码，但取消号码失败：${result.message}`,
  };
}

function shouldRetryOAuthPhoneCancel(message: string): boolean {
  const text = message.toLowerCase();
  return text.includes('early_cancel_denied') ||
    text.includes('刚购买') ||
    text.includes('cannot be cancelled yet') ||
    text.includes('try again later') ||
    text.includes('too early') ||
    text.includes('2 minutes') ||
    text.includes('120');
}

function appendCancelResultMessage(message: string, cancelResult: { ok: boolean; message: string }): string {
  const cancelMessage = cancelResult.message || (cancelResult.ok ? '取消成功' : '取消失败');
  return `${message}；取消号码${cancelResult.ok ? '成功' : '失败'}：${cancelMessage}`;
}

function summarizeOAuthPhoneSmsRaw(value: unknown): unknown {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value === 'string') {
    return value.length > 240 ? `${value.slice(0, 240)}...` : value;
  }
  try {
    const text = JSON.stringify(value);
    return text.length > 400 ? `${text.slice(0, 400)}...` : JSON.parse(text);
  } catch {
    return String(value).slice(0, 240);
  }
}

async function saveOAuthPhoneRunState(
  status: Awaited<ReturnType<typeof loadOAuthState>>['phoneVerification']['status'],
  message: string,
  order?: Partial<OAuthPhoneOrder>,
  smsCode = '',
  options: { preserveExchangeMessage?: boolean } = {},
): Promise<Awaited<ReturnType<typeof saveOAuthState>>> {
  const current = await loadOAuthState();
  const previous = current.phoneVerification;
  return saveOAuthState({
    ...(options.preserveExchangeMessage ? {} : { exchangeMessage: message }),
    phoneVerification: {
      ...previous,
      status,
      providerId: order?.providerId || previous.providerId,
      countryId: order?.countryId || previous.countryId,
      serviceCode: order?.serviceCode || previous.serviceCode,
      cost: Number(order?.cost || previous.cost || 0),
      operator: order?.operator || previous.operator,
      activationId: order?.activationId || previous.activationId,
      phoneNumber: order?.phoneNumber || previous.phoneNumber,
      smsCode: smsCode || previous.smsCode,
      message,
      startedAt: previous.startedAt || Date.now(),
      updatedAt: Date.now(),
    },
  });
}

function maskPhone(value: string): string {
  const digits = value.replace(/[^\d]/g, '');
  return digits.length > 4 ? `${digits.slice(0, 3)}***${digits.slice(-4)}` : digits;
}

function maskEmail(value: string): string {
  const email = value.trim();
  const [name, domain] = email.split('@');
  if (!name || !domain) {
    return email ? '[EMAIL]' : '';
  }
  const visible = name.length <= 2 ? `${name[0] || ''}*` : `${name.slice(0, 2)}***${name.slice(-1)}`;
  return `${visible}@${domain}`;
}

let oauthPhoneLogWriteQueue = Promise.resolve();

function logOAuthPhone(stage: string, data: Record<string, unknown> | ActionResult | undefined = undefined): void {
  const prefix = `[OPX OAuthPhone] ${stage}`;
  const safeData = sanitizeOAuthPhoneLogData(data);
  if (data === undefined) {
    console.info(prefix);
  } else {
    console.info(prefix, safeData);
  }
  const entry = {
    id: `${Date.now()}-${stage}-${Math.random().toString(36).slice(2, 7)}`,
    time: Date.now(),
    stage,
    message: data && 'message' in data ? redactOAuthPhoneLogText(String(data.message || '')) : '',
    data: serializeOAuthPhoneLogData(safeData),
  };
  oauthPhoneLogWriteQueue = oauthPhoneLogWriteQueue
    .then(async () => {
      await appendOAuthPhoneLog(entry);
      await mirrorOAuthPhoneLogToAutomation(entry);
    })
    .catch((error) => {
      console.info('[OPX OAuthPhone] log-persist-skipped', error);
    });
}

async function resetOAuthPhoneLogs(): Promise<void> {
  const current = await loadOAuthState();
  await saveOAuthState({
    phoneVerification: {
      ...current.phoneVerification,
      logs: [],
    },
  });
}

async function appendOAuthPhoneLog(entry: Awaited<ReturnType<typeof loadOAuthState>>['phoneVerification']['logs'][number]): Promise<void> {
  const current = await loadOAuthState();
  await saveOAuthState({
    phoneVerification: {
      ...current.phoneVerification,
      logs: [...current.phoneVerification.logs, entry].slice(-80),
    },
  });
}

async function mirrorOAuthPhoneLogToAutomation(
  entry: Awaited<ReturnType<typeof loadOAuthState>>['phoneVerification']['logs'][number],
): Promise<void> {
  const automation = await loadAutomationState();
  const stepId = 'wait-oauth-email-code';
  const stepRunning = automation.steps.some((step) => step.id === stepId && step.status === 'running');
  if (!automation.run.running || automation.run.currentStepId !== stepId || !stepRunning) {
    return;
  }

  await appendAutomationLog(resolveOAuthPhoneAutomationLogLevel(entry), formatOAuthPhoneAutomationLog(entry), stepId);
}

function resolveOAuthPhoneAutomationLogLevel(
  entry: Awaited<ReturnType<typeof loadOAuthState>>['phoneVerification']['logs'][number],
) {
  const normalizedStage = entry.stage.toLowerCase();
  const normalizedData = `${entry.message}\n${entry.data}`.toLowerCase();
  if (normalizedStage.includes('error') || normalizedData.includes('"ok":false') || normalizedData.includes('"error":true')) {
    return 'error';
  }
  if (
    normalizedStage.includes('success')
    || normalizedStage.includes('complete')
    || normalizedStage.includes('received')
    || normalizedData.includes('"hascode":true')
  ) {
    return 'success';
  }
  if (
    normalizedStage.includes('fallback')
    || normalizedStage.includes('timeout')
    || normalizedStage.includes('cancel')
    || normalizedStage.includes('rejected')
  ) {
    return 'warn';
  }
  return 'info';
}

function formatOAuthPhoneAutomationLog(entry: Awaited<ReturnType<typeof loadOAuthState>>['phoneVerification']['logs'][number]): string {
  const parts = [`OAuth接码：${entry.stage}`];
  if (entry.message) {
    parts.push(entry.message);
  }
  if (entry.data) {
    parts.push(truncateAutomationLogData(entry.data, 900));
  }
  return parts.join(' ');
}

function truncateAutomationLogData(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}

async function flushOAuthPhoneLogs(): Promise<void> {
  await oauthPhoneLogWriteQueue.catch(() => undefined);
}

function serializeOAuthPhoneLogData(data: unknown): string {
  if (data === undefined) {
    return '';
  }
  try {
    return JSON.stringify(sanitizeOAuthPhoneLogData(data));
  } catch {
    return redactOAuthPhoneLogText(String(data));
  }
}

function sanitizeOAuthPhoneLogData(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactOAuthPhoneLogText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeOAuthPhoneLogData(item));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, childValue] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if ([
      'apikey',
      'accesstoken',
      'idtoken',
      'refreshtoken',
      'sessiontoken',
      'token',
      'authorization',
      'bearer',
      'clientsecret',
      'code',
      'codeparam',
      'codeverifier',
      'codechallenge',
    ].includes(normalizedKey)) {
      result[key] = '[REDACTED]';
      continue;
    }
    result[key] = sanitizeOAuthPhoneLogData(childValue);
  }
  return result;
}

function redactOAuthPhoneLogText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>，。；)]+/gi, (match) => redactLogUrl(match))
    .replace(/(api_key=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/(api[_-]?key["':\s=]+)([^"',\s}]+)/gi, '$1[REDACTED]')
    .replace(/\b(access[_-]?token|id[_-]?token|refresh[_-]?token|session[_-]?token|authorization|bearer|code[_-]?verifier|code[_-]?challenge|code)\b([="'\s:]+)([^\s,;，。]+)/gi, '$1$2[REDACTED]');
}

function redactLogUrl(value: string): string {
  try {
    const url = new URL(value);
    const path = url.pathname
      .split('/')
      .filter(Boolean)
      .map((segment) => segment.length > 18 ? `${segment.slice(0, 6)}...${segment.slice(-4)}` : segment)
      .join('/');
    const query = url.search ? '?[REDACTED]' : '';
    const hash = url.hash ? '#[REDACTED]' : '';
    return `${url.origin}${path ? `/${path}` : ''}${query}${hash}`;
  } catch {
    return '[URL_REDACTED]';
  }
}

function redactOAuthCallbackUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.searchParams.has('code')) {
      url.searchParams.set('code', '<redacted>');
    }
    return url.toString();
  } catch {
    return value.replace(/code=[^&]+/, 'code=<redacted>');
  }
}

async function handleOAuthCallback(callbackUrl: string): Promise<void> {
  const oauth = await loadOAuthState();
  logOAuthPhone('oauth-callback-detected', {
    url: redactOAuthCallbackUrl(callbackUrl),
    storedStatus: oauth.exchangeStatus,
    hasSessionState: Boolean(oauth.state),
    hasCodeVerifier: Boolean(oauth.codeVerifier),
    codeVerifierLength: oauth.codeVerifier.length,
    redirectUri: oauth.redirectUri,
    email: maskEmail(oauth.email),
  });
  if (!oauth.state || !oauth.codeVerifier) {
    logOAuthPhone('oauth-callback-no-session', {
      url: redactOAuthCallbackUrl(callbackUrl),
      hasState: Boolean(oauth.state),
      hasCodeVerifier: Boolean(oauth.codeVerifier),
    });
    await saveOAuthState({
      callbackUrl,
      exchangeStatus: 'error',
      exchangeMessage: '捕获到 OAuth 回调，但没有找到本地会话，请重新生成 OAuth 链接',
    });
    return;
  }

  if (oauth.callbackUrl === callbackUrl && oauth.exchangeStatus === 'success') {
    logOAuthPhone('oauth-callback-duplicate-skip', {
      url: redactOAuthCallbackUrl(callbackUrl),
      exchangeStatus: oauth.exchangeStatus,
    });
    return;
  }
  if (oauth.callbackUrl === callbackUrl && oauth.exchangeStatus === 'pending') {
    logOAuthPhone('oauth-callback-pending-skip', {
      url: redactOAuthCallbackUrl(callbackUrl),
      exchangeStatus: oauth.exchangeStatus,
    });
    return;
  }

  let callback;
  try {
    callback = parseOAuthCallbackUrl(callbackUrl);
  } catch (error) {
    logOAuthPhone('oauth-callback-parse-error', {
      url: redactOAuthCallbackUrl(callbackUrl),
      message: String(error),
    });
    await saveOAuthState({
      callbackUrl,
      exchangeStatus: 'error',
      exchangeMessage: `OAuth 回调 URL 解析失败：${String(error)}`,
    });
    return;
  }

  if (callback.error) {
    logOAuthPhone('oauth-callback-error-param', {
      error: callback.error,
      errorDescription: callback.errorDescription,
      url: redactOAuthCallbackUrl(callbackUrl),
    });
    await saveOAuthState({
      callbackUrl,
      codeParam: callback.codeParam,
      exchangeStatus: 'error',
      exchangeMessage: callback.errorDescription || callback.error,
    });
    return;
  }

  if (!callback.code) {
    logOAuthPhone('oauth-callback-missing-code', {
      url: redactOAuthCallbackUrl(callbackUrl),
      stateLength: callback.state.length,
    });
    await saveOAuthState({
      callbackUrl,
      exchangeStatus: 'error',
      exchangeMessage: 'OAuth 回调缺少 code',
    });
    return;
  }

  if (callback.state !== oauth.state) {
    logOAuthPhone('oauth-callback-state-mismatch', {
      url: redactOAuthCallbackUrl(callbackUrl),
      callbackStateLength: callback.state.length,
      storedStateLength: oauth.state.length,
    });
    await saveOAuthState({
      callbackUrl,
      codeParam: callback.codeParam,
      exchangeStatus: 'error',
      exchangeMessage: 'OAuth state 不匹配，请重新生成链接',
    });
    return;
  }

  logOAuthPhone('oauth-callback-accepted', {
    url: redactOAuthCallbackUrl(callbackUrl),
    codeLength: callback.code.length,
    stateLength: callback.state.length,
    redirectUri: oauth.redirectUri,
  });
  await saveOAuthState({
    callbackUrl,
    codeParam: callback.codeParam,
    exchangeStatus: 'pending',
    exchangeMessage: '已捕获 code，正在换取 token...',
    exportSource: 'oauth-code',
  });
  await exchangeCurrentOAuthCode();
}

async function exchangeCurrentOAuthCode(): Promise<OAuthResultResponse> {
  const oauth = await loadOAuthState();
  logOAuthPhone('oauth-token-exchange-check', summarizeOAuthExchangeState(oauth));
  if (oauth.exchangeStatus === 'success' && (oauth.sub2apiJson || oauth.cpaJson)) {
    logOAuthPhone('oauth-token-exchange-already-success', summarizeOAuthExchangeState(oauth));
    return {
      ok: true,
      message: oauth.exchangeMessage || 'OAuth token 已换取完成',
      state: oauth,
    };
  }
  if (!oauth.callbackUrl || !oauth.codeParam) {
    logOAuthPhone('oauth-token-exchange-skip', {
      reason: 'missing-callback-or-code-param',
      hasCallbackUrl: Boolean(oauth.callbackUrl),
      hasCodeParam: Boolean(oauth.codeParam),
    });
    return { ok: false, message: '还没有捕获 OAuth code' };
  }

  const callback = parseOAuthCallbackUrl(oauth.callbackUrl);
  if (!callback.code) {
    logOAuthPhone('oauth-token-exchange-skip', {
      reason: 'missing-code',
      callbackUrl: redactOAuthCallbackUrl(oauth.callbackUrl),
    });
    return { ok: false, message: 'OAuth 回调缺少 code' };
  }

  const lockKey = `${oauth.callbackUrl}|${oauth.codeVerifier}`;
  const existingLock = oauthExchangeLocks.get(lockKey);
  if (existingLock) {
    logOAuthPhone('oauth-token-exchange-wait-existing', {
      callbackUrl: redactOAuthCallbackUrl(oauth.callbackUrl),
    });
    return existingLock;
  }

  const lock = exchangeCurrentOAuthCodeUnlocked(oauth, callback.code)
    .finally(() => {
      oauthExchangeLocks.delete(lockKey);
    });
  oauthExchangeLocks.set(lockKey, lock);
  return lock;
}

async function exchangeCurrentOAuthCodeUnlocked(
  oauth: Awaited<ReturnType<typeof loadOAuthState>>,
  code: string,
): Promise<OAuthResultResponse> {
  const callback = parseOAuthCallbackUrl(oauth.callbackUrl);
  try {
    logOAuthPhone('oauth-token-exchange-start', {
      callbackUrl: redactOAuthCallbackUrl(oauth.callbackUrl),
      codeLength: code.length,
      stateLength: callback.state.length,
      hasCodeVerifier: Boolean(oauth.codeVerifier),
      codeVerifierLength: oauth.codeVerifier.length,
      redirectUri: oauth.redirectUri,
      email: maskEmail(oauth.email),
    });
    const credentials = await exchangeOAuthCode(code, oauth);
    const credentialsWithEmail = {
      ...credentials,
      email: credentials.email || oauth.email,
    };
    const cpaJson = createCpaJson(credentialsWithEmail, oauth.password);
    const sub2apiJson = createSub2ApiJson(credentialsWithEmail);
    const next = await saveOAuthState({
      credentials: credentialsWithEmail,
      cpaJson,
      sub2apiJson,
      exchangeStatus: 'success',
      exchangeMessage: '已换取 token，并生成 sub2api / CPA JSON',
      exportSource: 'oauth-code',
    });
    logOAuthPhone('oauth-token-exchange-success', {
      email: maskEmail(credentialsWithEmail.email),
      accountId: credentialsWithEmail.account_id,
      hasRefreshToken: Boolean(credentialsWithEmail.refresh_token),
      hasIdToken: Boolean(credentialsWithEmail.id_token),
      expired: credentialsWithEmail.expired,
      sub2apiLength: sub2apiJson.length,
      cpaLength: cpaJson.length,
    });
    await flushOAuthPhoneLogs();
    return {
      ok: true,
      message: next.exchangeMessage,
      state: await loadOAuthState(),
    };
  } catch (error) {
    logOAuthPhone('oauth-token-exchange-error', {
      message: error instanceof Error ? error.message : String(error),
      diagnostics: error instanceof OAuthTokenExchangeError ? error.diagnostics : undefined,
    });
    const next = await saveOAuthState({
      exchangeStatus: 'error',
      exchangeMessage: error instanceof Error ? error.message : String(error),
      credentials: null,
      cpaJson: '',
      sub2apiJson: '',
    });
    await flushOAuthPhoneLogs();
    return {
      ok: false,
      message: next.exchangeMessage,
      state: await loadOAuthState(),
    };
  }
}


async function handleAcicaSyncEmails(message: { type: 'opx:acica-sync-emails'; settings?: unknown }): Promise<{ ok: boolean; message: string; count: number; lines: string[]; emails: string[] }> {
  const settings = normalizeAcicaMailboxSettings(message.settings || DEFAULT_ACICA_MAILBOX_SETTINGS);
  const result = await syncAcicaEmailPool(settings);
  return {
    ok: result.ok,
    message: result.message,
    count: result.count,
    lines: result.lines,
    emails: result.emails,
  };
}

async function waitForAcicaOtp(message: {
  type: 'opx:wait-acica-otp';
  jobId?: string;
  email: string;
  settings?: unknown;
  timeoutMs?: number;
  ignoreCodes?: string[];
}): Promise<OutlookOtpResponse> {
  const jobId = message.jobId || makeOutlookJobId();
  const settings = normalizeAcicaMailboxSettings(message.settings || DEFAULT_ACICA_MAILBOX_SETTINGS);
  const email = extractEmailFromAccountLine(message.email) || String(message.email || '').trim();
  const deadline = Date.now() + (message.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const aborter = new AbortController();
  outlookOtpAborters.set(jobId, aborter);
  const ignored = new Set((message.ignoreCodes || []).map((code) => String(code || '').trim()).filter(Boolean));

  try {
    while (Date.now() <= deadline) {
      if (aborter.signal.aborted) {
        return { ok: false, canceled: true, message: '已停止邮箱验证码接收' };
      }
      const remainSec = Math.max(5, Math.min(settings.otpWaitSeconds, Math.ceil((deadline - Date.now()) / 1000)));
      const result = await pollAcicaOtp(email, settings, {
        signal: aborter.signal,
        waitSeconds: remainSec,
        keyword: 'ChatGPT',
        since: Number((message as { since?: number }).since || 0),
      });
      if (result.ok && result.code && !ignored.has(result.code)) {
        return { ok: true, code: result.code, message: result.message };
      }
      if (result.fatal) {
        return { ok: false, message: result.message, failureKind: result.failureKind };
      }
      await delay(Math.max(1000, settings.otpPollIntervalSec * 1000), aborter.signal);
    }
    return { ok: false, message: '等待 Acica 验证码超时', failureKind: 'mail_not_arrived' };
  } finally {
    if (outlookOtpAborters.get(jobId) === aborter) {
      outlookOtpAborters.delete(jobId);
    }
  }
}

function isAcicaSyncEmailsMessage(message: unknown): message is { type: 'opx:acica-sync-emails'; settings?: unknown } {
  return Boolean(message && typeof message === 'object' && (message as { type?: unknown }).type === 'opx:acica-sync-emails');
}

function isAcicaOtpMessage(message: unknown): message is { type: 'opx:wait-acica-otp'; email: string } {
  return Boolean(
    message &&
      typeof message === 'object' &&
      (message as { type?: unknown }).type === 'opx:wait-acica-otp' &&
      typeof (message as { email?: unknown }).email === 'string',
  );
}

function isTrustedFillEmailMessage(message: unknown): message is { type: 'opx:trusted-fill-email'; tabId: number; email: string } {
  return Boolean(
    message &&
    typeof message === 'object' &&
    (message as { type?: string }).type === 'opx:trusted-fill-email' &&
    Number.isFinite((message as { tabId?: number }).tabId) &&
    typeof (message as { email?: string }).email === 'string',
  );
}

function isTrustedFillOtpMessage(message: unknown): message is { type: 'opx:trusted-fill-otp'; tabId: number; code: string } {
  return Boolean(
    message &&
    typeof message === 'object' &&
    (message as { type?: string }).type === 'opx:trusted-fill-otp' &&
    Number.isFinite((message as { tabId?: number }).tabId) &&
    typeof (message as { code?: string }).code === 'string',
  );
}

async function trustedFillOtp(message: { tabId: number; code: string }): Promise<{
  ok: boolean;
  message: string;
  data?: Record<string, unknown>;
}> {
  const debuggerApi = getNativeChromeApi().chrome?.debugger;
  if (!debuggerApi) {
    return { ok: false, message: '当前浏览器不支持验证码受信任输入' };
  }
  const target = { tabId: message.tabId };
  let attached = false;
  try {
    await debuggerApi.attach(target, '1.3');
    attached = true;
    const controlsExpression = `(() => {
        const visible = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
        };
        const specificInputs = Array.from(document.querySelectorAll('input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"]')).filter(visible);
        const inputs = specificInputs.length > 0
          ? specificInputs
          : Array.from(document.querySelectorAll('input')).filter(visible);
        const input = inputs[0];
        const buttons = Array.from(document.querySelectorAll('button')).filter(visible);
        const button = buttons.find((el) => el.type === 'submit') || buttons.find((el) => /继续|continue/i.test(el.textContent || ''));
        const point = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
        const bodyText = (document.body?.innerText || document.body?.textContent || '').replace(/\\s+/g, ' ').trim();
        const errorMatch = bodyText.match(/(代码不正确|验证码不正确|incorrect code|invalid code|wrong code)[^。.!?]{0,160}/i);
        const buttonText = (button?.textContent || '').replace(/\\s+/g, ' ').trim();
        const buttonDisabled = Boolean(button && (button.disabled || button.matches(':disabled')));
        const buttonAriaDisabled = button?.getAttribute('aria-disabled') === 'true';
        const buttonBusy = Boolean(button && (
          buttonDisabled ||
          buttonAriaDisabled ||
          button.getAttribute('aria-busy') === 'true' ||
          /loading|submitting|verifying|处理中|正在验证|请稍候/i.test(buttonText)
        ));
        return {
          input: input ? point(input) : null,
          button: button ? point(button) : null,
          values: inputs.map((el) => String(el.value || '')),
          combinedValue: inputs.map((el) => String(el.value || '')).join(''),
          buttonDisabled,
          buttonAriaDisabled,
          buttonBusy,
          buttonText,
          url: location.href,
          pathname: location.pathname,
          errorText: errorMatch ? errorMatch[0] : '',
        };
      })()`;
    const points = await locateTrustedFormControls(debuggerApi, target, controlsExpression);
    if (!points?.input || !points.button) {
      return { ok: false, message: '验证码受信任输入没有找到输入框或继续按钮' };
    }
    await debuggerClick(debuggerApi, target, points.input.x, points.input.y);
    await debuggerApi.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2,
    });
    await debuggerApi.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2,
    });
    await debuggerApi.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8,
    });
    await debuggerApi.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8,
    });
    await debuggerTypeText(debuggerApi, target, message.code);
    const ready = await waitForTrustedOtpReady(
      debuggerApi,
      target,
      controlsExpression,
      message.code,
      5_000,
    );
    if (!ready?.input || !ready.button) {
      return {
        ok: false,
        message: '验证码输入后页面未进入可提交状态',
        data: trustedOtpDiagnostics(ready, 'input-not-ready'),
      };
    }
    await debuggerClick(debuggerApi, target, ready.button.x, ready.button.y);
    let submitted = await waitForTrustedOtpSubmission(debuggerApi, target, controlsExpression, ready.url, 2_500);
    let submitMethod = 'button';
    if (!submitted.submitted) {
      submitMethod = 'enter-fallback';
      const latest = submitted.state || ready;
      if (latest.input) {
        await debuggerClick(debuggerApi, target, latest.input.x, latest.input.y);
      }
      await debuggerPressEnter(debuggerApi, target);
      submitted = await waitForTrustedOtpSubmission(debuggerApi, target, controlsExpression, ready.url, 3_500);
    }
    const data = trustedOtpDiagnostics(submitted.state || ready, submitMethod);
    if (!submitted.submitted) {
      return {
        ok: false,
        message: '验证码已输入，但按钮和 Enter 均未触发页面提交',
        data,
      };
    }
    return {
      ok: true,
      message: `已使用浏览器受信任事件提交验证码（${submitMethod === 'button' ? '按钮' : 'Enter 补交'}）`,
      data,
    };
  } catch (error) {
    return { ok: false, message: `验证码受信任输入失败：${error instanceof Error ? error.message : String(error)}` };
  } finally {
    if (attached) {
      await debuggerApi.detach(target).catch(() => undefined);
    }
  }
}

async function trustedFillEmail(message: { tabId: number; email: string }): Promise<{ ok: boolean; message: string }> {
  const debuggerApi = getNativeChromeApi().chrome?.debugger;
  if (!debuggerApi) {
    return { ok: false, message: '当前浏览器不支持受信任输入回退' };
  }
  const target = { tabId: message.tabId };
  let attached = false;
  try {
    await debuggerApi.attach(target, '1.3');
    attached = true;
    const points = await locateTrustedFormControls(debuggerApi, target, `(() => {
        const visible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const input = Array.from(document.querySelectorAll('input[type="email"], input[name="email"], input[autocomplete="email"]')).find(visible);
        const buttons = Array.from(document.querySelectorAll('button')).filter(visible);
        const button = buttons.find((el) => el.type === 'submit') || buttons.find((el) => /继续|continue/i.test(el.textContent || ''));
        const point = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
        return { input: input ? point(input) : null, button: button ? point(button) : null };
      })()`);
    if (!points?.input || !points.button) {
      return { ok: false, message: '受信任输入回退没有找到邮箱框或继续按钮' };
    }
    await debuggerClick(debuggerApi, target, points.input.x, points.input.y);
    await debuggerApi.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2,
    });
    await debuggerApi.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2,
    });
    await debuggerApi.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8,
    });
    await debuggerApi.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8,
    });
    await debuggerApi.sendCommand(target, 'Input.insertText', { text: message.email });
    await new Promise((resolve) => globalThis.setTimeout(resolve, 180));
    await debuggerClick(debuggerApi, target, points.button.x, points.button.y);
    return { ok: true, message: '已使用浏览器受信任事件重新提交邮箱' };
  } catch (error) {
    return { ok: false, message: `受信任输入回退失败：${error instanceof Error ? error.message : String(error)}` };
  } finally {
    if (attached) {
      await debuggerApi.detach(target).catch(() => undefined);
    }
  }
}

async function debuggerClick(
  debuggerApi: NativeDebuggerApi,
  target: NativeDebuggerTarget,
  x: number,
  y: number,
): Promise<void> {
  await debuggerApi.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await debuggerApi.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await debuggerApi.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

async function debuggerTypeText(
  debuggerApi: NativeDebuggerApi,
  target: NativeDebuggerTarget,
  text: string,
): Promise<void> {
  for (const char of text) {
    const upper = char.toUpperCase();
    const isDigit = /[0-9]/.test(char);
    const code = isDigit ? `Digit${char}` : `Key${upper}`;
    const windowsVirtualKeyCode = char.charCodeAt(0);
    await debuggerApi.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: char,
      code,
      text: char,
      unmodifiedText: char,
      windowsVirtualKeyCode,
    });
    await debuggerApi.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: char,
      code,
      windowsVirtualKeyCode,
    });
    await new Promise((resolve) => globalThis.setTimeout(resolve, 45));
  }
}

async function debuggerPressEnter(
  debuggerApi: NativeDebuggerApi,
  target: NativeDebuggerTarget,
): Promise<void> {
  await debuggerApi.sendCommand(target, 'Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Enter',
    code: 'Enter',
    text: '\r',
    unmodifiedText: '\r',
    windowsVirtualKeyCode: 13,
  });
  await debuggerApi.sendCommand(target, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
  });
}

type TrustedFormControls = {
  input?: { x: number; y: number } | null;
  button?: { x: number; y: number } | null;
  values?: string[];
  combinedValue?: string;
  buttonDisabled?: boolean;
  buttonAriaDisabled?: boolean;
  buttonBusy?: boolean;
  buttonText?: string;
  url?: string;
  pathname?: string;
  errorText?: string;
};

async function evaluateTrustedFormControls(
  debuggerApi: NativeDebuggerApi,
  target: NativeDebuggerTarget,
  expression: string,
): Promise<TrustedFormControls | null> {
  try {
    const located = await debuggerApi.sendCommand(target, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
    }) as { result?: { value?: TrustedFormControls } };
    return located.result?.value || null;
  } catch {
    // The execution context can be replaced while the auth page rerenders.
    return null;
  }
}

async function waitForTrustedOtpReady(
  debuggerApi: NativeDebuggerApi,
  target: NativeDebuggerTarget,
  expression: string,
  code: string,
  timeoutMs: number,
): Promise<TrustedFormControls | null> {
  const deadline = Date.now() + timeoutMs;
  let lastState: TrustedFormControls | null = null;
  do {
    lastState = await evaluateTrustedFormControls(debuggerApi, target, expression) || lastState;
    const actual = String(lastState?.combinedValue || '').replace(/\s+/g, '');
    const expected = String(code || '').replace(/\s+/g, '');
    if (
      lastState?.input &&
      lastState.button &&
      actual === expected &&
      !lastState.buttonDisabled &&
      !lastState.buttonAriaDisabled
    ) {
      return lastState;
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 120));
  } while (Date.now() < deadline);
  return lastState;
}

async function waitForTrustedOtpSubmission(
  debuggerApi: NativeDebuggerApi,
  target: NativeDebuggerTarget,
  expression: string,
  initialUrl: string | undefined,
  timeoutMs: number,
): Promise<{ submitted: boolean; state: TrustedFormControls | null }> {
  const deadline = Date.now() + timeoutMs;
  let lastState: TrustedFormControls | null = null;
  do {
    lastState = await evaluateTrustedFormControls(debuggerApi, target, expression) || lastState;
    if (lastState) {
      const advanced = Boolean(
        lastState.url &&
        (lastState.url !== initialUrl || !/email-verification/i.test(lastState.pathname || '')),
      );
      if (advanced || lastState.buttonBusy || Boolean(lastState.errorText)) {
        return { submitted: true, state: lastState };
      }
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 120));
  } while (Date.now() < deadline);
  return { submitted: false, state: lastState };
}

function trustedOtpDiagnostics(state: TrustedFormControls | null, submitMethod: string): Record<string, unknown> {
  return {
    submitMethod,
    values: state?.values || [],
    combinedValue: state?.combinedValue || '',
    buttonDisabled: Boolean(state?.buttonDisabled),
    buttonAriaDisabled: Boolean(state?.buttonAriaDisabled),
    buttonBusy: Boolean(state?.buttonBusy),
    buttonText: state?.buttonText || '',
    url: state?.url || '',
    errorText: state?.errorText || '',
  };
}

async function locateTrustedFormControls(
  debuggerApi: NativeDebuggerApi,
  target: NativeDebuggerTarget,
  expression: string,
  timeoutMs = 15_000,
): Promise<TrustedFormControls | null> {
  const deadline = Date.now() + timeoutMs;
  do {
    const controls = await evaluateTrustedFormControls(debuggerApi, target, expression);
    if (controls?.input && controls.button) {
      return controls;
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  return null;
}

async function waitForOutlookOtp(message: OutlookOtpMessage): Promise<OutlookOtpResponse> {
  const jobId = message.jobId || makeOutlookJobId();
  const startedAt = message.since ?? Date.now();
  const deadline = Date.now() + (message.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const intervalMs = message.intervalMs ?? DEFAULT_INTERVAL_MS;
  const apiBase = normalizeApiBase(message.apiBase || DEFAULT_OUTLOOK_API_BASE);
  const aborter = new AbortController();
  outlookOtpAborters.set(jobId, aborter);
  const e2eMailboxUrl = await loadE2eMailboxUrl();
  if (e2eMailboxUrl) {
    const ignored = new Set((message.ignoreCodes || []).map((code) => String(code || '').trim()).filter(Boolean));
    try {
      while (Date.now() <= deadline) {
        if (aborter.signal.aborted) {
          return { ok: false, canceled: true, message: '已停止 E2E 邮件验证码接收' };
        }
        const polled = await pollMailboxUrlOtp(e2eMailboxUrl, { signal: aborter.signal });
        if (polled.ok && polled.code && !ignored.has(polled.code)) {
          return { ok: true, code: polled.code, message: polled.message };
        }
        if (polled.fatal) {
          return { ok: false, message: polled.message, failureKind: polled.failureKind };
        }
        await delay(Math.max(1000, intervalMs), aborter.signal);
      }
      return { ok: false, message: '等待 E2E 邮件验证码超时', failureKind: 'mail_not_arrived' };
    } finally {
      if (outlookOtpAborters.get(jobId) === aborter) outlookOtpAborters.delete(jobId);
    }
  }
  // acica-first: poll by email via mail.acica.top (no nested job aborter)
  const acicaSettings = normalizeAcicaMailboxSettings((message as { acica?: unknown }).acica || DEFAULT_ACICA_MAILBOX_SETTINGS);
  const accountEmail = extractEmailFromAccountLine(message.accountLine);
  const isTokenLine = String(message.accountLine || '').includes('----') || /---/.test(String(message.accountLine || ''));
  const tryAcicaBeforeLocalOutlook = Boolean(acicaSettings.enabled && acicaSettings.preferAcicaOtp && accountEmail);
  if (tryAcicaBeforeLocalOutlook) {
    const ignored = new Set((message.ignoreCodes || []).map((code) => String(code || '').trim()).filter(Boolean));
    let acicaLast: OutlookOtpResponse = { ok: false, message: 'Acica 尚未返回验证码' };
    while (Date.now() <= deadline) {
      if (aborter.signal.aborted) {
        return { ok: false, canceled: true, message: '已停止邮箱验证码接收' };
      }
      const remainSec = Math.max(5, Math.min(acicaSettings.otpWaitSeconds, Math.ceil((deadline - Date.now()) / 1000)));
      const polled = await pollAcicaOtp(accountEmail, acicaSettings, {
        signal: aborter.signal,
        waitSeconds: remainSec,
        keyword: 'ChatGPT',
        since: startedAt,
      });
      if (polled.ok && polled.code && !ignored.has(polled.code)) {
        return { ok: true, code: polled.code, message: polled.message };
      }
      acicaLast = { ok: false, message: polled.message, failureKind: polled.failureKind };
      if (polled.fatal) {
        if (!isTokenLine) return acicaLast;
        break;
      }
      // for plain email accounts, keep waiting on Acica until deadline
      if (!isTokenLine) {
        await delay(Math.max(1000, acicaSettings.otpPollIntervalSec * 1000), aborter.signal);
        continue;
      }
      // token line: one/few acica attempts then fall back to local outlook API
      break;
    }
    if (!isTokenLine) {
      return acicaLast;
    }
  }

  try {
    while (Date.now() <= deadline) {
      if (aborter.signal.aborted) {
        return {
          ok: false,
          canceled: true,
          message: '已停止 Outlook 验证码接收',
        };
      }
      const result = await fetchLatestOtp(
        apiBase,
        message.accountLine,
        startedAt,
        message.ignoreCodes || [],
        aborter.signal,
      );
      if (result.ok && result.code) {
        return result;
      }
      if (!result.ok && result.fatal) {
        return result;
      }
      await delay(intervalMs, aborter.signal);
    }

    return {
      ok: false,
      message: '等待 Outlook 验证码超时',
    };
  } finally {
    if (outlookOtpAborters.get(jobId) === aborter) {
      outlookOtpAborters.delete(jobId);
    }
  }
}

function cancelOutlookOtp(message: OutlookOtpCancelMessage): OutlookOtpResponse {
  let canceled = false;
  if (message.jobId) {
    const aborter = outlookOtpAborters.get(message.jobId);
    if (aborter) {
      aborter.abort();
      outlookOtpAborters.delete(message.jobId);
      canceled = true;
    }
  } else {
    for (const aborter of outlookOtpAborters.values()) {
      aborter.abort();
      canceled = true;
    }
    outlookOtpAborters.clear();
  }
  return {
    ok: true,
    canceled,
    message: canceled ? '已发送停止接收验证码指令' : '当前没有正在接收的 Outlook 验证码任务',
  };
}

async function checkOutlookApi(message: OutlookApiCheckMessage): Promise<OutlookOtpResponse> {
  const apiBase = normalizeApiBase(message.apiBase || DEFAULT_OUTLOOK_API_BASE);
  let response: Response;
  try {
    response = await fetch(`${apiBase}/health`, {
      method: 'GET',
      cache: 'no-store',
      signal: AbortSignal.timeout(1800),
    });
  } catch (error) {
    return {
      ok: false,
      message: `本地 Outlook 服务未连接：${String(error)}`,
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      message: `本地 Outlook 服务异常：HTTP ${response.status}`,
    };
  }
  return {
    ok: true,
    message: '本地 Outlook 服务已启动',
  };
}

async function fetchLatestOtp(
  apiBase: string,
  accountLine: string,
  startedAt: number,
  ignoreCodes: string[] = [],
  signal?: AbortSignal,
): Promise<OutlookOtpResponse & { fatal?: boolean }> {
  let response: Response;
  try {
    response = await fetch(`${apiBase}/api/outlook/fetch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_line: accountLine,
        limit: OUTLOOK_OTP_FETCH_LIMIT,
        mailbox: 'default',
        query: OUTLOOK_OTP_QUERY,
        since: startedAt,
        unseen_only: false,
        mark_seen: false,
      }),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) {
      return {
        ok: false,
        fatal: true,
        canceled: true,
        message: '已停止 Outlook 验证码接收',
      };
    }
    return {
      ok: false,
      fatal: true,
      message: `无法连接 Outlook 本地 API：${String(error)}`,
    };
  }

  if (!response.ok) {
    const detail = await readResponseDetail(response);
    return {
      ok: false,
      fatal: true,
      message: `Outlook API 返回 ${response.status}：${detail}`,
    };
  }

  const payload = await response.json() as OutlookFetchPayload;
  const startedAtSeconds = startedAt / 1000;
  const messages = [...(payload.messages || [])].sort(
    (a, b) => Number(b.received_at || 0) - Number(a.received_at || 0),
  );

  const ignored = new Set(ignoreCodes.map((code) => String(code || '').trim()).filter(Boolean));
  const otpMessages = messages.filter((item) => {
    const code = String(item.otp || '').trim();
    return code && !ignored.has(code);
  });
  const fresh = otpMessages.find((item) => {
    if (!item.otp) {
      return false;
    }
    const receivedAt = Number(item.received_at || 0);
    return !receivedAt || receivedAt >= startedAtSeconds - 15;
  });

  const latest = fresh || (ignored.size > 0 ? undefined : otpMessages[0]);
  if (!latest?.otp) {
    return {
      ok: false,
      message: `暂未收到 Outlook 验证码，邮件数量=${messages.length}`,
    };
  }

  const receivedAt = Number(latest.received_at || 0);
  const freshnessLabel = fresh ? '新验证码' : '最近验证码';
  return {
    ok: true,
    code: String(latest.otp).trim(),
    message: `收到${freshnessLabel}：${String(latest.otp).trim()}${receivedAt ? `，邮件时间=${formatUnixTime(receivedAt)}` : ''}`,
  };
}

function isOutlookOtpMessage(message: unknown): message is OutlookOtpMessage {
  return Boolean(
    message &&
      typeof message === 'object' &&
      (message as OutlookOtpMessage).type === 'opx:wait-outlook-otp' &&
      typeof (message as OutlookOtpMessage).accountLine === 'string',
  );
}

function isOutlookOtpCancelMessage(message: unknown): message is OutlookOtpCancelMessage {
  return Boolean(
    message &&
      typeof message === 'object' &&
      (message as OutlookOtpCancelMessage).type === 'opx:cancel-outlook-otp',
  );
}

function isOutlookApiCheckMessage(message: unknown): message is OutlookApiCheckMessage {
  return Boolean(
    message &&
      typeof message === 'object' &&
      (message as OutlookApiCheckMessage).type === 'opx:check-outlook-api',
  );
}

function isOAuthCreateSessionMessage(message: unknown): message is OAuthCreateSessionMessage {
  return Boolean(
    message &&
      typeof message === 'object' &&
      (message as OAuthCreateSessionMessage).type === 'opx:oauth-create-session' &&
      typeof (message as OAuthCreateSessionMessage).email === 'string',
  );
}

function isOAuthExchangeMessage(message: unknown): message is OAuthExchangeMessage {
  return Boolean(
    message &&
      typeof message === 'object' &&
      (message as { type?: unknown }).type === 'opx:oauth-exchange-code',
  );
}

function isOAuthGenerateFromSessionMessage(message: unknown): message is OAuthGenerateFromSessionMessage {
  return Boolean(
    message &&
      typeof message === 'object' &&
      (message as { type?: unknown }).type === 'opx:oauth-generate-from-session',
  );
}

function isOAuthPhoneStartMessage(message: unknown): message is OAuthPhoneStartMessage {
  return Boolean(
    message &&
      typeof message === 'object' &&
      (message as { type?: unknown }).type === 'opx:oauth-phone-start',
  );
}

function isOAuthPhoneCancelMessage(message: unknown): message is OAuthPhoneCancelMessage {
  return Boolean(
    message &&
      typeof message === 'object' &&
      (message as { type?: unknown }).type === 'opx:oauth-phone-cancel',
  );
}

function isCheckoutLinkMessage(message: unknown): message is CheckoutLinkMessage {
  return Boolean(
    message &&
      typeof message === 'object' &&
      (message as CheckoutLinkMessage).type === 'opx:create-checkout-link' &&
      typeof (message as CheckoutLinkMessage).raw === 'string' &&
      typeof (message as CheckoutLinkMessage).options === 'object',
  );
}

function isChatGptSessionMessage(message: unknown): message is ChatGptSessionMessage {
  return Boolean(
    message &&
      typeof message === 'object' &&
      (message as ChatGptSessionMessage).type === 'opx:fetch-chatgpt-session',
  );
}

function isChatGptSessionResponse(value: unknown): value is ChatGptSessionResponse {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as ChatGptSessionResponse).ok === 'boolean' &&
      typeof (value as ChatGptSessionResponse).message === 'string',
  );
}

function isRandomAddressMessage(message: unknown): message is RandomAddressMessage {
  return Boolean(
    message &&
      typeof message === 'object' &&
      (
        (message as RandomAddressMessage).type === 'opx:fetch-random-address' ||
        (message as RandomAddressMessage).type === 'opx:fetch-random-us-address'
      ),
  );
}

function isSmsRelayFetchMessage(message: unknown): message is SmsRelayFetchMessage {
  return Boolean(
    message &&
      typeof message === 'object' &&
      (message as SmsRelayFetchMessage).type === 'opx:fetch-sms-relay' &&
      typeof (message as SmsRelayFetchMessage).url === 'string',
  );
}

function isClearDomainCookiesMessage(message: unknown): message is ClearDomainCookiesMessage {
  return Boolean(
    message &&
      typeof message === 'object' &&
      (message as ClearDomainCookiesMessage).type === 'opx:clear-domain-cookies' &&
      ((message as ClearDomainCookiesMessage).target === 'paypal' ||
        (message as ClearDomainCookiesMessage).target === 'chatgpt'),
  );
}

function isAutomationFinishCleanupMessage(message: unknown): message is AutomationFinishCleanupMessage {
  return Boolean(
    message &&
      typeof message === 'object' &&
      (message as AutomationFinishCleanupMessage).type === 'opx:automation-finish-cleanup',
  );
}

function isProxyApplyMessage(message: unknown): message is ProxyApplyRequest {
  return Boolean(
    message &&
      typeof message === 'object' &&
      (message as ProxyApplyRequest).type === 'opx:proxy-apply' &&
      typeof (message as ProxyApplyRequest).stage === 'string',
  );
}

function isProxyClearMessage(message: unknown): message is ProxyClearRequest {
  return Boolean(
    message &&
      typeof message === 'object' &&
      (message as ProxyClearRequest).type === 'opx:proxy-clear',
  );
}

function isProxyStatusMessage(message: unknown): message is ProxyStatusRequest {
  return Boolean(
    message &&
      typeof message === 'object' &&
      (message as ProxyStatusRequest).type === 'opx:proxy-status',
  );
}

function isProxySaveMessage(message: unknown): message is ProxySaveRequest {
  return Boolean(
    message &&
      typeof message === 'object' &&
      (message as ProxySaveRequest).type === 'opx:proxy-save',
  );
}

async function fetchSmsRelay(url: string): Promise<SmsRelayFetchResponse> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return {
        ok: false,
        message: '接码 API 只支持 http/https 链接',
      };
    }
  } catch {
    return {
      ok: false,
      message: '接码 API 链接格式无效',
    };
  }

  let response: Response;
  try {
    response = await fetch(parsedUrl.toString(), {
      method: 'GET',
      cache: 'no-store',
    });
  } catch (error) {
    return {
      ok: false,
      message: `接码 API 请求失败：${String(error)}`,
    };
  }

  const status = response.status;
  const { parsed: detail, text } = await readSmsRelayResponse(response);
  if (!response.ok) {
    return {
      ok: false,
      status,
      message: `接码 API 返回 ${status}：${text || response.statusText}`,
      text,
      raw: detail,
    };
  }

  if (isRecord(detail)) {
    const data = detail.data;
    const message = String(detail.msg || detail.message || 'OK');
    return {
      ok: isSmsRelaySuccessPayload(detail),
      status,
      message,
      data,
      text,
      raw: detail,
    };
  }

  return {
    ok: true,
    status,
    message: 'OK',
    data: String(detail || '').trim(),
    text,
    raw: detail,
  };
}

async function readSmsRelayResponse(response: Response): Promise<{ parsed: unknown; text: string }> {
  const text = await response.text();
  if (!text) {
    return { parsed: '', text: '' };
  }
  try {
    return { parsed: JSON.parse(text), text };
  } catch {
    return { parsed: text, text };
  }
}

function normalizeApiBase(value: string): string {
  return value.replace(/\/+$/, '');
}

async function readResponseDetail(response: Response): Promise<string> {
  try {
    const data = await response.json() as { detail?: string };
    return data.detail || response.statusText;
  } catch {
    return response.statusText;
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function makeOutlookJobId(): string {
  return `outlook-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function formatUnixTime(value: number): string {
  const milliseconds = value > 10_000_000_000 ? value : value * 1000;
  return new Date(milliseconds).toLocaleString('zh-CN', {
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object');
}

function isSmsRelaySuccessPayload(value: Record<string, unknown>): boolean {
  if (typeof value.success === 'boolean') {
    return value.success;
  }
  if (typeof value.ok === 'boolean') {
    return value.ok;
  }

  const codeValue = value.code ?? value.status ?? value.statusCode;
  if (codeValue === undefined || codeValue === null || codeValue === '') {
    return true;
  }

  const code = Number(codeValue);
  if (Number.isNaN(code)) {
    return true;
  }
  return code === 0 || code === 1 || code === 200;
}

interface OutlookFetchPayload {
  messages?: Array<{
    otp?: string;
    received_at?: number;
  }>;
}

interface NativeChromeRoot {
  chrome?: {
    action?: NativeActionApi;
    browserAction?: NativeActionApi;
    sidePanel?: NativeSidePanelApi;
    sidebarAction?: NativeSidebarActionApi;
    debugger?: NativeDebuggerApi;
  };
  browser?: {
    action?: NativeActionApi;
    browserAction?: NativeActionApi;
    sidePanel?: NativeSidePanelApi;
    sidebarAction?: NativeSidebarActionApi;
  };
}

async function loadE2eMailboxUrl(): Promise<string> {
  const key = 'opx.e2e.mailboxUrl';
  const data = await browser.storage.local.get(key);
  return typeof data[key] === 'string' ? data[key].trim() : '';
}

function isProxyAutomationStageMessage(message: unknown): message is ProxyAutomationStageRequest {
  if (!message || typeof message !== 'object') return false;
  const request = message as ProxyAutomationStageRequest;
  return request.type === 'opx:proxy-automation-stage'
    && (request.stage === 'auth' || request.stage === 'checkout' || request.stage === 'billing')
    && typeof request.cycleId === 'string';
}

interface NativeDebuggerTarget {
  tabId: number;
}

interface NativeDebuggerApi {
  attach(target: NativeDebuggerTarget, requiredVersion: string): Promise<void>;
  detach(target: NativeDebuggerTarget): Promise<void>;
  sendCommand(target: NativeDebuggerTarget, method: string, params?: Record<string, unknown>): Promise<unknown>;
}

interface NativeSidebarActionApi {
  open?: () => Promise<void> | void;
}

interface NativeActionApi {
  onClicked?: {
    addListener(listener: (tab: ChromeTab) => void): void;
  };
}

interface NativeSidePanelApi {
  setPanelBehavior?(behavior: { openPanelOnActionClick: boolean }): Promise<void> | void;
  open?(options: SidePanelOpenOptions): Promise<void> | void;
}

interface SidePanelOpenOptions {
  tabId?: number;
  windowId?: number;
}

interface ChromeTab {
  id?: number;
  windowId?: number;
}

function installProbeAlarmListener(): void {
  const alarms = (browser as typeof browser & {
    alarms?: { onAlarm?: { addListener?: (cb: (alarm: { name: string }) => void) => void } };
  }).alarms;
  if (!alarms?.onAlarm?.addListener) {
    console.debug('[OPX] alarms API unavailable, probe scheduler disabled');
    return;
  }
  alarms.onAlarm.addListener((alarm) => {
    void handleProbeAlarm(alarm.name);
  });
}

function isProbeSaveAccountsMessage(message: unknown): message is ProbeSaveAccountsMessage {
  return Boolean(message && typeof message === 'object' && (message as ProbeSaveAccountsMessage).type === 'opx:probe-save-accounts');
}
function isProbeSyncCurrentSessionMessage(message: unknown): message is { type: 'opx:probe-sync-current-session' } {
  return Boolean(message && typeof message === 'object' && (message as { type?: string }).type === 'opx:probe-sync-current-session');
}
function isProbeUpsertTaskMessage(message: unknown): message is ProbeUpsertTaskMessage {
  return Boolean(message && typeof message === 'object' && (message as ProbeUpsertTaskMessage).type === 'opx:probe-upsert-task' && (message as ProbeUpsertTaskMessage).task && typeof (message as ProbeUpsertTaskMessage).task === 'object');
}
function isProbeDeleteTaskMessage(message: unknown): message is ProbeDeleteTaskMessage {
  return Boolean(message && typeof message === 'object' && (message as ProbeDeleteTaskMessage).type === 'opx:probe-delete-task' && typeof (message as ProbeDeleteTaskMessage).taskId === 'string');
}
function isProbeControlMessage(message: unknown): message is ProbeControlMessage {
  return Boolean(message && typeof message === 'object' && (message as ProbeControlMessage).type === 'opx:probe-control' && typeof (message as ProbeControlMessage).action === 'string');
}
function isProbeClearHitsMessage(message: unknown): message is ProbeClearHitsMessage {
  return Boolean(message && typeof message === 'object' && (message as ProbeClearHitsMessage).type === 'opx:probe-clear-hits');
}
function isProbeHitDbQueryMessage(message: unknown): message is ProbeHitDbQueryMessage {
  return Boolean(message && typeof message === 'object' && (message as ProbeHitDbQueryMessage).type === 'opx:probe-hitdb-query');
}
function isProbeHitDbDeleteMessage(message: unknown): message is ProbeHitDbDeleteMessage {
  return Boolean(message && typeof message === 'object' && (message as ProbeHitDbDeleteMessage).type === 'opx:probe-hitdb-delete' && typeof (message as ProbeHitDbDeleteMessage).dbId === 'string');
}
function isProbeHitDbExportMessage(message: unknown): message is ProbeHitDbExportMessage {
  return Boolean(message && typeof message === 'object' && (message as ProbeHitDbExportMessage).type === 'opx:probe-hitdb-export');
}

function isProbeMethodsQueryMessage(message: unknown): message is ProbeMethodsQueryMessage {
  return Boolean(message && typeof message === 'object' && (message as ProbeMethodsQueryMessage).type === 'opx:probe-methods-query');
}
function isProbeMethodsExportMessage(message: unknown): message is ProbeMethodsExportMessage {
  return Boolean(message && typeof message === 'object' && (message as ProbeMethodsExportMessage).type === 'opx:probe-methods-export');
}
function isProbeMethodsClearMessage(message: unknown): message is ProbeMethodsClearMessage {
  return Boolean(message && typeof message === 'object' && (message as ProbeMethodsClearMessage).type === 'opx:probe-methods-clear');
}
function isProbeAccountReportMessage(message: unknown): message is ProbeAccountReportMessage {
  return Boolean(message && typeof message === 'object' && (message as ProbeAccountReportMessage).type === 'opx:probe-account-report');
}
function isProbeAccountActionMessage(message: unknown): message is ProbeAccountActionMessage {
  return Boolean(
    message && typeof message === 'object'
    && (message as ProbeAccountActionMessage).type === 'opx:probe-account-action'
    && ['enable', 'disable', 'delete'].includes(String((message as ProbeAccountActionMessage).action || ''))
    && Array.isArray((message as ProbeAccountActionMessage).accountIds),
  );
}
function isProbeFactorQueryMessage(message: unknown): message is ProbeFactorQueryMessage {
  return Boolean(message && typeof message === 'object' && (message as ProbeFactorQueryMessage).type === 'opx:probe-factor-query');
}
function isProbeFactorExportMessage(message: unknown): message is ProbeFactorExportMessage {
  return Boolean(message && typeof message === 'object' && (message as ProbeFactorExportMessage).type === 'opx:probe-factor-export');
}
function isProbeFactorClearMessage(message: unknown): message is ProbeFactorClearMessage {
  return Boolean(message && typeof message === 'object' && (message as ProbeFactorClearMessage).type === 'opx:probe-factor-clear');
}
function isProbeFactorImportMessage(message: unknown): message is ProbeFactorImportMessage {
  return Boolean(
    message && typeof message === 'object'
    && (message as ProbeFactorImportMessage).type === 'opx:probe-factor-import'
    && typeof (message as ProbeFactorImportMessage).text === 'string',
  );
}

function isRunLogListMessage(message: unknown): message is RunLogListMessage {
  return Boolean(message && typeof message === 'object' && (message as RunLogListMessage).type === 'opx:runlog-list');
}
function isRunLogAppendMessage(message: unknown): message is RunLogAppendMessage {
  return Boolean(message && typeof message === 'object' && (message as RunLogAppendMessage).type === 'opx:runlog-append' && (message as RunLogAppendMessage).event && typeof (message as RunLogAppendMessage).event === 'object');
}
function isRunLogClearMessage(message: unknown): message is RunLogClearMessage {
  return Boolean(message && typeof message === 'object' && (message as RunLogClearMessage).type === 'opx:runlog-clear');
}
function isRunLogExportMessage(message: unknown): message is RunLogExportMessage {
  return Boolean(message && typeof message === 'object' && (message as RunLogExportMessage).type === 'opx:runlog-export');
}
function isProbeStateMessage(message: unknown): message is ProbeStateMessage {
  return Boolean(message && typeof message === 'object' && (message as ProbeStateMessage).type === 'opx:probe-get-state');
}


function isProbeSmartStartMessage(message: unknown): message is { type: 'opx:probe-smart-start'; runHealthCheck?: boolean; startScheduled?: boolean; runOnce?: boolean } {
  return Boolean(message && typeof message === 'object' && (message as { type?: string }).type === 'opx:probe-smart-start');
}

function isProbeImportSessionMessage(message: unknown): message is { type: 'opx:probe-import-session'; email?: string; chatgptAccountId?: string; tokenRaw: string; source?: 'session' | 'automation'; identitySnapshot?: CheckoutIdentitySnapshot } {
  return Boolean(
    message
    && typeof message === 'object'
    && (message as { type?: string }).type === 'opx:probe-import-session'
    && typeof (message as { tokenRaw?: unknown }).tokenRaw === 'string',
  );
}
