# 保存支付方式复核表

## 1. 结构门

- [x] SSOT 与 `payment-runner` 并列，SetupIntent 未并入 Checkout Runner。
- [x] Intent、支付方式、渠道三个轴拥有独立类型。
- [x] 能力矩阵包含 Card、PayPal、Apple Pay、Google Pay、Link、银行借记/跳转、UPI、PIX、BLIK、TWINT、MoMo、GoPay、Kakao Pay。
- [x] 账号模型区分本地 probe id 与真实 ChatGPT accountId。
- [x] transport、Element bridge、orchestrator、reconcile 各自拥有独立 owner。

## 2. 行为门

- [x] Card setup + inline-elements 被矩阵准入。
- [x] 钱包被标记 wallet-managed，不进入通用 setup 路径。
- [x] PIX 等默认 one-time-only，不进入保存路径。
- [x] PK/Checkout live-test 模式不一致时，网络调用次数为 0。
- [x] Stripe 拒绝和网络不明确结果被分开分类。
- [x] 成功 init 只证明 PK 对目标 Checkout 可用，不证明 SetupIntent 或服务端附着。
- [x] SetupIntent retrieve 只在返回同一个 `seti_` 时证明 PK 归属。
- [x] ChatGPT transport 对 401 做终止分类，对 create 5xx 标记未知副作用。
- [x] createSetupIntent 使用 account + method + attempt 幂等键。
- [x] confirmSetup 每 attempt 最多提交一次。
- [x] confirm 结果不明确时 retrieve 原 Intent，不创建新 Intent。
- [x] Intent succeeded 后仍需 listPaymentMethods 复核 attached/default。
- [x] ChatGPT 账号或 attempt 切换会销毁旧 Element 并使旧 attempt 失效。

## 3. 安全与数据门

- [x] PK 验证结果只保存指纹，不返回完整 key。
- [x] PK 归属请求使用 `credentials: omit`，不向 Stripe 发送 ChatGPT Cookie。
- [x] 页面桥校验 origin、source window、version、requestId、attemptId、账号摘要。
- [x] 卡号/CVC 始终由 Stripe Element 托管。
- [x] client secret、Cookie value、完整 provider payload 不进入 state/log/export。
- [x] 错误消息经过 secret/token/卡号模式脱敏。

## 4. 兼容门

- [x] 旧 ProbeAccount 缺少 `chatgptAccountId` 时可加载为空值。
- [x] 结构化账号 JSON 可导入 `chatgpt_account_id`/`account_id`。
- [x] 当前 session/自动化同步会透传 `session.accountId`。
- [x] 现有 payment-runner 聚焦测试持续通过。
- [x] Hosted resolution 和 session credential 测试持续通过。
- [x] TypeScript compile、Chrome MV3 与 Firefox MV2 production build 均通过。

## 5. 支付方式准入门

| 方式组 | 升级到 supported 所需证据 | 当前状态 |
| --- | --- | --- |
| Card | SetupIntent succeeded + attached PM + server list | PASS：SPM-16 联机 E2E 已证明 succeeded、attached/reusable/default 与服务端列表一致 |
| PayPal | 商户/地区开放 + mandate/reusable PM + server list | probe-required |
| Apple Pay/Google Pay | wallet 可用 + tokenized card 语义正确 | wallet-managed |
| Link | Link 可用且与 merchant list 分开展示 | probe-required |
| 银行借记 | mandate accepted + reusable debit PM + server list | probe-required |
| 银行跳转/UPI | redirect 后产生 mandate/debit/autopay 对象 | probe-required |
| PIX/BLIK/TWINT/MoMo/GoPay/Kakao Pay | provider 明确返回可复用对象且服务端可列出 | one-time-only |

准入与展示实现证据：

- [x] PayPal、银行借记、银行跳转和 UPI 缺少 merchant/region/mandate/reusable/server 任一证据时保持 probe-required。
- [x] Apple Pay、Google Pay 和 Link 进入钱包分组，不标记为商户保存凭据。
- [x] PIX、BLIK、TWINT、MoMo、GoPay、Kakao Pay 进入单次分组且不启动通用 setup。
- [x] Card 只有在 SetupIntent、可复用对象和服务端列表三项齐备后才允许持久化结论。

## 6. 测试矩阵

