# 试用资格与多支付提链 SSOT

状态：`canonical-implemented`，文档版本 `1.1.0`，更新时间：2026-08-06

本文件是试用、优惠、零金额资格探测，以及多支付方式提取终链的唯一编排真相。`smart-automation`、`payment-runner`、`eligibility-factors`、`multi-factor-experiments` 和 `saved-payment-methods` 只保留领域细节；当这些文档与本文件的编排规则冲突时，以本文件为准。

## 1. 目标与边界

### 1.1 目标

1. 在同一账号、国家、出口和时间约束下，最大化发现 `free_trial`、`promo_zero`、`zero_amount`、`intro_discount_zero` 和其他零金额资格。
2. 在资格仍然成立的前提下，发现所有已暴露支付方式，并为每个方式提取一个经过域名白名单验证的终链。
3. 将 Auth、Checkout、Billing、UPL 中间阶段和支付 Runner 的出口变体记录为可比较的实验单元。
4. 让每个结果都能回答：资格从哪里出现、在哪个阶段被保持或丢失、哪个方式被暴露、最终链接是否仍指向同一资格会话。

### 1.2 非目标

- 不把“页面能打开”或“支付 URL 存在”当作试用成功。
- 不在未暴露方式上直接进入生产候选；强制筛查结果只能进入实验区。
- 不重复执行未知副作用的 `confirm`/`approve`；写操作结果未知时只查询原 Checkout。
- 不并发切换浏览器代理；代理是进程级状态，默认有效并发为 `1`。
- 不把缺少显式 live 配置的公网观察结果写成资格证据；默认交付证据来自本地 fixture、状态机测试和浏览器构建。

## 2. 方案选择

| 方案 | 做法 | 优点 | 风险 | 结论 |
|---|---|---|---|---|
| A 专项脚本 | 每种方式各写一条试用脚本 | 上手快 | 状态、资格和证据分裂，重复 confirm | 不采用 |
| B 单一复用链 | 只复用源 Checkout，顺序提取方式 | 资格证明最强，副作用最少 | 对未暴露方式覆盖不足 | 作为保守基线 |
| C 统一资格探测平台 | 发现、复用、独立 Checkout、强制筛查、出口实验共用一套证据账本 | 覆盖高、可归因、可恢复 | 调度和证据实现成本较高 | **推荐默认** |

默认运行模式为 `hybrid`：`exploit` 使用历史高命中单元，`balanced` 保留可比较的账号×出口样本，`explore` 轮换低样本和强制筛查单元。

## 3. 核心不变量

### 3.1 资格保持不变量

一个支付终链只有在下列五段全部通过时，才能标记为 `qualified_payment_link`：

```text
source qualification
  -> method offered
  -> qualification revalidate
  -> exactly one confirm/approve (only when required)
  -> final URL allowlist + same-session evidence
```

等价的机器条件：

```text
sourceQualificationVerified == true
methodOffered == true
qualificationPreserved == true
qualificationVerified == true
finalLinkVerified == true
```

`sourceSessionReused` 在复用模式必须为 `true`；独立 Checkout 模式必须证明 `sessionDistinct == true`，并在独立会话重新通过资格门禁。任何字段缺失都只能是 `probe_required` 或失败状态，不能降级为成功。

`qualified_payment_link` 与 `probe_required` 是已落地的目标聚合状态。独立 Checkout 还必须满足 `sessionDistinct=true`；Hosted 源长链固定按复用源资格会话计算，不伪装为独立 Checkout。

### 3.2 写操作不变量

- 每个 `MethodAttempt` 最多一次 `confirm`，最多一次 `approve`。
- `confirm` 返回超时、断连或未知状态时，生成 `unknown_side_effect`，查询原会话状态；禁止创建第二个支付意图来“试一次”。
- `approve` 仅对需要外部授权的方式调用；Hosted 长链只做白名单和资格校验。
- 资格从 `zero` 变为非零、从 `trial` 变为普通付费或促销失效时，立即停止该方式后续写操作。

## 4. 统一对象模型

