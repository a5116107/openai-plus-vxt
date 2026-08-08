# 保存支付方式 SSOT

> 试用资格保持、多支付方式提链和终链入库以 [试用资格与多支付提链 SSOT](../trial-payment-probe/README.md) 为全局编排真相；本文件保留 SetupIntent、mandate 与复用凭据细节。

## 1. 目标

本 SSOT 定义“把支付凭据保存到当前 ChatGPT 账号对应的 Stripe Customer，并在后端复核”的唯一流程。它与 `docs/ssot/payment-runner/` 并列：

- `payment-runner` 处理已经存在的 `cs_` Checkout 支付确认和终链解析。
- `saved-payment-methods` 处理 SetupIntent、mandate、可复用凭据和已保存方式列表。
- 两条状态机共享账号身份、Stripe 公钥候选和观测基础设施，但不共享写操作状态。

首期交付以 Card 为正式路径；其他方式通过能力矩阵逐项准入，不因页面显示图标就标记“可保存”。

## 2. 非目标与硬边界

1. 不采集、记录或持久化完整卡号、CVC、完整 Stripe client secret、完整 publishable key。
2. 不把一次性 Checkout 成功等同于保存成功。
3. 不把 Apple Pay、Google Pay、Stripe Link 的钱包账户描述为商户自有凭据。
4. 不把 iDEAL 等银行跳转方式本身描述为 reusable；只有其后生成的 mandate/debit 对象可进入复核。
5. 不把 SetupIntent 流程插入现有 `screen -> ... -> finalize` Checkout Runner。
6. 写操作结果不明确时不重建 SetupIntent、不重复 confirm；只查询原 Intent 和服务端列表。

## 3. 三轴模型

任何能力判断必须同时声明以下三个轴：

### 3.1 Intent 轴

| Intent | 目的 | 典型对象 | 完成证据 |
| --- | --- | --- | --- |
| `setup` | 保存未来使用的凭据 | SetupIntent + PaymentMethod | Intent succeeded 且 PM 已附着 |
| `payment-checkout` | 当前交易 | Checkout Session / PaymentIntent | 当前支付结果，不自动证明复用 |
| `mandate` | 建立后续扣款授权 | Mandate + debit/PM | mandate 有效且服务端对象可复用 |

### 3.2 支付方式轴

Card、PayPal、钱包、Link、银行借记、银行跳转、UPI、PIX、BLIK、TWINT、MoMo、GoPay、Kakao Pay 各自拥有独立能力状态和证据要求。

### 3.3 渠道轴

| 渠道 | 含义 | 是否等于支付方式 |
| --- | --- | --- |
| `inline-elements` | 扩展页面内挂载 Stripe Element | 否 |
| `hosted-checkout` | Stripe/OpenAI 托管页 | 否 |
| `native-redirect` | 跳转银行、钱包或提供方 | 否 |
| `saved-method-picker` | 选择已附着到 Customer 的方式 | 否 |

Hosted Checkout 是交互渠道。只有 hosted setup mode 返回可复用对象并通过服务端复核时，才算保存路径。

## 4. 唯一状态机

状态机由一个 `session` 身份门和七个操作阶段组成；实现中的完整 trace 因此包含八个节点。

```text
session
-> createSetupIntent
-> resolveMerchantKey
-> mountElement
-> confirmSetup
-> retrieveIntent
-> listPaymentMethods
-> verifyAttachedAndDefault
```

| 阶段 | 输入 | 动作 | 通过证据 | 失败出口 |
| --- | --- | --- | --- | --- |
| session | 当前登录会话 | 读取 email、ChatGPT accountId、Cookie 快照 | accountId 非空且身份快照就绪 | `identity_required` |
| createSetupIntent | accountId + idempotency key | 经 ChatGPT 后端创建 SetupIntent | `seti_`、client secret、Customer 引用 | `setup_create_failed` |
| resolveMerchantKey | SetupIntent/Checkout + PK 候选 | 只读验证候选 PK 对目标对象的访问能力 | `OWNERSHIP_VERIFIED` | `key_rejected` / `key_inconclusive` |
| mountElement | client secret + verified PK | 页面世界加载 Stripe.js 并挂载 Element | Element ready 事件 | `element_mount_failed` |
| confirmSetup | 用户交互 + billing details | 只提交一次 `confirmSetup` | succeeded / requires_action / 明确拒绝 | unknown 进入 retrieve |
| retrieveIntent | 原 SetupIntent | 查询同一 Intent | 终态和 PaymentMethod id | `side_effect_inconclusive` |
| listPaymentMethods | accountId/Customer | 后端列出已保存方式 | PM 列表绑定目标账号 | `server_reconcile_failed` |
| verifyAttachedAndDefault | Intent + 列表 | 核对 attached、reusable、default | 三项证据一致 | `attachment_mismatch` |

