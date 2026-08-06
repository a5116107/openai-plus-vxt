import './style.css';

import { loadAutomationState } from '../../src/app/state';
import { flashButtonLabel, setButtonPending } from '../../src/app/button-feedback';
import {
  DEFAULT_CHECKOUT_EXTRACT_MODE,
  DEFAULT_CHECKOUT_OPTIONS,
  normalizeCheckoutExtractMode,
  normalizeCheckoutOptions,
} from '../../src/features/link-extractor/checkout';
import {
  clearAutomationGeneratedFiles,
  parseAutomationSettings,
  saveAutomationSettings,
  updateAutomationEmails,
  updateAutomationSmsTargets,
} from '../../src/features/automation/state';
import { runAutomationForEmail } from '../../src/features/automation/runner';
import type {
  AutomationEmailAccount,
  AutomationSettings,
  AutomationSmsTarget,
  AutomationState,
} from '../../src/features/automation/types';
import type { CheckoutExtractMode } from '../../src/features/link-extractor/types';
import { OAUTH_PHONE_PROVIDER_DEFINITIONS } from '../../src/features/oauth-phone/providers';
import {
  formatOpenAiPhoneChannelLabel,
  isOpenAiPhoneSmsFirst,
  isOpenAiPhoneWhatsappFirst,
  resolveOpenAiPhoneOfferCountryIso,
  resolveOpenAiPhoneOfferSupport,
  type OpenAiPhoneChannelSupport,
} from '../../src/features/oauth-phone/openai-channel-support';
import {
  fetchOAuthPhoneOfferMatrix,
  testOAuthPhoneProvider,
} from '../../src/features/oauth-phone/service';
import {
  loadOAuthPhoneSettings,
  maskOAuthPhoneApiKey,
  parseOAuthPhoneApiTargets,
  saveOAuthPhoneSettings,
} from '../../src/features/oauth-phone/state';
import type {
  OAuthPhoneApiTarget,
  OAuthPhonePriceOffer,
  OAuthPhoneProviderId,
  OAuthPhoneProviderSelectionMode,
  OAuthPhoneSelectedOffer,
  OAuthPhoneSettings,
} from '../../src/features/oauth-phone/types';
import {
  DEFAULT_PROXY_SETTINGS,
  type AutomationProxyStage,
  type ProxyEndpoint,
  type ProxyRuntimeStatus,
  type ProxySettings,
  type ProxyStage,
} from '../../src/features/proxy/types';
import {
  formatProxyEndpoint,
  loadProxySettings,
  normalizeEndpoint,
  normalizeProxySettings,
  parseProxyConnectionList,
  parseProxyConnectionString,
} from '../../src/features/proxy/state';
import { exportSeedHealthCsv, exportSeedHealthJson } from '../../src/features/proxy/seed-health';
import { importRegisterToolConfig, importRegisterToolLocalRuntime, parseRegisterToolConfigText } from '../../src/features/proxy/import-register-tool';
import {
  importRegisterToolMailboxText,
  importRegisterToolMailboxesFromConfig,
  mergeMailboxLinesByEmail,
} from '../../src/features/automation/import-register-tool-mailboxes';
import {
  DEFAULT_ACICA_MAILBOX_SETTINGS,
  normalizeAcicaMailboxSettings,
} from '../../src/features/mailbox/acica';
import {
  buildAccountEligibilityReport,
  DEFAULT_PROBE_TASK_CONFIG,
  normalizeTaskConfig,
  queryHitDatabase,
  rankProbeCountries,
  recommendHighHitCountries,
  buildCountryMethodRecommendations,
  selectCountriesForProbe,
} from '../../src/features/probe/state';
import { defaultProbeCountries, listProbeCountries, PROBE_CHANNELS } from '../../src/features/probe/countries';
import { formatRouteVariantsText, parseRouteVariantsText } from '../../src/features/probe/experiment';
import type {
  ProbeAccountReportRow,
  ProbeCountryScore,
  ProbeFactorResponse,
  ProbeHitDashboardFilter,
  ProbeHitDashboardSummary,
  ProbeHitDatabaseRecord,
  ProbeHitDbResponse,
  ProbeHitRecord,
  ProbeResponse,
  ProbeState,
  ProbeTask,
  ProbeTaskConfig,
  ProbeTaskUnitRuntime,
} from '../../src/features/probe/types';

const PUBLIC_SMS_SOURCE_MODE = 'api';

type PasteImportDialogOptions = {
  title: string;
  description: string;
  placeholder: string;
  confirmText: string;
  onConfirm: (text: string) => void;
};

const app = document.querySelector<HTMLElement>('#app');
let statusTooltipBound = false;
let latestProbeState: ProbeState | null = null;
let latestRunLogEvents: Array<Record<string, unknown>> = [];
let runLogPollTimer: number | null = null;
let runLogLastRenderKey = '';
let latestProxySettings: ProxySettings | null = null;
let probeAccountReportPage = 1;
const PROBE_ACCOUNT_REPORT_PAGE_SIZE = 50;
const probeAccountSelection = new Set<string>();

if (app) {
  void render();
}

