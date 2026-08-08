import { setButtonPending } from '../../app/button-feedback';
import type { FeaturePanelHandle } from '../../app/types';
import { fetchChatGptSession } from '../link-extractor/session';
import type { ChatGptSessionInfo, ChatGptSessionResponse } from '../link-extractor/types';
import {
  createSavedPaymentTransport,
  classifyStoredPaymentMethodType,
  exportSavedPaymentAuditJson,
  listSavedPaymentPolicyDecisions,
  loadSavedPaymentFeatureSettings,
  loadSavedPaymentState,
  saveSavedPaymentFeatureSettings,
  saveSavedPaymentMethodList,
  type SavedPaymentStartResponse,
} from '../saved-payment-methods';

export function createPaymentPanel(container: HTMLElement): FeaturePanelHandle {
  const accountBar = document.createElement('div');
  accountBar.className = 'opx-payment-account';
  const accountIdentity = document.createElement('div');
  accountIdentity.className = 'opx-payment-account-copy';
  const accountTitle = document.createElement('strong');
  accountTitle.textContent = '未读取 ChatGPT 账号';
  const accountMeta = document.createElement('span');
  accountMeta.textContent = '等待 session';
  accountIdentity.append(accountTitle, accountMeta);
  const refreshButton = createButton('刷新', 'opx-button opx-button-secondary');
  accountBar.append(accountIdentity, refreshButton);

  const addSection = document.createElement('section');
  addSection.className = 'opx-payment-section';
  const addTitle = document.createElement('h3');
  addTitle.textContent = '添加卡片';
  const featureToggle = document.createElement('label');
  featureToggle.className = 'opx-check-row';
  const featureCheckbox = document.createElement('input');
  featureCheckbox.type = 'checkbox';
  const featureLabel = document.createElement('span');
  featureLabel.textContent = '启用测试卡保存（仅 pk_test）';
  featureToggle.append(featureCheckbox, featureLabel);
  const addGrid = document.createElement('div');
  addGrid.className = 'opx-grid opx-payment-add-grid';
  const billingName = createInput('持卡人姓名', 'text');
  billingName.autocomplete = 'cc-name';
  const publishableKey = createInput('Stripe PK 候选', 'password');
  publishableKey.autocomplete = 'off';
  publishableKey.spellcheck = false;
  addGrid.append(createField('姓名', billingName), createField('Stripe PK', publishableKey));
  const defaultToggle = document.createElement('label');
  defaultToggle.className = 'opx-check-row';
  const defaultCheckbox = document.createElement('input');
  defaultCheckbox.type = 'checkbox';
  defaultCheckbox.checked = true;
  const defaultLabel = document.createElement('span');
  defaultLabel.textContent = '设为默认支付方式';
  defaultToggle.append(defaultCheckbox, defaultLabel);
  const addButton = createButton('添加卡');
  addSection.append(addTitle, featureToggle, addGrid, defaultToggle, addButton);

  const methodSection = document.createElement('section');
  methodSection.className = 'opx-payment-section';
  const methodHead = document.createElement('div');
  methodHead.className = 'opx-payment-section-head';
  const methodTitle = document.createElement('h3');
  methodTitle.textContent = '账号支付方式';
  const exportButton = createButton('导出审计', 'opx-button opx-button-secondary');
  methodHead.append(methodTitle, exportButton);
  const methodList = document.createElement('div');
  methodList.className = 'opx-payment-method-list';
  methodSection.append(methodHead, methodList);

  const policySection = document.createElement('section');
  policySection.className = 'opx-payment-section';
  const policyTitle = document.createElement('h3');
  policyTitle.textContent = '渠道准入';
  const policyList = document.createElement('div');
  policyList.className = 'opx-payment-policy-list';
  policySection.append(policyTitle, policyList);

  const status = document.createElement('div');
  status.className = 'opx-status';
  status.dataset.toast = 'off';
  status.textContent = '等待读取当前账号。';
  container.append(accountBar, addSection, methodSection, policySection, status);

  let session: ChatGptSessionInfo | null = null;
  let refreshInFlight = false;
  let addInFlight = false;
  let featureEnabled = false;
  let lastSessionRefreshAt = 0;

  const renderFeatureControls = () => {
    billingName.disabled = !featureEnabled;
    publishableKey.disabled = !featureEnabled;
    defaultCheckbox.disabled = !featureEnabled;
    addButton.disabled = !featureEnabled || addInFlight;
  };

  const refreshFeatureSettings = async () => {
    const settings = await loadSavedPaymentFeatureSettings();
    featureEnabled = settings.enabled;
    featureCheckbox.checked = featureEnabled;
    renderFeatureControls();
  };

  const renderLocalState = async () => {
    const state = await loadSavedPaymentState();
    const account = session?.accountId ? state.accounts[session.accountId] : undefined;
    methodList.innerHTML = '';
    if (!account?.paymentMethods.length) {
      methodList.append(emptyRow('当前账号没有已复核的保存方式'));
    } else {
      const groups = [
        { id: 'merchant-saved', label: '商户保存' },
        { id: 'wallet', label: '钱包与 Link' },
        { id: 'one-time', label: '单次方式' },
      ] as const;
      for (const group of groups) {
        const methods = account.paymentMethods.filter((method) => classifyStoredPaymentMethodType(method.type) === group.id);
        if (!methods.length) continue;
        const heading = document.createElement('div');
        heading.className = 'opx-payment-method-group';
        heading.textContent = group.label;
        methodList.append(heading);
        for (const method of methods) {
          const row = document.createElement('div');
          row.className = 'opx-payment-method-row';
          const identity = document.createElement('div');
          const label = document.createElement('strong');
          label.textContent = method.card
            ? `${method.card.brand || 'Card'} •••• ${method.card.last4 || '----'}`
            : method.type;
          const detail = document.createElement('span');
          detail.textContent = method.card?.expMonth && method.card?.expYear
            ? `${String(method.card.expMonth).padStart(2, '0')}/${method.card.expYear}`
            : method.id;
          identity.append(label, detail);
          row.append(identity);
          if (group.id === 'wallet') row.append(badge('钱包', 'wallet'));
          else if (group.id === 'one-time') row.append(badge('单次', 'one-time'));
          else if (method.isDefault) row.append(badge('默认', 'verified'));
          methodList.append(row);
        }
      }
    }
  };

  const renderPolicies = () => {
    policyList.innerHTML = '';
    const groups = [
      { label: '商户保存', methods: ['card', 'paypal', 'bank_debit', 'bank_redirect', 'upi'] },
      { label: '钱包管理', methods: ['apple_pay', 'google_pay', 'link'] },
      { label: '仅单次', methods: ['pix', 'blik', 'twint', 'momo', 'gopay', 'kakao_pay'] },
    ];
    const decisions = new Map(listSavedPaymentPolicyDecisions().map((item) => [item.method, item]));
    for (const group of groups) {
      const row = document.createElement('div');
      row.className = 'opx-payment-policy-row';
      const label = document.createElement('strong');
      label.textContent = group.label;
      const values = document.createElement('span');
      values.textContent = group.methods.map((method) => {
        const item = decisions.get(method as Parameters<typeof decisions.get>[0]);
        return `${methodLabel(method)}：${policyStatusLabel(item?.status || 'unsupported')}`;
      }).join(' · ');
      row.append(label, values);
      policyList.append(row);
    }
  };

  const refresh = async () => {
    if (refreshInFlight) return;
    refreshInFlight = true;
    lastSessionRefreshAt = Date.now();
    setStatus(status, '正在读取账号和已保存方式...', 'pending');
    try {
      const response: ChatGptSessionResponse = await fetchChatGptSession();
      if (!response?.ok || !response.session?.accountId || !response.session.accessToken) {
        session = null;
        accountTitle.textContent = 'ChatGPT session 未就绪';
        accountMeta.textContent = response?.message || '请先登录 ChatGPT';
        setStatus(status, accountMeta.textContent, 'error');
        await renderLocalState();
        return;
      }
      const previousAccountId = session?.accountId || '';
      session = response.session;
      accountTitle.textContent = session.email || 'ChatGPT 账号';
      accountMeta.textContent = maskAccountId(session.accountId);
      if (previousAccountId && previousAccountId !== session.accountId) {
        setStatus(status, '账号已切换，已加载新账号的独立支付状态。', 'pending');
      }
      const listed = await createSavedPaymentTransport().listPaymentMethods({
        chatgptAccountId: session.accountId,
        accessToken: session.accessToken,
      });
      if (listed.ok && listed.data) {
        await saveSavedPaymentMethodList(session.accountId, session.email, listed.data);
        setStatus(status, `已复核 ${listed.data.paymentMethods.length} 个保存方式。`, 'ok');
      } else {
        setStatus(status, listed.message || '支付方式列表读取失败', listed.retryable ? 'pending' : 'error');
      }
      await renderLocalState();
    } catch (error) {
      setStatus(status, error instanceof Error ? error.message : String(error), 'error');
    } finally {
      refreshInFlight = false;
    }
  };

  refreshButton.addEventListener('click', () => {
    const restore = setButtonPending(refreshButton, '读取中...');
    void refresh().finally(restore);
  });

  featureCheckbox.addEventListener('change', async () => {
    featureCheckbox.disabled = true;
    try {
      const settings = await saveSavedPaymentFeatureSettings({ enabled: featureCheckbox.checked });
      featureEnabled = settings.enabled;
      setStatus(
        status,
        featureEnabled ? '测试卡保存已启用，仅接受 pk_test。' : '测试卡保存已关闭。',
        featureEnabled ? 'ok' : 'pending',
      );
    } catch (error) {
      featureCheckbox.checked = featureEnabled;
      setStatus(status, error instanceof Error ? error.message : String(error), 'error');
    } finally {
      featureCheckbox.disabled = false;
      renderFeatureControls();
    }
  });

  addButton.addEventListener('click', async () => {
    if (addInFlight) return;
    const key = publishableKey.value.trim();
    const name = billingName.value.trim();
    if (!featureEnabled) {
      setStatus(status, '请先启用测试卡保存。', 'error');
      return;
    }
    if (!session?.accountId) {
      setStatus(status, '请先刷新并确认当前 ChatGPT 账号。', 'error');
      return;
    }
    if (!/^pk_test_[A-Za-z0-9_-]+$/.test(key)) {
      setStatus(status, '当前 rollout 仅接受 Stripe 测试环境 PK。', 'error');
      return;
    }
    if (!name) {
      setStatus(status, '请输入持卡人姓名。', 'error');
      return;
    }
    addInFlight = true;
    const restore = setButtonPending(addButton, '等待页面确认...');
    setStatus(status, '已在 ChatGPT 页面打开卡片输入框。', 'pending');
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !String(tab.url || '').startsWith('https://chatgpt.com/')) {
        setStatus(status, '当前活动标签不是 ChatGPT 页面。', 'error');
        return;
      }
      const response = await browser.tabs.sendMessage(tab.id, {
        type: 'opx:saved-payment:start',
        publishableKey: key,
        billingName: name,
        setAsDefault: defaultCheckbox.checked,
      }) as SavedPaymentStartResponse;
      const needsAction = response?.code === 'SETUP_INTENT_REQUIRES_ACTION';
      const message = needsAction
        ? '需要在 ChatGPT 页面完成进一步验证。'
        : response?.message || '保存流程返回空结果';
      setStatus(status, message, response?.ok ? 'ok' : response?.code === 'USER_CANCELLED' || needsAction ? 'pending' : 'error');
      await refresh();
    } catch (error) {
      setStatus(status, error instanceof Error ? error.message : String(error), 'error');
    } finally {
      publishableKey.value = '';
      addInFlight = false;
      restore();
      renderFeatureControls();
    }
  });

  exportButton.addEventListener('click', async () => {
    const state = await loadSavedPaymentState();
    const json = exportSavedPaymentAuditJson(state, session?.accountId || '');
    downloadText(`saved-payment-audit-${Date.now()}.json`, json, 'application/json');
    setStatus(status, '已导出脱敏审计。', 'ok');
  });

  renderPolicies();
  void renderLocalState();
  void refreshFeatureSettings();
  return {
    update: async () => {
      await refreshFeatureSettings();
      if (Date.now() - lastSessionRefreshAt >= 10_000) await refresh();
      else await renderLocalState();
    },
    onShow: async () => {
      await refreshFeatureSettings();
      await refresh();
    },
  };
}