| 层 | 场景 | 命令/证据 |
| --- | --- | --- |
| unit | 能力矩阵、live/test mismatch、PK verified/rejected | `pnpm test:saved-payment-methods` |
| unit | accountId 结构化导入、Cookie 身份快照 | `pnpm tsx --test tests/session-credential.test.ts` |
| regression | Hosted 提取行为 | `pnpm test:hosted-resolution` |
| regression | Checkout Runner 不受影响 | `pnpm test:payment-runner` |
| static | TypeScript | `pnpm compile` |
| integration | SetupIntent create/retrieve/list/default | SPM-05 mock suite |
| unit/runtime | Element bridge 消息门、单次 confirm、账号/attempt 切换 | SPM mock controller/orchestrator suite |
| browser | 支付面板、窄屏布局、控件边界 | SPM-13 Playwright evidence |
| E2E | 测试账号真实保存并服务端列表复核 | SPM-16 evidence bundle |

## 7. 当前批次证据

- [x] `pnpm test:saved-payment-methods`：26/26，包含默认关闭、test/Card-only 功能开关归一化和 Stripe.js 失败清理/重试测试。
- [x] `pnpm tsx --test tests/session-credential.test.ts`：4/4。
- [x] `pnpm test:hosted-resolution`：5/5。
- [x] `pnpm test:probe-readiness`：16/16。
- [x] `pnpm test:payment-runner`：15/15。
- [x] `pnpm test:checkout-pipeline`：5/5。
- [x] `pnpm compile`：TypeScript 0 errors。
- [x] 七组聚焦、后端与回归测试合计 72/72。
- [x] `pnpm build`：Chrome MV3 production build 完成，总大小约 1.45 MB；manifest 含 `saved-payment-elements.js`、`world: MAIN`、`document_start`。
- [x] `pnpm build:firefox`：Firefox MV2 production build 完成，总大小约 1.45 MB；SPM-16 已完成 Chrome 真实 Stripe Element 交互，Firefox 由同源实现、构建和回归覆盖。
- [x] `node scripts/e2e-saved-payment-ui.mjs`：420px/360px 两个视口各识别 7 个控件，均无横向溢出、控件越界、顶栏标签裁切或控制台错误；`clippedTabs` 均为空数组。
- [x] UI 截图：`image/saved-payment-panel-desktop.png`、`image/saved-payment-panel-narrow.png`。
- [x] `pnpm package:saved-payment`：生成 `dist/openai-plus-vxt-0.0.37-chrome.zip` 与 `dist/openai-plus-vxt-0.0.37-firefox.xpi`，manifest/MAIN-world bridge/版本检查全部通过。
- [x] `dist/saved-payment-release-0.0.37.json`：生产源码、浏览器 E2E/内嵌测试后端脚本及 Chrome/Firefox 构建目录的 secret key、完整 PK、SetupIntent secret、Luhn 卡号形态扫描 findings 为空，并记录双包 SHA-256。
- [x] `dist/saved-payment-rollback-0.0.37.md`：第一动作关闭 `opx.savedPaymentMethods.feature.enabled`，并回链上一 Firefox 产物。
- [x] 生产代码 secret-shaped 扫描未发现具体 PK、client secret 或卡号 fixture；桥回包测试证明不含请求中的 PK/client secret。
- [x] `quality-guard review-entry` 已在当前闭环请求指纹 `06ea161d70766098` 下运行：`spec.verdict`、`quality.verdict`、`verify.evidence` 均为 PASS，任务复核 5/5、0 blocking；专项 E2E 薄入口与 runner 均无 structural-quality finding。
- [x] fork 发布已完成：`a5116107/openai-plus-vxt` 的 `main` 和集成分支已同步 0.0.37 集成结果，预发布 `v0.0.37-ssot.1` 已上传双端产物、哈希清单和回滚说明。
- [ ] 上游交付仍受权限门阻断：向 `suyancc/openai-plus-vxt` 推送返回 403，当前令牌也无权创建上游 PR。
- [ ] 最新严格质量总门仍受迁移规模和结构预算阻断；功能测试、双端构建、浏览器夹具与敏感信息扫描均通过，但 change/shape budget 和既有超大文件未被标记为 PASS。

命令实际通过后再勾选并记录测试数量；文件存在不计为 PASS。

## 8. SPM-16 联机门

