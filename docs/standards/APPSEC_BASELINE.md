# AppSec Baseline

本基线用于 OpenAI Plus VXT 浏览器扩展。扩展在本地编排注册、代理、邮箱、优惠评估和支付方式探测，不提供服务端账号系统、角色系统或 SQL 数据库。所有“不适用”项仍记录边界、证据和触发重新评估的条件。

## 控制矩阵

| ID | 适用性与当前实现 | 代码/配置证据 | 验证与残余风险 |
| --- | --- | --- | --- |
| APPSEC-AUTH-01 | 部分适用。身份源为上游 OpenAI 会话；扩展导入 access token，不采集或验证密码/MFA。上游认证失败进入分类日志与重试状态。 | `src/features/probe/state.ts` 的账号解析；`src/features/automation/runner-errors.ts` 的错误分类。 | `npm run compile`。账号枚举、MFA、锁定由上游负责；扩展需避免在日志和研究导出中泄露 token。 |
| APPSEC-RBAC-02 | 当前不适用。扩展没有多用户服务端资源、角色或租户，所有数据位于当前浏览器配置域。 | `src/app/storage-scope.ts`；扩展 manifest 无服务端管理接口。 | 新增共享看板、远端 API 或多租户同步时必须建立 subject/action/resource/condition 矩阵。 |
| APPSEC-SESSION-03 | 部分适用。上游 token 只用于当前浏览器流程；研究观测与因素导出不包含 token。 | `src/features/probe/types.ts` 中 `ProbeObservation`；`src/features/probe/service.ts` 的因素导出。 | `node tools/_eligibility_experiment_smoke.mjs`。账号池仍在浏览器本地保存 tokenRaw，属于显式残余风险；浏览器配置目录必须受操作系统账号保护。 |
| APPSEC-SECRETS-04 | 适用。API key 输入使用 password 控件，界面显示时掩码；代理凭据仅以脱敏 endpoint summary 进入日志和观测。 | `entrypoints/automation-settings/main.ts` 的 provider key 控件；`src/features/probe/service.ts` 的 `sanitizeEndpointSummary`。 | `node scripts/guardrails/secrets-scan.js`。本地 storage 中的 token/API key 仍依赖浏览器配置保护，不应同步到公开配置。 |
| APPSEC-OWASP-05 | 适用。主要边界是扩展 DOM 渲染、广泛 host permission、本地 secrets、代理配置和第三方响应解析；本轮复核 XSS、敏感信息、依赖、配置与 URL 边界。 | `wxt.config.ts`；`entrypoints/automation-settings/main.ts`；`src/features/proxy/*`。 | `node scripts/guardrails/security-scan.js --scan-changed`、浏览器 E2E。广泛 host permission 是功能需要，也是持续残余风险。 |
| APPSEC-SUPPLY-06 | 适用。Node 依赖由 `pnpm-lock.yaml` 固定，构建产物由 WXT 生成并计算 SHA-256。 | `package.json`、`pnpm-lock.yaml`、`wxt.config.ts`。 | `node scripts/guardrails/deps-guard.js --strict`、`npm run build`、`npm run build:firefox`。发布前复核依赖告警和 XPI 哈希。 |
| APPSEC-SSRF-07 | 部分适用。扩展不提供任意 URL 抓取 API；健康检查和业务请求目标由代码固定，用户代理地址只进入浏览器代理配置。 | `src/features/probe/service.ts` 的健康检查固定目标；`src/features/proxy/state.ts` 的代理解析。 | `npm run compile`。若以后加入用户 URL 抓取、webhook 或回调转发，必须增加协议、私网、重定向、超时和大小限制。 |
| APPSEC-XSS-08 | 适用。设置页使用模板渲染，但所有来自账号、国家、日志、代理、链接和上游响应的动态字段进入 `innerHTML` 前走 `escapeHtml`/`escapeAttr`。 | `entrypoints/automation-settings/main.ts` 的 `escapeHtml`、`escapeAttr` 及因素/矩阵/日志渲染。 | 浏览器 E2E 页面错误为 0；继续禁止将未经编码的外部字段写入 HTML，URL 打开动作必须保持独立属性编码。 |
| APPSEC-SQLI-09 | 当前不适用。扩展没有 SQL/NoSQL/LDAP 查询或 shell 拼接的数据通道，本地数据使用浏览器结构化 storage。 | `src/features/probe/state.ts`、`src/features/run-log/state.ts`。 | 新增远端数据库、命令调用或动态模板查询时重新启用注入测试。 |
| APPSEC-PERM-10 | 当前不适用。没有服务端角色、tenant 或 owner 资源；扩展权限由浏览器 manifest 和当前配置域控制。 | `wxt.config.ts` permissions/host_permissions；`src/app/storage-scope.ts`。 | 新增云同步或团队共享时必须覆盖跨租户、水平和垂直权限拒绝用例。 |

## 发布验证

1. `npm run compile`
2. `node scripts/guardrails/secrets-scan.js`
3. `node scripts/guardrails/security-scan.js --scan-changed`
4. `node scripts/guardrails/deps-guard.js --strict`
5. `node C:/Users/Administrator/.codex/skills/quality-guard/scripts/appsec-baseline-entry.mjs --phase verify --mode appsec-baseline --format both`

## 持续风险

- 浏览器本地账号池保存上游 token，研究观测、运行日志和导出必须持续保持脱敏。
- 扩展使用广泛 host permissions 和代理权限；发布包来源、哈希和安装浏览器配置需可追踪。
- 动态代理、支付页面和第三方邮箱接口均可能改变响应结构；解析失败按错误记录，不把错误折算成无资格。
