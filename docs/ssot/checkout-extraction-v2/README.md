# Checkout 提链与资格验证 SSOT

本目录是结构化金额、Checkout 页面回退、优惠重建、双模式提链、账号身份与重试指标的唯一实现清单。代码事实优先由生产模块与行为测试复核。

## 流程线

`账号身份恢复 -> Cookie/Session 邮箱校验 -> Checkout create -> checkout/update -> 可选 taxes -> 结构化金额 -> Checkout 页面 React Router 回退 -> 严格零元门 -> oaics_ 页面解析 -> Hosted/Custom 分别入库 -> 实际支付方式证据门 -> 支付方式 Runner`

`checkout/update` 任意层出现 `invalid_promotion` 时，当前 Checkout Session 立即标记丢弃；状态机重新执行完整 create/update/金额验证流程，不复用失效 Session。

## 逻辑线

- 金额优先读取 `total_summary.due`、`invoice.amount_due`、`amount_total`、`total.*` 和 `lineItems`，支持 wrapper 递归与 minor-unit 对象。
- API 缺金额时，访问 Checkout 页面并解析 React Router `_N` 引用、`streamController.enqueue` 分块和 `application/json`。
- `hosted`、`custom` 均真实调用 Checkout create；`both` 顺序创建两个独立 Session，并按模式拆成两条命中库记录。
- 每账号保存 Cookie、设备 ID、Session ID；运行前恢复 Cookie，Checkout 请求携带设备/Session 标识。
- Cookie、设备 ID、Session ID 不进入资格因素 CSV/JSON、命中库 CSV或账号报表 CSV。
- AT-only 账号继续参与 Checkout API 资格探测，但 Hosted 解析明确记录 `identity_required`，不会把 `oaics_` 当 Stripe `cs_`。
- 401 凭据失败细分：`invalid_jwt`（JWT 失效）、`token_rejected`（会话上下文拒绝）、`cloudflare`（CF 网络层）；只有前两类把账号标记 invalid，CF 不误判。
- 组合认证：有 cookie 快照的账号探测前用 `/api/auth/session` 刷新 accessToken 并回写；Checkout/update/taxes 请求携带 Bearer + Cookie + device-id。纯 AT 无法换取 session，方向为 cookie -> 刷新 AT。
- 设置页“一键同步当前登录会话”会按邮箱更新账号 AT 与 Cookie 快照；恢复后 `/api/auth/session` 邮箱不一致时记录 `identity_mismatch`。
- `oaics_` 页面解析只从最终 URL、页面 HTML 和 Performance Resource 提取 Hosted URL、`cs_` 与 Stripe PK；支付方式只从可见页面文本或 Stripe init 结构化响应确认。
- `plannedPaymentMethod` 只表示实验计划；`submittedPaymentMethod` 只在 confirm 实际提交后写入。未暴露方式记录 `method_not_offered`，不进入支付提交。

## 指标线

每次观测保存 `checkoutAttempts`、`updateAttempts`、`fullFlowAttempts`、`cfRetryCount`、`cfExitRotations`、`invalidPromotionRebuilds`、`pageFallbackAttempts`。看板显示创建、资格、可用三段转化率，Hosted/Custom 资格率和四层重试汇总。

## 代码归属

- `src/features/link-extractor/checkout-amount.ts`：结构化金额与 React Router 解码。
- `src/features/link-extractor/checkout.ts`：网络请求、完整流程状态机和指标。
- `src/features/probe/service.ts`：账号身份恢复、模式编排、观测生成。
- `src/features/probe/hosted-resolution.ts`：Hosted 页面证据解析和身份/解析状态模型。
- `src/features/probe/state.ts`：归一化、双模式拆分持久化、导出。
- `entrypoints/automation-settings/main.ts`：模式配置、命中库和转化率看板。
- `tests/checkout-pipeline.test.ts`：生产解析器与状态机行为测试。
- `tests/hosted-resolution.test.ts`：AT-only、登录页、Hosted/Stripe 资源、支付方式可见证据与账号匹配测试。