function createButton(label: string, className = 'opx-button'): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  return button;
}

function createInput(placeholder: string, type: string): HTMLInputElement {
  const input = document.createElement('input');
  input.className = 'opx-input';
  input.type = type;
  input.placeholder = placeholder;
  return input;
}

function createField(label: string, control: HTMLElement): HTMLLabelElement {
  const field = document.createElement('label');
  field.className = 'opx-field';
  const title = document.createElement('span');
  title.textContent = label;
  field.append(title, control);
  return field;
}

function emptyRow(text: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'opx-payment-empty';
  row.textContent = text;
  return row;
}

function badge(text: string, kind: string): HTMLElement {
  const element = document.createElement('span');
  element.className = `opx-payment-badge is-${kind}`;
  element.textContent = text;
  return element;
}

function setStatus(element: HTMLElement, message: string, kind: 'pending' | 'ok' | 'error'): void {
  element.textContent = String(message || '').slice(0, 300);
  element.className = 'opx-status';
  element.dataset.type = kind;
}

function maskAccountId(value: string): string {
  const id = String(value || '');
  return id.length > 12 ? `${id.slice(0, 6)}...${id.slice(-4)}` : id;
}

function downloadText(filename: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function methodLabel(method: string): string {
  const labels: Record<string, string> = {
    card: '卡片',
    paypal: 'PayPal',
    bank_debit: '银行借记',
    bank_redirect: '银行跳转',
    upi: 'UPI',
    apple_pay: 'Apple Pay',
    google_pay: 'Google Pay',
    link: 'Link',
    pix: 'PIX',
    blik: 'BLIK',
    twint: 'TWINT',
    momo: 'MoMo',
    gopay: 'GoPay',
    kakao_pay: 'Kakao Pay',
  };
  return labels[method] || method;
}

function policyStatusLabel(status: string): string {
  if (status === 'supported') return '可用';
  if (status === 'probe-required') return '待实证';
  return '不进入保存';
}