async function render(): Promise<void> {
  delete document.documentElement.dataset.automationSettingsReady;
  const state = await loadAutomationState();
  const oauthPhone = await loadOAuthPhoneSettings();
  const checkoutOptions = normalizeCheckoutOptions({
    ...DEFAULT_CHECKOUT_OPTIONS,
    ...state.settings.checkoutOptions,
  });
  const checkoutExtractMode = normalizeCheckoutExtractMode(state.settings.checkoutExtractMode || DEFAULT_CHECKOUT_EXTRACT_MODE);
  const generatedFiles = state.generatedFiles;
  const latestGenerated = generatedFiles.records[0] || null;
  const hasSub2api = Boolean(generatedFiles.sub2apiJson.trim());
  const hasCpa = Boolean(generatedFiles.cpaJson.trim());
  const registrationMode = state.settings.registrationMode === 'phone' ? 'phone' : 'email';
  const isPhoneRegistration = registrationMode === 'phone';
  const effectiveOAuthExtractMode = isPhoneRegistration ? 'direct' : state.settings.oauthExtractMode;

  app!.innerHTML = `
    <section class="page">
      <div class="topbar">
        <div>
          <h1 class="title">自动化设置</h1>
          <p class="subtitle">邮箱账号与验证码默认由 Acica 自动同步和取件；Outlook 本地服务保留为兜底。</p>
        </div>
        <div class="button-row">
          <button id="btn-copy-diagnostics" class="button secondary" type="button">复制诊断报告</button>
          <button id="btn-save" class="button" type="button">保存设置</button>
          <button id="btn-close" class="button secondary" type="button">关闭</button>
        </div>
      </div>
      <div class="grid settings-accordion">
        <details class="settings-panel" open>
          <summary class="settings-panel-summary">
            <span>
              <strong>注册设置</strong>
              <em>${isPhoneRegistration ? '手机号注册 · 复用 OAuth 手机接码' : `${state.emails.length} 个邮箱 · ${state.emails.filter((email) => email.status === 'error').length} 个失败`}</em>
            </span>
            <b>展开</b>
          </summary>
          <div class="settings-panel-body">
          <div class="row compact">
            <label class="field">
              <span>注册方式</span>
              <select id="registration-mode" class="select">
                ${option('email', '邮箱注册', registrationMode)}
                ${option('phone', '手机号注册', registrationMode)}
              </select>
            </label>
          </div>
          <div id="phone-registration-summary" class="subsection"${isPhoneRegistration ? '' : ' hidden'}>
            <div class="card-head">
              <div>
                <h3>手机号注册</h3>
                <p class="hint">注册取号、短信轮询和 OAuth 手机验证共用下面的 OAuth 手机接码配置。</p>
              </div>
            </div>
            <div class="pool-summary">
              OAuth 手机接码：${oauthPhone.enabled ? '启用' : '关闭'} · ${oauthPhone.sourceMode === 'api' ? `API 号码 ${oauthPhone.apiTargets.length} 个` : `平台报价 ${oauthPhone.selectedOffers.length} 个`}
            </div>
          </div>
          <div id="email-pool-fields"${isPhoneRegistration ? ' hidden' : ''}>
          <div class="table-head">
            <div>
              <h3>邮箱池</h3>
              <p class="hint">凭证和 token 在表格中脱敏显示，完整内容只保存在本地设置。默认从 mail.acica.top 自动同步邮箱并自动取验证码；一般无需粘贴 token。</p>
            </div>
            <div class="table-actions">
              <button id="btn-clear-emails" class="button secondary small" type="button">清除全部</button>
              <button id="btn-restore-emails" class="button secondary small" type="button">恢复全部</button>
              <button id="btn-import-emails" class="button secondary small" type="button">导入</button>
              <button id="btn-sync-acica-emails" class="button small" type="button">从 Acica 自动同步</button>
              <button id="btn-import-rt-emails" class="button secondary small" type="button">导入 Register-Tool 邮箱</button>
              <button id="btn-refresh-emails" class="button secondary small" type="button">刷新</button>
            </div>
          </div>
          <textarea id="raw-emails" class="raw-store" spellcheck="false">${escapeHtml(state.settings.rawEmails)}</textarea>
          <div id="email-summary" class="pool-summary"></div>
          <div id="email-table" class="table-wrap email-table-wrap"></div>
          <div class="row row-three">
            <label class="field">
              <span>邮箱选择</span>
              <select id="email-mode" class="select">
                <option value="random"${state.settings.emailSelectionMode === 'random' ? ' selected' : ''}>随机选择可用邮箱</option>
                <option value="next"${state.settings.emailSelectionMode === 'next' ? ' selected' : ''}>自动选择未执行邮箱</option>
                <option value="specified"${state.settings.emailSelectionMode === 'specified' ? ' selected' : ''}>执行指定邮箱</option>
              </select>
            </label>
            <label class="field">
              <span>指定邮箱</span>
              <select id="specified-email" class="select"></select>
            </label>
          </div>
          </div>
          </div>
        </details>

        <details class="settings-panel">
          <summary class="settings-panel-summary">
            <span>
              <strong>接码池</strong>
              <em>${state.smsTargets.length} 个号码 · ${state.smsTargets.filter((target) => target.disabled).length} 个不可用</em>
            </span>
            <b>展开</b>
          </summary>
          <div class="settings-panel-body">
          <div class="table-head">
            <div>
              <h3>接码池</h3>
              <p class="hint">填写 号码----API 链接，一行一个；导入后会合并去重。</p>
            </div>
            <div class="table-actions">
              <button id="btn-clear-sms" class="button secondary small" type="button">清除全部</button>
              <button id="btn-import-sms" class="button secondary small" type="button">导入</button>
              <button id="btn-refresh-sms" class="button secondary small" type="button">刷新</button>
            </div>
          </div>
          <textarea id="raw-sms" class="raw-store" spellcheck="false">${escapeHtml(state.settings.rawSms)}</textarea>
          <input id="sms-source-mode" type="hidden" value="api">
          <div id="sms-table" class="table-wrap sms-table-wrap"></div>
          <div class="row compact">
            <label class="field">
              <span>接码选择</span>
              <select id="sms-mode" class="select">
                <option value="random"${state.settings.smsSelectionMode === 'random' ? ' selected' : ''}>随机抽取低频号码</option>
                <option value="next"${state.settings.smsSelectionMode === 'next' ? ' selected' : ''}>按使用次数最少</option>
              </select>
            </label>
          </div>
          </div>
        </details>


        <details class="settings-panel" open>
          <summary class="settings-panel-summary">
            <span>
              <strong>代理配置（三段式）</strong>
              <em id="proxy-summary-em">前置 + 出口1 + 出口2</em>
            </span>
            <b>展开</b>
          </summary>
          <div class="settings-panel-body">
            <p class="hint">不再绑定 JP 注册 / US 支付。出口1、出口2 都可填任意国家代理；撞资格时优先用“国家出口映射”。支持一键粘贴解析 host:port:user:pass / URL / curl。</p>
            <label class="check-row"><input id="proxy-prefer-method-pools" type="checkbox" /> <span>优先使用支付方式三阶段代理池（UPL）</span></label>
            <label class="check-row"><input id="proxy-seed-health-enabled" type="checkbox" checked /> <span>启用 seed 失败冷却/自动剔除</span></label>
            <div class="row row-three">
              <label class="field">
                <span>失败冷却秒</span>
                <input id="proxy-seed-cooldown" class="input" type="number" min="0" max="86400" step="1" value="180" />
              </label>
              <label class="field">
                <span>失败 N 次剔除</span>
                <input id="proxy-seed-remove-after" class="input" type="number" min="1" max="50" step="1" value="3" />
              </label>
              <label class="field">
                <span>失败几次后开始冷却</span>
                <input id="proxy-seed-skip-after" class="input" type="number" min="1" max="20" step="1" value="1" />
              </label>
            </div>
            <div id="proxy-seed-health-board" class="pool-summary">seed 健康：未加载</div>
            <div class="button-row left">
              <button id="btn-proxy-seed-export" class="button secondary small" type="button">导出 seed 健康 CSV</button>
              <button id="btn-proxy-seed-export-json" class="button secondary small" type="button">导出 JSON</button>
            </div>
            <div class="row">
              <label class="field">
                <span>方式池 · 方法</span>
                <select id="proxy-pool-method" class="select">
                  <option value="paypal">PayPal</option>
                  <option value="momo">MoMo</option>
                  <option value="gopay">GoPay</option>
                  <option value="ideal">iDEAL</option>
                  <option value="upi">UPI</option>
                  <option value="pix">PIX</option>
                  <option value="blik">BLIK</option>
                  <option value="twint">TWINT</option>
                  <option value="kakao">Kakao</option>
                </select>
              </label>
            </div>
            <div class="row row-three">
              <label class="field">
                <span>bootstrap 池</span>
                <textarea id="proxy-pool-bootstrap" class="raw-store" spellcheck="false" placeholder="每行一个代理"></textarea>
              </label>
              <label class="field">
                <span>promotion 池</span>
                <textarea id="proxy-pool-promotion" class="raw-store" spellcheck="false" placeholder="每行一个代理"></textarea>
              </label>
              <label class="field">
                <span>provider 池</span>
                <textarea id="proxy-pool-provider" class="raw-store" spellcheck="false" placeholder="每行一个代理"></textarea>
              </label>
            </div>
            <div class="button-row left">
              <button id="btn-proxy-pool-save" class="button secondary" type="button">保存当前方式三池</button>
              <span id="proxy-pool-status" class="status">方式池未加载</span>
            </div>
            <label class="check-row">
              <input id="proxy-enabled" type="checkbox" />
              <span>启用扩展代理管理（自动按步骤切换出口）</span>
            </label>
            <div class="row">
              <label class="field">
                <span>链路模式</span>
                <select id="proxy-chain-mode" class="select">
                  <option value="direct-exit">直连出口（浏览器直接走出口1/2）</option>
                  <option value="front-gateway">前置网关（浏览器始终走前置，由本地客户端切出口）</option>
                </select>
              </label>
              <label class="field">
                <span>当前阶段</span>
                <select id="proxy-active-stage" class="select">
                  <option value="none">直连 / 未应用</option>
                  <option value="front">前置代理</option>
                  <option value="exit1">出口1（任意国家）</option>
                  <option value="exit2">出口2（任意国家）</option>
                </select>
              </label>
            </div>

            <div class="subsection">
              <div class="card-head">
                <div>
                  <h3>Auth → Checkout / 优惠评估 → Billing</h3>
                  <p class="hint">每阶段独立 seed 池；阶段进入时轮换，阶段内部保持同一出口。代理用户名可使用 {SESSION} 生成新会话。</p>
                </div>
              </div>
              <label class="check-row"><input id="proxy-auto-routing-enabled" type="checkbox" checked /> <span>启用三阶段业务出口</span></label>
              <label class="check-row"><input id="proxy-auto-sticky" type="checkbox" checked /> <span>阶段内部固定出口</span></label>
              <label class="check-row"><input id="proxy-auto-verify" type="checkbox" checked /> <span>切换后验证出口 IP / 国家</span></label>
              <label class="check-row"><input id="proxy-auto-distinct" type="checkbox" /> <span>本轮三个阶段必须使用不同出口 IP</span></label>
              <div class="row row-three">
                <label class="field">
                  <span>Auth 回退出口</span>
                  <select id="proxy-auto-auth-fallback" class="select">
                    <option value="exit1">出口1</option><option value="exit2">出口2</option><option value="front">前置</option>
                  </select>
                </label>
                <label class="field">
                  <span>Checkout 回退出口</span>
                  <select id="proxy-auto-checkout-fallback" class="select">
                    <option value="exit1">出口1</option><option value="exit2">出口2</option><option value="front">前置</option>
                  </select>
                </label>
                <label class="field">
                  <span>Billing 回退出口</span>
                  <select id="proxy-auto-billing-fallback" class="select">
                    <option value="exit2">出口2</option><option value="exit1">出口1</option><option value="front">前置</option>
                  </select>
                </label>
              </div>
              <div class="row row-three">
                <label class="field"><span>Auth seed 池</span><textarea id="proxy-auto-auth-pool" class="raw-store" spellcheck="false" placeholder="每行一个代理"></textarea></label>
                <label class="field"><span>Checkout / 优惠 seed 池</span><textarea id="proxy-auto-checkout-pool" class="raw-store" spellcheck="false" placeholder="每行一个代理"></textarea></label>
                <label class="field"><span>Billing seed 池</span><textarea id="proxy-auto-billing-pool" class="raw-store" spellcheck="false" placeholder="每行一个代理"></textarea></label>
              </div>
              <div class="row row-three">
                <label class="check-row"><input id="proxy-auto-auth-rotate" type="checkbox" checked /> <span>Auth 进入时轮换</span></label>
                <label class="check-row"><input id="proxy-auto-checkout-rotate" type="checkbox" checked /> <span>Checkout 进入时轮换</span></label>
                <label class="check-row"><input id="proxy-auto-billing-rotate" type="checkbox" checked /> <span>Billing 进入时轮换</span></label>
              </div>
              <label class="field">
                <span>不同出口最大尝试次数</span>
                <input id="proxy-auto-max-attempts" class="input" type="number" min="1" max="10" step="1" value="3" />
              </label>
              <div id="proxy-auto-evidence" class="pool-summary">三阶段出口证据：尚未运行</div>
            </div>

            <div class="subsection">
              <div class="card-head">
                <div>
                  <h3>一键解析代理</h3>
                  <p class="hint">支持：host:port:user:pass · user:pass@host:port · scheme://user:pass@host:port · curl -x ... -U ...。可多行，按目标槽位填充。</p>
                </div>
              </div>
              <textarea id="proxy-paste-raw" class="textarea" spellcheck="false" placeholder="us2.cliproxy.io:3010:htzg1141917-region-Rand-sid-xxxx-t-5:braujrvs&#10;或&#10;http://user:pass@host:3010&#10;或 curl -x us2.cliproxy.io:3010 -U &quot;user:pass&quot;"></textarea>
              <div class="row">
                <label class="field">
                  <span>解析目标</span>
                  <select id="proxy-parse-target" class="select">
                    <option value="exit1">填到出口1</option>
                    <option value="exit2">填到出口2</option>
                    <option value="front">填到前置代理</option>
                    <option value="exit1-exit2">多行：第1条→出口1，第2条→出口2</option>
                    <option value="country">解析为国家出口映射行</option>
                  </select>
                </label>
                <label class="field">
                  <span>默认协议</span>
                  <select id="proxy-parse-scheme" class="select">
                    <option value="http">HTTP</option>
                    <option value="https">HTTPS</option>
                    <option value="socks5">SOCKS5</option>
                    <option value="socks4">SOCKS4</option>
                  </select>
                </label>
              </div>
              <div class="button-row left">
                <button id="btn-proxy-parse-fill" class="button" type="button">一键解析并填充</button>
                <button id="btn-proxy-parse-save" class="button secondary" type="button">解析并保存</button>
                <button id="btn-proxy-parse-clear" class="button secondary small" type="button">清空粘贴框</button>
              </div>
              <div id="proxy-parse-status" class="pool-summary">粘贴代理文本后点“一键解析并填充”。</div>
            </div>

            <div class="subsection" id="proxy-register-tool-panel">
              <div class="card-head">
                <div>
                  <h3>接入 GPT-Register-Tool 配置环境</h3>
                  <p class="hint">参考本机工具：前置 10808 + 链式出口 TH:18090 / IN:18091 / JP:18092 / US:18093。可粘贴 config.json，或一键套用本机链式默认。</p>
                </div>
              </div>
              <textarea id="proxy-register-tool-json" class="textarea" spellcheck="false" placeholder="粘贴 GPT-Register-Tool 的 config.json 全文，或只贴 proxy/paypal/upi 片段"></textarea>
              <div class="row">
                <div class="field">
                  <span>选项</span>
                  <label class="check-row"><input id="proxy-rt-enable-pools" type="checkbox" checked /> <span>导入 paypal/upi 方式三阶段池</span></label>
                  <label class="check-row"><input id="proxy-rt-merge" type="checkbox" /> <span>与现有国家映射/方式池合并</span></label>
                  <label class="check-row"><input id="proxy-rt-save-apply" type="checkbox" checked /> <span>导入后保存并应用前置</span></label>
                  <label class="check-row"><input id="proxy-rt-import-mailboxes" type="checkbox" checked /> <span>JSON 含单账号时同步写入邮箱池</span></label>
                </div>
              </div>
              <div class="button-row left">
                <button id="btn-proxy-rt-local" class="button" type="button">一键本机链式默认</button>
                <button id="btn-proxy-rt-import" class="button secondary" type="button">从粘贴 JSON 导入</button>
                <button id="btn-proxy-rt-mailboxes" class="button secondary" type="button">仅导入邮箱文件文本</button>
                <button id="btn-proxy-rt-clear" class="button secondary small" type="button">清空粘贴</button>
              </div>
              <div id="proxy-rt-status" class="pool-summary">未接入。代理可一键默认；邮箱池需另导 mailbox_acica_export.txt（代理≠账号）。</div>
            </div>

            <div class="subsection">
              <div class="card-head">
                <div>
                  <h3>前置代理</h3>
                  <p class="hint">本地海外环境入口，常见 7890 / 10808。可开关。</p>
                </div>
              </div>
              <label class="check-row">
                <input id="proxy-front-enabled" type="checkbox" />
                <span>启用前置代理</span>
              </label>
              <div class="row row-three">
                <label class="field">
                  <span>协议</span>
                  <select id="proxy-front-scheme" class="select">
                    <option value="http">HTTP</option>
                    <option value="https">HTTPS</option>
                    <option value="socks5">SOCKS5</option>
                    <option value="socks4">SOCKS4</option>
                  </select>
                </label>
                <label class="field">
                  <span>主机</span>
                  <input id="proxy-front-host" class="input" type="text" placeholder="127.0.0.1" />
                </label>
                <label class="field">
                  <span>端口</span>
                  <input id="proxy-front-port" class="input" type="number" min="0" max="65535" step="1" placeholder="7890" />
                </label>
              </div>
              <div class="row">
                <label class="field">
                  <span>用户名（可选）</span>
                  <input id="proxy-front-username" class="input" type="text" autocomplete="off" />
                </label>
                <label class="field">
                  <span>密码（可选）</span>
                  <input id="proxy-front-password" class="input" type="password" autocomplete="off" />
                </label>
              </div>
              <div class="button-row left">
                <button id="btn-proxy-preset-7890" class="button secondary small" type="button">预设 7890</button>
                <button id="btn-proxy-preset-10808" class="button secondary small" type="button">预设 10808</button>
              </div>
            </div>

            <div class="subsection">
              <div class="card-head">
                <div>
                  <h3>出口代理 1（任意国家/用途）</h3>
                  <p class="hint">可用于注册、探测、支付等任意阶段，不再固定 JP。</p>
                </div>
              </div>
              <label class="check-row">
                <input id="proxy-exit1-enabled" type="checkbox" />
                <span>启用出口1</span>
              </label>
              <div class="row row-three">
                <label class="field">
                  <span>协议</span>
                  <select id="proxy-exit1-scheme" class="select">
                    <option value="http">HTTP</option>
                    <option value="https">HTTPS</option>
                    <option value="socks5">SOCKS5</option>
                    <option value="socks4">SOCKS4</option>
                  </select>
                </label>
                <label class="field">
                  <span>主机</span>
                  <input id="proxy-exit1-host" class="input" type="text" placeholder="us2.cliproxy.io 或任意出口主机" />
                </label>
                <label class="field">
                  <span>端口</span>
                  <input id="proxy-exit1-port" class="input" type="number" min="0" max="65535" step="1" placeholder="10001" />
                </label>
              </div>
              <div class="row">
                <label class="field">
                  <span>用户名（可选）</span>
                  <input id="proxy-exit1-username" class="input" type="text" autocomplete="off" />
                </label>
                <label class="field">
                  <span>密码（可选）</span>
                  <input id="proxy-exit1-password" class="input" type="password" autocomplete="off" />
                </label>
              </div>
            </div>

            <div class="subsection">
              <div class="card-head">
                <div>
                  <h3>出口代理 2（任意国家/用途）</h3>
                  <p class="hint">可与出口1使用不同国家/会话；撞资格更推荐下方“国家出口映射”。</p>
                </div>
              </div>
              <label class="check-row">
                <input id="proxy-exit2-enabled" type="checkbox" />
                <span>启用出口2</span>
              </label>
              <div class="row row-three">
                <label class="field">
                  <span>协议</span>
                  <select id="proxy-exit2-scheme" class="select">
                    <option value="http">HTTP</option>
                    <option value="https">HTTPS</option>
                    <option value="socks5">SOCKS5</option>
                    <option value="socks4">SOCKS4</option>
                  </select>
                </label>
                <label class="field">
                  <span>主机</span>
                  <input id="proxy-exit2-host" class="input" type="text" placeholder="sg.cliproxy.io 或任意出口主机" />
                </label>
                <label class="field">
                  <span>端口</span>
                  <input id="proxy-exit2-port" class="input" type="number" min="0" max="65535" step="1" placeholder="10002" />
                </label>
              </div>
              <div class="row">
                <label class="field">
                  <span>用户名（可选）</span>
                  <input id="proxy-exit2-username" class="input" type="text" autocomplete="off" />
                </label>
                <label class="field">
                  <span>密码（可选）</span>
                  <input id="proxy-exit2-password" class="input" type="password" autocomplete="off" />
                </label>
              </div>
            </div>

            <div class="button-row left">
              <button id="btn-proxy-save" class="button" type="button">保存代理</button>
              <button id="btn-proxy-apply" class="button secondary" type="button">应用当前阶段</button>
              <button id="btn-proxy-clear" class="button secondary" type="button">清除代理</button>
              <button id="btn-proxy-refresh" class="button secondary" type="button">刷新状态</button>
            </div>
            <div id="proxy-status" class="status">等待加载代理配置。</div>
          </div>
        </details>


        <details class="settings-panel" open>
          <summary class="settings-panel-summary">
            <span>
              <strong>优惠资格探测（撞资格）</strong>
              <em id="probe-summary-em">同账号多出口提试用/优惠链接</em>
            </span>
            <b>展开</b>
          </summary>
          <div class="settings-panel-body">
            <p class="hint">本质：同一账号在任意多个国家出口发起 checkout“撞资格”。出口不限 JP/US，国家越多覆盖越全。命中后提醒并入库。</p>

            <div class="subsection">
              <div class="card-head">
                <div>
                  <h3>探测账号</h3>
                  <p class="hint">每行一个：email----accessToken；也支持直接粘贴 OAuth/Session JSON，自动提取 access_token + session_token 并恢复身份 Cookie。</p>
                </div>
                <div class="table-actions">
                  <button id="btn-probe-sync-session" class="button small" type="button">同步当前登录会话</button>
                  <button id="btn-probe-save-accounts" class="button secondary small" type="button">保存账号</button>
                </div>
              </div>
              <textarea id="probe-raw-accounts" class="textarea" spellcheck="false" placeholder="user@example.com----eyJhbGciOi...&#10;{&quot;credentials&quot;:{&quot;access_token&quot;:&quot;eyJ...&quot;,&quot;session_token&quot;:&quot;...&quot;}}"></textarea>
              <div id="probe-account-summary" class="pool-summary">尚未加载账号</div>
            </div>

            <div class="subsection">
              <div class="card-head">
                <div>
                  <h3>定时自动探测 + 提醒</h3>
                  <p class="hint">入口代理负责预热；出口按国家 follow 切换后发起 checkout。</p>
                </div>
              </div>
              <div class="row">
                <label class="field">
                  <span>任务名称</span>
                  <input id="probe-task-name" class="input" type="text" placeholder="如：欧洲多国探测" />
                </label>
                <label class="field">
                  <span>轮询间隔(秒)</span>
                  <input id="probe-interval" class="input" type="number" min="15" max="3600" step="1" value="60" />
                </label>
              </div>
              <div class="row">
                <label class="field">
                  <span>单浏览器并发（固定）</span>
                  <input id="probe-concurrency" class="input" type="number" min="1" max="1" step="1" value="1" disabled />
                </label>
                <label class="field">
                  <span>重试次数</span>
                  <input id="probe-retry" class="input" type="number" min="0" max="10" step="1" value="3" />
                </label>
              </div>
              <div class="row">
                <label class="field">
                  <span>计划</span>
                  <select id="probe-plan" class="select">
                    <option value="chatgptplusplan">Plus</option>
                    <option value="chatgptteamplan">Team</option>
                  </select>
                </label>
                <label class="field">
                  <span>账号来源</span>
                  <select id="probe-account-source" class="select">
                    <option value="enabled">启用账号</option>
                    <option value="all">全部账号</option>
                    <option value="manual-only">仅手动导入</option>
                  </select>
                </label>
              </div>
              <div class="row">
                <label class="field">
                  <span>入口代理（预热/刷Token）</span>
                  <select id="probe-entry-proxy" class="select">
                    <option value="front">前置代理</option>
                    <option value="exit1">出口1</option>
                    <option value="none">不切换</option>
                  </select>
                </label>
                <label class="field">
                  <span>出口代理（发起 Checkout）</span>
                  <select id="probe-exit-proxy" class="select">
                    <option value="follow-country">跟随目标国家(follow)</option>
                    <option value="fixed-exit2">固定出口2</option>
                    <option value="fixed-front">固定前置</option>
                    <option value="none">不切换</option>
                  </select>
                </label>
              </div>

              <div class="card-head">
                <div>
                  <h3>出口国家（可多选）</h3>
                  <p class="hint">已选 <span id="probe-country-count">0</span> 个</p>
                </div>
                <div class="table-actions">
                  <button id="btn-probe-country-all" class="button secondary small" type="button">全选</button>
                  <button id="btn-probe-country-none" class="button secondary small" type="button">清空</button>
                  <button id="btn-probe-country-default" class="button secondary small" type="button">常用</button>
                </div>
              </div>
              <div id="probe-country-grid" class="probe-country-grid"></div>

              <div class="card-head" style="margin-top:8px">
                <div>
                  <h3>支付通道（可多选）</h3>
                </div>
              </div>
              <div id="probe-channel-row" class="probe-channel-row"></div>

              <div class="row">
                <div class="field">
                  <span>视觉提醒</span>
                  <label class="check-row"><input id="probe-pin-success" type="checkbox" checked /> <span>成功即置顶/角标</span></label>
                  <label class="check-row"><input id="probe-skip-after-hit" type="checkbox" checked /> <span>账号成功后跳过本轮剩余国家</span></label>
                  <label class="check-row"><input id="probe-auto-switch-exit" type="checkbox" checked /> <span>按国家自动切换出口代理</span></label>
                  <label class="check-row"><input id="probe-auto-open-hit" type="checkbox" checked /> <span>命中后自动打开结账页</span></label>
                  <label class="check-row"><input id="probe-sniff-hit" type="checkbox" checked /> <span>打开后识别 0 金额/试用文案</span></label>
                  <label class="check-row"><input id="probe-save-hitdb" type="checkbox" checked /> <span>命中链接保存到数据库</span></label>
                  <label class="check-row"><input id="probe-exclude-unhealthy" type="checkbox" checked /> <span>按健康检查自动剔除失败出口</span></label>
                  <label class="check-row"><input id="probe-high-rate-only" type="checkbox" /> <span>高命中率国家优先轮询</span></label>
                  <label class="check-row"><input id="probe-exploration-enabled" type="checkbox" checked /> <span>保留实验性国家探测</span></label>
                  <label class="check-row"><input id="probe-factor-tracking" type="checkbox" checked /> <span>记录逐次变量并分析资格因素</span></label>
                  <label class="check-row"><input id="probe-drift-detection" type="checkbox" checked /> <span>检测命中率/价格/方式漂移</span></label>
                  <input id="probe-research-mode" type="checkbox" hidden />
                  <label class="check-row"><input id="probe-balanced-order" type="checkbox" checked /> <span>账号使用错位国家顺序抵消顺序效应</span></label>
                  <span style="margin-top:8px">受控因素</span>
                  <label class="check-row"><input data-probe-factor="account" type="checkbox" checked /> <span>账号</span></label>
                  <label class="check-row"><input data-probe-factor="country" type="checkbox" checked /> <span>国家</span></label>
                  <label class="check-row"><input data-probe-factor="route" type="checkbox" checked /> <span>三阶段路由</span></label>
                  <label class="check-row"><input data-probe-factor="paymentMethod" type="checkbox" checked /> <span>支付方式</span></label>
                  <label class="check-row"><input data-probe-factor="seed" type="checkbox" checked /> <span>seed / 动态出口</span></label>
                  <label class="check-row"><input data-probe-factor="time" type="checkbox" checked /> <span>跨时段</span></label>
                  <label class="check-row"><input data-probe-factor="sequence" type="checkbox" checked /> <span>执行顺序</span></label>
                  <label class="check-row"><input id="probe-staged-pipeline" type="checkbox" /> <span>启用 UPL 三阶段（bootstrap→promotion→provider）</span></label>
                  <label class="check-row"><input id="probe-use-selected-bootstrap" type="checkbox" checked /> <span>选中国家同时作为 bootstrap/provider</span></label>
                  <label class="check-row"><input id="probe-enable-promotion-update" type="checkbox" checked /> <span>中段调用 checkout/update</span></label>
                  <label class="check-row"><input id="probe-enable-provider-taxes" type="checkbox" /> <span>末段调用 checkout/taxes</span></label>
                  <label class="check-row"><input id="probe-require-zero" type="checkbox" /> <span>requireZero：非 0 金额直接丢弃</span></label>
                  <div class="field">
                    <span>Checkout 页面模式</span>
                    <select id="probe-checkout-ui-mode" class="select">
                      <option value="hosted">Hosted 长链（默认）</option>
                      <option value="custom">Custom 直卡短链</option>
                      <option value="both">双模式（分别创建并保存）</option>
                    </select>
                  </div>
                  <label class="check-row"><input id="probe-extract-final-url" type="checkbox" /> <span>命中后提取支付终链（iDEAL/UPI/PIX…）</span></label>
                  <label class="check-row"><input id="probe-enable-stripe-confirm" type="checkbox" /> <span>可选 Stripe confirm 提链（需 pk）</span></label>
                  <label class="check-row"><input id="probe-extract-all-methods" type="checkbox" checked /> <span>为全部已探测支付方式分别提取终链</span></label>
                  <label class="check-row"><input id="probe-force-unlisted-methods" type="checkbox" /> <span>实验筛查页面未显示的配置方式（仅资格筛查）</span></label>
                  <label class="check-row"><input id="probe-detect-methods" type="checkbox" /> <span>探测 payment_method_types（Stripe init）</span></label>
                  <label class="check-row"><input id="probe-attach-detected-methods" type="checkbox" checked /> <span>把探测到的方式写入渠道/标签</span></label>
                  <label class="check-row"><input id="probe-auto-apply-detected-methods" type="checkbox" checked /> <span>按国家自动推荐支付方式（仅用探测到的支持方式）</span></label>
                </div>
                <div class="field">
                  <span>支付 Checkout 会话</span>
                  <select id="probe-payment-checkout-mode" class="select">
                    <option value="reuse_eligibility_session">复用资格 Checkout（默认，验证资格保持）</option>
                    <option value="independent_checkout">新建独立 Checkout（实验对照，可能重新定价）</option>
                  </select>
                  <span>提醒方式</span>
                  <select id="probe-notify-mode" class="select">
                    <option value="sound-badge">声音 + 角标（默认）</option>
                    <option value="sound-badge-pin">声音 + 角标 + 置顶</option>
                    <option value="silent">静默仅记录</option>
                  </select>
                  <label class="check-row" style="margin-top:8px"><input id="probe-sound-enabled" type="checkbox" checked /> <span>声音/通知提醒</span></label>
                  <label class="check-row"><input id="probe-tls-note" type="checkbox" checked /> <span>Checkout 走浏览器 TLS（扩展内建）</span></label>
                </div>
              </div>

              <div class="row row-three">
                <label class="field">
                  <span>实验策略</span>
                  <select id="probe-experiment-mode" class="select">
                    <option value="hybrid">混合：命中 + 归因 + 探索</option>
                    <option value="discovery">发现：优先扩大命中</option>
                    <option value="attribution">归因：完整平衡对照</option>
                  </select>
                </label>
                <label class="field"><span>利用流量%</span><input id="probe-exploit-percent" class="input" type="number" min="0" max="100" value="50" /></label>
                <label class="field"><span>平衡流量%</span><input id="probe-balanced-percent" class="input" type="number" min="0" max="100" value="30" /></label>
                <label class="field"><span>探索流量%</span><input id="probe-explore-percent" class="input" type="number" min="0" max="100" value="20" /></label>
                <label class="field">
                  <span>最低命中率%</span>
                  <input id="probe-min-hit-rate" class="input" type="number" min="0" max="100" step="1" value="30" />
                </label>
                <label class="field">
                  <span>最低尝试次数</span>
                  <input id="probe-min-hit-attempts" class="input" type="number" min="1" max="1000" step="1" value="3" />
                </label>
                <label class="field">
                  <span>高命中最多国家数(0不限)</span>
                  <input id="probe-max-high-rate" class="input" type="number" min="0" max="200" step="1" value="12" />
                </label>
                <label class="field">
                  <span>每轮实验国家数</span>
                  <input id="probe-exploration-count" class="input" type="number" min="0" max="50" step="1" value="2" />
                </label>
                <label class="field">
                  <span>自适应探索占比%</span>
                  <input id="probe-adaptive-percent" class="input" type="number" min="5" max="50" step="1" value="20" />
                </label>
                <label class="field">
                  <span>因素最小样本</span>
                  <input id="probe-factor-min-samples" class="input" type="number" min="2" max="200" step="1" value="5" />
                </label>
                <label class="field">
                  <span>漂移单侧最小样本</span>
                  <input id="probe-drift-min-samples" class="input" type="number" min="2" max="500" step="1" value="10" />
                </label>
                <label class="field">
                  <span>观测保留条数</span>
                  <input id="probe-observation-limit" class="input" type="number" min="500" max="10000" step="100" value="3000" />
                </label>
                <label class="field">
                  <span>每个账号×出口目标样本</span>
                  <input id="probe-research-target-cell" class="input" type="number" min="1" max="20" step="1" value="3" />
                </label>
                <label class="field">
                  <span>同组合复测间隔(分钟)</span>
                  <input id="probe-research-repeat-minutes" class="input" type="number" min="0" max="10080" step="15" value="240" />
                </label>
                <label class="field">
                  <span>因果结论最低总样本</span>
                  <input id="probe-research-min-total" class="input" type="number" min="20" max="10000" step="10" value="100" />
                </label>
                <label class="field">
                  <span>每单元 seed 重复数</span>
                  <input id="probe-seed-replicates" class="input" type="number" min="1" max="20" step="1" value="3" />
                </label>
                <label class="field">
                  <span>promotion 国家（中段）</span>
                  <input id="probe-promotion-country" class="input" type="text" maxlength="2" placeholder="VN" value="VN" />
                </label>
                <label class="field">
                  <span>固定 bootstrap 国家</span>
                  <input id="probe-bootstrap-country" class="input" type="text" maxlength="2" placeholder="空=跟随选中" value="" />
                </label>
                <label class="field">
                  <span>固定 provider 国家</span>
                  <input id="probe-provider-country" class="input" type="text" maxlength="2" placeholder="空=跟随选中" value="" />
                </label>
                <label class="field">
                  <span>优先支付方式</span>
                  <select id="probe-payment-method" class="select">
                    <option value="">跟随渠道</option>
                    <option value="paypal">PayPal</option>
                    <option value="momo">MoMo</option>
                    <option value="gopay">GoPay</option>
                    <option value="ideal">iDEAL</option>
                    <option value="upi">UPI</option>
                    <option value="pix">PIX</option>
                    <option value="blik">BLIK</option>
                    <option value="twint">TWINT</option>
                    <option value="kakao">Kakao</option>
                    <option value="hosted">Hosted</option>
                  </select>
                </label>
                <label class="field">
                  <span>iDEAL 银行</span>
                  <input id="probe-ideal-bank" class="input" type="text" placeholder="n26" value="n26" />
                </label>
                <label class="field">
                  <span>Stripe pk（可选 confirm）</span>
                  <input id="probe-stripe-pk" class="input" type="text" placeholder="pk_live_... / pk_test_..." value="" />
                </label>
              </div>
              <div class="button-row left">
                <button id="btn-probe-smart-once" class="button" type="button">智能开跑一轮</button>
                <button id="btn-probe-smart-start" class="button secondary" type="button">智能启动定时</button>
                <button id="btn-probe-create-task" class="button secondary" type="button">创建/更新探测任务</button>
                <button id="btn-probe-run-once" class="button secondary" type="button">立即跑一轮</button>
                <button id="btn-probe-start" class="button secondary" type="button">启动定时</button>
                <button id="btn-probe-stop" class="button secondary" type="button">停止</button>
                <button id="btn-probe-refresh" class="button secondary" type="button">刷新</button>
              </div>
              <div id="probe-task-status" class="status">等待创建探测任务。注册读到 session 后会自动同步探测池。</div>
            </div>

            <div class="subsection" id="runlog-panel">
              <div class="card-head">
                <div>
                  <h3>任务运行中心</h3>
                  <p class="hint">任务总进度和逐账号、逐国家调度单元终态；处理数只表示真实请求，完成数包含自动跳过。</p>
                </div>
              </div>
              <div class="row">
                <label class="field">
                  <span>三阶段路由变体（名称=Auth&gt;Checkout&gt;Billing，@=当前国家）</span>
                  <textarea id="probe-route-variants" class="textarea" rows="4" spellcheck="false"></textarea>
                </label>
                <label class="field">
                  <span>支付方式实验白名单（逗号分隔，空=全部已探测支持方式）</span>
                  <input id="probe-payment-variants" class="input" type="text" placeholder="ideal,upi,pix" />
                </label>
              </div>
              <div id="probe-run-summary" class="pool-summary">尚未开始任务</div>
              <div id="probe-run-board" class="table-wrap"></div>
            </div>

            <div class="subsection" id="runlog-panel-stream">
              <div class="card-head">
                <div>
                  <h3>实时运行日志</h3>
                  <p class="hint">吸收对方日志台：账号标签 · 级别色 · 阶段/进度 · 可行动失败提示 · 导出。</p>
                </div>
                <div class="table-actions">
                  <span id="runlog-connected" class="runlog-pill" data-connected="1">实时日志已连接</span>
                  <button id="btn-runlog-refresh" class="button secondary small" type="button">刷新</button>
                  <button id="btn-runlog-clear" class="button secondary small" type="button">清空</button>
                  <button id="btn-runlog-export-csv" class="button secondary small" type="button">导出 CSV</button>
                  <button id="btn-runlog-export-jsonl" class="button secondary small" type="button">导出 JSONL</button>
                </div>
              </div>
              <div class="row">
                <label class="field">
                  <span>级别过滤</span>
                  <select id="runlog-filter-level" class="select">
                    <option value="all">全部</option>
                    <option value="debug">debug</option>
                    <option value="info">info</option>
                    <option value="success">success</option>
                    <option value="warn">warn</option>
                    <option value="error">error</option>
                  </select>
                </label>
                <label class="field">
                  <span>账号过滤</span>
                  <input id="runlog-filter-account" class="input" type="text" placeholder="账号# / email / id" />
                </label>
                <div class="field">
                  <span>显示</span>
                  <label class="check-row"><input id="runlog-autoscroll" type="checkbox" checked /> <span>自动滚动</span></label>
                  <label class="check-row"><input id="runlog-live" type="checkbox" checked /> <span>实时轮询(1.5s)</span></label>
                </div>
              </div>
              <div id="runlog-summary" class="pool-summary">尚未加载运行日志</div>
              <div id="runlog-stream" class="runlog-stream" aria-live="polite"></div>
            </div>

            <div class="subsection">
              <div class="card-head">
                <div>
                  <h3>国家出口映射（可选）</h3>
                  <p class="hint">每行：CC----host:port 或 CC----scheme://user:pass@host:port。用于 follow-country；可与一键解析的“解析为国家出口映射”配合，不限 JP/US。</p>
                </div>
                <div class="table-actions">
                  <button id="btn-probe-save-country-exits" class="button secondary small" type="button">保存映射</button>
                </div>
              </div>
              <textarea id="probe-country-exits" class="textarea" spellcheck="false" placeholder="PH----127.0.0.1:7901&#10;ID----socks5://127.0.0.1:7902&#10;TR----http://user:pass@1.2.3.4:8080"></textarea>
            </div>

            <div class="subsection">
              <div class="card-head">
                <div>
                  <h3>国家 × 通道成功率</h3>
                  <p class="hint">根据历史探测尝试统计命中率，便于优选出口。</p>
                </div>
              </div>
              <div id="probe-stats-table" class="table-wrap"></div>
            </div>

            <div class="subsection">
              <div class="card-head">
                <div>
                  <h3>高命中国家推荐 / 本轮有效出口</h3>
                  <p class="hint">结合健康检查 + 命中率阈值，预览本轮会跑哪些国家；可一键应用到勾选。</p>
                </div>
                <div class="table-actions">
                  <button id="btn-probe-plan-preview" class="button secondary small" type="button">刷新预览</button>
                  <button id="btn-probe-apply-highrate" class="button secondary small" type="button">应用高命中到勾选</button>
                </div>
              </div>
              <div id="probe-plan-summary" class="pool-summary">尚未预览本轮有效国家</div>
              <div id="probe-recommend-table" class="table-wrap"></div>
            <div class="subsection">
              <div class="card-head">
                <div>
                  <h3>方式探测结果看板</h3>
                  <p class="hint">按国家汇总探测到的 <code>payment_method_types</code>（仅展示实际支持的方式），并给出推荐支付方式。</p>
                </div>
                <div class="table-actions">
                  <button id="btn-probe-methods-refresh" class="button secondary small" type="button">刷新</button>
                  <button id="btn-probe-methods-export" class="button secondary small" type="button">导出 CSV</button>
                  <button id="btn-probe-methods-clear" class="button secondary small" type="button">清空</button>
                  <button id="btn-probe-apply-method-rec" class="button secondary small" type="button">应用推荐方式到任务</button>
                </div>
              </div>
              <div id="probe-methods-summary" class="pool-summary">尚未加载方式探测结果</div>
              <div id="probe-methods-table" class="table-wrap"></div>
            </div>

            </div>

            <div class="subsection">
              <div class="card-head">
                <div>
                  <h3>出口代理健康检查</h3>
                  <p class="hint">按当前任务国家切换出口，请求 chatgpt trace 测通。</p>
                </div>
                <div class="table-actions">
                  <button id="btn-probe-health" class="button secondary small" type="button">检查出口健康</button>
                </div>
              </div>
              <div id="probe-health-table" class="table-wrap"></div>
            </div>

            <div class="subsection">
              <div class="card-head">
                <div>
                  <h3>账号资格撞库报表</h3>
                  <p class="hint">按账号汇总 zero/trial/promo 命中、国家覆盖和最佳资格，便于筛选可继续撞的号。</p>
                </div>
                <div class="table-actions">
                  <button id="btn-probe-account-select-page" class="button secondary small" type="button">选择本页</button>
                  <button id="btn-probe-account-enable" class="button secondary small" type="button">批量启用</button>
                  <button id="btn-probe-account-disable" class="button secondary small" type="button">批量停用</button>
                  <button id="btn-probe-account-delete" class="button secondary small" type="button">批量删除</button>
                  <button id="btn-probe-account-report-refresh" class="button secondary small" type="button">刷新报表</button>
                  <button id="btn-probe-account-report-export" class="button secondary small" type="button">导出报表 CSV</button>
                </div>
              </div>
              <div class="row">
                <label class="field"><span>资产状态</span><select id="probe-account-filter-status" class="select">
                  <option value="all">全部账号</option><option value="enabled">已启用</option><option value="disabled">已停用</option>
                  <option value="healthy">凭据健康</option><option value="expiring">凭据将过期</option><option value="expired">凭据已过期</option>
                  <option value="hit">已有资格链接</option><option value="error">最近失败</option>
                </select></label>
                <label class="field"><span>搜索</span><input id="probe-account-filter-query" class="input" type="search" placeholder="邮箱 / 账号 / 国家" /></label>
                <div class="field"><span>分页</span><div class="button-row left">
                  <button id="btn-probe-account-prev" class="button secondary small" type="button">上一页</button>
                  <button id="btn-probe-account-next" class="button secondary small" type="button">下一页</button>
                  <span id="probe-account-page-summary" class="status">第 1 页</span>
                </div></div>
              </div>
              <div id="probe-account-report-summary" class="pool-summary">账号报表未加载</div>
              <div id="probe-account-report-table" class="table-wrap"></div>
            </div>

            <div class="subsection">
              <div class="card-head">
                <div>
                  <h3>资格因素与规则漂移</h3>
                  <p class="hint">按账号、国家、阶段出口、IP/ASN、支付方式、时间及交互项分层；区间估计用于控制小样本误判。</p>
                </div>
                <div class="table-actions">
                  <button id="btn-probe-factor-refresh" class="button secondary small" type="button">刷新分析</button>
                  <button id="btn-probe-factor-import" class="button secondary small" type="button">导入观测</button>
                  <button id="btn-probe-factor-export-csv" class="button secondary small" type="button">导出 CSV</button>
                  <button id="btn-probe-factor-export-json" class="button secondary small" type="button">导出 JSON</button>
                  <button id="btn-probe-factor-clear" class="button secondary small" type="button">清空观测</button>
                </div>
              </div>
              <div id="probe-factor-summary" class="pool-summary">尚未积累逐次实验观测</div>
              <div id="probe-quality-summary" class="pool-summary">证据质量尚未评估</div>
              <div id="probe-runner-summary" class="pool-summary">支付 Runner 尚无观测</div>
              <h4 class="probe-factor-subhead">实验可识别性门禁</h4>
              <div id="probe-readiness-summary" class="pool-summary">尚未评估账号与出口条件</div>
              <div id="probe-readiness-table" class="table-wrap"></div>
              <h4 class="probe-factor-subhead">平衡实验覆盖</h4>
              <div id="probe-matrix-summary" class="pool-summary">尚未建立账号×出口矩阵</div>
              <div id="probe-matrix-table" class="table-wrap"></div>
              <div id="probe-factor-conclusions" class="probe-factor-conclusions"></div>
              <h4 class="probe-factor-subhead">匹配对照与混杂审计</h4>
              <div id="probe-controlled-table" class="table-wrap"></div>
              <div id="probe-confounding-table" class="table-wrap"></div>
              <h4 class="probe-factor-subhead">统计功效与样本缺口</h4>
              <div id="probe-power-table" class="table-wrap"></div>
              <div id="probe-factor-table" class="table-wrap"></div>
              <h4 class="probe-factor-subhead">上游漂移告警</h4>
              <div id="probe-drift-table" class="table-wrap"></div>
              <h4 class="probe-factor-subhead">下一轮实验建议</h4>
              <div id="probe-adaptive-table" class="table-wrap"></div>
            </div>

            <div class="subsection">
              <div class="card-head">
                <div>
                  <h3>运行命中（本轮缓存）</h3>
                  <p class="hint">当前轮次即时命中；正式沉淀看下方命中数据库看板。</p>
                </div>
                <div class="table-actions">
                  <button id="btn-probe-clear-hits" class="button secondary small" type="button">清空运行命中</button>
                  <button id="btn-probe-copy-hits" class="button secondary small" type="button">复制有效链接</button>
                </div>
              </div>
              <div id="probe-hit-table" class="table-wrap"></div>
            </div>

            <div class="subsection">
              <div class="card-head">
                <div>
                  <h3>命中链接数据库看板</h3>
                  <p class="hint">命中后自动入库，支持筛选、导出 CSV、单条删除。</p>
                </div>
                <div class="table-actions">
                  <button id="btn-probe-hitdb-refresh" class="button secondary small" type="button">刷新看板</button>
                  <button id="btn-probe-hitdb-export" class="button secondary small" type="button">导出 CSV</button>
                  <button id="btn-probe-hitdb-clear" class="button secondary small" type="button">清空数据库</button>
                </div>
              </div>
              <div class="row row-three">
                <label class="field">
                  <span>国家</span>
                  <input id="probe-hitdb-country" class="input" type="text" placeholder="如 PH" />
                </label>
                <label class="field">
                  <span>类型</span>
                  <select id="probe-hitdb-kind" class="select">
                    <option value="">全部</option>
                    <option value="zero">zero</option>
                    <option value="trial">trial</option>
                    <option value="promo">promo</option>
                    <option value="link">link</option>
                    <option value="channel">channel</option>
                  </select>
                </label>
                <label class="field">
                  <span>关键词</span>
                  <input id="probe-hitdb-query" class="input" type="text" placeholder="email/链接/备注" />
                </label>
              </div>
              <label class="check-row">
                <input id="probe-hitdb-only-link" type="checkbox" checked />
                <span>仅显示有链接记录</span>
              </label>
              <label class="check-row">
                <input id="probe-hitdb-only-usable" type="checkbox" checked />
                <span>仅显示资格门通过的有效链接</span>
              </label>
              <div id="probe-hitdb-summary" class="pool-summary">命中库未加载</div>
              <div id="probe-hitdb-table" class="table-wrap"></div>
            </div>
          </div>
        </details>

        <details class="settings-panel" open>
          <summary class="settings-panel-summary">
            <span>
              <strong>提取设置</strong>
              <em>${checkoutExtractMode === 'server' ? '服务器 API' : '本地提取'} · OAuth ${effectiveOAuthExtractMode === 'direct' ? '直接生成' : '邮箱接码提取'} · 手机接码 ${oauthPhone.enabled ? '启用' : '关闭'}</em>
            </span>
            <b>展开</b>
          </summary>
          <div class="settings-panel-body">
          <div class="row">
            <label class="field">
              <span>支付链接提取模式</span>
              <select id="checkout-extract-mode" class="select">
                ${option('local', '本地提取 （需要本地JP代理）', checkoutExtractMode)}
                ${option('server', '服务器 API （无需任何代理）', checkoutExtractMode)}
              </select>
            </label>
          </div>
          <div class="row">
            <label class="field">
              <span>提取 OAuth 方式</span>
              <select id="oauth-extract-mode" class="select">
                ${option('email', '邮箱接码提取', effectiveOAuthExtractMode)}
                ${option('direct', '直接生成文件', effectiveOAuthExtractMode)}
              </select>
            </label>
            <label class="field">
              <span>执行账号数</span>
              <input id="batch-account-limit" class="input" type="number" min="1" max="999" step="1" value="${state.settings.batchAccountLimit}" />
            </label>
          </div>
          <div id="checkout-options-row" class="row row-three">
            <label class="field">
              <span>套餐</span>
              <select id="checkout-plan" class="select">
                ${option('chatgptplusplan', 'ChatGPT Plus', checkoutOptions.planName)}
                ${option('chatgptteamplan', 'ChatGPT Team', checkoutOptions.planName)}
              </select>
            </label>
            <label class="field">
              <span>链接形式</span>
              <select id="checkout-ui-mode" class="select">
                ${option('hosted', '长链接 / hosted', checkoutOptions.uiMode)}
                ${option('custom', '短链接 / custom', checkoutOptions.uiMode)}
              </select>
            </label>
            <label class="field">
              <span>计费区域</span>
              <select id="checkout-region" class="select">
                ${option('US', '美国 / USD', checkoutOptions.region)}
                ${option('PH', '菲律宾 / PHP', checkoutOptions.region)}
                ${option('ID', '印尼 / IDR', checkoutOptions.region)}
                ${option('TR', '土耳其 / TRY', checkoutOptions.region)}
                ${option('AR', '阿根廷 / USD', checkoutOptions.region)}
                ${option('BR', '巴西 / BRL', checkoutOptions.region)}
                ${option('IN', '印度 / INR', checkoutOptions.region)}
                ${option('DE', '德国 / EUR', checkoutOptions.region)}
                ${option('JP', '日本 / JPY', checkoutOptions.region)}
                ${option('GB', '英国 / GBP', checkoutOptions.region)}
              </select>
            </label>
          </div>
          <label class="check-row">
            <input id="stop-on-error" type="checkbox"${state.settings.stopOnError ? ' checked' : ''} />
            <span>步骤失败后停止自动执行</span>
          </label>
          <label class="check-row">
            <input id="auto-open-checkout" type="checkbox"${state.settings.autoOpenCheckout ? ' checked' : ''} />
            <span>生成订阅链接后自动打开</span>
          </label>
          <div class="subsection">
            <div class="card-head">
              <div>
                <h3>Plus 双 Checkout 闭环</h3>
                <p class="hint">启用后支付阶段使用 A / 保存卡 / B / Saved Card / billing / Plus 状态机。</p>
              </div>
            </div>
            <label class="check-row">
              <input id="plus-closure-enabled" type="checkbox"${state.settings.plusCheckoutClosure.enabled ? ' checked' : ''} />
              <span>启用双 Checkout 闭环</span>
            </label>
            <label class="check-row">
              <input id="plus-closure-live-enabled" type="checkbox"${state.settings.plusCheckoutClosure.liveEnabled ? ' checked' : ''} />
              <span>启用 live 商户路径</span>
            </label>
            <label class="check-row">
              <input id="plus-closure-require-network" type="checkbox"${state.settings.plusCheckoutClosure.requireVerifiedNetwork ? ' checked' : ''} />
              <span>要求 Checkout 实际出口证据</span>
            </label>
            <div class="row row-three">
              <label class="field"><span>目标国家</span><input id="plus-closure-target-country" class="input" maxlength="2" value="${escapeHtml(state.settings.plusCheckoutClosure.targetCountry)}" /></label>
              <label class="field"><span>账单国家</span><input id="plus-closure-billing-country" class="input" maxlength="2" value="${escapeHtml(state.settings.plusCheckoutClosure.billingCountry)}" /></label>
              <label class="field"><span>预期币种</span><input id="plus-closure-currency" class="input" maxlength="3" value="${escapeHtml(state.settings.plusCheckoutClosure.expectedCurrency)}" /></label>
            </div>
          </div>
          <label class="check-row">
            <input id="debug-mode" type="checkbox"${state.settings.debugMode ? ' checked' : ''} />
            <span>调试模式：记录详细步骤、页面状态和失败诊断</span>
          </label>

          <div id="oauth-phone-section" class="subsection">
            <div class="card-head">
              <div>
                <h3>OAuth 手机接码</h3>
                <p class="hint">注册手机号和 OAuth 手机验证共用这套 OpenAI 手机接码配置。</p>
              </div>
              <button id="btn-save-oauth-phone" class="button secondary small" type="button">保存接码设置</button>
            </div>
            <label class="check-row">
              <input id="oauth-phone-enabled" type="checkbox"${oauthPhone.enabled ? ' checked' : ''} />
              <span>启用 OAuth 手机接码模块</span>
            </label>
            <div class="row oauth-phone-mode-row">
              <label class="field">
                <span>接码模式</span>
                <select id="oauth-phone-source-mode" class="select">
                  ${option('provider', '接码平台接码', oauthPhone.sourceMode)}
                  ${option('api', 'API 接码池', oauthPhone.sourceMode)}
                </select>
              </label>
              <label class="field">
                <span>接码超时</span>
                <input id="oauth-phone-timeout" class="input" type="number" min="15" max="600" step="1" value="${oauthPhone.smsTimeoutSeconds || 120}" />
              </label>
            </div>
            <div class="row row-three oauth-provider-mode-panel">
              <label class="field">
                <span>快速切换平台</span>
                <select id="oauth-phone-active-provider" class="select">
                  ${oauthPhoneProviderOptions(oauthPhone.activeProviderId)}
                </select>
              </label>
              <label class="field">
                <span>平台选择策略</span>
                <select id="oauth-phone-provider-mode" class="select">
                  ${option('priority', '优先当前平台', oauthPhone.providerMode)}
                  ${option('lowest-price', '价格最低优先', oauthPhone.providerMode)}
                  ${option('highest-stock', '库存最多优先', oauthPhone.providerMode)}
                </select>
              </label>
              <label class="field">
                <span>服务代码 / 项目 ID（Fox SMS 默认 91）</span>
                <input id="oauth-phone-service-code" class="input" value="${escapeAttr(oauthPhone.serviceCode)}" placeholder="dr / 91" />
              </label>
            </div>
            <div class="row compact oauth-provider-mode-panel">
              <div class="field">
                <span>已选择报价</span>
                <div id="oauth-phone-selected-summary" class="pool-summary">${oauthPhone.selectedOffers.length ? `${oauthPhone.selectedOffers.length} 个报价` : '未选择报价'}</div>
              </div>
            </div>
            <div class="table-wrap oauth-phone-table-wrap oauth-provider-mode-panel">
              <table class="data-table oauth-phone-table">
                <thead>
                  <tr>
                    <th>平台</th>
                    <th>启用</th>
                    <th>API key</th>
                    <th>优先级</th>
                    <th>状态</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  ${oauthPhone.providers.map((provider) => `
                    <tr data-provider-id="${escapeAttr(provider.id)}">
                      <td><strong class="email-text">${escapeHtml(providerLabel(provider.id))}</strong></td>
                      <td><input id="oauth-phone-provider-enabled-${provider.id}" type="checkbox"${provider.enabled ? ' checked' : ''} /></td>
                      <td>
                        <input id="oauth-phone-provider-key-${provider.id}" class="input compact-input" type="password" value="${escapeAttr(provider.apiKey)}" placeholder="${escapeAttr(maskOAuthPhoneApiKey(provider.apiKey) || 'API key')}" autocomplete="off" />
                      </td>
                      <td>
                        <input id="oauth-phone-provider-priority-${provider.id}" class="input compact-input" type="number" min="1" max="99" step="1" value="${provider.priority}" />
                      </td>
                      <td><span id="oauth-phone-provider-status-${provider.id}" class="status-pill" data-status="${provider.enabled ? 'idle' : 'error'}">${provider.enabled ? '待测试' : '未启用'}</span></td>
                      <td>
                        <div class="table-action-group">
                          <button id="btn-test-oauth-phone-${provider.id}" class="table-action-button" type="button">测试</button>
                        </div>
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
            <div class="table-head compact oauth-provider-mode-panel">
              <div>
                <h3>可用报价</h3>
                <p class="hint">自动去除单价为 0 或余量为 0 的报价，价格统一显示为美元；Tiger SMS 从 ₽ 换算，Fox SMS 从 ¥ 换算。</p>
              </div>
              <div class="table-actions">
                <button id="btn-refresh-oauth-phone-offers" class="button secondary small" type="button">刷新报价</button>
              </div>
            </div>
            <div class="oauth-offer-controls oauth-provider-mode-panel">
              <label class="field offer-search-field">
                <span>搜索国家</span>
                <input id="oauth-offer-search" class="input" value="" placeholder="国家 / ID / ISO / 平台" />
              </label>
              <label class="field offer-channel-field">
                <span>OpenAI 渠道</span>
                <select id="oauth-offer-channel-filter" class="select">
                  ${option('all', '全部渠道', 'all')}
                  ${option('sms', 'SMS 优先', 'all')}
                  ${option('whatsapp', 'WhatsApp 优先', 'all')}
                </select>
              </label>
              <label class="field offer-filter-field">
                <span>使用状态</span>
                <select id="oauth-offer-use-filter" class="select">
                  ${option('all', '全部报价', 'all')}
                  ${option('selected', '已使用', 'all')}
                  ${option('unselected', '未使用', 'all')}
                </select>
              </label>
              <label class="field offer-sort-field">
                <span>排序方式</span>
                <select id="oauth-offer-sort" class="select">
                  ${option('price-asc', '单价从低到高', 'price-asc')}
                  ${option('price-desc', '单价从高到低', 'price-asc')}
                  ${option('stock-desc', '余量从高到低', 'price-asc')}
                  ${option('stock-asc', '余量从低到高', 'price-asc')}
                </select>
              </label>
              <label class="field offer-price-field">
                <span>最低接受价格</span>
                <input id="oauth-phone-min-price" class="input" type="number" min="0" step="0.0001" value="${oauthPhone.minPrice || ''}" placeholder="0 表示不限制" />
              </label>
              <label class="field offer-price-field">
                <span>最高接受价格</span>
                <input id="oauth-phone-max-price" class="input" type="number" min="0" step="0.0001" value="${oauthPhone.maxPrice || ''}" placeholder="0 表示不限制" />
              </label>
            </div>
            <div id="oauth-phone-offers" class="table-wrap oauth-offer-table-wrap oauth-provider-mode-panel">${renderOAuthPhoneOfferTable(oauthPhone.selectedOffers, oauthPhone.selectedOffers, '点击刷新报价读取平台库存。')}</div>
            <div class="oauth-api-mode-panel">
              <div class="table-head compact">
                <div>
                  <h3>API 接码池</h3>
                  <p class="hint">每行一个号码和接码 API 链接，格式为 号码----API 链接。</p>
                </div>
                <div class="table-actions">
                  <button id="btn-import-oauth-phone-api" class="button secondary small" type="button">导入 API 接码</button>
                  <button id="btn-refresh-oauth-phone-api" class="button secondary small" type="button">刷新预览</button>
                  <button id="btn-clear-oauth-phone-api" class="button danger small" type="button">清空</button>
                </div>
              </div>
              <textarea id="oauth-phone-raw-api-targets" class="raw-store oauth-api-raw-store" spellcheck="false">${escapeHtml(oauthPhone.rawApiTargets)}</textarea>
              <div id="oauth-phone-api-targets" class="table-wrap oauth-api-table-wrap">${renderOAuthPhoneApiTargetTable(oauthPhone.rawApiTargets, oauthPhone.apiTargets)}</div>
            </div>
            <div id="oauth-phone-status" class="status">OAuth 手机接码配置会同时用于手机号注册和 OAuth 手机验证。</div>
          </div>

          <div id="status" class="status">等待保存。</div>
          </div>
        </details>

        <details class="settings-panel">
          <summary class="settings-panel-summary">
            <span>
              <strong>生成文件</strong>
              <em>${generatedFiles.records.length ? `${generatedFiles.records.length} 个账号已保存` : '暂无生成内容'}</em>
            </span>
            <b>展开</b>
          </summary>
          <div class="settings-panel-body">
          <div class="card-head">
            <div>
              <h2>生成文件</h2>
              <p class="hint">第 19 步会把 sub2api / CPA 保存到这里，多个账号会累积到同一份汇总内容。</p>
            </div>
            <button id="btn-clear-generated" class="button secondary small" type="button"${generatedFiles.records.length ? '' : ' disabled'}>清空文件</button>
          </div>
          <div class="file-meta">
            ${
              latestGenerated
                ? `已保存 ${generatedFiles.records.length} 个账号；最近：${escapeHtml(latestGenerated.email)}，${formatTime(latestGenerated.createdAt)}`
                : '还没有生成文件。运行第 19 步后会自动保存到这里。'
            }
          </div>
          <label class="field">
            <span>sub2api 汇总 JSON</span>
            <textarea id="generated-sub2api" class="textarea output-textarea" spellcheck="false" readonly placeholder="暂无 sub2api 内容">${escapeHtml(generatedFiles.sub2apiJson)}</textarea>
          </label>
          <div class="button-row left">
            <button id="btn-copy-sub2api" class="button secondary small" type="button"${hasSub2api ? '' : ' disabled'}>复制 sub2api</button>
            <button id="btn-download-sub2api" class="button secondary small" type="button"${hasSub2api ? '' : ' disabled'}>下载 sub2api</button>
          </div>
          <label class="field">
            <span>CPA 汇总 JSON（每个账号一条）</span>
            <textarea id="generated-cpa" class="textarea output-textarea" spellcheck="false" readonly placeholder="暂无 CPA 内容">${escapeHtml(generatedFiles.cpaJson)}</textarea>
          </label>
          <div class="button-row left">
            <button id="btn-copy-cpa" class="button secondary small" type="button"${hasCpa ? '' : ' disabled'}>复制 CPA</button>
            <button id="btn-download-cpa" class="button secondary small" type="button"${hasCpa ? '' : ' disabled'}>下载 CPA</button>
          </div>
          <div id="output-status" class="status">生成后的内容保存在浏览器本地存储。</div>
          </div>
        </details>
      </div>
    </section>
  `;

  const status = mustGet('status');
  const rawEmailsInput = mustGet('raw-emails') as HTMLTextAreaElement;
  const rawSmsInput = mustGet('raw-sms') as HTMLTextAreaElement;
  const registrationModeSelect = mustGet('registration-mode') as HTMLSelectElement;
  const specifiedEmailSelect = mustGet('specified-email') as HTMLSelectElement;
  const checkoutExtractModeSelect = mustGet('checkout-extract-mode') as HTMLSelectElement;
  const oauthExtractModeSelect = mustGet('oauth-extract-mode') as HTMLSelectElement;

  renderEmailTable();
  renderSmsTable();
  syncSpecifiedEmails(state.settings.specifiedEmailId);
  syncCheckoutOptionsVisibility();
  syncRegistrationModeVisibility();
  setupStatusTooltips();
  bindProxyPanel();
  void loadAndFillProxyPanel();
  bindProbePanel();
  void loadAndFillProbePanel();
  void refreshRunLogPanel();
  startRunLogLivePolling();

  const clearEmailsButton = mustGet('btn-clear-emails') as HTMLButtonElement;
  clearEmailsButton.addEventListener('click', () => {
    updateRawEmails('');
    setInlineStatus(status, '邮箱池已清空，点击保存后生效。', 'ok');
    flashButtonLabel(clearEmailsButton, '已清空');
  });
  const restoreEmailsButton = mustGet('btn-restore-emails') as HTMLButtonElement;
  restoreEmailsButton.addEventListener('click', async () => {
    const restoreButton = setButtonPending(restoreEmailsButton, '恢复中...');
    try {
      const latest = await loadAutomationState();
      const restorable = latest.emails.filter(isEmailRestorable);
      if (!restorable.length) {
        setInlineStatus(status, '邮箱池没有需要恢复的状态。', 'ok');
        flashButtonLabel(restoreEmailsButton, '无需恢复');
        return;
      }
      const next = await updateAutomationEmails(latest.emails.map((email) => isEmailRestorable(email) ? restoreEmailAccount(email) : email));
      Object.assign(state, next);
      renderEmailTable();
      syncSpecifiedEmails(specifiedEmailSelect.value);
      setInlineStatus(status, `已恢复 ${restorable.length} 个邮箱，可继续使用。`, 'ok');
      flashButtonLabel(restoreEmailsButton, '已恢复');
    } catch (error) {
      setInlineStatus(status, `恢复邮箱失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      restoreButton();
    }
  });
  const refreshEmailsButton = mustGet('btn-refresh-emails') as HTMLButtonElement;
  refreshEmailsButton.addEventListener('click', () => {
    renderEmailTable();
    syncSpecifiedEmails(specifiedEmailSelect.value);
    setInlineStatus(status, '邮箱池预览已刷新。', 'ok');
    flashButtonLabel(refreshEmailsButton, '已刷新');
  });
    const importEmailsButton = mustGet('btn-import-emails') as HTMLButtonElement;
  importEmailsButton.addEventListener('click', () => {
    openPasteImportDialog({
      title: '导入邮箱池',
      description: '每行一个 Outlook 账号。支持 Register-Tool 的 ---- 四段式，以及 mailbox_tokens.txt 的 --- 三段式（自动补 client_id）。',
      placeholder: 'email@outlook.com----password----clientId----refreshToken',
      confirmText: '导入邮箱',
      onConfirm: (text) => {
        const imported = importRegisterToolMailboxText(text, { source: 'paste' });
        if (imported.ok) {
          updateRawEmails(mergeMailboxLinesByEmail(rawEmailsInput.value, imported.lines));
          setInlineStatus(status, `${imported.message}，点击保存后生效。`, 'ok');
          return;
        }
        updateRawEmails(mergeLines(rawEmailsInput.value, text));
        setInlineStatus(status, `${imported.message}；已按原始行合并 ${countRawLines(text)} 行，点击保存后生效。`, imported.count ? 'ok' : 'error');
      },
    });
    flashButtonLabel(importEmailsButton, '已打开');
  });
  const syncAcicaEmailsButton = mustGet('btn-sync-acica-emails') as HTMLButtonElement;
  syncAcicaEmailsButton.addEventListener('click', async () => {
    const restoreButton = setButtonPending(syncAcicaEmailsButton, '同步中...');
    try {
      const acica = normalizeAcicaMailboxSettings(state.settings.acicaMailbox || DEFAULT_ACICA_MAILBOX_SETTINGS);
      const synced = await browser.runtime.sendMessage({
        type: 'opx:acica-sync-emails',
        settings: acica,
      }) as { ok?: boolean; message?: string; lines?: string[]; count?: number };
      if (!synced?.ok || !Array.isArray(synced.lines) || !synced.lines.length) {
        setInlineStatus(status, synced?.message || 'Acica 同步失败', 'error');
        return;
      }
      updateRawEmails(mergeMailboxLinesByEmail(rawEmailsInput.value, synced.lines));
      // auto save
      const next = await saveCurrentSettings({
        rawEmails: (document.getElementById('raw-emails') as HTMLTextAreaElement).value,
        acicaMailbox: acica,
      });
      setInlineStatus(status, `${synced.message || ('已同步 ' + (synced.count || synced.lines.length) + ' 个邮箱')}，已保存 ${next.emails.length} 个。`, 'ok');
      window.setTimeout(() => void render(), 200);
      flashButtonLabel(syncAcicaEmailsButton, '已同步');
    } catch (error) {
      setInlineStatus(status, error instanceof Error ? error.message : String(error), 'error');
    } finally {
      restoreButton();
    }
  });
  const importRtEmailsButton = mustGet('btn-import-rt-emails') as HTMLButtonElement;
  importRtEmailsButton.addEventListener('click', () => {
    openPasteImportDialog({
      title: '导入 Register-Tool 邮箱',
      description: '粘贴 mailbox_acica_export.txt / mailbox_acica_chatai.txt / mailbox_tokens.txt 全文。注意：之前接入的 mailbox_proxy 只是邮箱请求代理，不会自动带入账号。',
      placeholder: '从 GPT-Register-Tool 目录复制邮箱文件内容到这里',
      confirmText: '导入并规范化',
      onConfirm: (text) => {
        const imported = importRegisterToolMailboxText(text, { source: 'register-tool-file' });
        if (!imported.ok) {
          setInlineStatus(status, imported.message + (imported.errors[0] ? `；${imported.errors[0]}` : ''), 'error');
          return;
        }
        updateRawEmails(mergeMailboxLinesByEmail(rawEmailsInput.value, imported.lines));
        setInlineStatus(status, `${imported.message}，点击保存后生效。`, 'ok');
      },
    });
    flashButtonLabel(importRtEmailsButton, '已打开');
  });
