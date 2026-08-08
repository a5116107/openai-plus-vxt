# 原生支付 Runner 复核表

## 配置线

- [x] 设置页方式池包含 PayPal、MoMo、GoPay、iDEAL、UPI、PIX、BLIK、TWINT、Kakao。
- [x] 探测渠道常量覆盖上述方式，默认智能任务保留探索渠道。
- [x] 智能任务默认打开严格零元门、支付方式探测、终链提取；有 Stripe pk 时可进入原生 Runner。
- [x] 新建任务默认复用已经通过资格门的 Checkout；独立 Checkout 仅作为显式对照实验。

## 流程线

- [x] Runner 顺序固定为 `screen -> revalidate -> createPM -> confirm -> approve -> poll -> finalize`。
- [x] createPM、confirm、approve、finalize 前均经过 revalidate；资格漂移时不调用 finalize。
- [x] confirm/approve 结果不明时只 poll 同一 Checkout，不重放写操作。
- [x] 每个阶段通过统一 hook 暴露 proxy role 和事件。

## 逻辑线

- [x] 金额、mode、currency、支付方式多来源缺失/异常/冲突均关闭严格门。
- [x] 终链要求 HTTPS、无账号密码/端口/hash，并匹配方式专属 hostname/path。
- [x] 错误分类映射到资格未命中、网络不确定、协议不兼容、副作用不确定和终链无效。
- [x] 目标方式未出现在重验证结果时，Runner 在 `screen` 阶段终止，不创建支付方式、不提交 confirm。

## 数据线与看板

- [x] Observation/Hit 保留 Runner 状态、阶段、代码、资格证据和终链证据。
- [x] 独立保留 confirm/approve 提交与成功字段。
- [x] 设置页独立显示资格通过、方式提供、confirm、approve、终链验证、协议失败。
- [x] CSV 导出包含新增字段；CSV 导入按布尔值解析，旧数据可缺省。
- [x] 每个方式结果和看板保留源资格、源会话复用、目标方式暴露、资格保持四项证据；专用终链只在证据完整时标记成功。
- [x] 可选实验开关可筛查配置中但未被 discovery 暴露的方式；结果标记 `forcedProbe`，严格门仍阻断后续写阶段。

## 质量与交付

- [x] `npm run compile` 通过。
- [x] `pnpm test:payment-runner` 通过，10/10。
- [x] `pnpm build:firefox` 通过并记录产物。
- [x] Firefox XPI manifest、关键模块、版本和 SHA-256 已复核。
- [x] `quality-guard review-entry --no-chain` 已产出当前请求链证据并通过；全局 change/shape budget 与既有超大文件作为 advisory 结构债务单独列示。
- [x] 当前 Firefox XPI 已按 ZIP/XPI 兼容格式生成并核对关键文件。
- [x] Hosted/PayPal 按实际 Checkout 国家与币种解析，区域方式保持固定档案约束。
- [x] 默认 Runner 候选来自 Stripe 实际探测；未暴露方式只在显式实验开关下筛查。

## 实际证据

- `pnpm compile`：PASS，TypeScript 0 errors。
- `pnpm test:payment-runner`：PASS，11/11；包含严格门冲突、适配器币种唯一规则、confirm/approve 单次提交、未知副作用只 poll、资格漂移和终链白名单。
- `node tools/_probe_logic_smoke.cjs`：PASS；健康剔除和高命中国家选择逻辑通过。
- `node tools/_multi_factor_experiment_smoke.mjs`：PASS；三实验臂、三路由变体与 seed 选择通过。
- `node tools/_eligibility_analysis_smoke.mjs`：PASS；账号、国家、出口、交互、受控因素和漂移场景通过。
- `pnpm build:firefox` 与 `pnpm zip:firefox`：PASS；Firefox MV2 构建总大小约 1.22 MB。
- `node scripts/e2e-eligibility-dashboard.mjs`：PASS；扩展 `0.0.30` 实际加载，Runner 六类指标、CSV/JSON 新字段往返、390px 无页面横向溢出、页面/控制台 0 errors 全部通过。证据位于 `.context-snapshots/e2e-eligibility-dashboard-0.0.30/`。
- `pnpm dlx web-ext lint --source-dir .output/firefox-mv2 --output json`：0 errors、0 notices、27 warnings；警告为既有动态表格 `innerHTML` 与 Firefox manifest 版本兼容提示。
- XPI 只读归档复核：manifest `0.0.30`，Gecko ID `openai-plus-vxt@local.opx`，`incognito=spanning`，20 个文件；设置页、Runner 四个 revalidate checkpoint、MoMo/GoPay 白名单及 Runner 看板均存在。
- `dist/openai-plus-vxt-0.0.30.xpi` SHA-256：`44ABEE85F3E97963F78C4B4448911C6B8E75EF602E0E243D50DC94D08BC26C06`。
- `dist/openai-plus-vxt-0.0.30-mullvad.xpi` SHA-256：`44ABEE85F3E97963F78C4B4448911C6B8E75EF602E0E243D50DC94D08BC26C06`。
- 历史共享工作区曾因全局 change/shape/anti-mud budget 返回 FAILED；0.0.37 隔离收口已由下方 SUCCESS 记录取代，历史结果不再代表当前质量门。
- `pnpm test:payment-runner`：PASS，13/13；新增“方式未暴露时在 screen 止步”与“同一资格 Checkout 的保持证据”断言。
- `pnpm test:probe-readiness`：PASS，15/15；默认复用模式、独立对照开关、未暴露方式实验候选选择和 `forced=true` CSV 审计字段均通过。
- `pnpm compile`、`pnpm build`、`pnpm build:firefox`、`pnpm zip:firefox`：PASS；Firefox XPI 位于 `.output/openai-plus-vxt-0.0.34-firefox.xpi`。
- XPI SHA-256：`664BEAC6FC15334289CE1C0E2B6E96CB987DF55C52816E8178F0555A5B842EAC`；已确认包含 `manifest.json`、`background.js`、`automation-settings.html`。
- `node scripts/e2e-eligibility-dashboard.mjs`：PASS；版本 `0.0.34`，42 项界面、CSV/JSON 往返、移动端无横向溢出、页面/控制台 0 errors 均通过。超长页截图协议错误已在测试脚本中降级为视口证据采集，业务断言仍完整执行。
- 历史真实 seed 运行 `node scripts/e2e-proxy-stages.mjs` 未通过三出口断言：当时只产出 JP 与 VE 两个唯一 IP，Billing 被正确拒绝为重复出口；该记录只描述当时外部供应状态。

