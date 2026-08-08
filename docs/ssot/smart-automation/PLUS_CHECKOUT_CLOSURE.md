# Plus 双 Checkout 保存卡复用闭环

状态：实现与复核完成；SPM-16 test-mode live E2E 和 controlled production-like 全闭环统一证据均已通过

实施基线（2026-08-05）：`PCC-02..PCC-17` 的代码、单元/集成测试、真实扩展浏览器交互、Chrome/Firefox 构建、打包、回滚和脱敏扫描均已落地。`SPM-16` 已形成真实 test SetupIntent succeeded、attached/reusable/default 与服务端列表一致证据，`PCC-06` 随之完成。`PCC-17` 由单一 controlled production-like runner 在同一个脱敏 `closureRunId` 内串联真实 Stripe test merchant、扩展页面交互、closure FSM 与三网络面证据；live closure 仍按发布策略默认关闭。

本文是 `smart-automation` 总流程下的集成契约。领域行为仍分别由以下 SSOT 管理：

- Checkout 创建、优惠、金额和 `oaics_` 解析：`../checkout-extraction-v2/`
- SetupIntent、保存卡、attached/default 复核：`../saved-payment-methods/`
- 原生重定向支付方式 Runner：`../payment-runner/`
- Auth/Checkout/Billing 出口及处理有效性：`../eligibility-factors/`

本文件只定义这些领域如何组成同一次 Plus 订阅闭环。任务状态唯一记录在同目录 `TASKS.md`，验收状态唯一记录在 `VERIFY.md`。

## 1. 目标

交付以下可恢复、可观测、默认关闭的完整流程：

```text
读取同一 ChatGPT 账号 session
-> 创建 Checkout A 并验证 PH/PHP/零金额资格
-> 创建 SetupIntent 并保存 Card
-> retrieve + 服务端列表复核 attached/reusable/default
-> 创建独立 Checkout B
-> 验证 B 与 A 的 sessionId 不同且资格保持
-> 打开 B 并明确选择 Saved Card
-> 填写美国 billing address
-> 提交零金额订阅
-> 跟踪 /checkout/verify 的 SetupIntent
-> 读取服务端账号状态并确认 Plus
```

完成标准不是“各组件分别通过”，而是同一个脱敏 `closureRunId` 下同时存在身份、两个 Checkout、保存卡、选择卡、账单、提交、验证、Plus 和出口证据。

## 2. 当前缺口基线

| ID | 当前事实 | 影响 | 代码锚点 |
| --- | --- | --- | --- |
| G-01 | 保存卡默认关闭，归一化后固定 test/Card-only，面板只接收 `pk_test_*` | live 商户绑定链不进入 | `saved-payment-methods/state.ts`、`payment/panel.ts` |
| G-02 | 普通自动化只有一次 create/open/submit Checkout | 保存卡后没有 Checkout B | `automation/runner-checkout.ts`、`automation/steps.ts` |
| G-03 | 自动化 URL 门只识别 `cs_`/`cs_live_` | 视频中的 `oaics_` 在等待、填址和提交前被挡住 | `automation/runner-url.ts`、`address-autofill/pay-openai-autofill.ts`、`entrypoints/content.ts` |
| G-04 | 地址准备逻辑主动寻找 PayPal，没有 Saved Card 选择和选中确认 | 第二页可能提交错误方式或卡在错误状态 | `address-autofill/pay-openai-autofill.ts` |
| G-05 | 普通提链 UI/自动化只走 direct/server 单步接口 | 已有 staged pipeline 没进入普通闭环 | `link-extractor/panel.ts`、`background.ts` |
| G-06 | probe 的独立 Checkout 只服务原生方式候选；Card 被刻意排除 | 不直接复用为 Saved Card 闭环 | `payment/detect-methods.ts`、`probe/service.ts` |
| G-07 | server 提链模式没有与浏览器阶段统一的实际出口证据契约 | PH 参数不足以证明 PH 网络出口 | `link-extractor/checkout.ts`、`proxy/service.ts` |
| G-08 | SPM-16 已完成真实 test SetupIntent 与服务端列表复核 | 保存卡基础内核已解除；需并入 PCC-17 同次运行证据 | `saved-payment-methods/VERIFY.md` |
| G-09 | 成功判定分散在 URL、页面与 session | `Processing Payment` 可能被误当最终成功 | `automation/runner-url.ts`、`runner-payment-sms.ts` |
| G-10 | 大入口文件已有复杂度告警 | 直接继续堆逻辑会扩大回归面 | `automation/runner.ts`、`entrypoints/background.ts` |