const clearSmsButton = mustGet('btn-clear-sms') as HTMLButtonElement;
  clearSmsButton.addEventListener('click', () => {
    updateRawSms('');
    setInlineStatus(status, '接码池已清空，点击保存后生效。', 'ok');
    flashButtonLabel(clearSmsButton, '已清空');
  });
  const refreshSmsButton = mustGet('btn-refresh-sms') as HTMLButtonElement;
  refreshSmsButton.addEventListener('click', () => {
    renderSmsTable();
    setInlineStatus(status, '接码池预览已刷新。', 'ok');
    flashButtonLabel(refreshSmsButton, '已刷新');
  });
  const importSmsButton = mustGet('btn-import-sms') as HTMLButtonElement;
  importSmsButton.addEventListener('click', () => {
    openPasteImportDialog({
      title: '导入接码池',
      description: '每行一个接码配置，格式为 号码----API 链接，导入后会合并去重。',
      placeholder: '+14642649811----https://mail-api.example.com/api/text-relay/xxxx',
      confirmText: '导入接码',
      onConfirm: (text) => {
        updateRawSms(mergeLines(rawSmsInput.value, text));
        setInlineStatus(status, `已导入接码 ${countRawLines(text)} 行，点击保存后生效。`, 'ok');
      },
    });
    flashButtonLabel(importSmsButton, '已打开');
  });
  checkoutExtractModeSelect.addEventListener('change', syncCheckoutOptionsVisibility);
  registrationModeSelect.addEventListener('change', () => {
    syncRegistrationModeVisibility();
    renderEmailTable();
    syncSpecifiedEmails(specifiedEmailSelect.value);
    setInlineStatus(
      status,
      registrationModeSelect.value === 'phone'
        ? '已切换为手机号注册，注册取号将复用 OAuth 手机接码配置。'
        : '已切换为邮箱注册。',
      'ok',
    );
  });
  wireGeneratedFileActions();
  wireOAuthPhoneActions(oauthPhone);
  mustGet('btn-close').addEventListener('click', () => window.close());
  const copyDiagnosticsButton = mustGet('btn-copy-diagnostics') as HTMLButtonElement;
  copyDiagnosticsButton.addEventListener('click', async () => {
    const restoreButton = setButtonPending(copyDiagnosticsButton, '复制中...');
    let copied = false;
    try {
      const latest = await loadAutomationState();
      await navigator.clipboard.writeText(await buildAutomationDiagnosticReport(latest));
      setInlineStatus(status, '诊断报告已复制。', 'ok');
      copied = true;
    } catch (error) {
      setInlineStatus(status, `复制诊断报告失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      restoreButton();
      if (copied) {
        flashButtonLabel(copyDiagnosticsButton, '已复制');
      }
    }
  });
  const saveButton = mustGet('btn-save') as HTMLButtonElement;
  saveButton.addEventListener('click', async () => {
    const restoreButton = setButtonPending(saveButton, '保存中...');
    try {
      const next = await saveCurrentSettings();
      setInlineStatus(
        status,
        next.settings.registrationMode === 'phone'
          ? `已保存：手机号注册，复用 OAuth 手机接码；支付接码 ${next.smsTargets.length} 个。`
          : `已保存：${next.emails.length} 个邮箱，${next.smsTargets.length} 个接码。`,
        'ok',
      );
      window.setTimeout(() => void render(), 300);
    } catch (error) {
      setInlineStatus(status, error instanceof Error ? error.message : String(error), 'error');
    } finally {
      restoreButton();
    }
  });
  document.documentElement.dataset.automationSettingsReady = 'true';

  function collectSettingsPatch(overrides: Partial<AutomationSettings> = {}): Partial<AutomationSettings> {
    const rawEmails = valueOf('raw-emails');
    const rawSms = valueOf('raw-sms');
    const registrationMode = valueOf('registration-mode') === 'phone' ? 'phone' : 'email';
    const emailSelectionMode = registrationMode === 'phone'
      ? 'next'
      : valueOf('email-mode') === 'specified'
        ? 'specified'
        : valueOf('email-mode') === 'next' ? 'next' : 'random';
    const smsSourceMode = PUBLIC_SMS_SOURCE_MODE;
    const smsSelectionMode = valueOf('sms-mode') === 'next' ? 'next' : 'random';
    const batchAccountLimit = Number(valueOf('batch-account-limit') || 1);
    const specifiedEmailId = registrationMode === 'phone' ? '' : valueOf('specified-email');
    const stopOnError = checkedOf('stop-on-error');
    const autoOpenCheckout = checkedOf('auto-open-checkout');
    const debugMode = checkedOf('debug-mode');
    const oauthExtractMode = registrationMode === 'phone'
      ? 'direct'
      : valueOf('oauth-extract-mode') === 'direct' ? 'direct' : 'email';
    const checkoutExtractMode = valueOf('checkout-extract-mode') as CheckoutExtractMode;
    const plusCheckoutClosure = {
      enabled: checkedOf('plus-closure-enabled'),
      liveEnabled: checkedOf('plus-closure-live-enabled'),
      requireVerifiedNetwork: checkedOf('plus-closure-require-network'),
      targetCountry: valueOf('plus-closure-target-country').trim().toUpperCase(),
      billingCountry: valueOf('plus-closure-billing-country').trim().toUpperCase(),
      expectedCurrency: valueOf('plus-closure-currency').trim().toUpperCase(),
    };

    return {
      registrationMode,
      rawEmails,
      rawSms,
      emailSelectionMode,
      specifiedEmailId,
      smsSourceMode,
      smsSelectionMode,
      batchAccountLimit,
      stopOnError,
      autoOpenCheckout,
      debugMode,
      oauthExtractMode,
      checkoutExtractMode,
      plusCheckoutClosure,
      checkoutOptions: {
        planName: valueOf('checkout-plan') as 'chatgptplusplan' | 'chatgptteamplan',
        uiMode: valueOf('checkout-ui-mode') as 'hosted' | 'custom',
        region: valueOf('checkout-region'),
      },
      ...overrides,
    };
  }

  async function saveCurrentSettings(overrides: Partial<AutomationSettings> = {}) {
    const patch = collectSettingsPatch(overrides);
    const preview = parseAutomationSettings({
      ...state.settings,
      ...patch,
      checkoutOptions: {
        ...state.settings.checkoutOptions,
        ...(patch.checkoutOptions || {}),
      },
    }, state);
    const blockingErrors = [
      ...(patch.registrationMode === 'phone' ? [] : preview.emailErrors),
      ...preview.smsErrors,
    ];
    if (blockingErrors.length) {
      throw new Error(blockingErrors.join('；'));
    }
    const selectedStillExists = preview.emails.some((email) => email.id === patch.specifiedEmailId);
    const nextSpecifiedEmailId = patch.emailSelectionMode === 'specified' && selectedStillExists ? patch.specifiedEmailId || '' : '';
    return saveAutomationSettings({
      ...patch,
      specifiedEmailId: nextSpecifiedEmailId,
    });
  }

  async function saveCurrentOAuthPhoneSettings(overrides: Partial<OAuthPhoneSettings> = {}): Promise<OAuthPhoneSettings> {
    return saveOAuthPhoneSettings({
      enabled: checkedOf('oauth-phone-enabled'),
      sourceMode: valueOf('oauth-phone-source-mode') as OAuthPhoneSettings['sourceMode'],
      activeProviderId: valueOf('oauth-phone-active-provider') as OAuthPhoneProviderId,
      providerMode: valueOf('oauth-phone-provider-mode') as OAuthPhoneProviderSelectionMode,
      serviceCode: valueOf('oauth-phone-service-code'),
      countryIds: readSelectedOAuthPhoneOffers().map((offer) => offer.countryId),
      selectedCountries: [],
      selectedOffers: readSelectedOAuthPhoneOffers(),
      minPrice: Number(valueOf('oauth-phone-min-price') || 0),
      maxPrice: Number(valueOf('oauth-phone-max-price') || 0),
      smsTimeoutSeconds: Number(valueOf('oauth-phone-timeout') || 120),
      rawApiTargets: valueOf('oauth-phone-raw-api-targets'),
      apiTargets: parseOAuthPhoneApiTargets(
        valueOf('oauth-phone-raw-api-targets'),
        overrides.apiTargets || oauthPhone.apiTargets,
      ).targets,
      providers: OAUTH_PHONE_PROVIDER_DEFINITIONS.map((definition) => ({
        id: definition.id,
        enabled: checkedOf(`oauth-phone-provider-enabled-${definition.id}`),
        apiKey: valueOf(`oauth-phone-provider-key-${definition.id}`),
        priority: Number(valueOf(`oauth-phone-provider-priority-${definition.id}`) || 99),
        updatedAt: Date.now(),
      })),
      ...overrides,
    });
  }

  function wireOAuthPhoneActions(initialSettings: OAuthPhoneSettings): void {
    const status = mustGet('oauth-phone-status');
    const offersHost = mustGet('oauth-phone-offers');
    const summary = mustGet('oauth-phone-selected-summary');
    const saveButton = mustGet('btn-save-oauth-phone') as HTMLButtonElement;
    const refreshOffersButton = mustGet('btn-refresh-oauth-phone-offers') as HTMLButtonElement;
    const sourceModeSelect = mustGet('oauth-phone-source-mode') as HTMLSelectElement;
    const rawApiTargetsInput = mustGet('oauth-phone-raw-api-targets') as HTMLTextAreaElement;
    const apiTargetsHost = mustGet('oauth-phone-api-targets');
    const importApiButton = mustGet('btn-import-oauth-phone-api') as HTMLButtonElement;
    const refreshApiButton = mustGet('btn-refresh-oauth-phone-api') as HTMLButtonElement;
    const clearApiButton = mustGet('btn-clear-oauth-phone-api') as HTMLButtonElement;
    const offerSearchInput = mustGet('oauth-offer-search') as HTMLInputElement;
    const offerChannelFilterSelect = mustGet('oauth-offer-channel-filter') as HTMLSelectElement;
    const offerUseFilterSelect = mustGet('oauth-offer-use-filter') as HTMLSelectElement;
    const offerSortSelect = mustGet('oauth-offer-sort') as HTMLSelectElement;
    const minPriceInput = mustGet('oauth-phone-min-price') as HTMLInputElement;
    const maxPriceInput = mustGet('oauth-phone-max-price') as HTMLInputElement;
    const timeoutInput = mustGet('oauth-phone-timeout') as HTMLInputElement;
    let selectedOffers = initialSettings.selectedOffers;
    let currentOffers: OAuthPhoneSelectedOffer[] = initialSettings.selectedOffers;
    let currentApiTargets = initialSettings.apiTargets;

    const syncMode = (): void => {
      const isApiMode = sourceModeSelect.value === 'api';
      document.querySelectorAll<HTMLElement>('.oauth-provider-mode-panel').forEach((element) => {
        element.hidden = isApiMode;
      });
      document.querySelectorAll<HTMLElement>('.oauth-api-mode-panel').forEach((element) => {
        element.hidden = !isApiMode;
      });
    };

    const syncOffers = (message = ''): void => {
      summary.textContent = selectedOffers.length ? `${selectedOffers.length} 个报价` : '未选择报价';
      offersHost.innerHTML = renderOAuthPhoneOfferTable(
        currentOffers,
        selectedOffers,
        message,
        readOAuthOfferTableFilter(),
      );
    };
    const syncApiTargets = (): void => {
      const parsed = parseOAuthPhoneApiTargets(rawApiTargetsInput.value, currentApiTargets);
      currentApiTargets = parsed.targets;
      apiTargetsHost.innerHTML = renderOAuthPhoneApiTargetTable(rawApiTargetsInput.value, currentApiTargets);
      const error = parsed.errors.join('；');
      if (error) {
        setInlineStatus(status, error, 'error');
      }
    };
    syncMode();
    syncOffers(initialSettings.selectedOffers.length ? '已加载上次保存的报价选择。' : '点击刷新报价读取平台库存。');
    syncApiTargets();

    const syncFilteredOffers = (): void => syncOffers();
    sourceModeSelect.addEventListener('change', syncMode);
    offerSearchInput.addEventListener('input', syncFilteredOffers);
    offerChannelFilterSelect.addEventListener('change', syncFilteredOffers);
    offerUseFilterSelect.addEventListener('change', syncFilteredOffers);
    offerSortSelect.addEventListener('change', syncFilteredOffers);
    minPriceInput.addEventListener('input', syncFilteredOffers);
    maxPriceInput.addEventListener('input', syncFilteredOffers);
    timeoutInput.addEventListener('change', () => {
      const seconds = Number(timeoutInput.value || 120);
      timeoutInput.value = String(Number.isFinite(seconds) ? Math.max(15, Math.min(600, Math.round(seconds))) : 120);
    });
    rawApiTargetsInput.addEventListener('input', syncApiTargets);

    offersHost.addEventListener('change', (event) => {
      const input = (event.target as Element | null)?.closest<HTMLInputElement>('[data-oauth-offer-key]');
      if (!input) {
        return;
      }
      const offer = currentOffers.find((item) => oauthOfferKey(item) === input.dataset.oauthOfferKey);
      if (!offer) {
        return;
      }
      selectedOffers = input.checked
        ? upsertSelectedOffer(selectedOffers, offer)
        : selectedOffers.filter((item) => oauthOfferKey(item) !== oauthOfferKey(offer));
      syncOffers();
    });

    apiTargetsHost.addEventListener('click', (event) => {
      const button = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-oauth-api-action]');
      if (!button) {
        return;
      }
      const targetId = button.dataset.oauthApiTargetId || '';
      const target = currentApiTargets.find((item) => item.id === targetId);
      if (!target) {
        return;
      }
      if (button.dataset.oauthApiAction === 'delete') {
        rawApiTargetsInput.value = removeRawLine(rawApiTargetsInput.value, target.rawInput);
        syncApiTargets();
        setInlineStatus(status, `已删除 OAuth API 接码：${target.phone}，点击保存后生效。`, 'ok');
        flashButtonLabel(button, '已删除');
        return;
      }
      if (button.dataset.oauthApiAction === 'restore') {
        currentApiTargets = currentApiTargets.map((item) => item.id === targetId
          ? {
              ...item,
              disabled: false,
              disabledAt: 0,
              disabledReason: '',
              lastMessage: '已恢复可用',
            }
          : item);
        apiTargetsHost.innerHTML = renderOAuthPhoneApiTargetTable(rawApiTargetsInput.value, currentApiTargets);
        setInlineStatus(status, `已恢复 OAuth API 接码：${target.phone}，点击保存后生效。`, 'ok');
        flashButtonLabel(button, '已恢复');
      }
    });

    importApiButton.addEventListener('click', () => {
      openPasteImportDialog({
        title: '导入 OAuth API 接码池',
        description: '每行一个 OAuth 手机接码配置，格式为 号码----API 链接，导入后会合并去重。',
        placeholder: '+14642649811----https://mail-api.example.com/api/text-relay/xxxx',
        confirmText: '导入 API 接码',
        onConfirm: (text) => {
          rawApiTargetsInput.value = mergeLines(rawApiTargetsInput.value, text);
          syncApiTargets();
          setInlineStatus(status, `已导入 OAuth API 接码 ${countRawLines(text)} 行，点击保存后生效。`, 'ok');
        },
      });
      flashButtonLabel(importApiButton, '已打开');
    });
    refreshApiButton.addEventListener('click', () => {
      syncApiTargets();
      setInlineStatus(status, 'OAuth API 接码池预览已刷新。', 'ok');
      flashButtonLabel(refreshApiButton, '已刷新');
    });
    clearApiButton.addEventListener('click', () => {
      rawApiTargetsInput.value = '';
      currentApiTargets = [];
      syncApiTargets();
      setInlineStatus(status, 'OAuth API 接码池已清空，点击保存后生效。', 'ok');
      flashButtonLabel(clearApiButton, '已清空');
    });

    refreshOffersButton.addEventListener('click', async () => {
      const restoreButton = setButtonPending(refreshOffersButton, '查询中...');
      offersHost.innerHTML = '<div class="table-empty">正在查询各平台可用报价...</div>';
      try {
        await saveCurrentOAuthPhoneSettings({ selectedOffers, countryIds: selectedOffers.map((offer) => offer.countryId) });
        const result = await fetchOAuthPhoneOfferMatrix();
        currentOffers = mergeSavedOffersIntoMatrix(result.offers.map(toSelectedOAuthPhoneOffer), selectedOffers);
        syncOffers(result.message);
        setInlineStatus(status, result.message, result.ok ? 'ok' : 'error');
      } finally {
        restoreButton();
      }
    });

    saveButton.addEventListener('click', async () => {
      const restoreButton = setButtonPending(saveButton, '保存中...');
      try {
        selectedOffers = readSelectedOAuthPhoneOffers();
        const next = await saveCurrentOAuthPhoneSettings({
          selectedOffers,
          countryIds: selectedOffers.map((offer) => offer.countryId),
          apiTargets: currentApiTargets,
        });
        setInlineStatus(status, `已保存 OAuth 手机接码：平台报价 ${next.selectedOffers.length} 个，API 号码 ${next.apiTargets.length} 个`, 'ok');
      } catch (error) {
        setInlineStatus(status, error instanceof Error ? error.message : String(error), 'error');
      } finally {
        restoreButton();
      }
    });

    for (const definition of OAUTH_PHONE_PROVIDER_DEFINITIONS) {
      const testButton = mustGet(`btn-test-oauth-phone-${definition.id}`) as HTMLButtonElement;
      testButton.addEventListener('click', async () => {
        const restoreButton = setButtonPending(testButton, '测试中...');
        setProviderStatus(definition.id, 'running', '测试中');
        try {
          await saveCurrentOAuthPhoneSettings();
          const result = await testOAuthPhoneProvider(definition.id);
          setProviderStatus(definition.id, result.ok ? 'success' : 'error', result.message);
          setInlineStatus(status, result.message, result.ok ? 'ok' : 'error');
        } finally {
          restoreButton();
        }
      });
    }
  }

  function updateRawEmails(value: string): void {
    rawEmailsInput.value = normalizeRawLines(value);
    renderEmailTable();
    syncSpecifiedEmails(specifiedEmailSelect.value);
  }

  function updateRawSms(value: string): void {
    const normalized = normalizeRawLines(value);
    rawSmsInput.value = normalized;
    renderSmsTable();
  }

  function renderEmailTable(): void {
    const tableHost = mustGet('email-table');
    const summaryHost = mustGet('email-summary');
    tableHost.textContent = '';
    summaryHost.textContent = '';
    if (registrationModeSelect.value === 'phone') {
      summaryHost.textContent = '手机号注册模式不使用邮箱池。';
      return;
    }
    const preview = parseAutomationSettings({
      ...state.settings,
      rawEmails: rawEmailsInput.value,
      rawSms: valueOf('raw-sms'),
      smsSourceMode: PUBLIC_SMS_SOURCE_MODE,
    }, state);
    if (preview.emailErrors.length) {
      const errors = document.createElement('div');
      errors.className = 'table-error';
      errors.textContent = preview.emailErrors.join('；');
      tableHost.append(errors);
    }
    if (!preview.emails.length) {
      const empty = document.createElement('div');
      empty.className = 'table-empty';
      empty.textContent = '邮箱池为空，点击导入添加 Outlook 行。';
      tableHost.append(empty);
      return;
    }

    const generatedEmails = new Set(state.generatedFiles.records.map((record) => record.email.toLowerCase()));
    const currentError = state.steps.find((step) => step.status === 'error');
    const rows = preview.emails.map((email) => ({
      email,
      statusInfo: emailStatusInfo(email, generatedEmails, state.run.selectedEmailId, currentError?.message || ''),
    }));
    const successCount = rows.filter((row) => row.statusInfo.kind === 'success').length;
    const errorCount = rows.filter((row) => row.statusInfo.kind === 'error').length;
    summaryHost.textContent = `总数 ${preview.emails.length} · 成功 ${successCount} · 失败 ${errorCount}`;

    const table = document.createElement('table');
    table.className = 'data-table email-pool-table';
    table.innerHTML = `
      <thead>
        <tr>
          <th class="index-cell">序号</th>
          <th>邮箱</th>
          <th>凭证 / Token</th>
          <th>状态</th>
          <th>操作</th>
        </tr>
      </thead>
    `;
    const body = document.createElement('tbody');
    rows.forEach(({ email, statusInfo }, index) => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td class="index-cell">${index + 1}</td>
        <td><span class="email-text">${escapeHtml(email.email)}</span></td>
        <td><span class="credential-text">${escapeHtml(maskCredentialLine(email.rawInput))}</span></td>
        <td>
          <span
            class="status-pill"
            data-status="${escapeAttr(statusInfo.kind)}"
            data-tooltip="${escapeAttr(statusInfo.detail)}"
            title="${escapeAttr(statusInfo.detail)}"
            aria-label="${escapeAttr(statusInfo.detail)}"
          >${escapeHtml(statusInfo.label)}</span>
        </td>
        <td>
          <div class="table-action-group">
            ${isEmailRestorable(email) ? '<button class="table-action-button" data-action="restore" type="button">恢复</button>' : ''}
            <button class="table-action-button" data-action="run" type="button"${state.run.running ? ' disabled' : ''}>执行</button>
            <button class="table-action-button danger" data-action="delete" type="button">删除</button>
          </div>
        </td>
      `;
      row.querySelector<HTMLButtonElement>('[data-action="restore"]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget as HTMLButtonElement;
        const restoreButton = setButtonPending(button, '恢复中...');
        try {
          const latest = await loadAutomationState();
          if (!latest.emails.some((item) => item.id === email.id)) {
            setInlineStatus(status, `未找到邮箱：${email.email}，请先保存当前邮箱池。`, 'error');
            return;
          }
          const next = await updateAutomationEmails(latest.emails.map((item) => item.id === email.id ? restoreEmailAccount(item) : item));
          Object.assign(state, next);
          renderEmailTable();
          syncSpecifiedEmails(specifiedEmailSelect.value);
          setInlineStatus(status, `已恢复邮箱：${email.email}`, 'ok');
        } catch (error) {
          setInlineStatus(status, `恢复邮箱失败：${error instanceof Error ? error.message : String(error)}`, 'error');
        } finally {
          restoreButton();
        }
      });
      const runButton = row.querySelector<HTMLButtonElement>('[data-action="run"]');
      runButton?.addEventListener('click', async () => {
        const restoreButton = setButtonPending(runButton, '执行中...');
        setInlineStatus(status, `正在执行账号：${email.email}`, 'ok');
        try {
          await saveCurrentSettings({
            emailSelectionMode: 'specified',
            specifiedEmailId: email.id,
            batchAccountLimit: 1,
          });
          const result = await runAutomationForEmail(email.id);
          setInlineStatus(status, result.message, result.ok ? 'ok' : 'error');
          window.setTimeout(() => void render(), 300);
        } catch (error) {
          setInlineStatus(status, error instanceof Error ? error.message : String(error), 'error');
        } finally {
          restoreButton();
        }
      });
      row.querySelector<HTMLButtonElement>('[data-action="delete"]')?.addEventListener('click', (event) => {
        const deleteButton = event.currentTarget as HTMLButtonElement;
        updateRawEmails(removeRawLine(rawEmailsInput.value, email.rawInput));
        setInlineStatus(status, `已删除：${email.email}，点击保存后生效。`, 'ok');
        flashButtonLabel(deleteButton, '已删除');
      });
      body.append(row);
    });
    table.append(body);
    tableHost.append(table);
  }

  function renderSmsTable(): void {
    const tableHost = mustGet('sms-table');
    tableHost.textContent = '';
    const preview = parseAutomationSettings({
      ...state.settings,
      rawEmails: rawEmailsInput.value,
      rawSms: rawSmsInput.value,
      smsSourceMode: PUBLIC_SMS_SOURCE_MODE,
    }, state);
    if (preview.smsErrors.length) {
      const errors = document.createElement('div');
      errors.className = 'table-error';
      errors.textContent = preview.smsErrors.join('；');
      tableHost.append(errors);
    }
    if (!preview.smsTargets.length) {
      const empty = document.createElement('div');
      empty.className = 'table-empty';
      empty.textContent = '接码池为空，点击导入添加 号码----API 链接。';
      tableHost.append(empty);
      return;
    }

    const table = document.createElement('table');
    table.className = 'data-table sms-pool-table';
    table.innerHTML = `
      <thead>
        <tr>
          <th>来源</th>
          <th>号码</th>
          <th>API 链接</th>
          <th>状态</th>
          <th>操作</th>
        </tr>
      </thead>
    `;
    const body = document.createElement('tbody');
    for (const target of preview.smsTargets) {
      const statusInfo = smsStatusInfo(target, state.run.selectedSmsId);
      const row = document.createElement('tr');
      row.innerHTML = `
        <td><span class="provider-badge ${target.source === 'foxsms' ? 'provider-badge-foxsms' : 'provider-badge-smsbower'}">${target.source === 'foxsms' ? 'Fox SMS' : 'API'}</span></td>
        <td><span class="email-text">${escapeHtml(target.phone)}</span></td>
        <td><span class="credential-text api-text">${escapeHtml(smsTargetSourceDetail(target))}</span></td>
        <td><span class="status-pill" data-status="${escapeAttr(statusInfo.kind)}">${escapeHtml(statusInfo.label)}</span></td>
        <td>
          <div class="table-action-group">
            ${target.disabled ? '<button class="table-action-button" data-action="restore" type="button">恢复</button>' : ''}
            <button class="table-action-button danger" data-action="delete" type="button">删除</button>
          </div>
        </td>
      `;
      row.querySelector<HTMLButtonElement>('[data-action="restore"]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget as HTMLButtonElement;
        const restoreButton = setButtonPending(button, '恢复中...');
        try {
          const latest = await loadAutomationState();
          if (!latest.smsTargets.some((item) => item.id === target.id)) {
            setInlineStatus(status, `未找到接码：${target.phone}，请先保存当前接码池。`, 'error');
            return;
          }
          const next = await updateAutomationSmsTargets(latest.smsTargets.map((item) => item.id === target.id
            ? {
                ...item,
                disabled: false,
                disabledAt: 0,
                disabledReason: '',
                lastMessage: '已恢复可用',
              }
            : item));
          Object.assign(state, next);
          renderSmsTable();
          setInlineStatus(status, `已恢复接码：${target.phone}`, 'ok');
        } catch (error) {
          setInlineStatus(status, `恢复接码失败：${error instanceof Error ? error.message : String(error)}`, 'error');
        } finally {
          restoreButton();
        }
      });
      row.querySelector<HTMLButtonElement>('[data-action="delete"]')?.addEventListener('click', (event) => {
        const button = event.currentTarget as HTMLButtonElement;
        updateRawSms(removeRawLine(rawSmsInput.value, target.rawInput));
        setInlineStatus(status, `已删除接码：${target.phone}，点击保存后生效。`, 'ok');
        flashButtonLabel(button, '已删除');
      });
      body.append(row);
    }
    table.append(body);
    tableHost.append(table);
  }

  function syncSpecifiedEmails(currentId: string): void {
    const preview = parseAutomationSettings({
      ...state.settings,
      rawEmails: rawEmailsInput.value,
      rawSms: valueOf('raw-sms'),
      specifiedEmailId: currentId,
    }, state);
    specifiedEmailSelect.textContent = '';
    const emptyOption = document.createElement('option');
    emptyOption.value = '';
    emptyOption.textContent = preview.emails.length ? '未指定' : '先输入邮箱并保存';
    specifiedEmailSelect.append(emptyOption);
    for (const email of preview.emails) {
      const item = document.createElement('option');
      item.value = email.id;
      item.textContent = email.email;
      item.selected = email.id === currentId;
      specifiedEmailSelect.append(item);
    }
  }

  function syncRegistrationModeVisibility(): void {
    const phoneMode = registrationModeSelect.value === 'phone';
    mustGet('email-pool-fields').hidden = phoneMode;
    mustGet('phone-registration-summary').hidden = !phoneMode;
    oauthExtractModeSelect.disabled = phoneMode;
    if (phoneMode) {
      oauthExtractModeSelect.value = 'direct';
    }
  }

  function syncCheckoutOptionsVisibility(): void {
    const optionsRow = mustGet('checkout-options-row');
    optionsRow.hidden = checkoutExtractModeSelect.value === 'server';
  }

  function wireGeneratedFileActions(): void {
    const outputStatus = mustGet('output-status');
    const copySub2apiButton = mustGet('btn-copy-sub2api') as HTMLButtonElement;
    copySub2apiButton.addEventListener('click', async () => {
      await copyText(generatedFiles.sub2apiJson, outputStatus, '已复制 sub2api JSON');
      flashButtonLabel(copySub2apiButton, '已复制');
    });
    const downloadSub2apiButton = mustGet('btn-download-sub2api') as HTMLButtonElement;
    downloadSub2apiButton.addEventListener('click', () => {
      downloadJson(generatedFiles.sub2apiJson, 'sub2api_automation.json');
      outputStatus.textContent = '已下载 sub2api JSON';
      outputStatus.dataset.type = 'ok';
      flashButtonLabel(downloadSub2apiButton, '已下载');
    });
    const copyCpaButton = mustGet('btn-copy-cpa') as HTMLButtonElement;
    copyCpaButton.addEventListener('click', async () => {
      await copyText(generatedFiles.cpaJson, outputStatus, '已复制 CPA JSON');
      flashButtonLabel(copyCpaButton, '已复制');
    });
    const downloadCpaButton = mustGet('btn-download-cpa') as HTMLButtonElement;
    downloadCpaButton.addEventListener('click', () => {
      downloadJson(generatedFiles.cpaJson, 'cpa_automation.json');
      outputStatus.textContent = '已下载 CPA JSON';
      outputStatus.dataset.type = 'ok';
      flashButtonLabel(downloadCpaButton, '已下载');
    });
    const clearGeneratedButton = mustGet('btn-clear-generated') as HTMLButtonElement;
    clearGeneratedButton.addEventListener('click', async () => {
      const restoreButton = setButtonPending(clearGeneratedButton, '清空中...');
      try {
        await clearAutomationGeneratedFiles();
        await render();
      } finally {
        restoreButton();
      }
    });
  }
}