## 2026-08-08 0.0.37 收口复核

- `pnpm tsx --test tests/*.test.ts`：PASS，125/125；包含 forced probe 不晋级、`link_ready` 恢复不重放和终链资格保持。
- `pnpm test:e2e-proxy-stages`：PASS；自包含 Auth/Checkout/Billing 三代理 IP、国家、ASN 互异，阶段内黏性、顺序、去重和下一周期稳定性全部通过。
- `pnpm build`、`pnpm build:firefox`：PASS，Chrome MV3 与 Firefox MV2 均约 1.48 MB。
- `quality-guard review-entry --no-chain`：SUCCESS，仓库工作树 clean，blocker=0；change/shape budget 作为迁移结构债务保留 advisory。
- 真实多出口与真实支付结果仍以显式 live profile 为准，自包含 fixture 不替代公网资格结论。

## 2026-08-01 Hosted/PayPal 动态能力复核

- `pnpm compile`：PASS，TypeScript 0 errors。
- `pnpm test:payment-runner`：PASS，15/15；覆盖 65 个 Checkout 地区的 Hosted/PayPal 动态国家币种、PH/PHP、JP/JPY、DE/EUR PayPal Runner、区域方式固定约束和资格保持证据。
- `pnpm test:checkout-pipeline`：PASS，5/5；结构化金额、React Router 回退、invalid_promotion 完整重建及 CF 分层重试通过。
- `pnpm test:probe-readiness`：PASS，16/16；实际方式候选、严格命中、CSV 证据、国家/出口可识别性通过。
- `pnpm build`：PASS；Chrome MV3 生产包 1.31 MB。
- `node scripts/e2e-eligibility-dashboard.mjs`：PASS，扩展 `0.0.35` 实际加载，42/42 检查通过，页面与控制台 0 errors；证据位于 `.context-snapshots/e2e-eligibility-dashboard-0.0.35/result.json`。
- `pnpm build:firefox`、`pnpm zip:firefox`：PASS；Firefox MV2 XPI 为 375494 bytes、20 个条目，manifest `0.0.35`、Gecko ID `openai-plus-vxt@local.opx`，包含 `background.js` 与 `automation-settings.html`。
- `.output/openai-plus-vxt-0.0.35-firefox.xpi` 与 `dist/openai-plus-vxt-0.0.35.xpi` SHA-256：`E51D57F6AF977F3F21F88E8299BACA4745F67128E3CADB178D2C525F7492E0AB`。
- 当前项目在线全流程：Acica 返回 485 个邮箱，随机选择、SG Auth 出口、两次 OTP 获取与提交均成功；Auth OTP validate 返回 Cloudflare 403，流程未进入 Checkout，故本轮没有新增试用资格或支付终链。证据位于 `.context-snapshots/e2e-hosted-paypal-global-0.0.35/chrome-e2e-result.json`。
- 结论边界：动态能力与严格保存逻辑已经通过生产代码行为测试；“某个新增地区当前实际提供 PayPal 且保持试用资格”仍需一次通过 Auth/Checkout 的在线命中样本确认。

## 复核规则

任何只证明字段存在、没有行为输出的检查只能记为“结构存在”，不得记为流程 PASS。最终交付必须引用实际命令及输出摘要；外部真实支付未执行时，结论限于本地 Runner、mock transport 和构建验证。