## 3. 方案选择

### A. 集成状态机，复用领域模块，推荐

新建小型 closure orchestrator，现有模块继续拥有 URL、Checkout、保存卡、地址和代理能力。主 runner 只做薄接线。

- 优点：幂等、恢复、证据、测试边界清楚；不污染 Payment Runner。
- 成本：需要新增状态模型和 4 个自动化步骤，并补浏览器夹具。
- 风险：跨模块契约较多，必须先固定共享类型和失败码。

### B. 在 `runner.ts` 顺序插入若干调用

- 优点：初始文件数少。
- 成本：状态散落，账号切换、重试和未知副作用难以收敛。
- 风险：继续扩大已有超大入口，不采用。

### C. 把完整流程移到独立服务

- 优点：提链网络面天然隔离。
- 成本：浏览器 session、Stripe iframe、Saved Card UI 仍需扩展配合，形成双编排器。
- 风险：真相和恢复状态分裂，不作为当前路线。

决策：采用 A。server 只拥有 Checkout 网络请求与出口证明，不拥有浏览器支付状态机。

## 4. 状态机

```text
idle
-> session_ready
-> checkout_a_creating
-> checkout_a_qualified
-> card_setup_running
-> card_reconciled
-> checkout_b_creating
-> checkout_b_qualified
-> saved_card_selected
-> billing_ready
-> subscription_submitting
-> subscription_submitted
-> setup_verifying
-> subscription_verified
```

终态：

- `subscription_verified`：服务端账号状态明确为 Plus。
- `failed_terminal`：身份错位、资格丢失、Saved Card 不存在、明确 provider decline。
- `side_effect_unknown`：create/confirm/submit 后网络断开；只查询原对象，不重放写操作。
- `paused_user_action`：需要卡输入、3DS 或明确用户确认。
- `cancelled`：用户停止；保留脱敏证据，不自动删除已附着支付方式。

## 5. 不变量和提交门

任何一项失败都停止 `submit`：

1. Checkout A、SetupIntent、Checkout B 必须绑定同一 `accountDigest`。
2. A 与 B 必须都有可提取的 sessionId，且 `A.sessionId !== B.sessionId`。
3. A 和 B 必须满足相同计划、目标地区和优惠策略；B 必须再次通过严格零金额门。
4. Card 必须先有 `Intent=succeeded`、`attached=true`、`reusable=true`，默认状态单独记录。
5. 第二页必须明确选中 Saved Card，且页面后四位与服务端列表预期一致。
6. billing address 必须完整并通过页面回读；地址国家与 Checkout 资格国家分开记录。
7. 一个 SetupIntent attempt 只 create 一次、confirm 一次；结果不明只 retrieve/list。
8. Checkout create 重试若产生新 session，旧 session 标记 abandoned，禁止再次提交。
9. 浏览器代理是进程级状态，closure 有效并发固定为 1。
10. 只有 `/checkout/verify` 成功或页面离开不算 Plus；最终必须重新读取 session/account plan 状态。

## 6. Checkout 统一引用契约

新增共享解析器，由 `link-extractor` 领域拥有，其他模块只消费结构化结果：

```ts
type CheckoutSessionKind = 'openai' | 'stripe';

interface CheckoutReference {
  kind: CheckoutSessionKind;
  sessionId: string;       // oaics_* 或 cs_*
  processorEntity: string;
  canonicalUrl: string;
  page: 'checkout' | 'verify' | 'success';
}
```

必须覆盖：

- `https://chatgpt.com/checkout/openai_llc/oaics_*`
- `https://chatgpt.com/checkout/openai_llc/cs_*`
- `https://pay.openai.com/c/pay/cs_*`
- `https://chatgpt.com/checkout/verify?...stripe_session_id=oaics_*`
- `https://chatgpt.com/payments/success`