```text
ProbeRun
  └─ AccountUnit
      └─ RouteVariant (auth/checkout/billing/provider/runner exits)
          └─ QualificationAttempt
              └─ MethodAttempt (one per payment method)
                  └─ Evidence[]
```

### 4.1 对象职责

| 对象 | 必填字段 | 说明 |
|---|---|---|
| `ProbeRun` | `runId`, `mode`, `seed`, `startedAt`, `budget` | 一轮可重放的调度上下文 |
| `AccountUnit` | `accountId`, `chatgptAccountId`, `credentialStatus` | 账号身份和服务器凭据状态 |
| `RouteVariant` | `authExit`, `checkoutExit`, `billingExit`, `providerExit`, `runnerExit` | 每阶段出口及实际 IP/ASN/国家快照 |
| `QualificationAttempt` | `sourceSessionId`, `qualificationType`, `evidenceLevel`, `amountMinor`, `currency` | 源资格及重验证结果 |
| `MethodAttempt` | `method`, `sessionMode`, `methodOffered`, `runnerStatus`, `finalUrl` | 单支付方式的完整状态机 |
| `Evidence` | `stage`, `requestId`, `status`, `redactedPayloadHash`, `observedAt` | 可审计、脱敏、可重算的事实 |

## 5. 资格分类与证据等级

### 5.1 资格类型

| 类型 | 判定条件 | 可否进入支付 Runner |
|---|---|---|
| `candidate` | 页面或响应出现疑似 trial/promo/zero 文案 | 否，仅继续取证 |
| `zero_amount` | 结构化金额明确为 `0` 且币种可识别 | 是 |
| `free_trial` | 响应含 `free_trial`、`trial_period`、`trialing` 等结构化信号 | 是 |
| `promo_zero` | 优惠/活动字段存在且最终应付为 `0` | 是 |
| `intro_discount_zero` | 首期优惠使应付为 `0`，后续周期金额非零 | 是，必须记录续费金额 |
| `deferred_payment` | 当前应付为 `0`，但需要保存支付方式或后续扣款 | 仅在支付方式门禁通过后进入 |
| `nonzero` | 明确非零 | 否，作为资格丢失 |
| `unknown` | 金额或资格信号无法确认 | 否，进入重试/人工复核 |

### 5.2 证据等级

| 等级 | 证据 | 结果含义 |
|---|---|---|
| `candidate` | 页面文本、标签、URL | 线索 |
| `page` | Checkout 页面和结构化状态 | 页面层命中 |
| `strict-response` | API 响应金额为 0 或 trial 字段明确 | 严格响应命中 |
| `strict-page` | 页面金额、币种、trial/promo 文案相互一致 | 可入库资格 |
| `provider-final` | 方式 Runner 返回白名单终链 | 可入库支付终链 |
| `entitlement-verified` | 账户权益/订阅状态回读与 Checkout 资格一致 | 最高等级，允许提升统计权重 |

晋级只能单向进行；任何后续重验证失败都将结果降为 `qualification_lost`，保留原证据和漂移事件，不覆盖历史事实。

## 6. 端到端流程

### 6.1 阶段 0：预检与预算

1. 锁定 `runId + accountId + routeVariant + seed` 幂等键。
2. 检查服务器凭据、冷却窗口、出口健康度和账号副作用预算。
3. 生成本轮方法候选：已发现方式、配置方式、可选强制筛查方式分层存放。

### 6.2 阶段 1：Auth

记录登录响应、账号 ID、Auth 出口实际 IP/ASN/国家和会话 Cookie。Auth 失败只影响当前 `AccountUnit`，不得污染其他账号。

### 6.3 阶段 2：源 Checkout

使用 Checkout 出口创建或读取源会话，采集结构化金额、币种、优惠、trial 字段、Checkout session ID 和 Billing country。通过 `strict-response` 或 `strict-page` 后才创建 `QualificationAttempt`。

### 6.4 阶段 3：Billing / promotion / provider

按 `RouteVariant` 串行切换出口，执行 UPL 的 `bootstrap -> promotion -> provider`。每次切换都写 `stageTrace` 和实际网络指纹；如果切换导致 session 失配或资格漂移，停止当前单元。

### 6.5 阶段 4：方式发现与筛查

