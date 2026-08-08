# 原生扩展支付 Runner SSOT

> 资格保持、方式候选分层、出口映射和终链入库以 [试用资格与多支付提链 SSOT](../trial-payment-probe/README.md) 为全局编排真相；本文件保留 Runner 适配器细节。

## 1. 目标与边界

本 SSOT 定义命中后的原生支付链路，唯一流程顺序为：

`screen -> revalidate -> createPM -> confirm -> approve -> poll -> finalize`

Runner 只在以下条件同时满足时形成“终链可用”结果：

1. checkout session、Stripe publishable key、支付方式适配器均有效。
2. `screen` 与每个写操作前的 `revalidate` 都通过严格零元资格门。
3. amount、mode、currency、payment_method_types 从固定可信路径读取；缺失、格式错误或冲突均关闭资格门。
4. `confirm` 或 `approve` 的结果不明确时，不重复写操作，只轮询同一个 checkout session。
5. 最终 URL 必须通过计划支付方式专属的 HTTPS hostname/path 白名单；Stripe hooks 和 pm-redirects 只能作为中转。

Runner 不把普通 hosted checkout、任意支付站点 URL、仅有优惠文案或“可能为 0 元”的响应升级为有效终链。

## 2. 统一阶段契约

| 阶段 | 输入 | 主要动作 | 成功证据 | 失败后续 |
| --- | --- | --- | --- | --- |
| screen | Checkout session | 初次 Stripe init | 完整严格门快照 | 关闭 Runner |
| revalidate | checkpoint | 再次 Stripe init | 新 revision 且严格门通过 | 关闭 Runner |
| createPM | gate snapshot | 创建方式专属 PaymentMethod | `pm_` id | 不进入 confirm |
| confirm | gate + pm | 单次确认同一 Checkout | accepted 或明确 provider decline | unknown 只 poll |
| approve | confirm requires approval | 单次审批 | approved 或 unknown | unknown 只 poll |
| poll | confirm/approve 状态 | GET 同一 Checkout，最多有限次数 | 方式中转/终链 URL | 超时归为副作用不明 |
| finalize | poll 状态 | 解析中转并验证终链 | 专属白名单 URL | 丢弃 URL |

## 3. 支付适配器

每种方式实现相同 Runner 接口，由适配器提供 `stripeType`、币种策略、国家策略、代理角色和终链白名单：

| 方式 | Stripe type | 国家/币种策略 | 终链约束 |
| --- | --- | --- | --- |
| Hosted | - | 跟随已验证 Checkout 的实际国家与币种 | `checkout.stripe.com/c/pay/` / `pay.openai.com/c/pay/` |
| PayPal | `paypal` | 跟随已验证 Checkout 的实际国家与币种 | `paypal.com` 的支付/授权路径 |
| MoMo | `momo` | VN / VND 固定 | `payment.momo.vn` |
| GoPay | `gopay` | ID / IDR 固定 | `app.midtrans.com/snap/v*/redirection/` |
| iDEAL | `ideal` | NL / EUR 固定 | `ideal.nl` / `pay.bunq.com` |
| UPI | `upi` | IN / INR 固定 | `payments.stripe.com/upi/instructions/` |
| PIX | `pix` | BR / BRL 固定 | `payments.stripe.com/pix/` |
| BLIK | `blik` | PL / PLN 固定 | Stripe BLIK action path |
| TWINT | `twint` | CH / CHF 固定 | `twint.ch` 非根路径 |
| Kakao Pay | `kakao_pay` | KR / KRW 固定 | Kakao/KakaoPay/Nicepay 非根路径 |

`hosted` 仅作为 Checkout 长链通道，不参加原生方式 Runner。Hosted/PayPal 的 `global` 表示“由 Checkout 上下文驱动”，不表示上游在所有地区必然提供 PayPal；生产候选仍必须来自该 Session 的 Stripe `payment_method_types`。未暴露方式默认不进入 Runner，只有显式实验开关可送入严格筛查，严格门关闭时不会创建 PaymentMethod 或提交 confirm。

Checkout 地区表当前覆盖 65 个地区。Hosted/PayPal 不再依赖固定的 10 个 USD 地区：实际 Checkout 返回 `country/currency` 后，bootstrap、promotion、provider 三阶段跟随该国家，严格门使用该实际币种。MoMo、UPI、PIX 等区域方式继续使用支付档案中的固定国家与币种，显式阶段 override 仍有最高优先级。