function option(value: string, label: string, current: string): string {
  return `<option value="${escapeAttr(value)}"${value === current ? ' selected' : ''}>${escapeHtml(label)}</option>`;
}

function oauthPhoneProviderOptions(current: string): string {
  return OAUTH_PHONE_PROVIDER_DEFINITIONS.map((provider) => option(provider.id, provider.label, current)).join('');
}

function providerLabel(providerId: string): string {
  return OAUTH_PHONE_PROVIDER_DEFINITIONS.find((provider) => provider.id === providerId)?.label || providerId;
}

function providerBadgeClass(providerId: string): string {
  if (providerId === 'herosms') {
    return 'provider-badge-herosms';
  }
  if (providerId === 'smspool') {
    return 'provider-badge-smspool';
  }
  if (providerId === 'tigersms') {
    return 'provider-badge-tigersms';
  }
  if (providerId === 'foxsms') {
    return 'provider-badge-foxsms';
  }
  return 'provider-badge-smsbower';
}

function readSelectedOAuthPhoneOffers(): OAuthPhoneSelectedOffer[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>('[data-oauth-offer-key]:checked'))
    .map((input) => parseOAuthOfferDataset(input.dataset))
    .filter((offer): offer is OAuthPhoneSelectedOffer => Boolean(offer));
}

function parseOAuthOfferDataset(dataset: DOMStringMap): OAuthPhoneSelectedOffer | null {
  const providerId = dataset.providerId === 'herosms' ||
    dataset.providerId === 'smspool' ||
    dataset.providerId === 'tigersms' ||
    dataset.providerId === 'foxsms'
    ? dataset.providerId
    : 'smsbower';
  const countryId = String(dataset.countryId || '').trim();
  const serviceCode = String(dataset.serviceCode || '').trim();
  if (!countryId || !serviceCode) {
    return null;
  }
  return {
    providerId,
    countryId,
    countryName: String(dataset.countryName || countryId),
    serviceCode,
    cost: Number(dataset.cost || 0),
    count: Number(dataset.count || 0),
    operator: String(dataset.operator || ''),
    updatedAt: Number(dataset.updatedAt || Date.now()),
  };
}