优先读取 Stripe init/Checkout 暴露的 `payment_method_types`。未暴露方式进入 `forcedProbe` 队列，结果只允许 `probe_required`、`method_not_offered` 或失败，不得伪造 `methodOffered`。

### 6.6 阶段 5：支付 Runner

对每个候选方式执行：

```text
screen -> revalidate -> createPM -> confirm -> approve -> poll -> finalize
```

其中 `confirm/approve` 只在方式适配器声明需要时执行。每个方式使用独立 `MethodAttempt`，不共享可变写状态。

### 6.7 阶段 6：终链与入库

最终 URL 必须满足方式白名单、HTTPS、无凭据、无端口、无 hash 和预期路径约束。入库记录源资格、方式资格、session 关系、Runner 状态、终链校验和脱敏证据哈希。

## 7. 多支付方式能力矩阵

| 方式 | 当前档案 | 原生 Runner | 能力范围 | 典型出口 | 终链白名单 | 默认策略 |
|---|---:|---:|---|---|---|---|
| `hosted` | 是 | 长链通道 | global | checkout/provider | `checkout.stripe.com/c/pay`, `pay.openai.com/c/pay` | 源资格复用 |
| `paypal` | 是 | 是 | global | provider/approve | `paypal.com` 授权路径 | 复用后一次 approve |
| `momo` | 是 | 是 | regional | VN | `payment.momo.vn` | VN 独立或复用 |
| `gopay` | 是 | 是 | regional | ID / Midtrans | `app.midtrans.com/snap/...` | ID 独立或复用 |
| `ideal` | 是 | 是 | regional | NL / `pay.bunq.com` | iDEAL/bunq | NL 独立或复用 |
| `upi` | 是 | 是 | regional | IN / Stripe | `payments.stripe.com/upi/instructions` | IN 独立或复用 |
| `pix` | 是 | 是 | regional | BR / Stripe | `payments.stripe.com/pix` | BR 独立或复用 |
| `blik` | 是 | 是 | regional | PL / Stripe | Stripe BLIK 路径 | PL 独立或复用 |
| `twint` | 是 | 是 | regional | CH | `twint.ch` | CH 独立或复用 |
| `kakao` | 是 | 是 | regional | KR | Kakao/NicePay | KR 独立或复用 |

矩阵是能力事实，不代表方式一定对某账号可用。方式状态必须区分 `detected`、`forced_probe`、`offered`、`qualification_lost`、`link_ready`。

## 8. Checkout 会话策略

| 模式 | 适用场景 | 必须证明 | 失败处理 |
|---|---|---|---|
| `reuse_eligibility_session` | 资格保持优先、低副作用 | `sourceSessionReused=true` 且目标方式在同一会话重新通过门禁 | 标记 `qualification_lost`，不新建写会话 |
| `independent_checkout` | 方式覆盖和归因实验 | 新 session ID、独立会话金额为 0/trial、账号身份一致 | `session_not_distinct` 或 `identity_mismatch`，不提交 |

同一账号同一运行中，独立 Checkout 仍须串行；不同账号可以并行，但浏览器代理切换仍由全局锁保护。

## 9. 多阶段出口统一映射

| 逻辑阶段 | 普通自动化 | UPL | Runner | 记录字段 |
|---|---|---|---|---|
| Auth | 登录/会话恢复 | `bootstrap` 前置 | `checkout` 前置 | `authExit` |
| Checkout | 创建/读取 Checkout | `bootstrap` | `checkout` | `checkoutExit` |
| Billing | billing details/taxes | `promotion` + `provider` | `provider` | `billingExit`, `providerExit` |
| 支付授权 | 无或 Hosted | provider | `confirm`/`approve`/`poll` | `runnerExit` |

出口快照至少包含 `proxyId`、`actualIp`、`actualCountry`、`asn`、`colo`、`checkedAt`。阶段切换顺序固定为 Auth -> Checkout -> Billing/provider -> Runner；不得在单次 confirm 期间切换出口。

## 10. 调度、覆盖率与停止条件

### 10.1 三种实验模式

