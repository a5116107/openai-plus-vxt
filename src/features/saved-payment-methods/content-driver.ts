import { fetchChatGptSession } from '../link-extractor/session';
import {
  createWindowSavedPaymentElementBridge,
  sanitizeSavedPaymentMessage,
} from './element-bridge';
import { createSavedPaymentOrchestrator, type SavedPaymentOrchestrator } from './orchestrator';
import {
  evaluateSavedPaymentFeatureGate,
  loadSavedPaymentFeatureSettings,
  recordSavedPaymentAttempt,
} from './state';
import { createSavedPaymentTransport } from './transport';

export interface SavedPaymentStartMessage {
  type: 'opx:saved-payment:start';
  publishableKey: string;
  billingName: string;
  setAsDefault?: boolean;
}

export interface SavedPaymentStartResponse {
  ok: boolean;
  code: string;
  message: string;
  attemptId?: string;
  paymentMethodId?: string;
}

let activeOrchestrator: SavedPaymentOrchestrator | null = null;
let activeOverlayCleanup: (() => void) | null = null;

export function isSavedPaymentStartMessage(value: unknown): value is SavedPaymentStartMessage {
  if (!isRecord(value) || value.type !== 'opx:saved-payment:start') return false;
  return /^pk_(?:live|test)_[A-Za-z0-9_-]+$/.test(String(value.publishableKey || '')) &&
    typeof value.billingName === 'string' && value.billingName.trim().length > 0 && value.billingName.length <= 200 &&
    (value.setAsDefault === undefined || typeof value.setAsDefault === 'boolean');
}