function renderOAuthPhoneApiTargetTable(rawInput: string, targets: OAuthPhoneApiTarget[]): string {
  const parsed = parseOAuthPhoneApiTargets(rawInput, targets);
  const displayTargets = targets.length ? targets : parsed.targets;
  const error = parsed.errors.join('；');
  if (!displayTargets.length) {
    return [
      error ? `<div class="table-error">${escapeHtml(error)}</div>` : '',
      '<div class="table-empty">OAuth API 接码池为空，点击导入添加 号码----API 链接。</div>',
    ].join('');
  }
  return `
    ${error ? `<div class="table-error">${escapeHtml(error)}</div>` : ''}
    <table class="data-table oauth-api-table">
      <thead>
        <tr>
          <th>号码</th>
          <th>API 链接</th>
          <th>状态</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        ${displayTargets.map((target) => {
          const statusInfo = oauthApiTargetStatusInfo(target);
          return `
            <tr>
              <td><span class="email-text">${escapeHtml(target.phone)}</span></td>
              <td><span class="credential-text api-text">${escapeHtml(shortUrlText(target.url))}</span></td>
              <td><span class="status-pill" data-status="${escapeAttr(statusInfo.kind)}" data-tooltip="${escapeAttr(statusInfo.detail)}">${escapeHtml(statusInfo.label)}</span></td>
              <td>
                <div class="table-action-group">
                  ${target.disabled ? `<button class="table-action-button" data-oauth-api-action="restore" data-oauth-api-target-id="${escapeAttr(target.id)}" type="button">恢复</button>` : ''}
                  <button class="table-action-button danger" data-oauth-api-action="delete" data-oauth-api-target-id="${escapeAttr(target.id)}" type="button">删除</button>
                </div>
              </td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

function oauthApiTargetStatusInfo(target: OAuthPhoneApiTarget): { kind: string; label: string; detail: string } {
  const detail = [
    `号码：${target.phone}`,
    `API：${redactSensitiveText(target.url)}`,
    target.lastMessage ? `消息：${redactSensitiveText(target.lastMessage)}` : '',
    target.useCount ? `使用次数：${target.useCount}` : '',
    target.lastCodeAt ? `最后收码：${formatTime(target.lastCodeAt)}` : '',
  ].filter(Boolean).join('\n');
  if (target.disabled) {
    return {
      kind: 'error',
      label: target.disabledReason ? `不可用：${shortText(target.disabledReason, 18)}` : '号码不可用',
      detail,
    };
  }
  if (target.lastCodeAt) {
    return { kind: 'success', label: '已收码', detail };
  }
  if (target.lastMessage) {
    return { kind: 'idle', label: shortText(target.lastMessage, 18), detail };
  }
  if (target.useCount > 0) {
    return { kind: 'idle', label: `已用 ${target.useCount} 次`, detail };
  }
  return { kind: 'idle', label: '未使用', detail };
}

interface OAuthOfferTableFilter {
  query: string;
  channelFilter: string;
  useFilter: string;
  sort: string;
  minPrice: number;
  maxPrice: number;
}

interface OAuthOfferCountryGroup {
  key: string;
  providerId: OAuthPhoneProviderId;
  countryId: string;
  countryName: string;
  countryIso: string;
  channelSupport: OpenAiPhoneChannelSupport;
  offers: OAuthPhoneSelectedOffer[];
  minCost: number;
  maxCost: number;
  totalCount: number;
  hasUnknownCount: boolean;
  selectedCount: number;
}

function readOAuthOfferTableFilter(): OAuthOfferTableFilter {
  return {
    query: valueOf('oauth-offer-search').trim().toLowerCase(),
    channelFilter: valueOf('oauth-offer-channel-filter'),
    useFilter: valueOf('oauth-offer-use-filter'),
    sort: valueOf('oauth-offer-sort'),
    minPrice: Number(valueOf('oauth-phone-min-price') || 0),
    maxPrice: Number(valueOf('oauth-phone-max-price') || 0),
  };
}

function renderOAuthPhoneOfferTable(
  offers: OAuthPhoneSelectedOffer[],
  selectedOffers: OAuthPhoneSelectedOffer[],
  message: string,
  filter: OAuthOfferTableFilter = {
    query: '',
    channelFilter: 'all',
    useFilter: 'all',
    sort: 'price-asc',
    minPrice: 0,
    maxPrice: 0,
  },
): string {
  const selectedKeys = new Set(selectedOffers.map(oauthOfferKey));
  const availableOffers = offers.filter(isVisibleOAuthPhoneOffer);
  const visibleOffers = filterOAuthPhoneOffers(offers, selectedKeys, filter);
  const visibleGroups = groupOAuthPhoneOffers(visibleOffers, selectedKeys, filter.sort);
  if (!offers.length) {
    return `<div class="table-empty">${escapeHtml(message)}</div>`;
  }
  if (!visibleOffers.length) {
    const priceMessage = formatOfferFilterPriceMessage(filter);
    return `<div class="table-empty">没有符合筛选条件的报价。${priceMessage ? ` ${escapeHtml(priceMessage)}。` : ''}</div>`;
  }
  const note = [
    `显示 ${visibleGroups.length} 个国家 / ${visibleOffers.length}/${availableOffers.length} 条报价`,
    formatVisibleOfferChannelSummary(visibleGroups),
    filter.channelFilter !== 'all' ? `渠道：${formatOpenAiPhoneChannelFilterLabel(filter.channelFilter)}` : '',
    filter.minPrice > 0 ? `最低价 >= ${formatPrice(filter.minPrice)}` : '',
    filter.maxPrice > 0 ? `最高价 <= ${formatPrice(filter.maxPrice)}` : '',
    filter.query ? `搜索：${filter.query}` : '',
  ].filter(Boolean).join(' · ');
  return `
    <div class="oauth-offer-table-note">${escapeHtml(note)}</div>
    <table class="data-table oauth-offer-table">
      <thead>
        <tr>
          <th>国家 / ID</th>
          <th>OpenAI 渠道</th>
          <th>单价 ($)</th>
          <th>余量 (个)</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        ${visibleGroups.map((group) => renderOAuthPhoneOfferCountryGroup(group, selectedKeys, filter.sort)).join('')}
      </tbody>
    </table>
  `;
}

function renderOAuthPhoneOfferCountryGroup(
  group: OAuthOfferCountryGroup,
  selectedKeys: Set<string>,
  sort: string,
): string {
  const offers = [...group.offers].sort((left, right) => sortOAuthPhoneOffers(left, right, sort));
  const priceRange = group.minCost === group.maxCost
    ? `$${formatPrice(group.minCost)}`
    : `$${formatPrice(group.minCost)} - $${formatPrice(group.maxCost)}`;
  const selectedText = group.selectedCount ? ` · 已选 ${group.selectedCount}` : '';
  return `
    <tr class="oauth-country-row">
      <td colspan="5">
        <div class="offer-country-head">
          <div>
            <strong class="offer-country-title">${escapeHtml(group.countryName || group.countryId)} / ${escapeHtml(group.countryId)}</strong>
            <span class="provider-badge ${providerBadgeClass(group.providerId)}">${escapeHtml(providerLabel(group.providerId))}</span>
            ${renderOpenAiPhoneChannelBadge(group.channelSupport)}
          </div>
          <span class="offer-country-meta">${escapeHtml(group.countryIso || 'ISO?')} · ${offers.length} 个定价选项 · ${escapeHtml(priceRange)} · 余量 ${escapeHtml(formatOfferCount(group))}${escapeHtml(selectedText)}</span>
        </div>
      </td>
    </tr>
    ${offers.map((offer) => renderOAuthPhoneOfferOptionRow(offer, selectedKeys)).join('')}
  `;
}

function renderOAuthPhoneOfferOptionRow(
  offer: OAuthPhoneSelectedOffer,
  selectedKeys: Set<string>,
): string {
  const key = oauthOfferKey(offer);
  const optionLabel = offer.operator ? `定价选项 ${offer.operator}` : '默认定价';
  const support = resolveOpenAiPhoneOfferSupport(offer);
  return `
    <tr class="oauth-price-option-row">
      <td>
        <span class="offer-option-label">${escapeHtml(optionLabel)}</span>
      </td>
      <td>${renderOpenAiPhoneChannelBadge(support)}</td>
      <td>${formatPrice(offer.cost)}</td>
      <td>${escapeHtml(formatOfferCount(offer))}</td>
      <td>
        <label class="mini-check">
          <input
            type="checkbox"
            data-oauth-offer-key="${escapeAttr(key)}"
            data-provider-id="${escapeAttr(offer.providerId)}"
            data-country-id="${escapeAttr(offer.countryId)}"
            data-country-name="${escapeAttr(offer.countryName)}"
            data-service-code="${escapeAttr(offer.serviceCode)}"
            data-cost="${escapeAttr(offer.cost)}"
            data-count="${escapeAttr(offer.count)}"
            data-operator="${escapeAttr(offer.operator)}"
            data-updated-at="${offer.updatedAt || Date.now()}"
            ${selectedKeys.has(key) ? 'checked' : ''}
          />
          <span>使用</span>
        </label>
      </td>
    </tr>
  `;
}

function renderOpenAiPhoneChannelBadge(support: OpenAiPhoneChannelSupport): string {
  const label = formatOpenAiPhoneChannelLabel(support);
  const className = isOpenAiPhoneSmsFirst(support)
    ? 'openai-channel-sms'
    : isOpenAiPhoneWhatsappFirst(support)
      ? 'openai-channel-whatsapp'
      : 'openai-channel-unknown';
  const detail = support.channels.length
    ? `${support.countryIso || '未知 ISO'}：${support.channels.join(' > ')}`
    : `${support.countryIso || '未知 ISO'}：OpenAI 渠道未知`;
  return `<span class="openai-channel-badge ${className}" title="${escapeAttr(detail)}">${escapeHtml(label)}</span>`;
}

function formatVisibleOfferChannelSummary(groups: OAuthOfferCountryGroup[]): string {
  if (!groups.length) {
    return '';
  }
  const smsFirst = groups.filter((group) => isOpenAiPhoneSmsFirst(group.channelSupport)).length;
  const whatsappFirst = groups.filter((group) => isOpenAiPhoneWhatsappFirst(group.channelSupport)).length;
  const unknown = groups.length - smsFirst - whatsappFirst;
  return [
    `SMS 优先 ${smsFirst}`,
    `WhatsApp 优先 ${whatsappFirst}`,
    unknown ? `未知 ${unknown}` : '',
  ].filter(Boolean).join(' / ');
}

function matchesOpenAiPhoneChannelFilter(offer: OAuthPhoneSelectedOffer, channelFilter: string): boolean {
  if (channelFilter === 'sms') {
    return isOpenAiPhoneSmsFirst(resolveOpenAiPhoneOfferSupport(offer));
  }
  if (channelFilter === 'whatsapp') {
    return isOpenAiPhoneWhatsappFirst(resolveOpenAiPhoneOfferSupport(offer));
  }
  return true;
}

function formatOpenAiPhoneChannelFilterLabel(channelFilter: string): string {
  if (channelFilter === 'sms') {
    return 'SMS 优先';
  }
  if (channelFilter === 'whatsapp') {
    return 'WhatsApp 优先';
  }
  return '全部渠道';
}

function groupOAuthPhoneOffers(
  offers: OAuthPhoneSelectedOffer[],
  selectedKeys: Set<string>,
  sort: string,
): OAuthOfferCountryGroup[] {
  const byCountry = new Map<string, OAuthOfferCountryGroup>();
  for (const offer of offers) {
    const key = [offer.providerId, offer.countryId, offer.countryName || ''].join('|');
    const selected = selectedKeys.has(oauthOfferKey(offer)) ? 1 : 0;
    const channelSupport = resolveOpenAiPhoneOfferSupport(offer);
    const existing = byCountry.get(key);
    if (existing) {
      existing.offers.push(offer);
      existing.minCost = Math.min(existing.minCost, offer.cost);
      existing.maxCost = Math.max(existing.maxCost, offer.cost);
      existing.totalCount += normalizedOfferCount(offer.count);
      existing.hasUnknownCount = existing.hasUnknownCount || offer.count < 0;
      existing.selectedCount += selected;
      continue;
    }
    byCountry.set(key, {
      key,
      providerId: offer.providerId,
      countryId: offer.countryId,
      countryName: offer.countryName || offer.countryId,
      countryIso: channelSupport.countryIso,
      channelSupport,
      offers: [offer],
      minCost: offer.cost,
      maxCost: offer.cost,
      totalCount: normalizedOfferCount(offer.count),
      hasUnknownCount: offer.count < 0,
      selectedCount: selected,
    });
  }
  return [...byCountry.values()].sort((left, right) => sortOAuthPhoneOfferGroups(left, right, sort));
}

function filterOAuthPhoneOffers(
  offers: OAuthPhoneSelectedOffer[],
  selectedKeys: Set<string>,
  filter: OAuthOfferTableFilter,
): OAuthPhoneSelectedOffer[] {
  return offers
    .filter(isVisibleOAuthPhoneOffer)
    .filter((offer) => matchesOpenAiPhoneChannelFilter(offer, filter.channelFilter))
    .filter((offer) => filter.minPrice > 0 ? offer.cost >= filter.minPrice : true)
    .filter((offer) => filter.maxPrice > 0 ? offer.cost <= filter.maxPrice : true)
    .filter((offer) => {
      if (!filter.query) {
        return true;
      }
      return [
        offer.countryName,
        offer.countryId,
        providerLabel(offer.providerId),
        resolveOpenAiPhoneOfferCountryIso(offer),
      ].some((value) => String(value || '').toLowerCase().includes(filter.query));
    })
    .filter((offer) => {
      const selected = selectedKeys.has(oauthOfferKey(offer));
      if (filter.useFilter === 'selected') {
        return selected;
      }
      if (filter.useFilter === 'unselected') {
        return !selected;
      }
      return true;
    })
    .sort((left, right) => sortOAuthPhoneOffers(left, right, filter.sort));
}

function formatOfferFilterPriceMessage(filter: OAuthOfferTableFilter): string {
  const parts = [
    filter.minPrice > 0 ? `当前最低价为 ${formatPrice(filter.minPrice)}` : '',
    filter.maxPrice > 0 ? `当前最高价为 ${formatPrice(filter.maxPrice)}` : '',
  ].filter(Boolean);
  return parts.join('，');
}

function sortOAuthPhoneOffers(
  left: OAuthPhoneSelectedOffer,
  right: OAuthPhoneSelectedOffer,
  sort: string,
): number {
  if (sort === 'price-desc') {
    return right.cost - left.cost || compareOfferStock(left, right, 'desc');
  }
  if (sort === 'stock-desc') {
    return compareOfferStock(left, right, 'desc') || left.cost - right.cost;
  }
  if (sort === 'stock-asc') {
    return compareOfferStock(left, right, 'asc') || left.cost - right.cost;
  }
  return left.cost - right.cost || compareOfferStock(left, right, 'desc');
}

function sortOAuthPhoneOfferGroups(
  left: OAuthOfferCountryGroup,
  right: OAuthOfferCountryGroup,
  sort: string,
): number {
  if (sort === 'price-desc') {
    return right.maxCost - left.maxCost || compareGroupStock(left, right, 'desc') || compareCountryGroupName(left, right);
  }
  if (sort === 'stock-desc') {
    return compareGroupStock(left, right, 'desc') || left.minCost - right.minCost || compareCountryGroupName(left, right);
  }
  if (sort === 'stock-asc') {
    return compareGroupStock(left, right, 'asc') || left.minCost - right.minCost || compareCountryGroupName(left, right);
  }
  return left.minCost - right.minCost || compareGroupStock(left, right, 'desc') || compareCountryGroupName(left, right);
}

function compareCountryGroupName(left: OAuthOfferCountryGroup, right: OAuthOfferCountryGroup): number {
  return `${left.countryName} ${left.countryId}`.localeCompare(`${right.countryName} ${right.countryId}`);
}

function compareOfferStock(
  left: Pick<OAuthPhoneSelectedOffer, 'count'>,
  right: Pick<OAuthPhoneSelectedOffer, 'count'>,
  direction: 'asc' | 'desc',
): number {
  if (left.count < 0 && right.count < 0) {
    return 0;
  }
  if (left.count < 0) {
    return 1;
  }
  if (right.count < 0) {
    return -1;
  }
  return direction === 'asc' ? left.count - right.count : right.count - left.count;
}

function compareGroupStock(
  left: OAuthOfferCountryGroup,
  right: OAuthOfferCountryGroup,
  direction: 'asc' | 'desc',
): number {
  const leftUnknownOnly = left.hasUnknownCount && left.totalCount <= 0;
  const rightUnknownOnly = right.hasUnknownCount && right.totalCount <= 0;
  if (leftUnknownOnly && rightUnknownOnly) {
    return 0;
  }
  if (leftUnknownOnly) {
    return 1;
  }
  if (rightUnknownOnly) {
    return -1;
  }
  return direction === 'asc' ? left.totalCount - right.totalCount : right.totalCount - left.totalCount;
}

function isVisibleOAuthPhoneOffer(offer: Pick<OAuthPhoneSelectedOffer, 'cost' | 'count'>): boolean {
  return offer.cost > 0 && offer.count !== 0;
}

function normalizedOfferCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function formatOfferCount(value: Pick<OAuthPhoneSelectedOffer, 'count'> | OAuthOfferCountryGroup): string {
  if ('hasUnknownCount' in value) {
    if (value.hasUnknownCount && value.totalCount > 0) {
      return `${value.totalCount}+ / 未知`;
    }
    return value.hasUnknownCount ? '未知' : String(value.totalCount);
  }
  return value.count < 0 ? '未知' : String(value.count);
}

function toSelectedOAuthPhoneOffer(
  offer: OAuthPhonePriceOffer & { countryName?: string },
): OAuthPhoneSelectedOffer {
  return {
    providerId: offer.providerId,
    countryId: offer.countryId,
    countryName: offer.countryName || offer.countryId,
    serviceCode: offer.serviceCode,
    cost: offer.cost,
    count: offer.count,
    operator: offer.operator,
    updatedAt: Date.now(),
  };
}

function upsertSelectedOffer(
  current: OAuthPhoneSelectedOffer[],
  offer: OAuthPhoneSelectedOffer,
): OAuthPhoneSelectedOffer[] {
  return [...current.filter((item) => oauthOfferKey(item) !== oauthOfferKey(offer)), offer];
}

function mergeSavedOffersIntoMatrix(
  offers: OAuthPhoneSelectedOffer[],
  selectedOffers: OAuthPhoneSelectedOffer[],
): OAuthPhoneSelectedOffer[] {
  const byKey = new Map(offers.map((offer) => [oauthOfferKey(offer), offer]));
  for (const selected of selectedOffers) {
    if (!byKey.has(oauthOfferKey(selected))) {
      byKey.set(oauthOfferKey(selected), selected);
    }
  }
  return [...byKey.values()];
}

function oauthOfferKey(offer: OAuthPhoneSelectedOffer): string {
  return [
    offer.providerId,
    offer.countryId,
    offer.serviceCode,
    offer.operator,
    formatPrice(offer.cost),
  ].join('|');
}

function formatPrice(value: number): string {
  if (!Number.isFinite(value)) {
    return '-';
  }
  return String(Math.round(value * 10000) / 10000);
}

function setProviderStatus(providerId: string, kind: string, message: string): void {
  const element = mustGet(`oauth-phone-provider-status-${providerId}`);
  element.textContent = message;
  element.dataset.status = kind;
  element.dataset.tooltip = message;
}

function buildOAuthPhoneSummary(settings: OAuthPhoneSettings): string {
  const modeLabel = settings.sourceMode === 'api' ? 'API 接码池' : '接码平台接码';
  const apiDisabled = settings.apiTargets.filter((target) => target.disabled).length;
  const apiUsable = settings.apiTargets.length - apiDisabled;
  if (settings.sourceMode === 'api') {
    return [
      `状态：${settings.enabled ? '已启用' : '未启用'}`,
      `模式：${modeLabel}`,
      `API 号码：总数 ${settings.apiTargets.length} / 可用 ${apiUsable} / 不可用 ${apiDisabled}`,
      `接码超时：${settings.smsTimeoutSeconds || 120} 秒`,
    ].join('\n');
  }
  const enabledProviders = settings.providers.filter((provider) => provider.enabled);
  const keyCount = enabledProviders.filter((provider) => provider.apiKey.trim()).length;
  const offerSummary = settings.selectedOffers.length
    ? settings.selectedOffers.map((offer) => `${offer.countryName}/${offer.countryId} ${formatPrice(offer.cost)}`).join(', ')
    : '未选择报价';
  const service = settings.serviceCode || '未配置服务代码';
  const priceRange = [
    `最低价：${settings.minPrice > 0 ? settings.minPrice : '不限制'}`,
    `最高价：${settings.maxPrice > 0 ? settings.maxPrice : '不限制'}`,
  ].join(' / ');
  return [
    `状态：${settings.enabled ? '已启用' : '未启用'}`,
    `模式：${modeLabel}`,
    `平台：${providerLabel(settings.activeProviderId)} / 已启用 ${enabledProviders.length} 个 / 已填 key ${keyCount} 个`,
    `服务：${service}`,
    `报价：${offerSummary}`,
    priceRange,
    `接码超时：${settings.smsTimeoutSeconds || 120} 秒`,
  ].join('\n');
}


async function loadAndFillProxyPanel(): Promise<ProxySettings> {
  const settings = await loadProxySettings();
  latestProxySettings = settings;
  fillProxyPanel(settings);
  await refreshProxyStatus();
  return settings;
}


function renderSeedHealthBoard(settings: ProxySettings): void {
  const el = mustGet('proxy-seed-health-board');
  const rows = (settings.seedHealth || []).slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (!rows.length) {
    el.textContent = 'seed 健康：暂无记录';
    return;
  }
  const removed = rows.filter((item) => item.removed).length;
  const cooling = rows.filter((item) => !item.removed && item.cooldownUntil > Date.now()).length;
  const top = rows.slice(0, 5).map((item) => `${item.method}/${item.stage} fail=${item.fail} ${item.removed ? 'REMOVED' : (item.cooldownUntil > Date.now() ? 'COOL' : 'OK')}`).join(' · ');
  el.textContent = `seed 健康：${rows.length} 条 / 冷却 ${cooling} / 剔除 ${removed} · ${top}`;
}

function fillActiveMethodPool(settings: ProxySettings): void {
  latestProxySettings = settings;
  const method = valueOf('proxy-pool-method').trim().toLowerCase() || 'ideal';
  const pool = (settings.methodPools || []).find((item: any) => item.method === method);
  (mustGet('proxy-pool-bootstrap') as HTMLTextAreaElement).value = pool?.bootstrapRaw || '';
  (mustGet('proxy-pool-promotion') as HTMLTextAreaElement).value = pool?.promotionRaw || '';
  (mustGet('proxy-pool-provider') as HTMLTextAreaElement).value = pool?.providerRaw || '';
  const status = mustGet('proxy-pool-status');
  const count = (raw: string) => String(raw || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).length;
  status.textContent = pool
    ? `${method} 池已加载 · bootstrap ${count(pool.bootstrapRaw)} / promotion ${count(pool.promotionRaw)} / provider ${count(pool.providerRaw)}`
    : `${method} 尚无独立三池`;
}

function mergeMethodPool(pools: any[], next: any): any[] {
  const method = String(next.method || '').toLowerCase();
  const list = Array.isArray(pools) ? [...pools] : [];
  const idx = list.findIndex((item) => item.method === method);
  const row = {
    method,
    bootstrapRaw: String(next.bootstrapRaw || ''),
    promotionRaw: String(next.promotionRaw || ''),
    providerRaw: String(next.providerRaw || ''),
    bootstrapIndex: Number(next.bootstrapIndex || 0) || 0,
    promotionIndex: Number(next.promotionIndex || 0) || 0,
    providerIndex: Number(next.providerIndex || 0) || 0,
  };
  if (idx >= 0) list[idx] = { ...list[idx], ...row };
  else list.push(row);
  return list;
}
function fillProxyPanel(settings: ProxySettings): void {
  (mustGet('proxy-enabled') as HTMLInputElement).checked = settings.enabled;
  (mustGet('proxy-chain-mode') as HTMLSelectElement).value = settings.chainMode;
  (mustGet('proxy-active-stage') as HTMLSelectElement).value = settings.activeStage;
  (mustGet('proxy-prefer-method-pools') as HTMLInputElement).checked = Boolean(settings.preferMethodPools);
  (mustGet('proxy-seed-health-enabled') as HTMLInputElement).checked = settings.seedHealthEnabled !== false;
  (mustGet('proxy-seed-cooldown') as HTMLInputElement).value = String(settings.seedFailCooldownSec ?? 180);
  (mustGet('proxy-seed-remove-after') as HTMLInputElement).value = String(settings.seedRemoveAfterFails ?? 3);
  (mustGet('proxy-seed-skip-after') as HTMLInputElement).value = String(settings.seedFailSkipAfter ?? 1);
  const routing = settings.automationRouting;
  (mustGet('proxy-auto-routing-enabled') as HTMLInputElement).checked = routing.enabled;
  (mustGet('proxy-auto-sticky') as HTMLInputElement).checked = routing.stickyWithinStage;
  (mustGet('proxy-auto-verify') as HTMLInputElement).checked = routing.verifyExitOnSwitch;
  (mustGet('proxy-auto-distinct') as HTMLInputElement).checked = routing.requireDistinctExits;
  (mustGet('proxy-auto-max-attempts') as HTMLInputElement).value = String(routing.maxSwitchAttempts);
  for (const stage of ['auth', 'checkout', 'billing'] as const) {
    const route = routing[stage];
    (mustGet(`proxy-auto-${stage}-fallback`) as HTMLSelectElement).value = route.fallbackStage;
    (mustGet(`proxy-auto-${stage}-pool`) as HTMLTextAreaElement).value = route.poolRaw;
    (mustGet(`proxy-auto-${stage}-rotate`) as HTMLInputElement).checked = route.rotateOnEnter;
  }
  renderAutomationProxyEvidence(settings);
  renderSeedHealthBoard(settings);
  fillActiveMethodPool(settings);
  fillProxyEndpoint('front', settings.front);
  fillProxyEndpoint('exit1', settings.exit1);
  fillProxyEndpoint('exit2', settings.exit2);
  const countryArea = document.getElementById('probe-country-exits') as HTMLTextAreaElement | null;
  if (countryArea && Array.isArray(settings.countryExits)) {
    countryArea.value = settings.countryExits.map((row) => {
      const ep = row.endpoint;
      const auth = ep.username ? `${ep.username}:${ep.password || ''}@` : '';
      return `${row.country}----${ep.scheme}://${auth}${ep.host}:${ep.port}`;
    }).join('\n');
  }
  const summary = mustGet('proxy-summary-em');
  const countryCount = settings.countryExits?.length || 0;
  const poolCount = settings.methodPools?.length || 0;
  summary.textContent = settings.enabled
    ? `${settings.chainMode === 'front-gateway' ? '前置网关' : '直连出口'} · ${settings.activeStage} · 国家${countryCount} · 池${poolCount}`
    : '未启用';
}

function renderAutomationProxyEvidence(settings: ProxySettings): void {
  const labels: Record<AutomationProxyStage, string> = { auth: 'Auth', checkout: 'Checkout/优惠', billing: 'Billing' };
  const rows = (['auth', 'checkout', 'billing'] as const).map((stage) => {
    const row = settings.automationRouting.evidence[stage];
    if (!row) return `${labels[stage]}：待运行`;
    const exit = row.verified ? `${row.country || '--'} ${row.ip}${row.colo ? ` (${row.colo})` : ''}` : row.endpointSummary;
    const repeated = row.excludedIp ? ` · 失败 IP 重复，已拒绝 ${row.repeatedIpRejected || 1} 次` : '';
    return `${labels[stage]}：${exit}${row.distinct ? '' : ' · 与其他阶段重复'}${repeated}`;
  });
  mustGet('proxy-auto-evidence').textContent = rows.join(' ｜ ');
}

function fillProxyEndpoint(key: 'front' | 'exit1' | 'exit2', endpoint: ProxyEndpoint): void {
  (mustGet(`proxy-${key}-enabled`) as HTMLInputElement).checked = endpoint.enabled;
  (mustGet(`proxy-${key}-scheme`) as HTMLSelectElement).value = endpoint.scheme;
  (mustGet(`proxy-${key}-host`) as HTMLInputElement).value = endpoint.host;
  (mustGet(`proxy-${key}-port`) as HTMLInputElement).value = endpoint.port ? String(endpoint.port) : '';
  (mustGet(`proxy-${key}-username`) as HTMLInputElement).value = endpoint.username;
  (mustGet(`proxy-${key}-password`) as HTMLInputElement).value = endpoint.password;
}

function collectProxyEndpoint(key: 'front' | 'exit1' | 'exit2', label: string): ProxyEndpoint {
  return normalizeEndpoint({
    enabled: checkedOf(`proxy-${key}-enabled`),
    scheme: valueOf(`proxy-${key}-scheme`),
    host: valueOf(`proxy-${key}-host`),
    port: Number(valueOf(`proxy-${key}-port`) || 0),
    username: valueOf(`proxy-${key}-username`),
    password: valueOf(`proxy-${key}-password`),
    label,
  }, DEFAULT_PROXY_SETTINGS[key]);
}

function collectProxySettingsFromForm(): ProxySettings {
  const currentPools = latestProxySettings?.methodPools || [];
  const method = valueOf('proxy-pool-method').trim().toLowerCase() || 'ideal';
  const mergedPools = mergeMethodPool(currentPools, {
    method,
    bootstrapRaw: valueOf('proxy-pool-bootstrap'),
    promotionRaw: valueOf('proxy-pool-promotion'),
    providerRaw: valueOf('proxy-pool-provider'),
    bootstrapIndex: 0,
    promotionIndex: 0,
    providerIndex: 0,
  });
  const currentRouting = latestProxySettings?.automationRouting || DEFAULT_PROXY_SETTINGS.automationRouting;
  const routeFromForm = (stage: AutomationProxyStage) => ({
    ...currentRouting[stage],
    enabled: true,
    fallbackStage: valueOf(`proxy-auto-${stage}-fallback`),
    poolRaw: valueOf(`proxy-auto-${stage}-pool`),
    rotateOnEnter: checkedOf(`proxy-auto-${stage}-rotate`),
  });
  return normalizeProxySettings({
    enabled: checkedOf('proxy-enabled'),
    chainMode: valueOf('proxy-chain-mode') === 'front-gateway' ? 'front-gateway' : 'direct-exit',
    activeStage: valueOf('proxy-active-stage') as ProxyStage,
    preferMethodPools: checkedOf('proxy-prefer-method-pools'),
    automationRouting: {
      ...currentRouting,
      enabled: checkedOf('proxy-auto-routing-enabled'),
      stickyWithinStage: checkedOf('proxy-auto-sticky'),
      verifyExitOnSwitch: checkedOf('proxy-auto-verify'),
      requireDistinctExits: checkedOf('proxy-auto-distinct'),
      maxSwitchAttempts: Number(valueOf('proxy-auto-max-attempts') || 3),
      auth: routeFromForm('auth'),
      checkout: routeFromForm('checkout'),
      billing: routeFromForm('billing'),
    },
    seedHealthEnabled: checkedOf('proxy-seed-health-enabled'),
    seedFailCooldownSec: Number(valueOf('proxy-seed-cooldown') || 180),
    seedRemoveAfterFails: Number(valueOf('proxy-seed-remove-after') || 3),
    seedFailSkipAfter: Number(valueOf('proxy-seed-skip-after') || 1),
    seedHealth: latestProxySettings?.seedHealth || [],
    front: collectProxyEndpoint('front', '前置代理'),
    exit1: collectProxyEndpoint('exit1', '出口1（任意国家）'),
    exit2: collectProxyEndpoint('exit2', '出口2（任意国家）'),
    countryExits: parseCountryExitText(valueOf('probe-country-exits') || ''),
    methodPools: mergedPools,
  });
}

async function refreshProxyStatus(): Promise<void> {
  const statusEl = mustGet('proxy-status');
  try {
    const status = await browser.runtime.sendMessage({ type: 'opx:proxy-status' }) as ProxyRuntimeStatus;
    if (!status) {
      setInlineStatus(statusEl, '无法读取代理状态', 'error');
      return;
    }
    const mode = status.browserProxyMode || '-';
    setInlineStatus(
      statusEl,
      `${status.message} · browser=${mode} · ${status.applied?.summary || ''}`,
      status.ok ? 'ok' : 'error',
    );
    if (status.settings) {
      fillProxyPanel(status.settings);
    }
  } catch (error) {
    setInlineStatus(statusEl, error instanceof Error ? error.message : String(error), 'error');
  }
}

function applyParsedEndpointToForm(key: 'front' | 'exit1' | 'exit2', endpoint: ProxyEndpoint): void {
  (mustGet(`proxy-${key}-enabled`) as HTMLInputElement).checked = true;
  (mustGet(`proxy-${key}-scheme`) as HTMLSelectElement).value = endpoint.scheme;
  (mustGet(`proxy-${key}-host`) as HTMLInputElement).value = endpoint.host;
  (mustGet(`proxy-${key}-port`) as HTMLInputElement).value = String(endpoint.port || '');
  (mustGet(`proxy-${key}-username`) as HTMLInputElement).value = endpoint.username || '';
  (mustGet(`proxy-${key}-password`) as HTMLInputElement).value = endpoint.password || '';
}

function parseProxyPasteToForm(saveAfter: boolean): void {
  const statusEl = mustGet('proxy-status');
  const parseStatus = mustGet('proxy-parse-status');
  const raw = valueOf('proxy-paste-raw');
  const target = valueOf('proxy-parse-target') || 'exit1';
  const schemeRaw = valueOf('proxy-parse-scheme') || 'http';
  const scheme = (schemeRaw === 'https' || schemeRaw === 'socks4' || schemeRaw === 'socks5' ? schemeRaw : 'http') as 'http' | 'https' | 'socks4' | 'socks5';
  const list = parseProxyConnectionList(raw, { scheme, enabled: true, label: '解析代理' });
  if (!list.length) {
    parseStatus.textContent = '解析失败：未识别到 host:port / user:pass / curl 格式';
    setInlineStatus(statusEl, '代理文本解析失败', 'error');
    return;
  }

  if (target === 'country') {
    const area = mustGet('probe-country-exits') as HTMLTextAreaElement;
    const rows = list.map((item, index) => {
      const guessed = guessCountryFromUsername(item.endpoint.username) || `C${index + 1}`;
      const auth = item.endpoint.username
        ? `${item.endpoint.username}:${item.endpoint.password || ''}@`
        : '';
      return `${guessed}----${item.endpoint.scheme}://${auth}${item.endpoint.host}:${item.endpoint.port}`;
    });
    area.value = [area.value.trim(), ...rows].filter(Boolean).join('\n');
    parseStatus.textContent = `已解析 ${rows.length} 条并追加到国家出口映射（国家码可再改）`;
    setInlineStatus(statusEl, parseStatus.textContent, 'ok');
    return;
  }

  if (target === 'exit1-exit2') {
    applyParsedEndpointToForm('exit1', { ...list[0].endpoint, label: '出口1（任意国家）' });
    if (list[1]) applyParsedEndpointToForm('exit2', { ...list[1].endpoint, label: '出口2（任意国家）' });
    (mustGet('proxy-enabled') as HTMLInputElement).checked = true;
    parseStatus.textContent = list[1]
      ? `已填充出口1 + 出口2（格式 ${list[0].format}/${list[1].format}）`
      : `仅识别到 1 条，已填出口1（格式 ${list[0].format}）`;
  } else {
    const key = (target === 'front' || target === 'exit2' ? target : 'exit1') as 'front' | 'exit1' | 'exit2';
    applyParsedEndpointToForm(key, {
      ...list[0].endpoint,
      label: key === 'front' ? '前置代理' : key === 'exit1' ? '出口1（任意国家）' : '出口2（任意国家）',
    });
    (mustGet('proxy-enabled') as HTMLInputElement).checked = true;
    parseStatus.textContent = `已填充到 ${key}：${list[0].endpoint.host}:${list[0].endpoint.port}（${list[0].format}）`;
  }

  setInlineStatus(statusEl, parseStatus.textContent, 'ok');
  if (saveAfter) {
    void (async () => {
      try {
        const settings = collectProxySettingsFromForm();
        const result = await browser.runtime.sendMessage({
          type: 'opx:proxy-save',
          settings,
          applyStage: settings.enabled ? settings.activeStage : 'none',
        }) as ProxyRuntimeStatus;
        fillProxyPanel(result.settings || settings);
        setInlineStatus(statusEl, result.message || '解析并保存完成', result.ok ? 'ok' : 'error');
      } catch (error) {
        setInlineStatus(statusEl, error instanceof Error ? error.message : String(error), 'error');
      }
    })();
  }
}

function guessCountryFromUsername(username: string): string {
  const text = String(username || '');
  const m = text.match(/region-([A-Za-z]{2,})/i) || text.match(/(?:^|[_-])([A-Z]{2})(?:[_-]|$)/);
  if (!m) return '';
  const raw = m[1].toUpperCase();
  if (raw === 'RAND' || raw === 'RANDOM') return '';
  if (/^[A-Z]{2}$/.test(raw)) return raw;
  // region-US_DE_SG_BR -> take first
  const first = raw.split(/[_-]/)[0];
  return /^[A-Z]{2}$/.test(first) ? first : '';
}


function wireRegisterToolImport(statusEl: HTMLElement): void {
  const localBtn = document.getElementById('btn-proxy-rt-local');
  if (!localBtn || localBtn.dataset.bound === '1') return;
  localBtn.dataset.bound = '1';
  localBtn.addEventListener('click', () => void applyRegisterToolImport('local'));
  mustGet('btn-proxy-rt-import').addEventListener('click', () => void applyRegisterToolImport('json'));
  const mailboxBtn = document.getElementById('btn-proxy-rt-mailboxes');
  if (mailboxBtn) {
    mailboxBtn.addEventListener('click', () => void applyRegisterToolMailboxPaste());
  }
  mustGet('btn-proxy-rt-clear').addEventListener('click', () => {
    (mustGet('proxy-register-tool-json') as HTMLTextAreaElement).value = '';
    mustGet('proxy-rt-status').textContent = '粘贴框已清空（仅清空代理 JSON，不影响邮箱池）';
  });
  void statusEl;
}

async function applyRegisterToolMailboxPaste(): Promise<void> {
  const statusEl = mustGet('proxy-status');
  const rtStatus = mustGet('proxy-rt-status');
  const text = valueOf('proxy-register-tool-json');
  try {
    let imported = {
      ok: false,
      message: '',
      lines: [] as string[],
      count: 0,
      skipped: 0,
      errors: [] as string[],
      source: '',
    };
    const trimmed = text.trim();
    if (trimmed.startsWith('{')) {
      imported = importRegisterToolMailboxesFromConfig(parseRegisterToolConfigText(trimmed));
      if (!imported.ok) {
        imported = importRegisterToolMailboxText(trimmed, { source: 'register-tool-paste' });
      }
    } else {
      imported = importRegisterToolMailboxText(trimmed, { source: 'register-tool-paste' });
    }
    if (!imported.ok) {
      setInlineStatus(rtStatus, imported.message, 'error');
      setInlineStatus(statusEl, imported.message, 'error');
      return;
    }
    const rawEmailsInput = document.getElementById('raw-emails') as HTMLTextAreaElement | null;
    if (!rawEmailsInput) {
      setInlineStatus(rtStatus, '页面缺少邮箱池输入框', 'error');
      return;
    }
    rawEmailsInput.value = mergeMailboxLinesByEmail(rawEmailsInput.value, imported.lines);
    rawEmailsInput.dispatchEvent(new Event('input', { bubbles: true }));
    setInlineStatus(rtStatus, `${imported.message}。请点顶部“保存设置”写入邮箱池后重跑自动化。`, 'ok');
    setInlineStatus(statusEl, `邮箱池已填充 ${imported.count} 个账号（未保存）`, 'ok');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setInlineStatus(rtStatus, message, 'error');
    setInlineStatus(statusEl, message, 'error');
  }
}

async function applyRegisterToolImport(mode: 'local' | 'json'): Promise<void> {
  const statusEl = mustGet('proxy-status');
  const rtStatus = mustGet('proxy-rt-status');
  const enablePools = (mustGet('proxy-rt-enable-pools') as HTMLInputElement).checked;
  const merge = (mustGet('proxy-rt-merge') as HTMLInputElement).checked;
  const saveApply = (mustGet('proxy-rt-save-apply') as HTMLInputElement).checked;
  const existing = latestProxySettings || collectProxySettingsFromForm();
  try {
    const imported = mode === 'local'
      ? importRegisterToolLocalRuntime({
          existing,
          merge,
          enableMethodPools: enablePools,
        })
      : importRegisterToolConfig(parseRegisterToolConfigText(valueOf('proxy-register-tool-json')), {
          existing,
          merge,
          enableMethodPools: enablePools,
        });
    if (!imported.ok) {
      setInlineStatus(rtStatus, imported.message, 'error');
      setInlineStatus(statusEl, imported.message, 'error');
      return;
    }
    fillProxyPanel(imported.settings);
    let mailboxNote = '邮箱池未改（mailbox_proxy 不是账号池）';
    const syncMailboxes = (document.getElementById('proxy-rt-import-mailboxes') as HTMLInputElement | null)?.checked !== false;
    if (mode === 'json' && syncMailboxes) {
      try {
        const mailboxImported = importRegisterToolMailboxesFromConfig(
          parseRegisterToolConfigText(valueOf('proxy-register-tool-json')),
        );
        if (mailboxImported.ok) {
          const rawEmailsInput = document.getElementById('raw-emails') as HTMLTextAreaElement | null;
          if (rawEmailsInput) {
            rawEmailsInput.value = mergeMailboxLinesByEmail(rawEmailsInput.value, mailboxImported.lines);
            rawEmailsInput.dispatchEvent(new Event('input', { bubbles: true }));
            mailboxNote = `邮箱池已同步 ${mailboxImported.count} 个（需点保存设置）`;
          }
        } else {
          mailboxNote = mailboxImported.message;
        }
      } catch (mailboxError) {
        mailboxNote = mailboxError instanceof Error ? mailboxError.message : String(mailboxError);
      }
    } else if (mode === 'local') {
      mailboxNote = '本机链式默认只接代理；请用“导入 Register-Tool 邮箱”粘贴 mailbox_acica_export.txt';
    }

    latestProxySettings = imported.settings;
    const detail = `front=${imported.summary.front} · exit1=${imported.summary.exit1} · exit2=${imported.summary.exit2} · 国家 ${imported.summary.countries.join(',') || '-'} · 池 ${imported.summary.methods.join(',') || '-'} · ${mailboxNote}`;
    setInlineStatus(rtStatus, `${imported.message} · ${detail}`, 'ok');
    if (!saveApply) {
      setInlineStatus(statusEl, '已填充表单（未保存）', 'ok');
      return;
    }
    const result = await browser.runtime.sendMessage({
      type: 'opx:proxy-save',
      settings: imported.settings,
      applyStage: imported.settings.enabled ? 'front' : 'none',
    }) as ProxyRuntimeStatus;
    if (result?.settings) {
      latestProxySettings = result.settings;
      fillProxyPanel(result.settings);
    }
    setInlineStatus(statusEl, result?.message || imported.message, result?.ok === false ? 'error' : 'ok');
    setInlineStatus(rtStatus, `${imported.message} · 已保存应用`, result?.ok === false ? 'error' : 'ok');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setInlineStatus(rtStatus, message, 'error');
    setInlineStatus(statusEl, message, 'error');
  }
}

function bindProxyPanel(): void {
  const statusEl = mustGet('proxy-status');
  mustGet('btn-proxy-parse-fill').addEventListener('click', () => {
    parseProxyPasteToForm(false);
    flashButtonLabel(mustGet('btn-proxy-parse-fill') as HTMLButtonElement, '已解析');
  });
  mustGet('btn-proxy-parse-save').addEventListener('click', () => {
    parseProxyPasteToForm(true);
    flashButtonLabel(mustGet('btn-proxy-parse-save') as HTMLButtonElement, '已保存');
  });
  mustGet('btn-proxy-parse-clear').addEventListener('click', () => {
    (mustGet('proxy-paste-raw') as HTMLTextAreaElement).value = '';
    mustGet('proxy-parse-status').textContent = '粘贴框已清空';
  });
  wireRegisterToolImport(statusEl);
  mustGet('btn-proxy-preset-7890').addEventListener('click', () => {
    (mustGet('proxy-front-host') as HTMLInputElement).value = '127.0.0.1';
    (mustGet('proxy-front-port') as HTMLInputElement).value = '7890';
    (mustGet('proxy-front-scheme') as HTMLSelectElement).value = 'http';
    (mustGet('proxy-front-enabled') as HTMLInputElement).checked = true;
    flashButtonLabel(mustGet('btn-proxy-preset-7890') as HTMLButtonElement, '已填');
  });
  mustGet('btn-proxy-preset-10808').addEventListener('click', () => {
    (mustGet('proxy-front-host') as HTMLInputElement).value = '127.0.0.1';
    (mustGet('proxy-front-port') as HTMLInputElement).value = '10808';
    (mustGet('proxy-front-scheme') as HTMLSelectElement).value = 'socks5';
    (mustGet('proxy-front-enabled') as HTMLInputElement).checked = true;
    flashButtonLabel(mustGet('btn-proxy-preset-10808') as HTMLButtonElement, '已填');
  });
  mustGet('btn-proxy-pool-save').addEventListener('click', async () => {
    const button = mustGet('btn-proxy-pool-save') as HTMLButtonElement;
    const restore = setButtonPending(button, '保存中...');
    try {
      const settings = collectProxySettingsFromForm();
      const result = await browser.runtime.sendMessage({
        type: 'opx:proxy-save',
        settings,
      }) as ProxyRuntimeStatus;
      latestProxySettings = result.settings || settings;
      fillProxyPanel(latestProxySettings);
      setInlineStatus(mustGet('proxy-pool-status'), '方式三池已保存', 'ok');
    } catch (error) {
      setInlineStatus(mustGet('proxy-pool-status'), `保存失败：${String(error)}`, 'error');
    } finally {
      restore();
    }
  });
  mustGet('proxy-pool-method').addEventListener('change', () => {
    if (latestProxySettings) fillActiveMethodPool(latestProxySettings);
  });
  mustGet('btn-proxy-save').addEventListener('click', async () => {
    const button = mustGet('btn-proxy-save') as HTMLButtonElement;
    const restore = setButtonPending(button, '保存中...');
    try {
      const settings = collectProxySettingsFromForm();
      const result = await browser.runtime.sendMessage({
        type: 'opx:proxy-save',
        settings,
        applyStage: settings.enabled ? settings.activeStage : 'none',
      }) as ProxyRuntimeStatus;
      fillProxyPanel(result.settings || settings);
      setInlineStatus(statusEl, result.message || '代理已保存', result.ok ? 'ok' : 'error');
    } catch (error) {
      setInlineStatus(statusEl, error instanceof Error ? error.message : String(error), 'error');
    } finally {
      restore();
    }
  });
  mustGet('btn-proxy-apply').addEventListener('click', async () => {
    const button = mustGet('btn-proxy-apply') as HTMLButtonElement;
    const restore = setButtonPending(button, '应用中...');
    try {
      // save first so latest form values are used
      const settings = collectProxySettingsFromForm();
      await browser.runtime.sendMessage({ type: 'opx:proxy-save', settings });
      const stage = valueOf('proxy-active-stage') as ProxyStage;
      const result = await browser.runtime.sendMessage({ type: 'opx:proxy-apply', stage }) as ProxyRuntimeStatus;
      if (result.settings) fillProxyPanel(result.settings);
      setInlineStatus(statusEl, result.message || '已应用', result.ok ? 'ok' : 'error');
    } catch (error) {
      setInlineStatus(statusEl, error instanceof Error ? error.message : String(error), 'error');
    } finally {
      restore();
    }
  });
  mustGet('btn-proxy-clear').addEventListener('click', async () => {
    const button = mustGet('btn-proxy-clear') as HTMLButtonElement;
    const restore = setButtonPending(button, '清除中...');
    try {
      const result = await browser.runtime.sendMessage({ type: 'opx:proxy-clear' }) as ProxyRuntimeStatus;
      if (result.settings) fillProxyPanel(result.settings);
      setInlineStatus(statusEl, result.message || '已清除', result.ok ? 'ok' : 'error');
    } catch (error) {
      setInlineStatus(statusEl, error instanceof Error ? error.message : String(error), 'error');
    } finally {
      restore();
    }
  });
  mustGet('btn-proxy-refresh').addEventListener('click', async () => {
    const button = mustGet('btn-proxy-refresh') as HTMLButtonElement;
    const restore = setButtonPending(button, '刷新中...');
    try {
      await refreshProxyStatus();
    } finally {
      restore();
    }
  });
}


async function loadAndFillProbePanel(): Promise<void> {
  const response = await browser.runtime.sendMessage({ type: 'opx:probe-get-state' }) as ProbeResponse;
  if (!response?.state) {
    setInlineStatus(mustGet('probe-task-status'), response?.message || '无法读取探测状态', 'error');
    return;
  }
  fillProbePanel(response.state);
}

function fillProbePanel(state: ProbeState): void {
  const raw = mustGet('probe-raw-accounts') as HTMLTextAreaElement;
  if (!raw.value.trim()) {
    raw.value = state.rawAccounts || state.accounts.map((item) => `${item.email}----${item.tokenRaw}`).join('\n');
  }
  const identityReady = state.accounts.filter((item) => item.identitySnapshot?.cookies?.length).length;
  mustGet('probe-account-summary').textContent = `账号 ${state.accounts.length} · 启用 ${state.accounts.filter((item) => item.enabled).length} · Cookie 身份就绪 ${identityReady} · 仅 AT ${state.accounts.length - identityReady} · 运行命中 ${state.hits.length} · 命中库 ${(state.hitDatabase || []).length}`;
  const task = state.tasks.find((item) => item.id === state.activeTaskId) || state.tasks[0] || null;
  const config = task?.config || DEFAULT_PROBE_TASK_CONFIG;
  (mustGet('probe-task-name') as HTMLInputElement).value = config.name;
  (mustGet('probe-interval') as HTMLInputElement).value = String(config.intervalSec);
  (mustGet('probe-concurrency') as HTMLInputElement).value = String(config.concurrency);
  (mustGet('probe-retry') as HTMLInputElement).value = String(config.retryCount);
  (mustGet('probe-plan') as HTMLSelectElement).value = config.planName;
  (mustGet('probe-account-source') as HTMLSelectElement).value = config.accountSource;
  (mustGet('probe-entry-proxy') as HTMLSelectElement).value = config.entryProxyMode;
  (mustGet('probe-exit-proxy') as HTMLSelectElement).value = config.exitProxyMode;
  (mustGet('probe-pin-success') as HTMLInputElement).checked = config.pinOnSuccess;
  (mustGet('probe-skip-after-hit') as HTMLInputElement).checked = config.skipAccountAfterHit;
  (mustGet('probe-auto-switch-exit') as HTMLInputElement).checked = config.autoSwitchExitByCountry;
  (mustGet('probe-auto-open-hit') as HTMLInputElement).checked = config.autoOpenOnHit !== false;
  (mustGet('probe-sniff-hit') as HTMLInputElement).checked = config.sniffCheckoutOnHit !== false;
  (mustGet('probe-save-hitdb') as HTMLInputElement).checked = config.saveHitsToDatabase !== false;
  (mustGet('probe-exclude-unhealthy') as HTMLInputElement).checked = config.excludeUnhealthyExits !== false;
  (mustGet('probe-high-rate-only') as HTMLInputElement).checked = Boolean(config.highHitRateOnly);
  (mustGet('probe-exploration-enabled') as HTMLInputElement).checked = config.explorationEnabled !== false;
  (mustGet('probe-exploration-count') as HTMLInputElement).value = String(config.explorationCountryCount ?? 2);
  (mustGet('probe-factor-tracking') as HTMLInputElement).checked = config.factorTrackingEnabled !== false;
  (mustGet('probe-drift-detection') as HTMLInputElement).checked = config.driftDetectionEnabled !== false;
  (mustGet('probe-adaptive-percent') as HTMLInputElement).value = String(config.adaptiveExplorationPercent ?? 20);
  (mustGet('probe-factor-min-samples') as HTMLInputElement).value = String(config.factorMinSamples ?? 5);
  (mustGet('probe-drift-min-samples') as HTMLInputElement).value = String(config.driftMinSamples ?? 10);
  (mustGet('probe-observation-limit') as HTMLInputElement).value = String(config.observationRetentionLimit ?? 3000);
  (mustGet('probe-experiment-mode') as HTMLSelectElement).value = config.experimentMode || (config.researchModeEnabled ? 'attribution' : 'discovery');
  (mustGet('probe-research-mode') as HTMLInputElement).checked = (config.experimentMode || (config.researchModeEnabled ? 'attribution' : 'discovery')) !== 'discovery';
  (mustGet('probe-exploit-percent') as HTMLInputElement).value = String(config.exploitTrafficPercent ?? 50);
  (mustGet('probe-balanced-percent') as HTMLInputElement).value = String(config.balancedTrafficPercent ?? 30);
  (mustGet('probe-explore-percent') as HTMLInputElement).value = String(config.explorationTrafficPercent ?? 20);
  document.querySelectorAll<HTMLInputElement>('[data-probe-factor]').forEach((input) => {
    input.checked = (config.controlledFactors || []).includes(input.dataset.probeFactor as any);
  });
  (mustGet('probe-route-variants') as HTMLTextAreaElement).value = formatRouteVariantsText(config.routeVariants || []);
  (mustGet('probe-payment-variants') as HTMLInputElement).value = (config.paymentMethodVariants || []).join(',');
  (mustGet('probe-seed-replicates') as HTMLInputElement).value = String(config.seedReplicatesPerCell ?? 3);
  (mustGet('probe-balanced-order') as HTMLInputElement).checked = config.balancedOrderEnabled !== false;
  (mustGet('probe-research-target-cell') as HTMLInputElement).value = String(config.researchTargetSamplesPerCell ?? 3);
  (mustGet('probe-research-repeat-minutes') as HTMLInputElement).value = String(config.researchMinRepeatIntervalMinutes ?? 240);
  (mustGet('probe-research-min-total') as HTMLInputElement).value = String(config.researchMinTotalSamples ?? 100);
  (mustGet('probe-min-hit-rate') as HTMLInputElement).value = String(config.minHitRatePercent ?? 30);
  (mustGet('probe-min-hit-attempts') as HTMLInputElement).value = String(config.minHitAttempts ?? 3);
  (mustGet('probe-max-high-rate') as HTMLInputElement).value = String(config.maxHighRateCountries ?? 12);
  (mustGet('probe-staged-pipeline') as HTMLInputElement).checked = Boolean(config.stagedPipelineEnabled);
  (mustGet('probe-use-selected-bootstrap') as HTMLInputElement).checked = config.useSelectedAsBootstrapProvider !== false;
  (mustGet('probe-enable-promotion-update') as HTMLInputElement).checked = config.enablePromotionUpdate !== false;
  (mustGet('probe-enable-provider-taxes') as HTMLInputElement).checked = Boolean(config.enableProviderTaxes);
  (mustGet('probe-require-zero') as HTMLInputElement).checked = Boolean(config.requireZero);
  (mustGet('probe-checkout-ui-mode') as HTMLSelectElement).value = config.checkoutUiMode || 'hosted';
  (mustGet('probe-extract-final-url') as HTMLInputElement).checked = Boolean(config.extractFinalPaymentUrl);
  (mustGet('probe-enable-stripe-confirm') as HTMLInputElement).checked = Boolean(config.enableStripeConfirm);
  (mustGet('probe-payment-checkout-mode') as HTMLSelectElement).value = config.paymentCheckoutSessionMode || 'reuse_eligibility_session';
  (mustGet('probe-extract-all-methods') as HTMLInputElement).checked = config.extractAllDetectedMethods !== false;
  (mustGet('probe-force-unlisted-methods') as HTMLInputElement).checked = Boolean(config.forceUnlistedPaymentMethodProbe);
  (mustGet('probe-detect-methods') as HTMLInputElement).checked = Boolean(config.detectPaymentMethods);
  (mustGet('probe-attach-detected-methods') as HTMLInputElement).checked = config.attachDetectedMethods !== false;
  (mustGet('probe-auto-apply-detected-methods') as HTMLInputElement).checked = config.autoApplyDetectedMethods !== false;
  (mustGet('probe-payment-method') as HTMLSelectElement).value = String(config.paymentMethod || '');
  (mustGet('probe-ideal-bank') as HTMLInputElement).value = String(config.idealBank || 'n26');
  (mustGet('probe-stripe-pk') as HTMLInputElement).value = String(config.stripePublishableKey || '');
  (mustGet('probe-promotion-country') as HTMLInputElement).value = String(config.promotionCountry || 'VN');
  (mustGet('probe-bootstrap-country') as HTMLInputElement).value = String(config.bootstrapCountry || '');
  (mustGet('probe-provider-country') as HTMLInputElement).value = String(config.providerCountry || '');
  (mustGet('probe-notify-mode') as HTMLSelectElement).value = config.notifyMode;
  (mustGet('probe-sound-enabled') as HTMLInputElement).checked = config.soundEnabled;
  (mustGet('probe-tls-note') as HTMLInputElement).checked = config.preferChromeTlsNote;
  syncProbeHighRateInputs();
  syncProbeFactorInputs();
  renderProbeCountries(config.countries);
  renderProbeChannels(config.channels);
  latestProbeState = state;
  renderProbeHits(state.hits);
  renderProbeStats(state.stats || []);
  renderProbeHealth(state.proxyHealth || []);
  renderProbeHitDatabase(state.hitDatabase || [], collectProbeHitDbFilter());
  renderProbeAccountReport(state);
  renderProbeFactorBoard(state);
  renderProbeRecommendBoard(state);
  renderProbeMethodsBoard(state);
  const summary = mustGet('probe-summary-em');
  if (task) {
    const plan = previewProbeCountryPlan(state, task.config);
    const totalUnits = task.runtime.totalUnits || plan.countries.length;
    const completedUnits = task.runtime.completedUnits || task.runtime.processed;
    summary.textContent = `${task.runtime.status} · round ${task.runtime.round} · hit ${task.runtime.hits} · 完成 ${completedUnits}/${totalUnits}`;
    setInlineStatus(
      mustGet('probe-task-status'),
      `${task.config.name} · ${task.runtime.status} · ${task.runtime.lastMessage || '待命'} · 完成 ${completedUnits}/${totalUnits} · 实际请求 ${task.runtime.processed} · 跳过 ${task.runtime.skippedUnits || 0} · ${plan.note}`,
      task.runtime.status === 'error' ? 'error' : 'ok',
    );
    renderProbeRunCenter(task);
  } else {
    summary.textContent = '未创建任务';
    renderProbeRunCenter(null);
  }
  void loadCountryExitTextarea();
  void refreshRunLogPanel(false);
}

async function loadCountryExitTextarea(): Promise<void> {
  try {
    const status = await browser.runtime.sendMessage({ type: 'opx:proxy-status' }) as { settings?: { countryExits?: Array<{ country: string; endpoint: { scheme: string; host: string; port: number; username?: string; password?: string } }> } };
    const rows = status?.settings?.countryExits || [];
    const area = mustGet('probe-country-exits') as HTMLTextAreaElement;
    if (!area.value.trim()) {
      area.value = rows.map((row) => {
        const auth = row.endpoint.username ? `${row.endpoint.username}:${row.endpoint.password || ''}@` : '';
        return `${row.country}----${row.endpoint.scheme}://${auth}${row.endpoint.host}:${row.endpoint.port}`;
      }).join('\n');
    }
  } catch {
    // ignore
  }
}

function renderProbeCountries(selected: string[]): void {
  const host = mustGet('probe-country-grid');
  const selectedSet = new Set(selected.map((item) => item.toUpperCase()));
  host.innerHTML = listProbeCountries().map((item) => `
    <label class="probe-country-item">
      <input type="checkbox" data-probe-country="${item.country}" ${selectedSet.has(item.country) ? 'checked' : ''} />
      <span>${item.country} <small>${item.currency}</small></span>
    </label>
  `).join('');
  mustGet('probe-country-count').textContent = String(selectedSet.size);
  host.querySelectorAll('input[data-probe-country]').forEach((input) => {
    input.addEventListener('change', () => {
      mustGet('probe-country-count').textContent = String(collectProbeCountries().length);
      renderProbeRecommendBoard(latestProbeState);
    });
  });
}

function renderProbeChannels(selected: string[]): void {
  const host = mustGet('probe-channel-row');
  const selectedSet = new Set(selected.map((item) => item.toLowerCase()));
  host.innerHTML = PROBE_CHANNELS.map((channel) => `
    <label class="probe-channel-item">
      <input type="checkbox" data-probe-channel="${channel}" ${selectedSet.has(channel) ? 'checked' : ''} />
      <span>${channel}</span>
    </label>
  `).join('');
}

function renderProbeStats(stats: Array<{ country: string; channel: string; attempts: number; hits: number; errors: number; lastHitAt: number }>): void {
  const host = mustGet('probe-stats-table');
  if (!stats.length) {
    host.innerHTML = '<div class="table-empty">暂无统计，先跑一轮探测</div>';
    return;
  }
  const rows = [...stats].sort((a, b) => (b.hits - a.hits) || (b.attempts - a.attempts) || a.country.localeCompare(b.country)).slice(0, 100);
  host.innerHTML = `<table class="data-table"><thead><tr><th>国家</th><th>通道</th><th>尝试</th><th>命中</th><th>失败</th><th>命中率</th><th>最近</th></tr></thead><tbody>${rows.map((row) => { const rate = row.attempts ? Math.round((row.hits / row.attempts) * 100) : 0; return `<tr><td>${escapeHtml(row.country)}</td><td>${escapeHtml(row.channel)}</td><td>${row.attempts}</td><td>${row.hits}</td><td>${row.errors}</td><td>${rate}%</td><td>${row.lastHitAt ? new Date(row.lastHitAt).toLocaleString() : '-'}</td></tr>`; }).join('')}</tbody></table>`;
}

function renderProbeHealth(items: Array<{ country: string; status: string; latencyMs: number; endpointSummary: string; message: string; actualIp?: string; actualCountry?: string; asn?: string; asOrganization?: string; ipVersion?: string; networkType?: string }>): void {
  const host = mustGet('probe-health-table');
  if (!items.length) {
    host.innerHTML = '<div class="table-empty">尚未检查，点击“检查出口健康”</div>';
    return;
  }
  host.innerHTML = `<table class="data-table"><thead><tr><th>目标国家</th><th>状态</th><th>延迟</th><th>实际出口</th><th>ASN/网络</th><th>代理端点</th><th>详情</th></tr></thead><tbody>${items.map((item) => `<tr><td>${escapeHtml(item.country)}</td><td><span class="status-pill" data-status="${escapeAttr(item.status === 'ok' ? 'success' : item.status === 'fail' ? 'error' : 'idle')}">${escapeHtml(item.status)}</span></td><td>${item.latencyMs ? `${item.latencyMs}ms` : '-'}</td><td>${escapeHtml([item.actualIp, item.actualCountry, item.ipVersion].filter(Boolean).join(' / ') || '-')}</td><td>${escapeHtml([item.asn, item.asOrganization, item.networkType].filter(Boolean).join(' / ') || '-')}</td><td>${escapeHtml(item.endpointSummary)}</td><td>${escapeHtml(item.message)}</td></tr>`).join('')}</tbody></table>`;
}

function renderProbeRunCenter(task: ProbeTask | null): void {
  const summary = document.getElementById('probe-run-summary');
  const host = document.getElementById('probe-run-board');
  if (!summary || !host) return;
  if (!task) {
    summary.textContent = '尚未创建任务';
    host.innerHTML = '<div class="table-empty">创建并运行任务后显示逐账号进度。</div>';
    return;
  }
  const runtime = task.runtime;
  const units = runtime.unitStates || [];
  const completed = runtime.completedUnits || runtime.processed;
  const total = runtime.totalUnits || units.length;
  const durationMs = runtime.startedAt ? Math.max(0, (runtime.finishedAt || Date.now()) - runtime.startedAt) : 0;
  summary.textContent = [
    `状态 ${runtime.status}`,
    `进度 ${completed}/${total}`,
    `请求 ${runtime.processed}`,
    `命中 ${runtime.hits}`,
    `错误 ${runtime.errors}`,
    `跳过 ${runtime.skippedUnits || 0}`,
    runtime.runId ? `run ${runtime.runId.slice(-12)}` : '',
    durationMs ? `耗时 ${formatDuration(durationMs)}` : '',
  ].filter(Boolean).join(' · ');
  if (!units.length) {
    host.innerHTML = '<div class="table-empty">当前任务还没有运行单元。</div>';
    return;
  }
  const grouped = new Map<string, ProbeTaskUnitRuntime[]>();
  for (const unit of units) {
    const list = grouped.get(unit.accountId) || [];
    list.push(unit);
    grouped.set(unit.accountId, list);
  }
  host.innerHTML = [...grouped.entries()].map(([accountId, rows]) => {
    const done = rows.filter((row) => !['planned', 'running'].includes(row.status)).length;
    const hits = rows.filter((row) => row.status === 'hit').length;
    const errors = rows.filter((row) => row.status === 'error').length;
    const label = rows[0]?.email || accountId;
    return `<details class="probe-run-account"${rows.some((row) => row.status === 'running') ? ' open' : ''}>
      <summary>${escapeHtml(label)} · ${done}/${rows.length} · 命中 ${hits} · 错误 ${errors}</summary>
      <table class="data-table"><thead><tr><th>国家</th><th>状态</th><th>尝试</th><th>耗时</th><th>结果</th></tr></thead><tbody>
        ${rows.map((row) => `<tr>
          <td>${escapeHtml(row.country)}</td>
          <td>${escapeHtml(row.status)}</td>
          <td>${row.attempt}</td>
          <td>${row.durationMs ? escapeHtml(formatDuration(row.durationMs)) : '-'}</td>
          <td>${escapeHtml(row.message || row.hitKind || '-')}</td>
        </tr>`).join('')}
      </tbody></table>
    </details>`;
  }).join('');
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 60000) return `${(durationMs / 1000).toFixed(1)}s`;
  const minutes = Math.floor(durationMs / 60000);
  const seconds = Math.floor((durationMs % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}
function renderProbeHits(hits: ProbeHitRecord[]): void {
  const host = mustGet('probe-hit-table');
  if (!hits.length) {
    host.innerHTML = '<div class="table-empty">暂无命中</div>';
    return;
  }
  host.innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>时间</th>
          <th>账号</th>
          <th>国家</th>
          <th>类型</th>
          <th>金额/试用</th>
          <th>链接</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        ${hits.slice(0, 80).map((hit) => {
          const paymentLinks = (hit.paymentMethodLinks || []).filter((item) => item.url);
          const allLinks = [...new Set([hit.link, ...paymentLinks.map((item) => item.url)].filter(Boolean))];
          const paymentSummary = formatPaymentMethodLinkSummary(hit.paymentMethodLinks || []);
          return `
          <tr>
            <td>${new Date(hit.createdAt).toLocaleString()}</td>
            <td>${escapeHtml(hit.email || hit.accountId)}</td>
            <td>${escapeHtml(hit.country)}/${escapeHtml(hit.currency)}</td>
            <td>${escapeHtml(hit.hitKind)}${hit.savedToDb ? ' ·已入库' : ''}</td>
            <td>${escapeHtml([hit.amountHint, hit.promoHint, hit.hostedResolutionStatus ? `Hosted:${hit.hostedResolutionStatus}` : '', hit.hostedResolutionMethods?.length ? `页面方式:${hit.hostedResolutionMethods.join('|')}` : '', hit.paymentCheckoutSessionMode, hit.paymentCheckoutSessionDistinct ? '独立会话已验证' : '', paymentSummary, hit.sniff?.message].filter(Boolean).join(' / ') || '-')}</td>
            <td><div class="probe-hit-link">${escapeHtml(paymentLinks.length ? paymentLinks.map((item) => `${item.method}: ${item.url}`).join('\n') : (hit.link || hit.message))}</div></td>
            <td>
              <button class="button secondary small" data-copy-hit="${escapeAttr(allLinks.join('\n'))}" type="button" ${allLinks.length ? '' : 'disabled'}>复制全部</button>
            </td>
          </tr>
        `; }).join('')}
      </tbody>
    </table>
  `;
  host.querySelectorAll('[data-copy-hit]').forEach((button) => {
    button.addEventListener('click', async () => {
      const link = (button as HTMLElement).getAttribute('data-copy-hit') || '';
      if (!link) return;
      await navigator.clipboard.writeText(link);
      flashButtonLabel(button as HTMLButtonElement, '已复制');
    });
  });
}

function collectProbeHitDbFilter(): Partial<ProbeHitDashboardFilter> {
  return {
    country: valueOf('probe-hitdb-country').trim().toUpperCase(),
    hitKind: valueOf('probe-hitdb-kind').trim().toLowerCase(),
    query: valueOf('probe-hitdb-query').trim(),
    onlyWithLink: checkedOf('probe-hitdb-only-link'),
    onlyUsableLinks: checkedOf('probe-hitdb-only-usable'),
  };
}

function syncProbeHighRateInputs(): void {
  const enabled = checkedOf('probe-high-rate-only');
  for (const id of ['probe-min-hit-rate', 'probe-min-hit-attempts', 'probe-max-high-rate', 'probe-exploration-enabled']) {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) el.disabled = !enabled;
  }
  const explorationCount = document.getElementById('probe-exploration-count') as HTMLInputElement | null;
  if (explorationCount) {
    explorationCount.disabled = !enabled || !checkedOf('probe-exploration-enabled');
  }
}

function renderProbeHitDatabase(
  records: ProbeHitDatabaseRecord[],
  filter: Partial<ProbeHitDashboardFilter> = {},
  summaryInput?: ProbeHitDashboardSummary,
): void {
  const result = queryHitDatabase(records, filter);
  const summary = summaryInput || result.summary;
  const rows = result.records;
  const summaryEl = mustGet('probe-hitdb-summary');
  summaryEl.textContent = [
    `总计 ${summary.total}`,
    `有链接 ${summary.withLink}`,
    `有效链接 ${summary.usableLinks}`,
    `资格通过 ${summary.qualified}`,
    `zero ${summary.zero}`,
    `trial ${summary.trial}`,
    `promo ${summary.promo}`,
    `国家 ${summary.countries}`,
    summary.latestAt ? `最近 ${new Date(summary.latestAt).toLocaleString()}` : '',
  ].filter(Boolean).join(' · ');

  const host = mustGet('probe-hitdb-table');
  if (!rows.length) {
    host.innerHTML = '<div class="table-empty">命中库暂无匹配记录</div>';
    return;
  }
  host.innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>入库</th>
          <th>账号</th>
          <th>国家</th>
          <th>类型</th>
          <th>金额/试用</th>
          <th>链接</th>
          <th>任务</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        ${rows.slice(0, 120).map((hit) => {
          const paymentLinks = (hit.paymentMethodLinks || []).filter((item) => item.url);
          const allLinks = [...new Set([hit.link, ...paymentLinks.map((item) => item.url)].filter(Boolean))];
          const paymentSummary = formatPaymentMethodLinkSummary(hit.paymentMethodLinks || []);
          return `
          <tr>
            <td>${new Date(hit.savedAt || hit.createdAt).toLocaleString()}</td>
            <td>${escapeHtml(hit.email || hit.accountId)}</td>
            <td>${escapeHtml(hit.country)}/${escapeHtml(hit.currency)}</td>
            <td>${escapeHtml(`${hit.hitKind} · ${hit.checkoutUiMode || 'hosted'} · ${hit.linkVerificationLevel || 'candidate'} · Hosted:${hit.hostedResolutionStatus || 'not_required'}${hit.linkUsable ? ' ·有效' : ''}`)}</td>
            <td>${escapeHtml([hit.amountHint, hit.promoHint, hit.hostedResolutionMessage, hit.hostedResolutionMethods?.length ? `页面方式:${hit.hostedResolutionMethods.join('|')}` : '', hit.paymentCheckoutSessionMode, hit.paymentCheckoutSessionDistinct ? '独立会话已验证' : '', hit.checkoutRetryMetrics ? `重试 C${hit.checkoutRetryMetrics.checkoutAttempts}/U${hit.checkoutRetryMetrics.updateAttempts}/F${hit.checkoutRetryMetrics.fullFlowAttempts}/CF${hit.checkoutRetryMetrics.cfRetryCount}` : '', paymentSummary, hit.note, hit.sniff?.message].filter(Boolean).join(' / ') || '-')}</td>
            <td><div class="probe-hit-link">${escapeHtml(paymentLinks.length ? paymentLinks.map((item) => `${item.method}: ${item.url}`).join('\n') : (hit.link || hit.message))}</div></td>
            <td>${escapeHtml(hit.sourceTaskName || hit.taskId || '-')}</td>
            <td class="table-actions">
              <button class="button secondary small" data-copy-hitdb="${escapeAttr(allLinks.join('\n'))}" type="button" ${allLinks.length ? '' : 'disabled'}>复制全部</button>
              <button class="button secondary small" data-open-hitdb="${escapeAttr(hit.link || '')}" type="button" ${hit.link ? '' : 'disabled'}>打开</button>
              <button class="button secondary small" data-delete-hitdb="${escapeAttr(hit.dbId)}" type="button">删除</button>
            </td>
          </tr>
        `; }).join('')}
      </tbody>
    </table>
  `;
  host.querySelectorAll('[data-copy-hitdb]').forEach((button) => {
    button.addEventListener('click', async () => {
      const link = (button as HTMLElement).getAttribute('data-copy-hitdb') || '';
      if (!link) return;
      await navigator.clipboard.writeText(link);
      flashButtonLabel(button as HTMLButtonElement, '已复制');
    });
  });
  host.querySelectorAll('[data-open-hitdb]').forEach((button) => {
    button.addEventListener('click', () => {
      const link = (button as HTMLElement).getAttribute('data-open-hitdb') || '';
      if (!link) return;
      void browser.tabs.create({ url: link, active: true });
    });
  });
  host.querySelectorAll('[data-delete-hitdb]').forEach((button) => {
    button.addEventListener('click', async () => {
      const dbId = (button as HTMLElement).getAttribute('data-delete-hitdb') || '';
      if (!dbId) return;
      const restore = setButtonPending(button as HTMLButtonElement, '删除中...');
      try {
        const response = await browser.runtime.sendMessage({
          type: 'opx:probe-hitdb-delete',
          dbId,
        }) as ProbeHitDbResponse;
        if (response.state) fillProbePanel(response.state);
        else if (response.records) renderProbeHitDatabase(response.records, collectProbeHitDbFilter(), response.summary);
        setInlineStatus(mustGet('probe-task-status'), response.message || '已删除', response.ok ? 'ok' : 'error');
      } catch (error) {
        setInlineStatus(mustGet('probe-task-status'), error instanceof Error ? error.message : String(error), 'error');
      } finally {
        restore();
      }
    });
  });
}

async function refreshProbeHitDatabaseBoard(statusEl?: HTMLElement): Promise<void> {
  const filter = collectProbeHitDbFilter();
  const response = await browser.runtime.sendMessage({
    type: 'opx:probe-hitdb-query',
    filter,
  }) as ProbeHitDbResponse;
  if (response.state) {
    mustGet('probe-account-summary').textContent = `账号 ${response.state.accounts.length} · 启用 ${response.state.accounts.filter((item) => item.enabled).length} · 运行命中 ${response.state.hits.length} · 命中库 ${(response.state.hitDatabase || []).length}`;
    renderProbeHitDatabase(response.state.hitDatabase || response.records || [], filter, response.summary);
  } else if (response.records) {
    renderProbeHitDatabase(response.records, filter, response.summary);
  }
  if (statusEl) {
    setInlineStatus(statusEl, response.message || '命中库已刷新', response.ok ? 'ok' : 'error');
  }
}

function downloadText(content: string, filename: string, mime = 'text/plain;charset=utf-8'): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function renderProbeAccountReport(state: ProbeState | null = latestProbeState, reportInput?: ProbeAccountReportRow[]): void {
  const host = mustGet('probe-account-report-table');
  const summaryEl = mustGet('probe-account-report-summary');
  if (!state && !reportInput) {
    summaryEl.textContent = '账号报表未加载';
    host.innerHTML = '<div class="table-empty">暂无账号数据</div>';
    return;
  }
  const allRows = reportInput || buildAccountEligibilityReport(state as ProbeState);
  const status = (document.getElementById('probe-account-filter-status') as HTMLSelectElement | null)?.value || 'all';
  const query = ((document.getElementById('probe-account-filter-query') as HTMLInputElement | null)?.value || '').trim().toLowerCase();
  const rows = allRows.filter((row) => {
    if (status === 'enabled' && !row.enabled) return false;
    if (status === 'disabled' && row.enabled) return false;
    if (['healthy', 'expiring', 'expired'].includes(status) && row.credentialStatus !== status) return false;
    if (status === 'hit' && row.linkCount <= 0) return false;
    if (status === 'error' && row.failCount <= 0) return false;
    if (query) {
      const bag = `${row.email} ${row.accountId} ${row.source} ${row.lastProbeCountry} ${row.countries.join(' ')}`.toLowerCase();
      if (!bag.includes(query)) return false;
    }
    return true;
  });
  const withLink = allRows.filter((row) => row.linkCount > 0).length;
  const withZero = allRows.filter((row) => row.zeroCount > 0).length;
  const withTrial = allRows.filter((row) => row.trialCount > 0).length;
  const expired = allRows.filter((row) => row.credentialStatus === 'expired').length;
  summaryEl.textContent = [
    `账号 ${allRows.length}`,
    `当前筛选 ${rows.length}`,
    `启用 ${allRows.filter((row) => row.enabled).length}`,
    `有链接 ${withLink}`,
    `zero资格 ${withZero}`,
    `trial资格 ${withTrial}`,
    `凭据过期 ${expired}`,
    `总命中 ${allRows.reduce((sum, row) => sum + row.hitCount, 0)}`,
  ].join(' · ');
  if (!rows.length) {
    host.innerHTML = '<div class="table-empty">暂无账号报表</div>';
    return;
  }
  const pageCount = Math.max(1, Math.ceil(rows.length / PROBE_ACCOUNT_REPORT_PAGE_SIZE));
  probeAccountReportPage = Math.max(1, Math.min(probeAccountReportPage, pageCount));
  const pageStart = (probeAccountReportPage - 1) * PROBE_ACCOUNT_REPORT_PAGE_SIZE;
  const pageRows = rows.slice(pageStart, pageStart + PROBE_ACCOUNT_REPORT_PAGE_SIZE);
  const pageSummary = document.getElementById('probe-account-page-summary');
  if (pageSummary) pageSummary.textContent = `第 ${probeAccountReportPage}/${pageCount} 页 · ${rows.length} 条`;
  const prev = document.getElementById('btn-probe-account-prev') as HTMLButtonElement | null;
  const next = document.getElementById('btn-probe-account-next') as HTMLButtonElement | null;
  if (prev) prev.disabled = probeAccountReportPage <= 1;
  if (next) next.disabled = probeAccountReportPage >= pageCount;
  host.innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>账号</th>
          <th>状态/来源</th>
          <th>AT 健康</th>
          <th>成功率</th>
          <th>最佳资格</th>
          <th>命中/链接</th>
          <th>国家</th>
          <th>最近探测</th>
          <th>结果</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        ${pageRows.map((row) => `
          <tr>
            <td><label class="check-row"><input type="checkbox" data-probe-account-select="${escapeAttr(row.accountId)}" ${probeAccountSelection.has(row.accountId) ? 'checked' : ''} /><span>${escapeHtml(row.email || row.accountId)}</span></label><small>${escapeHtml(row.accountId)}</small></td>
            <td>${row.enabled ? '启用' : '停用'} · ${escapeHtml(row.source)}</td>
            <td>${escapeHtml(row.credentialStatus)}${row.tokenExpiresAt ? `<br><small>${escapeHtml(new Date(row.tokenExpiresAt).toLocaleString())}</small>` : ''}</td>
            <td>${row.successRate}%<br><small>${row.successCount}/${row.successCount + row.failCount}</small></td>
            <td>${escapeHtml(row.bestKind)}</td>
            <td>${row.hitCount}/${row.linkCount}<br><small>zero ${row.zeroCount} · trial ${row.trialCount} · promo ${row.promoCount}</small></td>
            <td>${escapeHtml(row.countries.join(', ') || '-')}</td>
            <td>${row.lastProbeAt ? new Date(row.lastProbeAt).toLocaleString() : '-'}<br><small>${escapeHtml(row.lastProbeCountry || '-')}</small></td>
            <td>${escapeHtml(row.lastMessage || (row.tags || []).slice(0, 5).join(' / ') || '-')}</td>
            <td class="table-actions">
              <button class="button secondary small" data-copy-account-link="${escapeAttr(row.topLink || '')}" type="button" ${row.topLink ? '' : 'disabled'}>复制链接</button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  host.querySelectorAll('[data-copy-account-link]').forEach((button) => {
    button.addEventListener('click', async () => {
      const link = (button as HTMLElement).getAttribute('data-copy-account-link') || '';
      if (!link) return;
      await navigator.clipboard.writeText(link);
      flashButtonLabel(button as HTMLButtonElement, '已复制');
    });
  });
  host.querySelectorAll('[data-probe-account-select]').forEach((input) => {
    input.addEventListener('change', () => {
      const id = (input as HTMLElement).getAttribute('data-probe-account-select') || '';
      if (!id) return;
      if ((input as HTMLInputElement).checked) probeAccountSelection.add(id);
      else probeAccountSelection.delete(id);
    });
  });
}

async function runProbeAccountAction(action: 'enable' | 'disable' | 'delete'): Promise<void> {
  const accountIds = [...probeAccountSelection];
  if (!accountIds.length) {
    setInlineStatus(mustGet('probe-task-status'), '请先选择账号', 'error');
    return;
  }
  if (action === 'delete' && !window.confirm(`确认删除选中的 ${accountIds.length} 个账号？命中历史会保留。`)) return;
  const response = await browser.runtime.sendMessage({
    type: 'opx:probe-account-action',
    action,
    accountIds,
  }) as ProbeResponse & { report?: ProbeAccountReportRow[] };
  if (response.ok) probeAccountSelection.clear();
  if (response.state) {
    latestProbeState = response.state;
    renderProbeAccountReport(response.state, response.report);
  }
  setInlineStatus(mustGet('probe-task-status'), response.message || '账号操作完成', response.ok ? 'ok' : 'error');
}

function syncProbeFactorInputs(): void {
  const tracking = checkedOf('probe-factor-tracking');
  const drift = tracking && checkedOf('probe-drift-detection');
  const mode = valueOf('probe-experiment-mode') || 'hybrid';
  const research = tracking && mode !== 'discovery';
  (mustGet('probe-research-mode') as HTMLInputElement).checked = mode !== 'discovery';
  for (const id of ['probe-factor-min-samples', 'probe-adaptive-percent', 'probe-observation-limit', 'probe-drift-detection', 'probe-experiment-mode']) {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) el.disabled = !tracking;
  }
  for (const id of ['probe-balanced-order', 'probe-research-target-cell', 'probe-research-repeat-minutes', 'probe-research-min-total']) {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) el.disabled = !research;
  }
  const skipAfterHit = document.getElementById('probe-skip-after-hit') as HTMLInputElement | null;
  if (skipAfterHit) skipAfterHit.disabled = research;
  for (const id of ['probe-exploit-percent', 'probe-balanced-percent', 'probe-explore-percent']) {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) el.disabled = !tracking || mode !== 'hybrid';
  }
  const driftSamples = document.getElementById('probe-drift-min-samples') as HTMLInputElement | null;
  if (driftSamples) driftSamples.disabled = !drift;
}

function renderProbeFactorBoard(state: ProbeState | null = latestProbeState): void {
  const summaryEl = mustGet('probe-factor-summary');
  const qualityEl = mustGet('probe-quality-summary');
  const runnerEl = mustGet('probe-runner-summary');
  const readinessSummary = mustGet('probe-readiness-summary');
  const readinessHost = mustGet('probe-readiness-table');
  const conclusionHost = mustGet('probe-factor-conclusions');
  const factorHost = mustGet('probe-factor-table');
  const driftHost = mustGet('probe-drift-table');
  const adaptiveHost = mustGet('probe-adaptive-table');
  const matrixSummary = mustGet('probe-matrix-summary');
  const matrixHost = mustGet('probe-matrix-table');
  const controlledHost = mustGet('probe-controlled-table');
  const confoundingHost = mustGet('probe-confounding-table');
  const powerHost = mustGet('probe-power-table');
  const report = state?.factorReport;
  renderProbeReadiness(state, readinessSummary, readinessHost);
  if (!state || !report || !report.sampleSize) {
    summaryEl.textContent = '尚未积累逐次实验观测';
    qualityEl.textContent = '证据质量尚未评估';
    runnerEl.textContent = '支付 Runner 尚无观测';
    conclusionHost.innerHTML = '';
    factorHost.innerHTML = '<div class="table-empty">运行探测后自动生成因素分层</div>';
    driftHost.innerHTML = '<div class="table-empty">暂无漂移样本</div>';
    adaptiveHost.innerHTML = '<div class="table-empty">暂无实验建议</div>';
    matrixSummary.textContent = '尚未建立账号×出口矩阵';
    matrixHost.innerHTML = '<div class="table-empty">启用平衡研究模式并运行探测后生成覆盖矩阵</div>';
    controlledHost.innerHTML = '<div class="table-empty">尚无可匹配的交叉样本</div>';
    confoundingHost.innerHTML = '<div class="table-empty">尚无变量绑定审计结果</div>';
    powerHost.innerHTML = '<div class="table-empty">尚无明确结果用于功效估算</div>';
    return;
  }
  const coverage = state.experimentCoverage;
  const quality = report.quality;
  summaryEl.textContent = [
    `当前纪元观测 ${report.sampleSize}`,
    `原始观测 ${quality.rawObservationCount} · 可归因 ${quality.attributionEligibleSamples} · 处理生效 ${quality.treatmentAppliedPercent}%`,
    `明确结果 ${report.resolvedSamples}`,
    `命中 ${report.hits}`,
    `错误 ${report.errors}`,
    `资格率 ${report.overallRate}%`,
    `错误率 ${report.errorRate}%`,
    `95%CI ${report.overallConfidenceLow}%–${report.overallConfidenceHigh}%`,
    `告警 ${(state.driftAlerts || []).length}`,
  ].join(' · ');
  qualityEl.textContent = [
    `结论状态 ${evidenceQualityStateLabel(quality.conclusionState)}`,
    `质量 ${quality.score}/100`,
    `协议 ${quality.protocolCount} 种（主协议 ${quality.dominantProtocolPercent}%）`,
    `出口验证 Auth ${quality.verifiedAuthPercent}% / Checkout ${quality.verifiedCheckoutPercent}% / Billing ${quality.verifiedBillingPercent}%`,
    `矩阵平衡 ${quality.matrixBalancePercent}%`,
    `可检测差异约 ${quality.minimumDetectableEffectPp}pp`,
    `规则纪元 ${quality.epochCount}（当前 n=${quality.latestEpochSamples}）`,
    `重复稳定 ${report.repeatStability?.stabilityPercent || 0}% / 转移 ${report.repeatStability?.transitionRatePercent || 0}%`,
    quality.blockers[0] ? `限制：${quality.blockers[0]}` : '质量门已满足',
  ].join(' · ');
  const runnerRows = (state.observations || []).filter((item) => Boolean(item.paymentRunnerStatus));
  const checkoutRows = (state.observations || []).filter((item) => Boolean(item.paymentCheckoutStatus));
  const rate = (count: number, total: number) => total ? Math.round((count / total) * 1000) / 10 : 0;
  const qualified = runnerRows.filter((item) => item.qualificationVerified).length;
  const methodOffered = runnerRows.filter((item) => item.detectedMethods.length > 0).length;
  const confirmRows = runnerRows.filter((item) => item.paymentRunnerConfirmSubmitted);
  const confirmSucceeded = confirmRows.filter((item) => item.paymentRunnerConfirmSucceeded).length;
  const approveRows = runnerRows.filter((item) => item.paymentRunnerApproveSubmitted);
  const approveSucceeded = approveRows.filter((item) => item.paymentRunnerApproveSucceeded).length;
  const finalVerified = runnerRows.filter((item) => item.finalLinkVerified).length;
  const protocolFailed = runnerRows.filter((item) => ['protocol_incompatible', 'invalid_final_url'].includes(item.paymentRunnerStatus)).length;
  const independentRows = checkoutRows.filter((item) => item.paymentCheckoutSessionMode === 'independent_checkout');
  const distinctRows = independentRows.filter((item) => item.paymentCheckoutSessionDistinct);
  const methodMissing = checkoutRows.filter((item) => item.paymentCheckoutStatus === 'method_not_offered').length;
  const qualificationLost = checkoutRows.filter((item) => item.paymentCheckoutStatus === 'qualification_lost').length;
  const extractedLinks = checkoutRows.reduce((sum, item) => sum + item.paymentMethodLinkCount, 0);
  const flowRows = (state.observations || []).filter((item) => item.checkoutAttempts > 0 || item.checkoutCreated);
  const flowCheckoutCreated = flowRows.filter((item) => item.checkoutCreated).length;
  const flowQualified = flowRows.filter((item) => item.qualificationVerified).length;
  const flowUsable = flowRows.filter((item) => item.linkUsable).length;
  const retryTotals = flowRows.reduce((sum, item) => ({
    checkout: sum.checkout + (item.checkoutAttempts || 0),
    update: sum.update + (item.updateAttempts || 0),
    full: sum.full + (item.fullFlowAttempts || 0),
    cf: sum.cf + (item.cfRetryCount || 0),
    rotations: sum.rotations + (item.cfExitRotations || 0),
    rebuilds: sum.rebuilds + (item.invalidPromotionRebuilds || 0),
    pages: sum.pages + (item.pageFallbackAttempts || 0),
  }), { checkout: 0, update: 0, full: 0, cf: 0, rotations: 0, rebuilds: 0, pages: 0 });
  const modeConversion = (['hosted', 'custom', 'both'] as const).map((mode) => {
    const rows = flowRows.filter((item) => item.checkoutUiMode === mode);
    return rows.length ? `${mode} ${rows.filter((item) => item.qualificationVerified).length}/${rows.length} (${rate(rows.filter((item) => item.qualificationVerified).length, rows.length)}%)` : '';
  }).filter(Boolean).join(' / ');
  runnerEl.textContent = runnerRows.length || checkoutRows.length || flowRows.length ? [
    `流程转化 创建 ${flowCheckoutCreated}/${flowRows.length} (${rate(flowCheckoutCreated, flowRows.length)}%) → 资格 ${flowQualified}/${flowCheckoutCreated} (${rate(flowQualified, flowCheckoutCreated)}%) → 可用 ${flowUsable}/${flowRows.length} (${rate(flowUsable, flowRows.length)}%)`,
    modeConversion ? `模式资格 ${modeConversion}` : '',
    `分层重试 Checkout ${retryTotals.checkout} / Update ${retryTotals.update} / 完整流程 ${retryTotals.full} / CF ${retryTotals.cf}（换出口 ${retryTotals.rotations}） / 失效优惠重建 ${retryTotals.rebuilds} / 页面回退 ${retryTotals.pages}`,
    `支付会话 ${checkoutRows.length}`,
    `独立会话 ${distinctRows.length}/${independentRows.length} (${rate(distinctRows.length, independentRows.length)}%)`,
    `方式未暴露 ${methodMissing}`,
    `重建后资格丢失 ${qualificationLost}`,
    `有效方式终链 ${extractedLinks}`,
    `Runner ${runnerRows.length}`,
    `资格通过 ${qualified}/${runnerRows.length} (${rate(qualified, runnerRows.length)}%)`,
    `方式提供 ${methodOffered}/${runnerRows.length} (${rate(methodOffered, runnerRows.length)}%)`,
    `confirm ${confirmSucceeded}/${confirmRows.length} (${rate(confirmSucceeded, confirmRows.length)}%)`,
    `approve ${approveSucceeded}/${approveRows.length} (${rate(approveSucceeded, approveRows.length)}%)`,
    `终链验证 ${finalVerified}/${runnerRows.length} (${rate(finalVerified, runnerRows.length)}%)`,
    `协议失败 ${protocolFailed}/${runnerRows.length} (${rate(protocolFailed, runnerRows.length)}%)`,
  ].filter(Boolean).join(' · ') : '支付 Runner 尚无观测';
  if (report.repeatStability?.message) qualityEl.title = report.repeatStability.message;
  matrixSummary.textContent = coverage ? [
    `矩阵 ${coverage.accountCount}账号 × ${coverage.exitCountryCount}出口`,
    `已覆盖 ${coverage.coveredCells}/${coverage.totalCells} (${coverage.coveragePercent}%)`,
    `已完成 ${coverage.completedCells}/${coverage.totalCells} (${coverage.completionPercent}%)`,
    `跨时段 ${coverage.crossTimeCellCount}`,
    `同账号多出口 ${coverage.sameAccountMultiExitCount}/${coverage.accountCount}`,
    `同出口多账号 ${coverage.sameExitMultiAccountCount}`,
    `平衡样本 ${coverage.matrixSampleSize}/${coverage.minTotalSamples}`,
    `实验臂 利用${coverage.armCounts?.exploit || 0}/平衡${coverage.armCounts?.balanced || 0}/探索${coverage.armCounts?.explore || 0}`,
    `设计覆盖 路由${coverage.routeVariantCount}/方式${coverage.paymentMethodCount}/seed${coverage.seedOrdinalCount}/单元${coverage.designCellCount}`,
    coverage.evidenceReady ? '结论门槛已满足' : '结论保持证据不足',
  ].join(' · ') : '尚未建立账号×出口矩阵';
  const incompleteCells = (coverage?.cells || []).filter((cell) => cell.status !== 'complete');
  matrixHost.innerHTML = coverage?.totalCells ? `
    <table class="data-table"><thead><tr><th>账号</th><th>出口国家</th><th>样本</th><th>时间跨度</th><th>状态</th><th>下次可测</th></tr></thead>
    <tbody>${(incompleteCells.length ? incompleteCells : coverage.cells).slice(0, 160).map((cell) => `<tr>
      <td>${escapeHtml(shortFactorValue(cell.accountId))}</td><td>${escapeHtml(cell.country)}</td>
      <td>${cell.samples}/${cell.targetSamples}</td><td>${cell.spanMinutes} 分钟</td>
      <td><span class="status-pill" data-status="${escapeAttr(cell.status === 'complete' ? 'success' : cell.status === 'ready' || cell.status === 'missing' ? 'running' : 'idle')}">${escapeHtml(cell.status)}</span></td>
      <td>${cell.nextEligibleAt > Date.now() ? new Date(cell.nextEligibleAt).toLocaleString() : '-'}</td>
    </tr>`).join('')}</tbody></table>
  ` : '<div class="table-empty">当前任务尚未形成有效矩阵</div>';
  conclusionHost.innerHTML = report.conclusions.map((item) => `
    <div class="probe-factor-conclusion" data-evidence="${escapeAttr(item.evidence)}">
      <strong>${escapeHtml(factorConclusionLabel(item.factor))}</strong>
      <span>${escapeHtml(item.message)}</span>
    </div>
  `).join('');
  controlledHost.innerHTML = report.controlledEffects?.length ? `
    <table class="data-table"><thead><tr><th>待检因素</th><th>控制变量</th><th>对照</th><th>匹配层/样本</th><th>调整后差值</th><th>方向一致</th><th>证据</th><th>结论</th></tr></thead>
    <tbody>${report.controlledEffects.map((effect) => `<tr>
      <td>${escapeHtml(factorDimensionLabel(effect.treatmentDimension))}</td>
      <td>${escapeHtml(effect.controlDimensions.map(factorDimensionLabel).join(' + '))}</td>
      <td>${escapeHtml(shortFactorValue(effect.levelA || '-'))} → ${escapeHtml(shortFactorValue(effect.levelB || '-'))}</td>
      <td>${effect.matchedStrata} / ${effect.matchedSamples}</td>
      <td>${effect.effectPercentPoints >= 0 ? '+' : ''}${effect.effectPercentPoints}pp</td>
      <td>${effect.directionConsistencyPercent}%</td>
      <td><span class="status-pill" data-status="${escapeAttr(effect.evidence === 'strong' ? 'success' : effect.evidence === 'moderate' || effect.evidence === 'weak' ? 'running' : 'idle')}">${escapeHtml(effect.evidence)}</span></td>
      <td>${escapeHtml(effect.message)}</td>
    </tr>`).join('')}</tbody></table>
  ` : '<div class="table-empty">尚无匹配对照结果</div>';
  confoundingHost.innerHTML = report.confoundingFindings?.length ? `
    <table class="data-table"><thead><tr><th>变量 A</th><th>变量 B</th><th>绑定关系</th><th>依赖度</th><th>样本</th><th>影响</th></tr></thead>
    <tbody>${report.confoundingFindings.map((finding) => `<tr>
      <td>${escapeHtml(factorDimensionLabel(finding.dimensionA))}</td><td>${escapeHtml(factorDimensionLabel(finding.dimensionB))}</td>
      <td>${escapeHtml(finding.relationship)}</td><td>${finding.dependencyPercent}%</td><td>${finding.samples}</td>
      <td><span class="status-pill" data-status="${escapeAttr(finding.level === 'critical' ? 'error' : 'running')}">${escapeHtml(finding.message)}</span></td>
    </tr>`).join('')}</tbody></table>
  ` : '<div class="table-empty">未发现达到 95% 阈值的变量绑定</div>';
  const powerPlan = report.powerPlan;
  powerHost.innerHTML = powerPlan?.targets?.length ? `
    <div class="pool-summary">基准资格率 ${powerPlan.baselineRate}% · α=${powerPlan.alpha} · 功效 ${(powerPlan.power * 100).toFixed(0)}% · ${escapeHtml(powerPlan.message)}</div>
    <table class="data-table"><thead><tr><th>目标差异</th><th>每组所需</th><th>总样本目标</th><th>当前明确结果</th><th>进度</th><th>尚缺</th></tr></thead>
    <tbody>${powerPlan.targets.map((target) => `<tr><td>${target.effectPercentPoints}pp</td><td>${target.requiredPerGroup}</td><td>${target.requiredTotal}</td><td>${target.currentResolved}</td><td>${target.progressPercent}%</td><td>${target.remainingSamples}</td></tr>`).join('')}</tbody></table>
  ` : '<div class="table-empty">明确结果不足</div>';
  const rows = report.rows
    .filter((row) => row.attempts >= Math.min(report.minSamples, 2))
    .sort((a, b) => factorDimensionPriority(a.dimension) - factorDimensionPriority(b.dimension)
      || b.confidenceLow - a.confidenceLow
      || b.attempts - a.attempts)
    .slice(0, 160);
  factorHost.innerHTML = rows.length ? `
    <table class="data-table"><thead><tr><th>因素</th><th>取值</th><th>样本</th><th>命中</th><th>错误</th><th>命中率</th><th>95%区间</th><th>相对总体</th><th>置信度</th></tr></thead>
    <tbody>${rows.map((row) => `<tr>
      <td>${escapeHtml(factorDimensionLabel(row.dimension))}</td>
      <td>${escapeHtml(shortFactorValue(row.value))}</td>
      <td>${row.resolved}/${row.attempts}</td><td>${row.hits}</td><td>${row.errors}</td>
      <td>${row.rate}%</td><td>${row.confidenceLow}%–${row.confidenceHigh}%</td>
      <td>${row.liftPercentPoints >= 0 ? '+' : ''}${row.liftPercentPoints}pp</td>
      <td><span class="status-pill" data-status="${escapeAttr(row.confidence === 'high' ? 'success' : row.confidence === 'insufficient' ? 'idle' : 'running')}">${escapeHtml(row.confidence)}</span></td>
    </tr>`).join('')}</tbody></table>
  ` : '<div class="table-empty">分组样本不足</div>';

  const alerts = state.driftAlerts || [];
  driftHost.innerHTML = alerts.length ? `
    <table class="data-table"><thead><tr><th>级别</th><th>类型</th><th>因素</th><th>取值</th><th>基线</th><th>近期</th><th>变化</th><th>结论</th></tr></thead>
    <tbody>${alerts.slice(0, 100).map((alert) => `<tr>
      <td><span class="status-pill" data-status="${escapeAttr(alert.level === 'critical' ? 'error' : alert.level === 'warning' ? 'running' : 'idle')}">${escapeHtml(alert.level)}</span></td>
      <td>${escapeHtml(driftKindLabel(alert.kind))}</td><td>${escapeHtml(factorDimensionLabel(alert.dimension))}</td><td>${escapeHtml(shortFactorValue(alert.value))}</td>
      <td>${alert.baselineValue}${alert.kind.includes('rate') ? '%' : ''} / n=${alert.baselineSamples}</td>
      <td>${alert.recentValue}${alert.kind.includes('rate') ? '%' : ''} / n=${alert.recentSamples}</td>
      <td>${alert.delta >= 0 ? '+' : ''}${alert.delta}${alert.kind.includes('rate') ? 'pp' : ''}</td><td>${escapeHtml(alert.message)}</td>
    </tr>`).join('')}</tbody></table>
  ` : '<div class="table-empty">近期窗口与历史基线未发现达到阈值的变化</div>';

  const recommendations = state.adaptiveRecommendations || [];
  adaptiveHost.innerHTML = recommendations.length ? `
    <table class="data-table"><thead><tr><th>优先级</th><th>因素</th><th>取值</th><th>当前样本</th><th>目标样本</th><th>原因</th></tr></thead>
    <tbody>${recommendations.slice(0, 100).map((item) => `<tr>
      <td><span class="status-pill" data-status="${escapeAttr(item.priority === 'urgent' ? 'error' : item.priority === 'high' ? 'running' : 'idle')}">${escapeHtml(item.priority)}</span></td>
      <td>${escapeHtml(factorDimensionLabel(item.dimension))}</td><td>${escapeHtml(shortFactorValue(item.value))}</td>
      <td>${item.currentSamples}</td><td>${item.targetSamples}</td><td>${escapeHtml(item.reason)}</td>
    </tr>`).join('')}</tbody></table>
  ` : '<div class="table-empty">当前样本覆盖已达到最低要求</div>';
}

function renderProbeReadiness(state: ProbeState | null, summary: HTMLElement, host: HTMLElement): void {
  const readiness = state?.experimentReadiness;
  if (!readiness) {
    summary.textContent = '尚未评估账号与出口条件';
    host.innerHTML = '<div class="table-empty">刷新状态后生成实验门禁</div>';
    return;
  }
  summary.textContent = [
    `有效账号 ${readiness.usableCredentialCount}/${readiness.enabledAccountCount}`,
    `健康出口 ${readiness.healthyExitCount}`,
    `实际国家 ${readiness.healthyActualCountryCount}`,
    `实际 IP ${readiness.healthyActualIpCount}`,
    `ASN ${readiness.healthyActualAsnCount}`,
    `当前规则 ${readiness.currentRuleEpochId || '待观测'}（n=${readiness.currentRuleEpochSamples}）`,
    `归因观测 ${readiness.attributionEligibleObservationCount}/${readiness.observationCount}`,
    `处理无效 ${readiness.invalidTreatmentObservationCount} · 部分生效 ${readiness.partialTreatmentObservationCount}`,
    `探索 ${readiness.adaptiveExplorationPercent}%→${readiness.driftBoostedExplorationPercent}%`,
    readiness.blockers[0] ? `首要限制：${readiness.blockers[0]}` : '运行条件已就绪',
  ].join(' · ');
  const statusLabel: Record<string, string> = { blocked: '阻塞', ready: '可开跑', observing: '采集中', identifiable: '可归因' };
  const factorLabel: Record<string, string> = {
    account: '账号', country: '国家', 'exit-ip': '出口 IP', 'exit-asn': '出口 ASN',
    'time-randomness': '跨时段/随机性', route: '三阶段路由', 'payment-method': '支付方式',
  };
  host.innerHTML = readiness.items.length ? `
    <table><thead><tr><th>因素</th><th>状态</th><th>水平</th><th>匹配层</th><th>样本</th><th>判定条件</th></tr></thead><tbody>${readiness.items.map((item) => `<tr>
      <td>${escapeHtml(factorLabel[item.factor] || item.factor)}</td>
      <td>${escapeHtml(statusLabel[item.status] || item.status)}</td>
      <td>${item.levels}</td><td>${item.matchedStrata}</td><td>${item.samples}</td>
      <td>${escapeHtml(item.message)}</td>
    </tr>`).join('')}</tbody></table>
  ` : '<div class="table-empty">尚无可识别性结果</div>';
}

function factorDimensionLabel(value: string): string {
  const labels: Record<string, string> = {
    global: '全局', account: '账号', accountBatch: '账号批次', accountSource: '账号来源', probeCountry: '探测国家',
    authCountry: 'Auth 国家', checkoutCountry: 'Checkout 国家', billingCountry: 'Billing 国家', authIp: 'Auth IP',
    checkoutIp: 'Checkout IP/出口', billingIp: 'Billing IP/出口', authAsn: 'Auth ASN', checkoutAsn: 'Checkout ASN',
    billingAsn: 'Billing ASN', paymentMethod: '支付方式', plan: '套餐', currency: '币种', clientVersion: '插件版本',
    accountAge: '账号年龄', tokenAge: '凭证年龄', tokenExpiryHorizon: '凭证剩余期', emailDomain: '邮箱域',
    browserProfile: '浏览器配置档', deviceCohort: '设备分组', localeExitAlignment: '语言与出口一致性', timeZoneExitAlignment: '时区与出口一致性',
    sequencePosition: '执行顺序', scheduleBlock: '实验区组', configuredRetries: '重试配置', checkoutIpVersion: 'Checkout IP版本',
    localHour: '本地时段', weekday: '星期', routeSignature: '三阶段路由', accountByCountry: '账号×国家',
    accountByCheckoutIp: '账号×Checkout出口', countryByPaymentMethod: '国家×支付方式',
    experimentMode: '实验模式', experimentArm: '实验臂', routeVariant: '计划路由', plannedPaymentMethod: '计划支付方式',
    seedOrdinal: 'seed序号', designCell: '设计单元', checkoutSubnet: 'Checkout网段', checkoutNetworkType: '网络类型',
    checkoutSchema: 'Checkout结构指纹', offerSet: '优惠集合指纹', upstreamProtocol: '上游协议指纹', ruleEpoch: '规则纪元',
    campaign: '活动', product: '产品', checkoutMode: 'Checkout模式', retryOrdinal: '实际重试序号', cooldownBucket: '冷却时长',
  };
  return labels[value] || value;
}

function factorConclusionLabel(value: string): string {
  return ({ account: '账号效应', country: '国家效应', exit: '出口效应', interaction: '交互效应', time: '时间效应', unexplained: '随机/未观测' } as Record<string, string>)[value] || value;
}

function evidenceQualityStateLabel(value: string): string {
  return ({ insufficient: '证据不足', correlation: '相关性', 'stable-association': '稳定关联', drifting: '规则漂移中' } as Record<string, string>)[value] || value;
}

function driftKindLabel(value: string): string {
  return ({ 'eligibility-rate': '资格命中率', 'error-rate': '错误率', price: '价格', 'payment-method': '支付方式', 'protocol-schema': '上游结构', 'offer-set': '优惠集合' } as Record<string, string>)[value] || value;
}

function factorDimensionPriority(value: string): number {
  return ['account', 'probeCountry', 'checkoutIp', 'billingIp', 'routeSignature', 'accountByCountry', 'accountByCheckoutIp', 'paymentMethod'].indexOf(value) >= 0
    ? ['account', 'probeCountry', 'checkoutIp', 'billingIp', 'routeSignature', 'accountByCountry', 'accountByCheckoutIp', 'paymentMethod'].indexOf(value)
    : 50;
}

function shortFactorValue(value: string): string {
  const text = String(value || '');
  if (text.startsWith('probe-acc-')) return `${text.slice(0, 18)}…`;
  return text.length > 72 ? `${text.slice(0, 69)}…` : text;
}

function previewProbeCountryPlan(state: ProbeState | null, configInput?: Partial<ProbeTaskConfig>) {
  const config = normalizeTaskConfig({
    ...(configInput || {}),
    ...collectProbeTaskConfigSafe(),
  });
  const selectedCountries = collectProbeCountries().length
    ? collectProbeCountries()
    : (config.countries || []);
  return selectCountriesForProbe({
    selectedCountries,
    stats: state?.stats || [],
    proxyHealth: state?.proxyHealth || [],
    config,
  });
}

function collectProbeTaskConfigSafe(): Partial<ProbeTaskConfig> {
  try {
    return collectProbeTaskConfig();
  } catch {
    return {};
  }
}


function renderProbeMethodsBoard(state: ProbeState | null = latestProbeState): void {
  const host = mustGet('probe-methods-table');
  const summaryEl = mustGet('probe-methods-summary');
  if (!state) {
    summaryEl.textContent = '尚未加载方式探测结果';
    host.innerHTML = '<div class="table-empty">暂无数据</div>';
    return;
  }
  const detections = state.methodDetections || [];
  const recommendations = buildCountryMethodRecommendations(detections);
  summaryEl.textContent = `探测记录 ${detections.length} · 覆盖国家 ${recommendations.length} · 仅展示探测到的支持方式`;
  if (!recommendations.length) {
    host.innerHTML = '<div class="table-empty">暂无方式探测结果。请开启“探测 payment_method_types”后跑一轮。</div>';
    return;
  }
  const head = '<table class="data-table"><thead><tr><th>国家</th><th>推荐方式</th><th>支持方式（探测）</th><th>样本</th><th>0元样本</th><th>最近探测</th><th>说明</th></tr></thead><tbody>';
  const body = recommendations.map((item) => {
    const when = item.lastDetectedAt ? new Date(item.lastDetectedAt).toLocaleString('zh-CN', { hour12: false }) : '-';
    return `<tr>
      <td>${escapeHtml(item.country)}</td>
      <td><strong>${escapeHtml(item.recommendedPaymentMethod || '-')}</strong></td>
      <td>${escapeHtml((item.interestingMethods.length ? item.interestingMethods : item.methods).join(', ') || '-')}</td>
      <td>${item.samples}</td>
      <td>${item.zeroSamples}</td>
      <td>${escapeHtml(when)}</td>
      <td>${escapeHtml(item.note)}</td>
    </tr>`;
  }).join('');
  host.innerHTML = `${head}${body}</tbody></table>`;
}

function downloadTextFile(filename: string, content: string, mime = 'text/csv;charset=utf-8'): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function refreshProbeMethodsBoard(): Promise<void> {
  const response = await browser.runtime.sendMessage({ type: 'opx:probe-methods-query' }) as any;
  if (response?.state) {
    latestProbeState = response.state;
    renderProbeMethodsBoard(response.state);
  } else if (latestProbeState) {
    renderProbeMethodsBoard(latestProbeState);
  }
  setInlineStatus(mustGet('probe-methods-summary'), response?.message || '已刷新方式探测看板', response?.ok === false ? 'error' : 'ok');
}

function renderProbeRecommendBoard(state: ProbeState | null = latestProbeState): void {
  const host = mustGet('probe-recommend-table');
  const summaryEl = mustGet('probe-plan-summary');
  if (!state) {
    summaryEl.textContent = '尚未加载探测状态';
    host.innerHTML = '<div class="table-empty">暂无推荐</div>';
    return;
  }
  const config = normalizeTaskConfig({
    ...DEFAULT_PROBE_TASK_CONFIG,
    ...collectProbeTaskConfigSafe(),
    countries: collectProbeCountries().length ? collectProbeCountries() : (state.tasks.find((item) => item.id === state.activeTaskId)?.config.countries || DEFAULT_PROBE_TASK_CONFIG.countries),
  });
  const plan = selectCountriesForProbe({
    selectedCountries: config.countries,
    stats: state.stats || [],
    proxyHealth: state.proxyHealth || [],
    config,
  });
  const ranked = rankProbeCountries({
    selectedCountries: config.countries,
    stats: state.stats || [],
    proxyHealth: state.proxyHealth || [],
    config,
  });
  const recommended = recommendHighHitCountries({
    selectedCountries: config.countries,
    stats: state.stats || [],
    proxyHealth: state.proxyHealth || [],
    config,
  });
  summaryEl.textContent = [
    plan.note,
    recommended.length ? `推荐 ${recommended.join(', ')}` : '暂无高命中推荐（样本不足时先全量探测）',
    plan.excludedUnhealthy.length ? `剔除不健康: ${plan.excludedUnhealthy.join(', ')}` : '',
    plan.experimentalCountries.length ? `实验探测: ${plan.experimentalCountries.join(', ')}` : '',
    plan.excludedLowRate.length ? `本轮暂缓: ${plan.excludedLowRate.slice(0, 12).join(', ')}${plan.excludedLowRate.length > 12 ? '…' : ''}` : '',
  ].filter(Boolean).join(' · ');

  if (!ranked.length) {
    host.innerHTML = '<div class="table-empty">暂无统计，先跑一轮或检查健康后再预览</div>';
    return;
  }
  const activeSet = new Set(plan.countries);
  host.innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>国家</th>
          <th>健康</th>
          <th>尝试</th>
          <th>命中</th>
           <th>命中率</th>
           <th>95%区间</th>
          <th>资格</th>
          <th>本轮</th>
          <th>最近命中</th>
        </tr>
      </thead>
      <tbody>
        ${ranked.slice(0, 80).map((row: ProbeCountryScore) => `
          <tr>
            <td>${escapeHtml(row.country)}</td>
            <td><span class="status-pill" data-status="${escapeAttr(row.health === 'ok' ? 'success' : row.health === 'fail' || row.health === 'skip' ? 'error' : 'idle')}">${escapeHtml(row.health)}</span></td>
            <td>${row.attempts}</td>
            <td>${row.hits}</td>
           <td>${row.rate}%</td>
           <td>${row.confidenceLow}%–${row.confidenceHigh}%</td>
            <td>${row.qualified ? '高命中' : '观察中'}</td>
            <td>${activeSet.has(row.country) ? '会跑' : '跳过'}</td>
            <td>${row.lastHitAt ? new Date(row.lastHitAt).toLocaleString() : '-'}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function collectProbeCountries(): string[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>('input[data-probe-country]:checked'))
    .map((input) => input.getAttribute('data-probe-country') || '')
    .filter(Boolean);
}

function collectProbeChannels(): string[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>('input[data-probe-channel]:checked'))
    .map((input) => input.getAttribute('data-probe-channel') || '')
    .filter(Boolean);
}

function collectProbeTaskConfig(): ProbeTaskConfig {
  return normalizeTaskConfig({
    name: valueOf('probe-task-name'),
    intervalSec: Number(valueOf('probe-interval') || 60),
    concurrency: Number(valueOf('probe-concurrency') || 1),
    retryCount: Number(valueOf('probe-retry') || 3),
    planName: valueOf('probe-plan'),
    accountSource: valueOf('probe-account-source'),
    entryProxyMode: valueOf('probe-entry-proxy'),
    exitProxyMode: valueOf('probe-exit-proxy'),
    countries: collectProbeCountries(),
    channels: collectProbeChannels(),
    pinOnSuccess: checkedOf('probe-pin-success'),
    skipAccountAfterHit: checkedOf('probe-skip-after-hit'),
    autoSwitchExitByCountry: checkedOf('probe-auto-switch-exit'),
    autoOpenOnHit: checkedOf('probe-auto-open-hit'),
    sniffCheckoutOnHit: checkedOf('probe-sniff-hit'),
    saveHitsToDatabase: checkedOf('probe-save-hitdb'),
    excludeUnhealthyExits: checkedOf('probe-exclude-unhealthy'),
    highHitRateOnly: checkedOf('probe-high-rate-only'),
    explorationEnabled: checkedOf('probe-exploration-enabled'),
    explorationCountryCount: Number(valueOf('probe-exploration-count') || 0),
    factorTrackingEnabled: checkedOf('probe-factor-tracking'),
    driftDetectionEnabled: checkedOf('probe-drift-detection'),
    adaptiveExplorationPercent: Number(valueOf('probe-adaptive-percent') || 20),
    factorMinSamples: Number(valueOf('probe-factor-min-samples') || 5),
    driftMinSamples: Number(valueOf('probe-drift-min-samples') || 10),
    observationRetentionLimit: Number(valueOf('probe-observation-limit') || 3000),
    experimentMode: valueOf('probe-experiment-mode'),
    researchModeEnabled: valueOf('probe-experiment-mode') !== 'discovery',
    exploitTrafficPercent: Number(valueOf('probe-exploit-percent') || 0),
    balancedTrafficPercent: Number(valueOf('probe-balanced-percent') || 0),
    explorationTrafficPercent: Number(valueOf('probe-explore-percent') || 0),
    controlledFactors: [...document.querySelectorAll<HTMLInputElement>('[data-probe-factor]:checked')]
      .map((input) => input.dataset.probeFactor || '').filter(Boolean),
    routeVariants: parseRouteVariantsText(valueOf('probe-route-variants')),
    paymentMethodVariants: valueOf('probe-payment-variants').split(/[;,\s]+/).map((item) => item.trim().toLowerCase()).filter(Boolean),
    seedReplicatesPerCell: Number(valueOf('probe-seed-replicates') || 3),
    balancedOrderEnabled: checkedOf('probe-balanced-order'),
    researchTargetSamplesPerCell: Number(valueOf('probe-research-target-cell') || 3),
    researchMinRepeatIntervalMinutes: Number(valueOf('probe-research-repeat-minutes') || 240),
    researchMinTotalSamples: Number(valueOf('probe-research-min-total') || 100),
    minHitRatePercent: Number(valueOf('probe-min-hit-rate') || 30),
    minHitAttempts: Number(valueOf('probe-min-hit-attempts') || 3),
    maxHighRateCountries: Number(valueOf('probe-max-high-rate') || 12),
    stagedPipelineEnabled: checkedOf('probe-staged-pipeline'),
    useSelectedAsBootstrapProvider: checkedOf('probe-use-selected-bootstrap'),
    enablePromotionUpdate: checkedOf('probe-enable-promotion-update'),
    enableProviderTaxes: checkedOf('probe-enable-provider-taxes'),
    requireZero: checkedOf('probe-require-zero'),
    checkoutUiMode: valueOf('probe-checkout-ui-mode'),
    extractFinalPaymentUrl: checkedOf('probe-extract-final-url'),
    enableStripeConfirm: checkedOf('probe-enable-stripe-confirm'),
    paymentCheckoutSessionMode: valueOf('probe-payment-checkout-mode'),
    extractAllDetectedMethods: checkedOf('probe-extract-all-methods'),
    forceUnlistedPaymentMethodProbe: checkedOf('probe-force-unlisted-methods'),
    detectPaymentMethods: checkedOf('probe-detect-methods'),
    attachDetectedMethods: checkedOf('probe-attach-detected-methods'),
    autoApplyDetectedMethods: checkedOf('probe-auto-apply-detected-methods'),
    paymentMethod: valueOf('probe-payment-method').trim().toLowerCase(),
    idealBank: valueOf('probe-ideal-bank').trim() || 'n26',
    stripePublishableKey: valueOf('probe-stripe-pk').trim(),
    promotionCountry: valueOf('probe-promotion-country').trim().toUpperCase() || 'VN',
    bootstrapCountry: valueOf('probe-bootstrap-country').trim().toUpperCase(),
    providerCountry: valueOf('probe-provider-country').trim().toUpperCase(),
    notifyMode: valueOf('probe-notify-mode'),
    soundEnabled: checkedOf('probe-sound-enabled'),
    preferChromeTlsNote: checkedOf('probe-tls-note'),
  });
}

function parseCountryExitText(raw: string): Array<{ country: string; endpoint: { enabled: boolean; scheme: string; host: string; port: number; username: string; password: string; label: string } }> {
  const rows: Array<{ country: string; endpoint: { enabled: boolean; scheme: string; host: string; port: number; username: string; password: string; label: string } }> = [];
  raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).forEach((line) => {
    const [countryPart, endpointPart] = line.split('----').map((part) => part.trim());
    const country = String(countryPart || '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(country) || !endpointPart) return;
    let scheme = 'http';
    let host = '';
    let port = 0;
    let username = '';
    let password = '';
    try {
      const normalized = endpointPart.includes('://') ? endpointPart : `http://${endpointPart}`;
      const url = new URL(normalized);
      scheme = (url.protocol.replace(':', '') || 'http').toLowerCase();
      host = url.hostname;
      port = Number(url.port || 0);
      username = decodeURIComponent(url.username || '');
      password = decodeURIComponent(url.password || '');
    } catch {
      const m = endpointPart.match(/^(?:(https?|socks5|socks4):\/\/)?(?:([^:@]+):([^@]*)@)?([^:]+):(\d+)$/i);
      if (!m) return;
      scheme = (m[1] || 'http').toLowerCase();
      username = m[2] || '';
      password = m[3] || '';
      host = m[4] || '';
      port = Number(m[5] || 0);
    }
    if (!host || port <= 0) return;
    rows.push({
      country,
      endpoint: {
        enabled: true,
        scheme,
        host,
        port,
        username,
        password,
        label: `出口/${country}`,
      },
    });
  });
  return rows;
}

function bindProbePanel(): void {
  const statusEl = mustGet('probe-task-status');
  mustGet('btn-probe-country-all').addEventListener('click', () => {
    renderProbeCountries(listProbeCountries().map((item) => item.country));
  });
  mustGet('btn-probe-country-none').addEventListener('click', () => {
    renderProbeCountries([]);
  });
  mustGet('btn-probe-country-default').addEventListener('click', () => {
    renderProbeCountries(defaultProbeCountries());
  });
  mustGet('probe-account-filter-status').addEventListener('change', () => {
    probeAccountReportPage = 1;
    renderProbeAccountReport();
  });
  mustGet('probe-account-filter-query').addEventListener('input', () => {
    probeAccountReportPage = 1;
    renderProbeAccountReport();
  });
  mustGet('btn-probe-account-prev').addEventListener('click', () => {
    probeAccountReportPage = Math.max(1, probeAccountReportPage - 1);
    renderProbeAccountReport();
  });
  mustGet('btn-probe-account-next').addEventListener('click', () => {
    probeAccountReportPage += 1;
    renderProbeAccountReport();
  });
  mustGet('btn-probe-account-select-page').addEventListener('click', () => {
    document.querySelectorAll<HTMLInputElement>('[data-probe-account-select]').forEach((input) => {
      const id = input.getAttribute('data-probe-account-select') || '';
      if (id) probeAccountSelection.add(id);
    });
    renderProbeAccountReport();
  });
  mustGet('btn-probe-account-enable').addEventListener('click', () => void runProbeAccountAction('enable'));
  mustGet('btn-probe-account-disable').addEventListener('click', () => void runProbeAccountAction('disable'));
  mustGet('btn-probe-account-delete').addEventListener('click', () => void runProbeAccountAction('delete'));
  mustGet('btn-probe-account-report-refresh').addEventListener('click', async () => {
    const button = mustGet('btn-probe-account-report-refresh') as HTMLButtonElement;
    const restore = setButtonPending(button, '刷新中...');
    try {
      const response = await browser.runtime.sendMessage({ type: 'opx:probe-account-report' }) as ProbeResponse & { report?: ProbeAccountReportRow[] };
      if (response.state) {
        latestProbeState = response.state;
        renderProbeAccountReport(response.state, response.report);
      } else if (response.report) {
        renderProbeAccountReport(latestProbeState, response.report);
      }
      setInlineStatus(statusEl, response.message || '账号报表已刷新', response.ok ? 'ok' : 'error');
    } catch (error) {
      setInlineStatus(statusEl, error instanceof Error ? error.message : String(error), 'error');
    } finally {
      restore();
    }
  });
  mustGet('btn-probe-account-report-export').addEventListener('click', async () => {
    const button = mustGet('btn-probe-account-report-export') as HTMLButtonElement;
    const restore = setButtonPending(button, '导出中...');
    try {
      const response = await browser.runtime.sendMessage({ type: 'opx:probe-account-report' }) as ProbeResponse & { report?: ProbeAccountReportRow[]; exportText?: string };
      if (response.state) {
        latestProbeState = response.state;
        renderProbeAccountReport(response.state, response.report);
      }
      if (response.exportText) {
        downloadText(response.exportText, `probe-account-report-${Date.now()}.csv`, 'text/csv;charset=utf-8');
        try { await navigator.clipboard.writeText(response.exportText); } catch { /* ignore */ }
      }
      setInlineStatus(statusEl, response.message || '账号报表已导出', response.ok ? 'ok' : 'error');
    } catch (error) {
      setInlineStatus(statusEl, error instanceof Error ? error.message : String(error), 'error');
    } finally {
      restore();
    }
  });
  mustGet('btn-probe-plan-preview').addEventListener('click', () => {
    renderProbeRecommendBoard(latestProbeState);
    const plan = previewProbeCountryPlan(latestProbeState);
    setInlineStatus(statusEl, `预览完成：${plan.note}`, 'ok');
  });
  mustGet('btn-probe-apply-highrate').addEventListener('click', () => {
    void (async () => {
      if (!latestProbeState) {
        setInlineStatus(statusEl, '请先刷新探测状态', 'error');
        return;
      }
      const button = mustGet('btn-probe-apply-highrate') as HTMLButtonElement;
      const restore = setButtonPending(button, '应用中...');
      try {
        const baseConfig = normalizeTaskConfig({
          ...DEFAULT_PROBE_TASK_CONFIG,
          ...collectProbeTaskConfigSafe(),
          countries: collectProbeCountries().length ? collectProbeCountries() : latestProbeState.tasks[0]?.config.countries,
        });
        const recommended = recommendHighHitCountries({
          selectedCountries: baseConfig.countries.length ? baseConfig.countries : listProbeCountries().map((item) => item.country),
          stats: latestProbeState.stats || [],
          proxyHealth: latestProbeState.proxyHealth || [],
          config: {
            ...baseConfig,
            highHitRateOnly: true,
          },
        });
        if (!recommended.length) {
          setInlineStatus(statusEl, '暂无高命中国家可应用，请先积累探测样本', 'error');
          return;
        }
        renderProbeCountries(recommended);
        (mustGet('probe-high-rate-only') as HTMLInputElement).checked = true;
        syncProbeHighRateInputs();
        const config = collectProbeTaskConfig();
        const latest = await browser.runtime.sendMessage({ type: 'opx:probe-get-state' }) as ProbeResponse;
        const activeId = latest.state?.activeTaskId || latest.state?.tasks[0]?.id;
        const response = await browser.runtime.sendMessage({
          type: 'opx:probe-upsert-task',
          task: {
            id: activeId,
            config: {
              ...config,
              countries: recommended,
              highHitRateOnly: true,
            },
          },
        }) as ProbeResponse;
        if (response.state) fillProbePanel(response.state);
        else renderProbeRecommendBoard(latestProbeState);
        setInlineStatus(statusEl, response.message || (`已应用并保存高命中国家 ${recommended.length} 个：${recommended.join(', ')}`), response.ok ? 'ok' : 'error');
      } catch (error) {
        setInlineStatus(statusEl, error instanceof Error ? error.message : String(error), 'error');
      } finally {
        restore();
      }
    })();
  });
  for (const id of ['probe-exclude-unhealthy', 'probe-high-rate-only', 'probe-exploration-enabled', 'probe-exploration-count', 'probe-min-hit-rate', 'probe-min-hit-attempts', 'probe-max-high-rate']) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener('change', () => {
      syncProbeHighRateInputs();
      renderProbeRecommendBoard(latestProbeState);
    });
  }
  for (const id of ['probe-factor-tracking', 'probe-drift-detection', 'probe-factor-min-samples', 'probe-drift-min-samples', 'probe-adaptive-percent', 'probe-observation-limit', 'probe-experiment-mode', 'probe-exploit-percent', 'probe-balanced-percent', 'probe-explore-percent', 'probe-balanced-order', 'probe-research-target-cell', 'probe-research-repeat-minutes', 'probe-research-min-total', 'probe-seed-replicates']) {
    document.getElementById(id)?.addEventListener('change', syncProbeFactorInputs);
  }
  mustGet('btn-probe-save-accounts').addEventListener('click', async () => {
    const button = mustGet('btn-probe-save-accounts') as HTMLButtonElement;
    const restore = setButtonPending(button, '保存中...');
    try {
      const response = await browser.runtime.sendMessage({
        type: 'opx:probe-save-accounts',
        rawAccounts: valueOf('probe-raw-accounts'),
      }) as ProbeResponse;
      if (response.state) fillProbePanel(response.state);
      setInlineStatus(statusEl, response.message || '账号已保存', response.ok ? 'ok' : 'error');
    } catch (error) {
      setInlineStatus(statusEl, error instanceof Error ? error.message : String(error), 'error');
    } finally {
      restore();
    }
  });
  mustGet('btn-probe-save-country-exits').addEventListener('click', async () => {
    const button = mustGet('btn-probe-save-country-exits') as HTMLButtonElement;
    const restore = setButtonPending(button, '保存中...');
    try {
      const countryExits = parseCountryExitText(valueOf('probe-country-exits'));
      const response = await browser.runtime.sendMessage({
        type: 'opx:proxy-save',
        settings: { countryExits },
      }) as { ok?: boolean; message?: string };
      setInlineStatus(statusEl, response?.message || `已保存 ${countryExits.length} 条国家出口映射`, response?.ok === false ? 'error' : 'ok');
    } catch (error) {
      setInlineStatus(statusEl, error instanceof Error ? error.message : String(error), 'error');
    } finally {
      restore();
    }
  });
  mustGet('btn-probe-create-task').addEventListener('click', async () => {
    const button = mustGet('btn-probe-create-task') as HTMLButtonElement;
    const restore = setButtonPending(button, '保存任务...');
    try {
      const latest = await browser.runtime.sendMessage({ type: 'opx:probe-get-state' }) as ProbeResponse;
      const activeId = latest.state?.activeTaskId || latest.state?.tasks[0]?.id;
      const response = await browser.runtime.sendMessage({
        type: 'opx:probe-upsert-task',
        task: {
          id: activeId,
          config: collectProbeTaskConfig(),
        },
      }) as ProbeResponse;
      if (response.state) fillProbePanel(response.state);
      setInlineStatus(statusEl, response.message || '任务已保存', response.ok ? 'ok' : 'error');
    } catch (error) {
      setInlineStatus(statusEl, error instanceof Error ? error.message : String(error), 'error');
    } finally {
      restore();
    }
  });
  const control = async (action: 'start' | 'stop' | 'run-once' | 'refresh', buttonId: string, pending: string) => {
    const button = mustGet(buttonId) as HTMLButtonElement;
    const restore = setButtonPending(button, pending);
    try {
      const latest = await browser.runtime.sendMessage({ type: 'opx:probe-get-state' }) as ProbeResponse;
      const taskId = latest.state?.activeTaskId || latest.state?.tasks[0]?.id;
      const response = await browser.runtime.sendMessage({
        type: 'opx:probe-control',
        action,
        taskId,
      }) as ProbeResponse;
      if (response.state) fillProbePanel(response.state);
      setInlineStatus(statusEl, response.message || action, response.ok ? 'ok' : 'error');
    } catch (error) {
      setInlineStatus(statusEl, error instanceof Error ? error.message : String(error), 'error');
    } finally {
      restore();
    }
  };
  mustGet('btn-probe-run-once').addEventListener('click', () => void control('run-once', 'btn-probe-run-once', '探测中...'));
  mustGet('btn-probe-start').addEventListener('click', () => void control('start', 'btn-probe-start', '启动中...'));
  mustGet('btn-probe-stop').addEventListener('click', () => void control('stop', 'btn-probe-stop', '停止中...'));
  mustGet('btn-probe-refresh').addEventListener('click', () => void control('refresh', 'btn-probe-refresh', '刷新中...'));
  mustGet('btn-probe-smart-once').addEventListener('click', () => void runSmartProbe(false));
  mustGet('btn-probe-smart-start').addEventListener('click', () => void runSmartProbe(true));
  wireRunLogPanel(statusEl);
  mustGet('btn-probe-clear-hits').addEventListener('click', async () => {
    const response = await browser.runtime.sendMessage({ type: 'opx:probe-clear-hits', scope: 'runtime' }) as ProbeResponse;
    if (response.state) fillProbePanel(response.state);
    setInlineStatus(statusEl, response.message || '运行命中已清空', response.ok ? 'ok' : 'error');
  });
  mustGet('probe-high-rate-only').addEventListener('change', () => {
    syncProbeHighRateInputs();
  });
  mustGet('btn-probe-hitdb-refresh').addEventListener('click', async () => {
    const button = mustGet('btn-probe-hitdb-refresh') as HTMLButtonElement;
    const restore = setButtonPending(button, '刷新中...');
    try {
      await refreshProbeHitDatabaseBoard(statusEl);
    } catch (error) {
      setInlineStatus(statusEl, error instanceof Error ? error.message : String(error), 'error');
    } finally {
      restore();
    }
  });
  mustGet('btn-probe-sync-session').addEventListener('click', async () => {
    const button = mustGet('btn-probe-sync-session') as HTMLButtonElement;
    const restore = setButtonPending(button, '同步中...');
    try {
      const response = await browser.runtime.sendMessage({
        type: 'opx:probe-sync-current-session',
      }) as ProbeResponse;
      if (response.state) fillProbePanel(response.state);
      setInlineStatus(statusEl, response.message || '登录会话已同步', response.ok ? 'ok' : 'error');
    } catch (error) {
      setInlineStatus(statusEl, error instanceof Error ? error.message : String(error), 'error');
    } finally {
      restore();
    }
  });

  mustGet('btn-probe-methods-refresh').addEventListener('click', () => {
    void refreshProbeMethodsBoard();
  });
  mustGet('btn-probe-methods-export').addEventListener('click', async () => {
    const response = await browser.runtime.sendMessage({ type: 'opx:probe-methods-export' }) as any;
    if (!response?.ok) {
      setInlineStatus(mustGet('probe-methods-summary'), response?.message || '导出失败', 'error');
      return;
    }
    downloadTextFile(`method-detections-${Date.now()}.csv`, response.csv || '');
    downloadTextFile(`method-recommendations-${Date.now()}.csv`, response.recommendationsCsv || '');
    setInlineStatus(mustGet('probe-methods-summary'), response.message || '已导出方式探测 CSV', 'ok');
  });
  mustGet('btn-probe-methods-clear').addEventListener('click', async () => {
    const response = await browser.runtime.sendMessage({ type: 'opx:probe-methods-clear' }) as any;
    if (response?.state) {
      latestProbeState = response.state;
      renderProbeMethodsBoard(response.state);
    }
    setInlineStatus(mustGet('probe-methods-summary'), response?.message || '已清空', response?.ok === false ? 'error' : 'ok');
  });
  mustGet('btn-probe-apply-method-rec').addEventListener('click', () => {
    if (!latestProbeState) return;
    const recommendations = buildCountryMethodRecommendations(latestProbeState.methodDetections || []);
    // majority recommended method across selected countries
    const selected = collectProbeCountries();
    const counts = new Map<string, number>();
    for (const row of recommendations) {
      if (selected.length && !selected.includes(row.country)) continue;
      const method = row.recommendedPaymentMethod;
      if (!method) continue;
      counts.set(method, (counts.get(method) || 0) + 1);
    }
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || recommendations[0]?.recommendedPaymentMethod || '';
    if (!best) {
      setInlineStatus(mustGet('probe-methods-summary'), '没有可应用的推荐方式（需先有探测支持结果）', 'error');
      return;
    }
    (mustGet('probe-payment-method') as HTMLSelectElement).value = best;
    (mustGet('probe-auto-apply-detected-methods') as HTMLInputElement).checked = true;
    (mustGet('probe-detect-methods') as HTMLInputElement).checked = true;
    setInlineStatus(mustGet('probe-methods-summary'), `已应用推荐方式 ${best}（来自探测到的支持方式）`, 'ok');
  });
  mustGet('btn-probe-factor-refresh').addEventListener('click', async () => {
    const response = await browser.runtime.sendMessage({ type: 'opx:probe-factor-query' }) as ProbeFactorResponse;
    if (response.state) {
      latestProbeState = response.state;
      renderProbeFactorBoard(response.state);
    }
    setInlineStatus(mustGet('probe-factor-summary'), response.message || '已刷新资格因素分析', response.ok ? 'ok' : 'error');
  });
  mustGet('btn-probe-factor-import').addEventListener('click', () => {
    openPasteImportDialog({
      title: '导入资格观测',
      description: '支持因素 JSON 导出文件或包含 accountId、probeCountry 列的 CSV；按 observation id 自动去重并立即重算。',
      placeholder: '{"observations":[...]}\n\n或 CSV：id,observedAt,accountId,probeCountry,outcome,...',
      confirmText: '合并导入',
      onConfirm: (text) => {
        void (async () => {
          const response = await browser.runtime.sendMessage({
            type: 'opx:probe-factor-import',
            text,
            format: 'auto',
            mode: 'merge',
          }) as ProbeFactorResponse;
          if (response.state) {
            latestProbeState = response.state;
            renderProbeFactorBoard(response.state);
          }
          setInlineStatus(mustGet('probe-factor-summary'), response.message || '观测导入完成', response.ok ? 'ok' : 'error');
        })();
      },
    });
  });
  const exportFactor = async (format: 'csv' | 'json') => {
    const response = await browser.runtime.sendMessage({ type: 'opx:probe-factor-export', format }) as ProbeFactorResponse;
    if (!response.ok || !response.exportText) {
      setInlineStatus(mustGet('probe-factor-summary'), response.message || '导出失败', 'error');
      return;
    }
    downloadTextFile(
      `eligibility-factors-${Date.now()}.${format}`,
      response.exportText,
      format === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8',
    );
    setInlineStatus(mustGet('probe-factor-summary'), response.message, 'ok');
  };
  mustGet('btn-probe-factor-export-csv').addEventListener('click', () => void exportFactor('csv'));
  mustGet('btn-probe-factor-export-json').addEventListener('click', () => void exportFactor('json'));
  mustGet('btn-probe-factor-clear').addEventListener('click', async () => {
    if (!confirm('清空逐次资格观测、因素结论和漂移告警？命中链接数据库不受影响。')) return;
    const response = await browser.runtime.sendMessage({ type: 'opx:probe-factor-clear' }) as ProbeFactorResponse;
    if (response.state) {
      latestProbeState = response.state;
      renderProbeFactorBoard(response.state);
    }
    setInlineStatus(mustGet('probe-factor-summary'), response.message || '已清空资格因素数据', response.ok ? 'ok' : 'error');
  });
  mustGet('btn-proxy-seed-export').addEventListener('click', async () => {
    const settings = latestProxySettings || await loadProxySettings();
    const csv = exportSeedHealthCsv(settings.seedHealth || []);
    downloadTextFile(`seed-health-${Date.now()}.csv`, csv);
    setInlineStatus(mustGet('proxy-pool-status'), `已导出 seed 健康 ${(settings.seedHealth || []).length} 条`, 'ok');
  });
  mustGet('btn-proxy-seed-export-json').addEventListener('click', async () => {
    const settings = latestProxySettings || await loadProxySettings();
    const json = exportSeedHealthJson(settings.seedHealth || []);
    downloadTextFile(`seed-health-${Date.now()}.json`, json, 'application/json;charset=utf-8');
    setInlineStatus(mustGet('proxy-pool-status'), `已导出 seed 健康 JSON ${(settings.seedHealth || []).length} 条`, 'ok');
  });
mustGet('btn-probe-hitdb-export').addEventListener('click', async () => {
    const button = mustGet('btn-probe-hitdb-export') as HTMLButtonElement;
    const restore = setButtonPending(button, '导出中...');
    try {
      const filter = collectProbeHitDbFilter();
      const response = await browser.runtime.sendMessage({
        type: 'opx:probe-hitdb-export',
        filter,
      }) as ProbeHitDbResponse;
      if (response.state) renderProbeHitDatabase(response.state.hitDatabase || response.records || [], filter, response.summary);
      if (response.exportText) {
        downloadText(response.exportText, `probe-hits-${Date.now()}.csv`, 'text/csv;charset=utf-8');
        try {
          await navigator.clipboard.writeText(response.exportText);
        } catch {
          // ignore clipboard failures
        }
      }
      setInlineStatus(statusEl, response.message || '已导出 CSV', response.ok ? 'ok' : 'error');
    } catch (error) {
      setInlineStatus(statusEl, error instanceof Error ? error.message : String(error), 'error');
    } finally {
      restore();
    }
  });
  mustGet('btn-probe-hitdb-clear').addEventListener('click', async () => {
    if (!window.confirm('确认清空命中链接数据库？此操作不可恢复。')) return;
    const button = mustGet('btn-probe-hitdb-clear') as HTMLButtonElement;
    const restore = setButtonPending(button, '清空中...');
    try {
      const response = await browser.runtime.sendMessage({ type: 'opx:probe-clear-hits', scope: 'database' }) as ProbeResponse;
      if (response.state) fillProbePanel(response.state);
      setInlineStatus(statusEl, response.message || '命中数据库已清空', response.ok ? 'ok' : 'error');
    } catch (error) {
      setInlineStatus(statusEl, error instanceof Error ? error.message : String(error), 'error');
    } finally {
      restore();
    }
  });
  let hitdbFilterTimer: number | undefined;
  for (const id of ['probe-hitdb-country', 'probe-hitdb-kind', 'probe-hitdb-query', 'probe-hitdb-only-link', 'probe-hitdb-only-usable']) {
    const el = mustGet(id);
    const eventName = id === 'probe-hitdb-only-link' || id === 'probe-hitdb-only-usable' || id === 'probe-hitdb-kind' ? 'change' : 'input';
    el.addEventListener(eventName, () => {
      window.clearTimeout(hitdbFilterTimer);
      hitdbFilterTimer = window.setTimeout(() => {
        void refreshProbeHitDatabaseBoard();
      }, eventName === 'input' ? 250 : 0);
    });
  }
  mustGet('btn-probe-health').addEventListener('click', async () => {
    const button = mustGet('btn-probe-health') as HTMLButtonElement;
    const restore = setButtonPending(button, '检查中...');
    try {
      const latest = await browser.runtime.sendMessage({ type: 'opx:probe-get-state' }) as ProbeResponse;
      const taskId = latest.state?.activeTaskId || latest.state?.tasks[0]?.id;
      const response = await browser.runtime.sendMessage({
        type: 'opx:probe-control',
        action: 'health-check',
        taskId,
      }) as ProbeResponse;
      if (response.state) fillProbePanel(response.state);
      setInlineStatus(statusEl, response.message || '健康检查完成', response.ok ? 'ok' : 'error');
    } catch (error) {
      setInlineStatus(statusEl, error instanceof Error ? error.message : String(error), 'error');
    } finally {
      restore();
    }
  });
  mustGet('btn-probe-copy-hits').addEventListener('click', async () => {
    const latest = await browser.runtime.sendMessage({ type: 'opx:probe-get-state' }) as ProbeResponse;
    const links = (latest.state?.hits || []).filter((hit) => hit.linkUsable).map((hit) => hit.link).filter(Boolean);
    if (!links.length) {
      setInlineStatus(statusEl, '没有可复制链接', 'error');
      return;
    }
    await navigator.clipboard.writeText(links.join('\n'));
    setInlineStatus(statusEl, `已复制 ${links.length} 条命中链接`, 'ok');
  });
}




function formatPaymentMethodLinkSummary(links: NonNullable<ProbeHitRecord['paymentMethodLinks']>): string {
  return links.map((item) => {
    const evidence = [
      item.sourceQualificationVerified ? '源资格' : '',
      item.forcedProbe ? '实验筛查' : '',
      item.sourceSessionReused ? '复用会话' : '',
      item.methodOffered ? '方式已暴露' : item.methodOffered === false ? '方式未暴露' : '',
      item.qualificationPreserved ? '资格保持' : '',
      item.capabilityScope === 'global' ? `全局上下文/${item.expectedCurrency || item.currency}` : '',
      item.capabilityScope === 'regional' ? `区域固定/${item.expectedCurrency || item.currency}` : '',
    ].filter(Boolean).join('·');
    return `${item.method}:${item.status}${evidence ? `(${evidence})` : ''}`;
  }).join(' / ');
}

async function runSmartProbe(startScheduled: boolean): Promise<void> {
  const statusEl = mustGet('probe-task-status');
  const button = mustGet(startScheduled ? 'btn-probe-smart-start' : 'btn-probe-smart-once') as HTMLButtonElement;
  const restore = setButtonPending(button, startScheduled ? '智能启动中...' : '智能开跑中...');
  try {
    // Ensure current form task is saved first when possible.
    try {
      const latest = await browser.runtime.sendMessage({ type: 'opx:probe-get-state' }) as ProbeResponse;
      const activeId = latest.state?.activeTaskId || latest.state?.tasks[0]?.id;
      const collected = collectProbeTaskConfig();
      await browser.runtime.sendMessage({
        type: 'opx:probe-upsert-task',
        task: {
          id: activeId,
          config: {
            ...collected,
            excludeUnhealthyExits: true,
            detectPaymentMethods: true,
            autoApplyDetectedMethods: true,
            saveHitsToDatabase: true,
            autoSwitchExitByCountry: true,
            exitProxyMode: 'follow-country',
            stagedPipelineEnabled: true,
            requireZero: true,
            extractFinalPaymentUrl: true,
            enableStripeConfirm: Boolean(collected.stripePublishableKey),
            factorTrackingEnabled: true,
            driftDetectionEnabled: true,
            experimentMode: 'hybrid',
            researchModeEnabled: true,
            explorationEnabled: true,
          },
        },
      });
    } catch {
      // ignore form collect errors; bootstrap can still create defaults
    }
    const response = await browser.runtime.sendMessage({
      type: 'opx:probe-smart-start',
      runHealthCheck: true,
      startScheduled,
      runOnce: !startScheduled,
    }) as ProbeResponse;
    if (response.state) fillProbePanel(response.state);
    void refreshRunLogPanel(false);
    setInlineStatus(statusEl, response.message || (startScheduled ? '智能定时已启动' : '智能开跑完成'), response.ok ? 'ok' : 'error');
  } catch (error) {
    setInlineStatus(statusEl, error instanceof Error ? error.message : String(error), 'error');
  } finally {
    restore();
  }
}

function wireRunLogPanel(statusEl: HTMLElement): void {
  const refreshBtn = document.getElementById('btn-runlog-refresh');
  if (!refreshBtn || refreshBtn.dataset.bound === '1') return;
  refreshBtn.dataset.bound = '1';
  refreshBtn.addEventListener('click', () => void refreshRunLogPanel(true));
  mustGet('btn-runlog-clear').addEventListener('click', async () => {
    const response = await browser.runtime.sendMessage({ type: 'opx:runlog-clear' }) as any;
    latestRunLogEvents = [];
    renderRunLogStream([]);
    setInlineStatus(mustGet('runlog-summary'), response?.message || '日志已清空', response?.ok === false ? 'error' : 'ok');
  });
  mustGet('btn-runlog-export-csv').addEventListener('click', () => void exportRunLog('csv'));
  mustGet('btn-runlog-export-jsonl').addEventListener('click', () => void exportRunLog('jsonl'));
  mustGet('runlog-filter-level').addEventListener('change', () => renderRunLogStream(latestRunLogEvents));
  mustGet('runlog-filter-account').addEventListener('input', () => renderRunLogStream(latestRunLogEvents));
  mustGet('runlog-autoscroll').addEventListener('change', () => {
    const stream = mustGet('runlog-stream');
    if ((mustGet('runlog-autoscroll') as HTMLInputElement).checked) {
      stream.scrollTop = stream.scrollHeight;
    }
  });
  mustGet('runlog-live').addEventListener('change', () => {
    if ((mustGet('runlog-live') as HTMLInputElement).checked) startRunLogLivePolling();
    else stopRunLogLivePolling();
  });
  void statusEl;
}

function startRunLogLivePolling(): void {
  stopRunLogLivePolling();
  const live = document.getElementById('runlog-live') as HTMLInputElement | null;
  if (live && !live.checked) return;
  runLogPollTimer = window.setInterval(() => {
    void refreshRunLogPanel(false);
  }, 1500);
  const pill = document.getElementById('runlog-connected');
  if (pill) {
    pill.dataset.connected = '1';
    pill.textContent = '实时日志已连接';
  }
}

function stopRunLogLivePolling(): void {
  if (runLogPollTimer != null) {
    window.clearInterval(runLogPollTimer);
    runLogPollTimer = null;
  }
}

async function refreshRunLogPanel(force = true): Promise<void> {
  const summary = document.getElementById('runlog-summary');
  const pill = document.getElementById('runlog-connected');
  if (!summary || !document.getElementById('runlog-stream')) return;
  try {
    const level = (document.getElementById('runlog-filter-level') as HTMLSelectElement | null)?.value || 'all';
    const accountId = ((document.getElementById('runlog-filter-account') as HTMLInputElement | null)?.value || '').trim();
    const response = await browser.runtime.sendMessage({
      type: 'opx:runlog-list',
      limit: 400,
      level: level === 'all' ? 'all' : level,
      accountId: accountId || undefined,
    }) as any;
    if (response?.ok === false) {
      if (pill) {
        pill.dataset.connected = '0';
        pill.textContent = '日志连接异常';
      }
      if (force) setInlineStatus(summary, response?.message || '读取日志失败', 'error');
      return;
    }
    latestRunLogEvents = Array.isArray(response?.events) ? response.events : (response?.state?.events || []);
    renderRunLogStream(latestRunLogEvents);
    if (pill) {
      pill.dataset.connected = '1';
      pill.textContent = '实时日志已连接';
    }
    const total = response?.state?.events?.length ?? latestRunLogEvents.length;
    summary.textContent = response?.message || `日志 ${latestRunLogEvents.length}/${total}`;
    if (force) setInlineStatus(summary, summary.textContent, 'ok');
  } catch (error) {
    if (pill) {
      pill.dataset.connected = '0';
      pill.textContent = '日志未连接';
    }
    if (force) setInlineStatus(summary, error instanceof Error ? error.message : String(error), 'error');
  }
}

function renderRunLogStream(events: Array<Record<string, unknown>>): void {
  const host = document.getElementById('runlog-stream');
  if (!host) return;
  const levelFilter = ((document.getElementById('runlog-filter-level') as HTMLSelectElement | null)?.value || 'all').toLowerCase();
  const accountFilter = ((document.getElementById('runlog-filter-account') as HTMLInputElement | null)?.value || '').trim().toLowerCase();
  let rows = events.slice();
  if (levelFilter && levelFilter !== 'all') {
    rows = rows.filter((item) => String(item.level || '').toLowerCase() === levelFilter);
  }
  if (accountFilter) {
    rows = rows.filter((item) => {
      const bag = `${item.accountLabel || ''} ${item.accountId || ''} ${item.email || ''}`.toLowerCase();
      return bag.includes(accountFilter);
    });
  }
  const key = rows.map((item) => String(item.id || item.ts || '')).join('|');
  const autoScroll = (document.getElementById('runlog-autoscroll') as HTMLInputElement | null)?.checked !== false;
  const nearBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 48;
  if (key === runLogLastRenderKey && host.childElementCount) {
    if (autoScroll && nearBottom) host.scrollTop = host.scrollHeight;
    return;
  }
  runLogLastRenderKey = key;
  if (!rows.length) {
    host.innerHTML = '<div class="table-empty">暂无运行日志。启动探测后将在此实时滚动。</div>';
    return;
  }
  host.innerHTML = rows.map((item) => {
    const level = String(item.level || 'info');
    const ts = Number(item.ts || 0);
    const time = ts ? new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }) : '--:--:--';
    const account = escapeHtml(String(item.accountLabel || item.email || item.accountId || '系统'));
    const stage = escapeHtml(String(item.stage || 'system'));
    const code = String(item.code || '');
    const progress = String(item.progress || '');
    const country = String(item.country || '');
    const message = escapeHtml(String(item.message || ''));
    const action = item.action ? `<span class="runlog-action">${escapeHtml(String(item.action))}</span>` : '';
    const metaBits = [code, progress, country].filter(Boolean).map((bit) => escapeHtml(bit)).join(' · ');
    return `<div class="runlog-line" data-level="${escapeAttr(level)}">
      <span class="runlog-time">${escapeHtml(time)}</span>
      <span class="runlog-level">${escapeHtml(level)}</span>
      <span class="runlog-account">${account}</span>
      <span class="runlog-stage">${stage}</span>
      <span class="runlog-msg">${message}${metaBits ? ` <small>${metaBits}</small>` : ''}${action}</span>
    </div>`;
  }).join('');
  if (autoScroll) host.scrollTop = host.scrollHeight;
}

