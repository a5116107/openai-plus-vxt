# Checkout 提链复核

## 已完成证据

- `pnpm test:checkout-pipeline`：PASS，5/5；测试通过本地 HTTP 服务实际驱动生产 `fetch`、解析器和完整流程状态机。
- `pnpm test:payment-runner`：PASS，15/15。
- `pnpm test:probe-readiness`：PASS，16/16；包含双模式生产拆分函数验证。
- `pnpm test:hosted-resolution`：PASS，5/5；覆盖 AT-only、登录页不误报方式、Hosted/`cs_`/PK 提取、checkout_loaded 和身份不匹配。
- `pnpm test:auth-cf`：PASS，6/6。
- `pnpm compile`：PASS，TypeScript 0 errors。

## 扩展与发布证据

- `node scripts/e2e-eligibility-dashboard.mjs`：PASS，扩展 `0.0.37` 实际加载；44 项检查全部通过，页面与控制台 0 errors。覆盖会话同步控件、无登录身份门、双模式、流程转化率、四层重试和导出脱敏。证据位于 `.context-snapshots/e2e-eligibility-dashboard-0.0.37/`。
- `pnpm build`：PASS，Chrome MV3 总大小约 1.3 MB。
- `pnpm build:firefox`：PASS，Firefox MV2 总大小约 1.3 MB。
- `pnpm zip:firefox`：PASS，Firefox ZIP 374,647 bytes。
- XPI：`.output/openai-plus-vxt-0.0.37-firefox.xpi`，381,727 bytes。
- XPI SHA-256：`3F189F7D4BF8D1AD5C2E36F742777C1997713F64C6CD472895295E1D72C1D9CB`。
- XPI 归档复核：manifest `0.0.37`，Gecko ID `openai-plus-vxt@local.opx`，`incognito=spanning`，包含 `manifest.json`、`background.js`、`automation-settings.html`。

## 在线证据

- 旧账号严格资格实测 US/PH/VN/KR 4 次均成功创建普通 Checkout，但零金额/试用 0/4；PH 为 110000 PHP minor units，未进入试用命中库。
- `0.0.37` 使用 Mullvad 实际用户配置副本实测“一键同步当前登录会话”，结果为未读取到登录 session；扩展记录身份门并停止 Hosted/支付方式推断，没有伪造 `cs_`、Hosted URL、PayPal、MoMo 或 KakaoPay。
- 在线证据位于 `.context-snapshots/live-eligibility-0.0.36/result-profile-session-sg.json`（0.0.36 会话同步实测）；JWT 匹配 0，失败页面邮箱已脱敏。

## 0.0.37 认证缺口补齐证据（2026-08-01）

- AT 四通道交叉验证结论：用户提供的 AT 在 `api.openai.com/v1/models`、`/v1/me`、`chatgpt.com/backend-api/me`（curl_cffi 指纹经 socks5 前置）和真实浏览器扩展上下文均返回 `401 invalid_jwt` / `unauthorized_unknown`，属 token 失效而非通道/代理/指纹问题。
- 机制验证结论：`/api/auth/session` 只认 next-auth cookie（`__Secure-next-auth.session-token`），Bearer AT 无法换取 session；方向为 cookie -> 刷新 AT（参考项目 gopay `_build_chatgpt_session` 同构）。纯 AT 无法驱动 Hosted 页面/Stripe 支付方式，必须有网页登录形成的 cookie 快照。
- 新增 `tests/token-auth.test.ts`：PASS，4/4（分类器、Cookie 头、401 credentialInvalid、CF 403 不误判）。
- 全量行为测试：checkout-pipeline 5/5、hosted-resolution 5/5、auth-cf 6/6、payment-runner 15/15、probe-readiness 16/16、token-auth 4/4，共 51/51 通过；`npm run compile` 0 errors。

## 复核边界

行为测试证明请求顺序、解析、重建和指标契约；当前浏览器配置没有对应账号登录 Cookie，因此 `resolved_hosted` 在线正例以及 PayPal/MoMo/KakaoPay 资格保持仍需在该账号完成一次网页登录后复测。线上资格与方式由实时账号、出口和上游规则决定，不以本地 fixture 代替线上命中结论。

## AT -> Session 协议级否决验证（2026-08-02）

- 探测脚本：`scripts/at-web-session-probe.py`，证据：`.context-snapshots/at-web-session-probe/result.json`。
- A/B 对照：同一浏览器会话下，`POST /api/auth/signin/openai -> /api/accounts/authorize` 带 Bearer 与不带 Bearer 的响应完全一致（200 login_start，continue_url=/log-in，创建 `authsess_`），证明 authorize 不消费 AT。
- Token Exchange 四形态均被 auth.openai.com/oauth/token 拒绝：RFC8693 subject_token=AT -> `token_expired`；jwt-bearer assertion=AT -> `invalid_grant`；refresh_token 空 -> `empty_string`；subject_token_type=refresh_token -> `invalid_value`。
- 结论：AT 无法经 authorize、token exchange 或 cookie 伪造换取网页 Session；`/api/auth/session` Bearer 只返回 WARNING_BANNER。方向唯一为 网页登录 Cookie -> /api/auth/session -> 刷新 AT。Hosted 长链/支付方式证据必须依赖真实网页登录形成的 Cookie 快照，插件记录 `identity_required` 属正确行为而非缺口。