## 5. 核心契约

### 5.1 账号绑定

- 本地 `ProbeAccount.id` 只是扩展内部主键。
- `ProbeAccount.chatgptAccountId` 保存 `/api/auth/session` 的真实账号 ID。
- 创建 SetupIntent、列表复核和默认方式更新必须使用同一 `chatgptAccountId`。
- email 仅用于展示和辅助匹配；账号 ID 存在时，以账号 ID 为身份主键。
- 切换 ChatGPT 登录账号后，旧 client secret、Element、Intent 和列表结果全部作废。

### 5.2 Stripe 公钥归属

PK 来源可以是配置、Hosted HTML 或 Resource Timing，但“提取到字符串”只算 candidate。准入步骤为：

1. 校验 `pk_live/pk_test` 与目标 `cs_live/cs_test` 模式一致。
2. 使用候选 PK 初始化明确的 Checkout，或 retrieve 明确的 SetupIntent。
3. Stripe 明确拒绝时标记 rejected；网络错误标记 inconclusive。
4. 只有成功返回目标对象形态时标记 verified。
5. 日志只保存形如 `pk_live...ABC123` 的指纹。

当前代码同时实现 Checkout init 与明确 SetupIntent retrieve 两种只读归属验证，并复用同一结果模型。

### 5.3 幂等

- `createSetupIntent` 的本地幂等键绑定 `chatgptAccountId + method + attemptId`；transport 对同一 account+attempt 单飞，orchestrator 持久化 method 维度。
- 一个 attempt 只允许一次 create 和一次 confirm。
- create/confirm 网络结果不明时，查询原 Intent；不生成第二个 Intent。
- 后端列表复核可重试，因为它是只读操作。
- 用户明确重新开始时生成新 attemptId，并卸载旧 Element。

### 5.4 页面桥

Stripe.js 和 Elements 运行在页面世界；扩展控制逻辑运行在隔离世界。桥接消息必须包含：

- `requestId`、`attemptId`、`chatgptAccountId` 的不可逆摘要。
- 固定允许的 command 枚举，不接受任意脚本字符串。
- 来源窗口、origin、消息版本和超时校验。
- 回包只含状态、Stripe 对象 ID 和脱敏错误，不含卡数据。

## 6. 支付方式与渠道能力矩阵

| 方式 | 默认 Intent | 可用渠道 | 复用策略 | 当前决策 |
| --- | --- | --- | --- | --- |
| Card | setup | Inline Elements、Hosted setup、Picker | reusable | 首期正式支持 |
| PayPal | setup/mandate | Elements、Redirect、Picker | conditional | 先探测商户/地区/mandate |
| Apple Pay | payment-checkout | Inline wallet | wallet-managed | 保存底层 tokenized card，不保存钱包账户 |
| Google Pay | payment-checkout | Inline wallet | wallet-managed | 同 Apple Pay |
| Link | setup/payment | Elements、Link picker | wallet-managed | 与商户 saved PM 列表分开 |
| 银行借记 | setup/mandate | Elements、Redirect、Picker | conditional | 独立 mandate adapter |
| iDEAL 等银行跳转 | payment/mandate | Redirect | conditional | 只认后续 mandate/debit |
| UPI | payment/mandate | Redirect | conditional | 仅 autopay/mandate 实证后准入 |
| PIX/BLIK/TWINT/MoMo/GoPay/Kakao Pay | payment-checkout | Redirect | one-time-only | 默认不进入保存状态机 |

运行时能力只能从 `unsupported -> probe-required -> supported` 单向升级，升级必须同时具备 provider 对象、服务端列表和后续复用语义证据。

## 7. 数据模型

生产模型至少包含：