async function exportRunLog(format: 'csv' | 'jsonl'): Promise<void> {
  const response = await browser.runtime.sendMessage({ type: 'opx:runlog-export', format }) as any;
  if (!response?.ok) {
    setInlineStatus(mustGet('runlog-summary'), response?.message || '导出失败', 'error');
    return;
  }
  const text = String(response.exportText || '');
  const filename = format === 'jsonl' ? `runlog-${Date.now()}.jsonl` : `runlog-${Date.now()}.csv`;
  const mime = format === 'jsonl' ? 'application/x-ndjson;charset=utf-8' : 'text/csv;charset=utf-8';
  downloadTextFile(filename, text, mime);
  setInlineStatus(mustGet('runlog-summary'), response.message || `已导出 ${format.toUpperCase()}`, 'ok');
}


function mustGet(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`missing element: ${id}`);
  }
  return element;
}

function valueOf(id: string): string {
  const element = mustGet(id) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  return element.value;
}

function checkedOf(id: string): boolean {
  return Boolean((mustGet(id) as HTMLInputElement).checked);
}

function setInlineStatus(element: HTMLElement, message: string, type: 'ok' | 'error'): void {
  element.textContent = message;
  element.dataset.type = type;
}

function setupStatusTooltips(): void {
  ensureStatusTooltip();
  if (statusTooltipBound) {
    return;
  }
  statusTooltipBound = true;

  const hide = (): void => {
    const tooltip = ensureStatusTooltip();
    tooltip.hidden = true;
    tooltip.textContent = '';
  };
  const show = (target: HTMLElement): void => {
    const text = target.dataset.tooltip || target.title || '';
    if (!text) {
      hide();
      return;
    }
    const tooltip = ensureStatusTooltip();
    tooltip.textContent = text;
    tooltip.hidden = false;
    const rect = target.getBoundingClientRect();
    const margin = 12;
    const tooltipRect = tooltip.getBoundingClientRect();
    const left = Math.min(
      Math.max(margin, rect.left),
      Math.max(margin, window.innerWidth - tooltipRect.width - margin),
    );
    const preferredTop = rect.bottom + 8;
    const top = preferredTop + tooltipRect.height + margin > window.innerHeight
      ? Math.max(margin, rect.top - tooltipRect.height - 8)
      : preferredTop;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  };

  document.addEventListener('mouseover', (event) => {
    const target = (event.target as Element | null)?.closest<HTMLElement>('.status-pill[data-tooltip]');
    if (target) {
      show(target);
    }
  });
  document.addEventListener('focusin', (event) => {
    const target = (event.target as Element | null)?.closest<HTMLElement>('.status-pill[data-tooltip]');
    if (target) {
      show(target);
    }
  });
  document.addEventListener('mouseout', (event) => {
    if ((event.target as Element | null)?.closest('.status-pill[data-tooltip]')) {
      hide();
    }
  });
  document.addEventListener('focusout', (event) => {
    if ((event.target as Element | null)?.closest('.status-pill[data-tooltip]')) {
      hide();
    }
  });
  document.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
}