## 4. 严格资格门

可信读取路径固定在 `strict-zero-gate.ts`：

- 金额：`total_summary.due`、`amount_total`、`amount`、`elements_options.amount`、`invoice.amount_due`
- mode：`mode`、`elements_options.mode`
- currency：`currency`、`elements_options.currency`、`total_summary.currency`、`invoice.currency`
- 方式：`payment_method_types`、`elements_options.payment_method_types`、`invoice.payment_method_types`

任一可信来源给出不一致值，结果为 `*_conflict`；可信来源全部缺失或格式异常，结果为 `*_missing`/`*_malformed`。只有 `amount=0`、`mode=subscription`、币种与解析后的能力上下文一致、计划方式存在于方式列表时才通过。

方式终链只有在源资格已验证、Runner 使用同一资格 Session、目标方式实际暴露、严格零元门复验通过且终链白名单通过时才标记 `link_ready`。失败尝试可作为诊断记录保留，但不计为可用链接、不进入有效链接看板。

## 5. 代理路由

Runner 通过 `beforeStage(stage, role)` 统一接入代理，不在每个方式适配器内复制代理逻辑：

| Runner 角色 | 阶段 | 既有三池映射 | 默认国家来源 |
| --- | --- | --- | --- |
| checkout | screen/revalidate | promotion | promotionCountry |
| provider | createPM/confirm/finalize | provider | providerCountry |
| approve | approve/poll | bootstrap | bootstrapCountry |

方式池优先于国家池；方式池失败后才回退到国家出口。健康门负责冷却、剔除失败 seed，并在观测中保存阶段国家、IP/ASN、seed summary 和 cycleId。

## 6. 错误分类与幂等规则

| 分类 | 含义 | 对外状态 |
| --- | --- | --- |
| qualification | 严格门关闭 | `not_qualified` |
| method-unavailable | 方式无适配器/type | `method_unavailable` |
| credential | token/权限错误 | `credential_terminal` |
| network / rate-limit | 网络、5xx、限速 | `network_inconclusive` |
| provider-decline | 提供方明确拒绝 | `protocol_incompatible` |
| protocol | 协议字段不兼容 | `protocol_incompatible` |
| side-effect-unknown | 写请求结果不明 | `side_effect_inconclusive` |
| invalid-final-url | 终链未通过白名单 | `invalid_final_url` |

`confirmSubmitted` 与 `approveSubmitted` 是单次 Runner 内的硬闸；5xx/网络未知副作用分支只能进入 `poll`，不自动重放写请求。

## 7. 观测与看板字段

每条账号×国家观测保存：计划路由/方式/seed、实际 Auth/Checkout/Billing 出口、支付方式提供列表、资格门结果、Runner 状态/阶段/代码、confirm/approve 提交与成功、终链验证、错误分类、时间与客户端变量。

看板必须分开统计：

- 资格通过率
- 支付方式提供率
- confirm 成功率
- approve 成功率
- 终链验证率
- 协议失败率

CSV/JSON 导出保留这些字段；不保存 access token，历史观测导入保持兼容。

## 8. 上游漂移探测

当 Stripe 字段路径、方式列表、币种、终链 hostname/path 或审批状态发生变化时，Runner 以错误分类和阶段事件暴露变化；看板通过漂移告警、方式提供率和终链验证率分离显示变化。探索流量继续保留，排行榜不得永久锁定国家。

## 9. 代码归属

- `src/features/payment/strict-zero-gate.ts`：严格资格门。
- `src/features/payment/runner-types.ts`：Runner 统一类型与事件契约。
- `src/features/payment/runner-adapters.ts`：方式适配器与代理角色。
- `src/features/payment/native-runner.ts`：状态机、幂等和错误状态。
- `src/features/payment/native-transport.ts`：Stripe init/PM/confirm/approve/poll/finalize 传输。
- `src/features/probe/service.ts`：探测任务、代理绑定、命中入库与观测落盘。
- `src/features/probe/analysis.ts`：CSV/JSON 观测导出。
- `entrypoints/automation-settings/main.ts`：支付 Runner 指标看板与方式配置。