- [x] `pnpm test:e2e-saved-payment:check` 已确认扩展构建、Playwright 和浏览器存在，并写入 `.context-snapshots/saved-payment-live-e2e/preflight.latest.json`。
- [x] `pnpm test:e2e-saved-payment:profile` 已实现只读 session/服务端列表探测；证据不返回 accountId、access token、Cookie 或支付方式 ID。
- [x] 本机 `Profile 4/5` 独立副本探测：headless 返回 HTTP 403，headed 通过浏览器挑战后 session HTTP 200 但账号/access token 为空；未触发 SetupIntent 写操作。
- [x] 原始 console 样本 key 模式审计：2 个唯一候选均为 `pk_live`，`pk_test` 为 0；证据只记录指纹，不记录完整 key。
- [x] E2E 支持 `SPM_E2E_BACKEND_BASE_URL` 测试商户代理，仅转发两个支付 API 的方法、查询与 JSON body；ChatGPT Cookie/Authorization 不转发，可选鉴权使用独立 `SPM_E2E_BACKEND_TOKEN`。
- [x] 内嵌测试后端支持 `sk_test` 创建 Customer/SetupIntent、列出 attached Card 并设置 default；`pnpm test:saved-payment-backend` 完成 3/3，覆盖预检证据不含支付输入、直连 profile probe 模式、mock Stripe 闭环、metadata 不发送原始 accountId，以及缺失进程内临时 bearer 返回 401。
- [x] Preflight 支持外部 `SPM_E2E_BACKEND_BASE_URL` 或内嵌 `SPM_E2E_STRIPE_SECRET_KEY` 二选一，只记录后端模式/accepted 布尔值和缺失变量名。
- [x] 浏览器 E2E 入口已缩减为 32 行模式分发，运行职责迁入 `tests/support/saved-payment-live-e2e-runner.mjs`；发布脱敏扫描覆盖两个 E2E support 模块。
- [x] 用户 mailbox URL 的真实注册链已完成，成功证据位于 `.context-snapshots/e2e-user-mailbox-retry/chrome-e2e-result.json`；邮箱、URL token、OTP、Cookie 和 access token 均未进入证据。
- [x] 当前独立 profile `.context-snapshots/profiles/saved-payment-live` 直连 headed 探测返回 session HTTP 200、账号/access token 存在、服务端列表 HTTP 200、支付方式数量 0、default=false；证据为 `.context-snapshots/saved-payment-live-e2e/profile-probe.latest.json`。
- [x] 2026-08-05 profile probe 新增 `SPM_E2E_SKIP_AUTH_PROXY=true` 直连模式，默认代理路径保持不变；3/3 后端/入口测试通过。
- [x] 2026-08-05 Profile 10 复核已判定不适合作为 E2E 根目录：它是正在使用的 Chrome 子 profile，不是独立 `Local State + Default/` user-data 副本；后续已由上述独立 profile 替代。
- [x] 同一 Stripe 测试商户的 publishable/secret key 已通过进程级临时输入完成联机运行；完整 key、client secret、Cookie 与卡数据均未写入仓库证据。
- [x] `pnpm test:e2e-saved-payment`：PASS；immutable 证据 `.context-snapshots/saved-payment-live-e2e/pcc-live-7b2c128f-cab4-4121-8146-85eff4931b85.json` 的 `ok=true`、`code=SAVED_PAYMENT_VERIFIED`，SetupIntent 为 `succeeded`，`attachedVerified/reusableVerified/defaultVerified=true`。
- [x] 同次运行重新读取服务端列表返回 HTTP 200，`containsExpected/defaultMatches=true`；Stripe confirm POST 返回 HTTP 200 且仅提交一次，confirm 后 retrieve 复用同一 host iframe Stripe 实例。
- [x] 运行证据只保存对象 ID、状态、字段名和脱敏 endpoint；`publishableKeyPersisted=false`、`rawCardDataPersisted=false`、ChatGPT credential 未转发到测试支付后端。
- [x] live runner 在创建 SetupIntent 前预检 Stripe.js top/isolated 两个上下文；页面加载器失败时移除失效 script 并最多重试三次。本轮 evidence 的两个预检均为 `loaded`，`requestFailures=[]`。

## 9. 最终验收信号

1. 测试环境中，当前 ChatGPT accountId 创建的 SetupIntent 成功。
2. Card Element 完成后，retrieve 返回 succeeded 和 `pm_`。
3. 服务端列表在同一 account/customer 下返回该 `pm_`，并单独证明 default 状态。
4. 切换账号后旧 attempt 失效，旧 `pm_` 不出现在新账号列表。
5. 导出的日志、state 和 XPI 检查中不存在 client secret、完整 PK、Cookie 值或卡数据。