function ensureStatusTooltip(): HTMLElement {
  const existing = document.querySelector<HTMLElement>('.status-tooltip');
  if (existing) {
    return existing;
  }
  const tooltip = document.createElement('div');
  tooltip.className = 'status-tooltip';
  tooltip.hidden = true;
  document.body.append(tooltip);
  return tooltip;
}

function openPasteImportDialog(options: PasteImportDialogOptions): void {
  document.querySelector('.import-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.className = 'import-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'import-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'import-dialog-title');

  const title = document.createElement('h2');
  title.id = 'import-dialog-title';
  title.textContent = options.title;

  const description = document.createElement('p');
  description.className = 'import-description';
  description.textContent = options.description;

  const textarea = document.createElement('textarea');
  textarea.className = 'import-textarea';
  textarea.placeholder = options.placeholder;
  textarea.spellcheck = false;

  const error = document.createElement('div');
  error.className = 'import-error';
  error.hidden = true;

  const actions = document.createElement('div');
  actions.className = 'import-actions';

  const cancel = document.createElement('button');
  cancel.className = 'button secondary';
  cancel.type = 'button';
  cancel.textContent = '取消';

  const confirm = document.createElement('button');
  confirm.className = 'button';
  confirm.type = 'button';
  confirm.textContent = options.confirmText;

  actions.append(cancel, confirm);
  dialog.append(title, description, textarea, error, actions);
  overlay.append(dialog);
  document.body.append(overlay);

  const close = (): void => {
    document.removeEventListener('keydown', onKeyDown);
    overlay.remove();
  };
  const submit = (): void => {
    const text = textarea.value.trim();
    if (!text) {
      error.textContent = '请先粘贴需要导入的内容。';
      error.hidden = false;
      textarea.focus();
      return;
    }
    options.onConfirm(text);
    close();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      close();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      submit();
    }
  };

  cancel.addEventListener('click', close);
  confirm.addEventListener('click', submit);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) {
      close();
    }
  });
  textarea.addEventListener('input', () => {
    error.hidden = true;
  });
  document.addEventListener('keydown', onKeyDown);
  window.setTimeout(() => textarea.focus(), 0);
}