```ts
interface SavedPaymentAttempt {
  id: string;
  chatgptAccountId: string;
  method: SavedPaymentMethodKind;
  intentKind: SavedPaymentIntentKind;
  channel: SavedPaymentChannel;
  state: string;
  setupIntentId?: string;
  paymentMethodId?: string;
  keyFingerprint?: string;
  confirmSubmitted: boolean;
  attachedVerified: boolean;
  defaultVerified: boolean;
  createdAt: number;
  updatedAt: number;
}
```

持久化层排除：client secret、完整 PK、Cookie 值、卡号、CVC、完整 provider payload。错误消息进入存储前必须脱敏。

## 8. Transport 与适配器边界

- `SavedPaymentTransport`：create、list，只负责 ChatGPT 后端请求和响应归一化。
- `SavedPaymentElementBridge` 内的 Stripe adapter：retrieve、mount、confirm；default 由 confirm 参数请求并由 list 复核。
- `SavedPaymentElementBridge`：retrieve、mount、confirm、unmount，只负责页面世界交互。
- `SavedPaymentMethodAdapter`：声明 method、intent、channel、mandate 和复核规则。
- `SavedPaymentOrchestrator`：执行状态机、幂等、切换账号失效和错误分类。
- 现有 `PaymentRunnerTransport` 保持 Checkout 专用。

## 9. 错误分类

| 分类 | 示例 | 后续 |
| --- | --- | --- |
| identity | accountId 缺失、账号切换 | 清空 attempt，重新读取 session |
| capability | 商户/地区不支持 | 保持 probe-required，不挂载 Element |
| credential | 后端会话过期 | 刷新 session 后重新开始 |
| key-ownership | PK 被拒绝或不明确 | rejected 停止；inconclusive 可只读重试 |
| provider-decline | 卡或 mandate 明确拒绝 | 显示脱敏错误，允许新 attempt |
| side-effect-unknown | confirm 网络断开 | retrieve 原 Intent，不重复 confirm |
| reconcile | Intent 成功但列表未附着 | 只读轮询后标记 mismatch |
| security | origin/消息版本/账号摘要不符 | 立即销毁桥和 attempt |

## 10. 迁移与兼容

1. `ProbeAccount.chatgptAccountId` 为向后兼容可选字段；旧记录加载为 `''`。
2. 旧账号在下一次 session 同步时补齐真实 accountId。
3. 现有 `stripePublishableKey` 配置继续作为候选，但必须经过归属验证后使用。
4. 现有 Checkout Runner 和命中看板字段保持不变；保存方式使用独立 attempt/metric 命名。
5. 功能开关默认只开放 Card + 测试环境；后续方式按能力证据逐项启用。

## 11. 代码归属

- `src/features/saved-payment-methods/types.ts`：三轴、能力、账号和 PK 验证类型。
- `src/features/saved-payment-methods/capabilities.ts`：方式/Intent/渠道矩阵。
- `src/features/saved-payment-methods/stripe-key-ownership.ts`：候选 PK 的只读 Checkout 归属验证。
- `src/features/saved-payment-methods/transport.ts`：账号绑定的 SetupIntent 创建与支付方式列表归一化。
- `src/features/saved-payment-methods/element-bridge.ts`：固定命令、消息门、账号摘要和隔离世界客户端。
- `src/features/saved-payment-methods/stripe-element-page.ts`：Stripe.js、Card Element、retrieve/confirm/unmount 页面控制器。
- `src/features/saved-payment-methods/orchestrator.ts`：身份门、七阶段编排、单飞和账号/attempt 失效。
- `src/features/saved-payment-methods/reconcile.ts`：Intent、服务端列表和 default 三方复核。
- `src/features/saved-payment-methods/policy.ts`：PayPal、银行、钱包、Link 和一次性方式的证据准入规则。
- `src/features/saved-payment-methods/state.ts`：按账号隔离的支付方式、attempt 和脱敏审计持久化/迁移/导出。
- `src/features/saved-payment-methods/content-driver.ts`：ChatGPT 页面 Card Element 模态、用户确认暂停和流程驱动。
- `entrypoints/saved-payment-elements.content.ts`：WXT MAIN-world 页面桥入口。
- `src/features/payment/panel.ts`：账号支付方式列表、Card 添加入口、渠道分组和状态展示。
- `src/features/probe/types.ts`、`state.ts`：真实 ChatGPT accountId 持久化。
- 测试账号 E2E、功能开关、打包与回滚已按 `TASKS.md` 的 `SPM-16` 收口。