- `discovery`：优先低样本国家、未暴露方式和新 seed；目标是覆盖率。
- `attribution`：固定账号、方式和时间窗口，只改变一个出口因素；目标是可归因。
- `hybrid`：默认 60% exploit、25% balanced、15% explore；目标是兼顾命中和学习。

### 10.2 覆盖率定义

```text
route_coverage = 已完成的 RouteVariant / 计划 RouteVariant
method_coverage = 已产生 MethodAttempt 的方式 / 目标方式集合
qualification_coverage = 有严格资格证据的 QualificationAttempt / 总尝试
link_coverage = provider-final 终链数 / method_offered 数
```

报表同时展示分母、失败原因和置信区间；没有分母的百分比不展示为成功率。

### 10.3 预算与冷却

- 账号预算：每轮最大 Checkout 创建数、最大方式数、最大写操作数。
- 出口预算：每个国家/seed 的请求速率、连续失败阈值和冷却分钟数。
- 方式预算：同一源资格最多一次筛查；强制方式按 `forceUnlisted` 和实验比例限额。
- 触发停止：凭据失效、身份不一致、资格连续漂移、出口健康失败、写操作未知副作用。

## 11. 证据账本与数据契约

每条结果必须包含：

```json
{
  "runId": "RUN_ID",
  "accountId": "ACCOUNT_ID",
  "routeVariant": {"authExit":"AUTH_EXIT","checkoutExit":"CHECKOUT_EXIT","billingExit":"BILLING_EXIT","runnerExit":"RUNNER_EXIT"},
  "qualification": {"type":"free_trial","level":"strict-response","amountMinor":0,"currency":"USD"},
  "methodAttempt": {"method":"pix","sessionMode":"reuse_eligibility_session","methodOffered":true,"qualificationPreserved":true},
  "final": {"urlRedacted":"https://payments.stripe.com/pix/REDACTED","finalLinkVerified":true},
  "sideEffect": "none|confirmed|unknown",
  "evidenceHashes": ["sha256:HASH"],
  "observedAt": "TIMESTAMP"
}
```

原始 token、完整付款参数、个人地址和响应中的敏感字段不进入日志、看板或导出。URL 仅保留白名单域名、路径类别和不可逆哈希；调试副本使用本地 fixture。

## 12. 幂等、恢复与漂移

幂等键：`payment-operation/runId/accountId/routeVariantId/qualificationSessionId/method/attemptOrdinal`。重启时：

1. 读取最后一个 `checkpoint`，恢复未完成的只读阶段。
2. 对 `unknown_side_effect` 只做查询，不重放写操作。
3. 对已 `link_ready` 的方式只重新校验 URL 和资格，不重新 confirm。
4. 账号切换必须清空浏览器上下文和出口锁，保留账本关联。
5. 检测到金额、币种、方式暴露或身份漂移时，关闭当前单元并创建 drift 事件。

## 13. 分阶段落地

1. **契约锁定**：创建本 SSOT、任务 DAG、验证矩阵；锁定字段和状态枚举。
2. **资格账本**：补齐资格类型、证据等级、严格金额/试用/促销解析和漂移事件。
3. **多方式提链**：统一候选分层、复用/独立 Checkout、一次写操作和白名单终链。
4. **出口实验**：统一 Auth/Checkout/Billing/Runner 映射、全局代理锁和 hybrid 调度。
5. **数据与恢复**：入库、看板、脱敏导出、checkpoint、未知副作用恢复和停止条件。
6. **验证与交付**：fixture 单测、集成矩阵、Chrome/Firefox 构建、live 观察（仅本地配置）和回滚演练。

## 14. 完成判定

本 SSOT 对应的实现批次只有在以下条件全部满足时关闭：

- 10 类方式均有能力/终链/失败状态测试；
- 每条成功终链都有严格资格和 session 关系证据；
- 未暴露方式与生产候选隔离；
- 三类出口角色可在账本中区分且代理锁测试通过；
- 复用、独立、未知副作用、重启恢复和资格漂移均有回归证据；
- 脱敏、统计分母、Chrome/Firefox 和回滚检查通过。

详细任务见 [TASKS.md](./TASKS.md)，验收命令和矩阵见 [VERIFY.md](./VERIFY.md)。