async function copyText(content: string, status: HTMLElement, successMessage: string): Promise<void> {
  if (!content.trim()) {
    return;
  }
  try {
    await navigator.clipboard.writeText(content);
    status.textContent = successMessage;
    status.dataset.type = 'ok';
  } catch (error) {
    status.textContent = `复制失败：${error instanceof Error ? error.message : String(error)}`;
    status.dataset.type = 'error';
  }
}

function downloadJson(content: string, filename: string): void {
  if (!content.trim()) {
    return;
  }
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1200);
}

async function buildAutomationDiagnosticReport(state: AutomationState): Promise<string> {
  const manifest = browser.runtime.getManifest();
  const oauthPhone = await loadOAuthPhoneSettings();
  const targetTab = await getDiagnosticTargetTab(state);
  const generatedEmails = new Set(state.generatedFiles.records.map((record) => record.email.toLowerCase()));
  const emailTotal = state.emails.length;
  const emailSuccess = state.emails.filter((email) => !isRestoredEmail(email) && (generatedEmails.has(email.email.toLowerCase()) || email.status === 'used')).length;
  const emailError = state.emails.filter((email) => email.status === 'error').length;
  const smsDisabled = state.smsTargets.filter((target) => target.disabled).length;
  const currentEmail = state.emails.find((email) => email.id === state.run.selectedEmailId) || null;
  const currentSms = state.smsTargets.find((target) => target.id === state.run.selectedSmsId) || null;
  const currentRegisterPhone = state.run.registerPhoneNumber || '';
  const latestError = state.steps.find((step) => step.status === 'error') || null;
  const lines: string[] = [];

  lines.push('# OPX 自动化诊断报告');
  lines.push(`生成时间：${formatTime(Date.now())}`);
  lines.push(`插件版本：${manifest.version || 'unknown'}`);
  lines.push(`调试模式：${state.settings.debugMode ? '开启' : '关闭'}`);
  lines.push('');
  lines.push('## 当前任务');
  lines.push(`运行状态：${state.run.running ? '运行中' : state.run.paused ? '已暂停' : '未运行'}`);
  lines.push(`当前步骤：${state.run.currentStepId || '无'}`);
  lines.push(`开始时间：${formatTime(state.run.startedAt)}`);
  lines.push(`结束时间：${formatTime(state.run.finishedAt)}`);
  lines.push(`目标标签页：tab=${state.run.targetTabId || '-'} window=${state.run.targetWindowId || '-'}`);
  lines.push(`目标页面：${targetTab ? redactSensitiveText(String(targetTab.url || '')) : '未读取到目标标签页'}`);
  lines.push(`目标状态：${targetTab?.status || '未知'}`);
  lines.push(`当前邮箱：${currentEmail?.email || '未选择'}`);
  lines.push(`当前注册手机号：${currentRegisterPhone || '未选择'}`);
  lines.push(`当前接码：${currentSms?.phone || '未选择'}`);
  lines.push(`订阅链接：${state.run.checkoutUrl ? redactSensitiveText(state.run.checkoutUrl) : '无'}`);
  lines.push('');
  lines.push('## 设置摘要');
  lines.push(`注册方式：${state.settings.registrationMode === 'phone' ? '手机号注册' : '邮箱注册'}`);
  lines.push(`邮箱选择：${state.settings.registrationMode === 'phone' ? '手机号注册模式不使用邮箱池' : `${state.settings.emailSelectionMode}${state.settings.specifiedEmailId ? ` / 指定 ${state.settings.specifiedEmailId}` : ''}`}`);
  lines.push('接码来源：API 链接');
  lines.push(`接码选择：${state.settings.smsSelectionMode}`);
  lines.push(`执行账号数：${state.settings.batchAccountLimit}`);
  lines.push(`失败停止：${state.settings.stopOnError ? '是' : '否'}`);
  lines.push(`自动打开订阅链接：${state.settings.autoOpenCheckout ? '是' : '否'}`);
  lines.push(`提取模式：${state.settings.checkoutExtractMode || 'local'}`);
  try {
    const proxy = await loadProxySettings();
    lines.push(`代理总开关：${proxy.enabled ? '开' : '关'}`);
    lines.push(`代理链路：${proxy.chainMode}`);
    lines.push(`代理阶段：${proxy.activeStage}`);
    lines.push(`前置：${formatProxyEndpoint(proxy.front)}`);
    lines.push(`出口1：${formatProxyEndpoint(proxy.exit1)}`);
    lines.push(`出口2：${formatProxyEndpoint(proxy.exit2)}`);
    for (const stage of ['auth', 'checkout', 'billing'] as const) {
      const evidence = proxy.automationRouting.evidence[stage];
      lines.push(`${stage} 出口：${evidence ? `${evidence.country || '--'} ${evidence.ip || evidence.endpointSummary}` : '待运行'}`);
    }
  } catch (error) {
    lines.push(`代理配置：读取失败 ${error instanceof Error ? error.message : String(error)}`);
  }
  lines.push(`OAuth 方式：${state.settings.registrationMode === 'phone' ? 'direct（手机号注册自动直接生成）' : state.settings.oauthExtractMode}`);
  lines.push(`邮箱池：总数 ${emailTotal} / 成功 ${emailSuccess} / 失败 ${emailError}`);
  lines.push(`接码池：总数 ${state.smsTargets.length} / 不可用 ${smsDisabled}`);
  const oauthPhoneMode = oauthPhone.sourceMode === 'api' ? 'API 接码池' : '接码平台接码';
  const oauthPhoneApiDisabled = oauthPhone.apiTargets.filter((target) => target.disabled).length;
  lines.push(`OAuth 手机接码：${oauthPhone.enabled ? '启用' : '关闭'} / 模式 ${oauthPhoneMode} / 超时 ${oauthPhone.smsTimeoutSeconds || 120}s`);
  lines.push(`OAuth 手机接码 API 池：总数 ${oauthPhone.apiTargets.length} / 可用 ${oauthPhone.apiTargets.length - oauthPhoneApiDisabled} / 不可用 ${oauthPhoneApiDisabled}`);
  oauthPhone.apiTargets.slice(0, 80).forEach((target, index) => {
    const disabled = target.disabled ? `不可用：${redactSensitiveText(target.disabledReason || '-')}` : '可用';
    lines.push(`- OAuth API ${index + 1}. ${target.phone}；${disabled}；次数=${target.useCount}；最后收码=${formatTime(target.lastCodeAt)}；API=${redactSensitiveText(target.url)}；消息=${redactSensitiveText(target.lastMessage || '-')}`);
  });
  if (oauthPhone.apiTargets.length > 80) {
    lines.push(`- OAuth API 还有 ${oauthPhone.apiTargets.length - 80} 个号码未展开`);
  }
  lines.push(`OAuth 手机接码平台模式：平台 ${providerLabel(oauthPhone.activeProviderId)} / 策略 ${oauthPhone.providerMode}`);
  const oauthPhoneOffers = oauthPhone.selectedOffers.length
    ? oauthPhone.selectedOffers.map((offer) => `${providerLabel(offer.providerId)} ${offer.countryName}/${offer.countryId} $${formatPrice(offer.cost)} stock=${offer.count}`).join('；')
    : '-';
  lines.push(`OAuth 手机接码条件：服务 ${oauthPhone.serviceCode || '-'} / 报价 ${oauthPhoneOffers} / 最低价 ${oauthPhone.minPrice || '不限制'} / 最高价 ${oauthPhone.maxPrice || '不限制'}`);
  lines.push(`OAuth 手机接码平台：${oauthPhone.providers.map((provider) => `${providerLabel(provider.id)}=${provider.enabled ? '启用' : '关闭'},key=${provider.apiKey ? '[REDACTED]' : '空'},priority=${provider.priority}`).join('；')}`);
  lines.push('');
  lines.push('## 步骤状态');
  for (const step of state.steps) {
    const started = step.startedAt ? formatTime(step.startedAt) : '-';
    const finished = step.finishedAt ? formatTime(step.finishedAt) : '-';
    const elapsed = step.startedAt && step.finishedAt ? `${Math.max(0, step.finishedAt - step.startedAt)}ms` : '-';
    lines.push(`- ${step.id} [${step.status}] ${redactSensitiveText(step.message || '')}；开始=${started}；结束=${finished}；耗时=${elapsed}`);
  }
  lines.push('');
  lines.push('## 邮箱池状态');
  state.emails.slice(0, 120).forEach((email, index) => {
    const success = generatedEmails.has(email.email.toLowerCase()) ? '开通成功' : email.status;
    lines.push(`- ${index + 1}. ${email.email}；状态=${success}；次数=${email.useCount}；最后=${redactSensitiveText(email.lastMessage || '-')}`);
  });
  if (state.emails.length > 120) {
    lines.push(`- 还有 ${state.emails.length - 120} 个邮箱未展开`);
  }
  lines.push('');
  lines.push('## 接码池状态');
  state.smsTargets.forEach((target, index) => {
    const source = target.source === 'foxsms' ? `Fox SMS jpn/35 logId=${target.activationId || '-'}` : `API=${redactSensitiveText(target.url)}`;
    const disabled = target.disabled ? `不可用：${redactSensitiveText(target.disabledReason || '-')}` : '可用';
    lines.push(`- ${index + 1}. ${target.phone}；来源=${source}；${disabled}；次数=${target.useCount}；最后收码=${formatTime(target.lastCodeAt)}；消息=${redactSensitiveText(target.lastMessage || '-')}`);
  });
  lines.push('');
  lines.push('## 最近错误');
  lines.push(latestError ? `${latestError.id}: ${redactSensitiveText(latestError.message)}` : '无');
  lines.push('');
  lines.push('## 最近日志');
  state.logs.slice(0, 160).reverse().forEach((entry) => {
    lines.push(`${formatTime(entry.time)} [${entry.level}] ${entry.stepId || '-'} ${redactSensitiveText(entry.message)}`);
  });

  return lines.join('\n');
}

async function getDiagnosticTargetTab(state: AutomationState): Promise<{ url?: string; status?: string } | null> {
  if (!state.run.targetTabId) {
    return null;
  }
  try {
    return await browser.tabs.get(state.run.targetTabId);
  } catch {
    return null;
  }
}

function redactSensitiveText(value: string): string {
  return String(value || '')
    .replace(/https?:\/\/[^\s"'<>，。；)]+/gi, (match) => redactUrl(match))
    .replace(/\b(access[_-]?token|id[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|authorization|bearer)\b([="'\s:]+)([^\s,;，。]+)/gi, '$1$2[REDACTED]')
    .replace(/\b(token|ba_token|setup_intent_client_secret)=([^&\s]+)/gi, '$1=[REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, '[REDACTED]');
}

function redactUrl(value: string): string {
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

function formatTime(value: number): string {
  if (!value) {
    return '未知时间';
  }
  return new Date(value).toLocaleString('zh-CN', {
    hour12: false,
  });
}

function normalizeRawLines(value: string): string {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join('\n');
}

function countRawLines(value: string): number {
  const normalized = normalizeRawLines(value);
  return normalized ? normalized.split('\n').length : 0;
}

function mergeLines(current: string, incoming: string): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const line of `${current}\n${incoming}`.split(/\r?\n/)) {
    const item = line.trim();
    if (!item || seen.has(item)) {
      continue;
    }
    seen.add(item);
    lines.push(item);
  }
  return lines.join('\n');
}

function removeRawLine(rawValue: string, rawInput: string): string {
  const target = rawInput.trim();
  return rawValue
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && line !== target)
    .join('\n');
}

function maskCredentialLine(rawInput: string): string {
  const parts = rawInput.split('----').map((item) => item.trim());
  if (parts.length < 2) {
    return '手动邮箱';
  }
  const labels = ['密码', 'Client', 'Token'];
  return parts.slice(1, 4).map((part, index) => `${labels[index]} ${maskSecret(part)}`).join(' / ');
}

function maskSecret(value: string): string {
  if (!value) {
    return '-';
  }
  if (value.length <= 10) {
    return `${value.slice(0, 2)}***${value.slice(-2)}`;
  }
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function emailStatusInfo(
  email: AutomationEmailAccount,
  generatedEmails: Set<string>,
  selectedEmailId: string,
  currentErrorMessage: string,
): { kind: string; label: string; detail: string } {
  if (isRestoredEmail(email)) {
    return { kind: 'idle', label: '已恢复可用', detail: emailStatusDetail(email, '已恢复可用') };
  }
  if (generatedEmails.has(email.email.toLowerCase())) {
    return { kind: 'success', label: '开通成功', detail: emailStatusDetail(email, '开通成功') };
  }
  if (email.status === 'error') {
    const detail = emailStatusDetail(email, email.lastMessage || '失败');
    return { kind: 'error', label: email.lastMessage ? `失败：${shortText(email.lastMessage, 22)}` : '失败', detail };
  }
  if (email.id === selectedEmailId && currentErrorMessage) {
    return {
      kind: 'error',
      label: `失败：${shortText(currentErrorMessage, 22)}`,
      detail: emailStatusDetail(email, currentErrorMessage),
    };
  }
  if (email.status === 'used') {
    return { kind: 'success', label: '流程完成', detail: emailStatusDetail(email, email.lastMessage || '流程完成') };
  }
  if (email.status === 'running') {
    return { kind: 'running', label: '执行中', detail: emailStatusDetail(email, email.lastMessage || '执行中') };
  }
  return { kind: 'idle', label: '未执行', detail: emailStatusDetail(email, email.lastMessage || '未执行') };
}

function emailStatusDetail(email: AutomationEmailAccount, statusText: string): string {
  const parts = [
    `邮箱：${email.email}`,
    `状态：${redactSensitiveText(statusText)}`,
    `使用次数：${email.useCount}`,
  ];
  if (email.lastUsedAt) {
    parts.push(`最后执行：${formatTime(email.lastUsedAt)}`);
  }
  if (email.lastMessage && email.lastMessage !== statusText) {
    parts.push(`消息：${redactSensitiveText(email.lastMessage)}`);
  }
  return parts.join('\n');
}

function isEmailRestorable(email: AutomationEmailAccount): boolean {
  if (isRestoredEmail(email)) {
    return false;
  }
  return email.status !== 'idle' || Boolean(email.lastUsedAt || email.useCount || email.lastMessage);
}

function restoreEmailAccount(email: AutomationEmailAccount): AutomationEmailAccount {
  return {
    ...email,
    status: 'idle',
    useCount: 0,
    lastUsedAt: 0,
    lastMessage: '已恢复可用',
  };
}

function isRestoredEmail(email: AutomationEmailAccount): boolean {
  return email.status === 'idle' && email.lastMessage === '已恢复可用';
}

function smsStatusInfo(target: AutomationSmsTarget, selectedSmsId: string): { kind: string; label: string } {
  if (target.disabled) {
    return { kind: 'error', label: target.disabledReason ? `不可用：${shortText(target.disabledReason, 18)}` : '号码不可用' };
  }
  if (target.id === selectedSmsId) {
    return { kind: 'running', label: '当前使用' };
  }
  if (target.lastCodeAt) {
    return { kind: 'success', label: '已收码' };
  }
  if (target.lastMessage) {
    return { kind: 'idle', label: shortText(target.lastMessage, 18) };
  }
  if (target.useCount > 0) {
    return { kind: 'idle', label: `已用 ${target.useCount} 次` };
  }
  return { kind: 'idle', label: '未使用' };
}

function smsTargetSourceDetail(target: AutomationSmsTarget): string {
  if (target.source === 'foxsms') {
    const logId = target.activationId ? ` · logId ${target.activationId}` : '';
    return `日本 jpn · PayPal ${target.projectId || '35'}${logId}`;
  }
  return shortUrlText(target.url);
}

function shortUrlText(value: string): string {
  try {
    const url = new URL(value);
    const path = `${url.pathname}${url.search}`.replace(/\/$/, '');
    return `${url.hostname}${path ? shortText(path, 42) : ''}`;
  } catch {
    return shortText(value, 56);
  }
}

function shortText(value: string, maxLength: number): string {
  const text = value.trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function escapeHtml(value: unknown): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value: unknown): string {
  return escapeHtml(value);
}