迁移后删除各模块的 `pathname.startsWith('/.../cs_')` 私有判断，避免再次漂移。

## 7. Checkout 创建契约

统一请求模型：

```ts
interface CheckoutCreationPolicy {
  transport: 'browser-direct' | 'server';
  pipeline: 'direct' | 'staged';
  requireZero: boolean;
  bootstrapCountry: string;
  promotionCountry: string;
  providerCountry: string;
  requireVerifiedNetwork: boolean;
}
```

要求：

- 普通面板和自动化都调用同一个 background command，不再各自决定 direct/server。
- staged 直接复用 `runStagedCheckoutPipeline`，不得复制 create/update/taxes。
- Checkout B 必须显式传入 `previousSessionId` 并要求 distinct。
- server 响应除 Checkout 数据外，返回 `requestId`、实际 IP、country、colo、ASN、verified、capturedAt；客户端把参数国家与实际国家分开。
- server 没有出口证据时允许生成诊断链接，但 closure 的 `requireVerifiedNetwork=true` 门失败。

## 8. 保存卡 live 策略

SPM-16 test E2E 先完成，再开放 live 集成。live 路径保持 `enabled=false` 默认值，并增加单独的 `liveClosureEnabled` 实验开关。

公钥解析按以下优先级产生 candidate：

1. 当前 Checkout/Stripe resource timing。
2. 当前页面配置与同源已加载 chunk。
3. Checkout 创建响应中经过脱敏传递的 candidate。
4. 仅用于诊断的用户输入 override。

约束：

- 不内置具体 live key。
- candidate 必须通过目标 SetupIntent retrieve 归属验证。
- state/log 只保存 key fingerprint，不保存完整 PK 或 client secret。
- test 与 live 尝试、证据和开关分开；升级旧设置时 live 默认关闭。
- Card 数据只进入 Stripe Element；closure 只接收状态、对象 ID 摘要和后四位。

## 9. Saved Card 选择契约

Saved Card 是独立于 PayPal 的支付准备模式：

```ts
type CheckoutPaymentPreference =
  | { kind: 'saved-card'; expectedLast4: string }
  | { kind: 'new-card' }
  | { kind: 'paypal' };
```

`saved-card` 模式必须：

1. 查找 `Saved` tab/radio/accordion 或 Stripe Payment Element 内等价项。
2. 展开并枚举掩码卡片。
3. 选择目标后四位。
4. 读取 checked/selected/aria 状态二次确认。
5. 没有目标卡时返回 `SAVED_CARD_NOT_FOUND`，不回退 PayPal 或新卡。

Stripe iframe 内交互继续走固定命令 MAIN-world bridge，不接受任意 selector/script 字符串。

## 10. 地址、提交和成功判定

把当前“准备支付方式 + 填地址 + 提交”拆成三个明确阶段：

- `selectSavedPaymentMethod`：只选择并验证卡。
- `fillAndVerifyBillingAddress`：只填写并回读 billing。
- `submitQualifiedCheckout`：重新读取零金额、选中卡和地址状态后单次点击。

提交后：

1. 捕获 payment error、requires_action、verify URL 或 success URL。
2. verify URL 中的 SetupIntent 只读 retrieve，不重放 Checkout submit。
3. 页面返回 ChatGPT 后重新读取 `/api/auth/session` 或账号 entitlement。
4. `planType/entitlement=Plus` 才写 `subscription_verified`。

## 11. 网络面和代理证据

closure 使用两个逻辑网络面：

- 浏览器网络面：Auth、打开 Checkout、Saved Card、billing、submit、verify。
- server 提链网络面：可选，用于 Checkout create/update/taxes。

浏览器证据继续由 `proxy/service.ts` 的 Cloudflare trace 产生。server 证据由 server 在同一请求执行上下文中产生，客户端不得按地区参数推断。

最小证据：

```ts
interface NetworkEvidence {
  plane: 'browser-auth' | 'browser-billing' | 'server-checkout';
  requestId: string;
  ip: string;
  country: string;
  colo: string;
  asn: string;
  verified: boolean;
  capturedAt: number;
}
```