## 12. 方案选择

- A：把 SetupIntent 插入现有 Checkout Runner。文件少，但状态和幂等语义混乱。
- B：独立保存方式内核，共享身份与观测基础设施。边界清楚，可逐方式演进。
- C：只跳转 Hosted setup。实现快，但依赖上游入口且难以统一能力与复核。

默认采用 B；Card 可在上游提供 hosted setup 时使用 C 作为渠道 fallback，A 不进入实施。

## 13. SPM-16 测试发布门

- 功能键为 `opx.savedPaymentMethods.feature`，默认 `enabled=false`；归一化后固定为 `environment=test`、`allowedMethods=['card']`。
- 支付面板只在用户显式启用且输入 `pk_test_*` 后开放 Card 保存；live key 和非 Card 方式不进入本批写路径。
- 真实浏览器 E2E 使用独立、已登录的 Chrome profile。卡号、有效期和 CVC 只注入 Stripe iframe，证据文件只保留 account digest、attempt/`pm_` 标识以及 attached/reusable/default 布尔值。
- `SPM_E2E_PROFILE_DIR` 指向独立 Chrome user-data 根目录（包含 `Local State` 和 `Default/`），不是正在使用的原 profile 子目录；从原 profile 复制时排除 Cache，且不终止或改写原浏览器进程。
- `SPM_E2E_SKIP_AUTH_PROXY=true` 仅用于只读 profile probe，跳过扩展中已保存的 Auth 代理并直连检查 session；完整 closure 仍按自身三网络面策略验证出口。
- 测试后端采用二选一配置：默认使用 `SPM_E2E_STRIPE_SECRET_KEY=sk_test_*` 自动启动仓库内嵌后端；已有服务时使用 `SPM_E2E_BACKEND_BASE_URL`（HTTPS，或本机 loopback HTTP）。`SPM_E2E_PUBLISHABLE_KEY` 必须与 `sk_test`/外部后端属于同一 Stripe 测试商户。
- 内嵌后端只绑定随机的 `127.0.0.1` 端口，并为每次运行生成仅在进程内传递的临时 bearer；它以 account digest 在内存映射 Stripe Customer，创建 test-mode SetupIntent，列出 attached Card，并在首次列表复核时设置 default。进程退出即清空映射，不输出或持久化 accountId、密钥、client secret、临时 bearer 与卡数据。
- 外部后端模式下，Playwright 仅代理 `/backend-api/payments/payment_method(s)`，不会把 ChatGPT Cookie 或 Authorization 转发给该后端；如后端需要鉴权，单独使用可选的 `SPM_E2E_BACKEND_TOKEN`。
- `pnpm test:e2e-saved-payment:profile` 只读取 `/api/auth/session` 和服务端支付方式列表，输出 account digest、HTTP 状态、数量与 default 布尔值，不创建 SetupIntent。
- `pnpm test:e2e-saved-payment:check` 只做环境预检并写入 `.context-snapshots/saved-payment-live-e2e/preflight.latest.json`；真实运行使用 `pnpm test:e2e-saved-payment`。
- `scripts/e2e-saved-payment-live.mjs` 只负责 `check/profile/live` 模式分发；环境解析、浏览器驱动、Profile 探测和证据写入归属 `tests/support/saved-payment-live-e2e-runner.mjs`，Stripe 测试后端归属相邻 support 模块。
- 原始 console 样本只包含 `pk_live` 候选；test-only rollout 不复用这些值。真实测试门使用同一测试商户的 `pk_test` + `sk_test`，或同商户 `pk_test` + 外部测试后端。
- 交付脚本 `pnpm package:saved-payment` 生成 Chrome ZIP、Firefox XPI、SHA-256/manifest/脱敏审计 JSON 和回滚 Markdown；脱敏扫描同时覆盖薄入口、E2E runner 和 Stripe 测试后端，功能开关关闭是第一回滚动作。
- 当前静态、回归、UI、打包、真实账号注册与独立 Profile 会话均已通过；测试商户 SetupIntent、attached/reusable Card 与服务端列表/default 一致性已由 `.context-snapshots/saved-payment-live-e2e/latest.json` 证明。