export async function runSavedCardSetupInPage(
  message: SavedPaymentStartMessage,
): Promise<SavedPaymentStartResponse> {
  if (location.hostname !== 'chatgpt.com') {
    return failure('CHATGPT_PAGE_REQUIRED', '请在 ChatGPT 页面发起添加卡片');
  }
  const featureGate = evaluateSavedPaymentFeatureGate(
    await loadSavedPaymentFeatureSettings(),
    message.publishableKey,
  );
  if (!featureGate.ok) {
    return failure(featureGate.code, featureGate.message);
  }
  await activeOrchestrator?.dispose();
  activeOverlayCleanup?.();
  activeOrchestrator = null;
  activeOverlayCleanup = null;

  const sessionResponse = await fetchChatGptSession();
  const session = sessionResponse.session;
  if (!sessionResponse.ok || !session?.accountId || !session.accessToken) {
    return failure('IDENTITY_REQUIRED', sessionResponse.message || '当前 ChatGPT session 未就绪');
  }

  const attemptId = `spm-${Date.now().toString(36)}-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const overlay = createCardSetupOverlay(attemptId);
  activeOverlayCleanup = overlay.cleanup;
  const transport = createSavedPaymentTransport();
  const orchestrator = createSavedPaymentOrchestrator({
    transport,
    createBridge: ({ attemptId: bridgeAttemptId, accountDigest }) => createWindowSavedPaymentElementBridge({
      attemptId: bridgeAttemptId,
      accountDigest,
    }),
    beforeConfirm: async () => overlay.waitForConfirmation(),
  });
  activeOrchestrator = orchestrator;

  try {
    const result = await orchestrator.runCardSetup({
      attemptId,
      session: {
        chatgptAccountId: session.accountId,
        accessToken: session.accessToken,
      },
      publishableKey: message.publishableKey,
      targetSelector: overlay.targetSelector,
      billingName: message.billingName,
      setAsDefault: message.setAsDefault !== false,
    });
    await recordSavedPaymentAttempt(result).catch(() => undefined);
    return {
      ok: result.ok,
      code: result.code,
      message: sanitizeSavedPaymentMessage(result.message),
      attemptId: result.attempt.id,
      paymentMethodId: result.attempt.paymentMethodId,
    };
  } catch (error) {
    return failure('SAVED_PAYMENT_FLOW_FAILED', error instanceof Error ? error.message : String(error));
  } finally {
    if (activeOrchestrator === orchestrator) activeOrchestrator = null;
    if (activeOverlayCleanup === overlay.cleanup) activeOverlayCleanup = null;
    await orchestrator.dispose();
    overlay.cleanup();
  }
}

function createCardSetupOverlay(attemptId: string): {
  targetSelector: string;
  waitForConfirmation(): Promise<boolean>;
  cleanup(): void;
} {
  const rootId = `opx-saved-payment-${attemptId}`;
  const targetId = `${rootId}-card`;
  const root = document.createElement('div');
  root.id = rootId;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-labelledby', `${rootId}-title`);
  root.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:2147483647', 'display:grid', 'place-items:center',
    'padding:16px', 'background:rgba(3,7,18,.72)', 'font-family:Inter,system-ui,sans-serif',
  ].join(';');

  const dialog = document.createElement('section');
  dialog.style.cssText = [
    'box-sizing:border-box', 'width:min(420px,100%)', 'padding:18px', 'border:1px solid #d1d5db',
    'border-radius:8px', 'background:#fff', 'color:#111827', 'box-shadow:0 20px 60px rgba(0,0,0,.35)',
  ].join(';');
  const title = document.createElement('h2');
  title.id = `${rootId}-title`;
  title.textContent = '添加支付卡';
  title.style.cssText = 'margin:0 0 14px;font-size:18px;line-height:24px;letter-spacing:0';
  const cardTarget = document.createElement('div');
  cardTarget.id = targetId;
  cardTarget.style.cssText = 'min-height:44px;padding:12px;border:1px solid #9ca3af;border-radius:6px;background:#fff';
  const status = document.createElement('p');
  status.textContent = '正在准备安全输入框...';
  status.style.cssText = 'min-height:20px;margin:10px 0;color:#4b5563;font-size:13px;line-height:20px;letter-spacing:0';
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px';
  const cancel = button('取消', '#fff', '#374151', '#d1d5db');
  const confirm = button('保存', '#047857', '#fff', '#047857');
  confirm.disabled = true;
  confirm.style.opacity = '.55';
  actions.append(cancel, confirm);
  dialog.append(title, cardTarget, status, actions);
  root.append(dialog);
  document.documentElement.append(root);

  let settled = false;
  let resolveConfirmation: ((approved: boolean) => void) | null = null;
  const confirmation = new Promise<boolean>((resolve) => { resolveConfirmation = resolve; });
  const settle = (approved: boolean) => {
    if (settled) return;
    settled = true;
    confirm.disabled = true;
    cancel.disabled = true;
    status.textContent = approved ? '正在保存...' : '已取消';
    resolveConfirmation?.(approved);
  };
  confirm.addEventListener('click', () => settle(true));
  cancel.addEventListener('click', () => settle(false));
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') settle(false);
  };
  window.addEventListener('keydown', onKeyDown);

  return {
    targetSelector: `#${targetId}`,
    waitForConfirmation() {
      if (!settled) {
        confirm.disabled = false;
        confirm.style.opacity = '1';
        status.textContent = '填写完成后保存';
        confirm.focus();
      }
      return confirmation;
    },
    cleanup() {
      settle(false);
      window.removeEventListener('keydown', onKeyDown);
      root.remove();
    },
  };
}

function button(label: string, background: string, color: string, border: string): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  element.style.cssText = [
    'height:36px', 'padding:0 14px', `border:1px solid ${border}`, 'border-radius:6px',
    `background:${background}`, `color:${color}`, 'font:600 13px/34px Inter,system-ui,sans-serif',
    'letter-spacing:0', 'cursor:pointer',
  ].join(';');
  return element;
}

function failure(code: string, message: string): SavedPaymentStartResponse {
  return { ok: false, code, message: sanitizeSavedPaymentMessage(message) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