`PH` 参数与 `country=PH, verified=true` 是两个字段。只有后者进入“实际菲律宾出口”结论。

## 12. 持久化和脱敏证据

```ts
interface PlusCheckoutClosureRun {
  id: string;
  accountDigest: string;
  phase: string;
  checkoutA?: CheckoutEvidence;
  savedMethod?: SavedMethodEvidence;
  checkoutB?: CheckoutEvidence;
  billingCountry?: string;
  submitted: boolean;
  subscriptionVerified: boolean;
  networkEvidence: NetworkEvidence[];
  createdAt: number;
  updatedAt: number;
}
```

禁止持久化：accessToken、Cookie、完整 accountId、client secret、完整 PK、卡号、CVC、完整 Stripe/OpenAI 原始响应、server 鉴权 token。

允许持久化：对象类型与摘要、sessionId 摘要或受控 ID、卡品牌/后四位、布尔门结果、金额/币种/国家、实际出口证据、脱敏错误码。

## 13. 错误和恢复

| 错误码 | 含义 | 恢复动作 |
| --- | --- | --- |
| `IDENTITY_CHANGED` | account digest 改变 | 销毁旧桥和 attempt，从 session 开始 |
| `CHECKOUT_A_NOT_ZERO` | 资格门失败 | 停止，不绑卡、不提交 |
| `SETUP_SIDE_EFFECT_UNKNOWN` | confirm 结果不明 | retrieve/list 原 Intent |
| `CARD_RECONCILE_FAILED` | attached/reusable/default 不一致 | 只读轮询后终止 |
| `CHECKOUT_NOT_DISTINCT` | B 复用了 A | 丢弃 B，按有限预算新建一次 |
| `QUALIFICATION_DRIFT` | B 资格/币种/地区漂移 | 停止提交，保留对比证据 |
| `SAVED_CARD_NOT_FOUND` | 页面未枚举目标卡 | 刷新一次服务端列表和页面，仍无则终止 |
| `BILLING_VERIFY_FAILED` | 地址回读不完整 | 不提交，允许用户修正 |
| `SUBMIT_SIDE_EFFECT_UNKNOWN` | 点击后网络/页面不明 | 只跟踪 verify/session，不重复点击 |
| `SUBSCRIPTION_NOT_VERIFIED` | 页面结束但账号非 Plus | 标记失败，保留服务端状态 |
| `NETWORK_EVIDENCE_MISSING` | 真实出口未验证 | 严格模式终止，诊断模式降级 |

恢复点只允许位于已持久化且无未决写副作用的阶段。所有 submit 在点击前先持久化 `subscription_submitting` 和 `submitCount=1`；浏览器重启后，该阶段只查询原 verify/session，禁止再次点击。`checkout_a_creating`、`checkout_b_creating`、`card_setup_running` 的中断实例分别转为 Checkout/Setup 未知副作用态，不重放原写操作。`paused_user_action` 允许用户处理后重新进入保存卡复核，但复用已存在的 Checkout A。

持久化恢复边界只接受非负安全整数：`submitCount` 归一化为 0/1，`amountMinor`、`createdAt`、`updatedAt` 和网络证据时间戳拒绝 `NaN`、`Infinity`、负数与小数。错误消息在进入 checkpoint 前统一清理 Cookie、Authorization/Bearer、裸 JWT、Stripe key/secret，并对 12..19 位候选数字执行 Luhn 校验后脱敏完整 PAN。

## 14. 文件所有权计划

| 责任 | 主要文件 | 规则 |
| --- | --- | --- |
| Checkout 引用 | 新增 `link-extractor/checkout-reference.ts` | 唯一 URL/session parser |
| Checkout 创建 | `link-extractor/checkout.ts`、`service.ts`、`types.ts` | 复用 direct/staged/server |
| closure FSM | 新增 `automation/plus-checkout-closure.ts` | 状态、门、恢复、证据 |
| runner 薄接线 | `automation/types.ts`、`steps.ts`、`runner-checkout.ts`、`runner.ts` | 不把 FSM 写回大入口 |
| 保存卡 live policy | `saved-payment-methods/state.ts`、`content-driver.ts`、`stripe-key-ownership.ts` | 默认关闭、归属验证、脱敏 |
| Saved Card/地址 | `address-autofill/pay-openai-autofill.ts`、`service.ts` | 模式化准备，不隐式回退 |
| 页面桥 | `saved-payment-elements.content.ts`、`entrypoints/content.ts` | 固定命令、固定 payload |
| 网络证据 | `proxy/types.ts`、`state.ts`、`service.ts`、server transport | 参数值与实际 trace 分离 |
| UI | `payment/panel.ts`、`automation/panel.ts` | 开关、阶段、错误、证据摘要 |
| 测试 | `tests/checkout-reference.test.ts`、`tests/plus-checkout-closure.test.ts`、Playwright support | 单元、集成、浏览器、live |

`payment/detect-methods.ts` 的 Card 排除保持不变。它属于重定向方式 Runner 的边界；Saved Card 由 closure 通过保存卡列表和 picker 处理。

## 15. 实施阶段

### P0 契约与回归锁

- 固定状态机、数据模型、错误码、功能开关和迁移。
- 为当前 `cs_`/`oaics_`、PayPal 偏好、一次 Checkout 行为增加 characterization tests。
- 完成 SPM-16 test-mode live E2E，先证明保存卡基础内核。

### P1 最小纵向闭环

- 统一 Checkout parser。
- 接通 direct/staged/server 创建策略。
- 实现 test-mode `A -> save card -> B distinct -> Saved Card -> submit -> Plus fixture`。

### P2 网络与 live rollout

- server Checkout 实际出口证据。
- live key candidate 自动发现和 SetupIntent ownership。
- 默认关闭的 production-like 浏览器流程与人工确认点。

### P3 硬化与交付

- 未知副作用恢复、账号切换、资格漂移、错误分流。
- Chrome/Firefox、窄屏 UI、脱敏、打包、回滚。
- 最终 live 证据包和 SSOT 状态更新。

## 16. 发布与回滚

功能开关分层：

1. `savedPaymentMethods.enabled`：保存卡总开关。
2. `plusCheckoutClosure.enabled`：双 Checkout 编排总开关。
3. `plusCheckoutClosure.liveEnabled`：live 商户路径，默认 false。
4. `plusCheckoutClosure.requireVerifiedNetwork`：生产默认 true。

回滚顺序：先关闭 closure，保留只读诊断；再关闭 live；最后关闭保存卡。回滚不自动删除已经附着到 Customer 的卡，也不重复提交 Checkout。

## 17. 最终验收

一次运行必须同时证明：

1. session/account digest 稳定。
2. Checkout A 为预期计划、PH/PHP、零金额，并有实际 Checkout 网络证据。
3. SetupIntent succeeded，目标 `pm_` attached/reusable，default 单独复核。
4. Checkout B 的 sessionId 与 A 不同，且资格未漂移。
5. 第二页明确选择预期 Saved Card，后四位一致。
6. 美国 billing address 回读完整。
7. submit 只发生一次，verify 指向本次对象。
8. 最终服务端账号状态为 Plus。
9. Auth、server Checkout、browser Billing 网络证据均有 verified 状态。
10. evidence bundle 不含任何禁止持久化字段。

未同时满足以上十项时，SSOT 状态保持“进行中”或“阻塞”，不标记完整闭环。

2026-08-06 最新成功 live 证据：`.context-snapshots/plus-checkout-closure/pcc-live-7b2c128f-cab4-4121-8146-85eff4931b85.live.json`，`closureRunId=pcc-live-7b2c128f-cab4-4121-8146-85eff4931b85`。十项 gate 全部为 true，最终 phase 为 `subscription_verified`，submitCount 为 1，三网络面均为 verified，敏感形态 findings 为空；checkpoint 序列包含 submit 前持久化的 `subscription_submitting`。Stripe.js 在创建 SetupIntent 前同时预检 top 与 isolated iframe，上游脚本短暂失败会清理节点并做有界重试；浏览器网络证据以 Cloudflare trace IP 为基准，ASN 查询必须按该 IP 成功、两者一致且字段完整。普通 fixture 覆盖 mutable latest 后，seal 仍只读取同 ID 的 immutable live/saved-payment/browser 子证据并通过。
