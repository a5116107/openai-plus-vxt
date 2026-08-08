# 验证记录

## 自动验证

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| TypeScript | `npm run compile` | PASS |
| 因素统计场景 | `node tools/_eligibility_analysis_smoke.mjs` | PASS |
| 平衡排程场景 | `node tools/_eligibility_experiment_smoke.mjs` | PASS |
| 0 元金额判定 | `node tools/_automation_qualification_smoke.mjs` | PASS（5 个零元 / 5 个非零） |
| Chrome MV3 构建 | `npm run build` | PASS |
| Firefox MV2 构建 | `npm run build:firefox` | PASS |
| XPI 打包 | `npm run zip:firefox` | PASS |
| Firefox 扩展 lint | `npx web-ext lint --source-dir .output/firefox-mv2` | PASS（0 errors / 0 notices） |
| 设置页浏览器 E2E | `node scripts/e2e-eligibility-dashboard.mjs` | PASS（32/32） |
| 0 元资格入库 E2E | `node scripts/e2e-automation-qualification.mjs` | PASS（10/10） |

合成场景结果：账号、国家、出口、账号×国家交互均为 `strong`；控制账号后的国家效应、控制账号+国家后的具体 IP 效应、控制账号+国家后的顺序效应均为 `strong`；国家与 IP 绑定会触发混杂告警；规则突变产生漂移告警。

## 代码复核

- 观测不包含 access token，账号只存匿名稳定 ID。
- 多通道结果不再把同一次国家评估重复累加为多个国家样本。
- 高命中排序包含 Wilson 95% 区间，按下界优先。
- 浏览器存储有可配置上限，清空因素数据不影响命中链接数据库。
- 健康检查记录实际 IP、国家、IPv4/IPv6、ASN、组织、colo 和网络粗分类。
- Auth/Checkout/Billing 实际证据与 bootstrap/promotion/provider seed 摘要分别保存。
- 漂移检测不足最小样本时不告警。
- 资格率分母排除请求错误，错误率单列；因素组置信度使用明确结果数。
- 证据质量报告包含协议一致性、三阶段出口验证覆盖、明确结果覆盖、矩阵平衡度和最小可检测差异。
- 全局资格率漂移后自动定位变点并切换当前规则纪元；浏览器场景 80 条历史观测自动切换为当前纪元 40 条。
- 研究模式使用账号错位国家顺序，且命中后仍完成剩余矩阵。
- 同一单元在最小复测间隔内进入 cooldown；完整矩阵、双向覆盖、跨时段和总样本共同控制证据等级。
- 缺失或未完成单元进入下一轮自适应实验建议。
- JSON 导入接受数组和 `schemaVersion: 2` 导出对象；CSV 导入校验最小字段并解析三阶段出口扁平字段。
- `merge` 按观测 ID 去重，`replace` 独立替换因素观测；两种模式均执行拒绝计数、容量裁剪和自动重算。
- 匹配对照输出匹配层数、匹配样本、调整后百分点差、方向一致率、z 值和证据等级。
- 混杂审计识别国家×IP、国家×ASN、国家×顺序、账号×国家、IP×账号和路线×国家绑定。
- 统计功效给出 10/15/20pp 三档目标；重复稳定性给出单元稳定率和相邻结果转移率。
- 注册页 content-script 操作有 25 秒响应边界；网络中断会轮换 Auth 出口，验证码等待使用 `otpWaitSeconds` 配置。
- 邮箱池没有下一项时保留当前失败步骤和错误日志，不再先清空进度导致 E2E 误判超时。
- 本次 OTP 配置回归：`OPX_E2E_OTP_WAIT_SECONDS=30` 后，流程约 30 秒进入正式失败终态，未再使用旧的 180 秒硬编码。

## 0 元资格捕获复核

- 在线证据 `.context-snapshots/e2e-full-flow-live-0.0.27/chrome-e2e-result.json` 已真实走完注册、OTP、Profile、Session、探测池交接和 Checkout，并读取到 `US$0.00`；旧逻辑仍提交支付并等待 PayPal，最终 `probeHitCount=0`、`hitDatabaseCount=0`。
- 修复后，明确 0 元会在 Checkout ready 后立即生成 `hitKind=zero` 记录，保存账号、国家、币种、原始链接及 Checkout/Billing 出口证据，并跳过支付提交。
- 确定性真扩展证据 `.context-snapshots/e2e-automation-qualification-0.0.28/result.json` 验证 10/10：步骤成功、记录持久化、金额/账号/国家/币种/链接关联正确、页面与扩展控制台错误均为 0。
- 修复后两次在线复测分别停在 Cloudflare challenge 401/403 和 Auth seed `Failed to fetch`；因此代码闭环已验证，线上修复版同轮入库仍待健康出口恢复后复测。

## 真实结论复核

参考环境真实记录为 729 条、58 个账号；明确资格结果 177 条，其中 94 命中。JP Checkout 81/94，IN 0/52；11 个同时覆盖两国的账号全部 JP 高于 IN。26 个重复账号×国家单元仅 1 个发生变化。

复核结论：纯账号绑定和完全逐请求随机解释均明显减弱；Checkout 国家/路线为当前最强稳定关联。具体出口 IP 因 160 个 IP 中仅 2 个覆盖多个账号而证据不足；TH 9/9、VN 4/4 均集中于单账号，不进入稳定高概率国家推荐。顺序、周期、账号 cohort 与路线配置仍是主要混杂。

## 浏览器实测

证据：`.context-snapshots/e2e-eligibility-dashboard-0.0.28/result.json`

- 0.0.28 真扩展加载、11 个研究配置项、80 条历史观测/当前纪元 40 条渲染：PASS。
- 证据质量状态、错误率、协议数、三阶段出口验证、矩阵平衡、MDE 与规则纪元：PASS。
- 因素表、6 类结论、漂移表、自适应建议：PASS。
- 4 账号 × 2 出口矩阵、缺失单元、双向覆盖和证据降级：PASS。
- 刷新、CSV 导出、JSON 导出、独立清空：PASS。
- 设置页 JSON 粘贴导入后观测数 `80 -> 81`，因素、漂移、纪元、矩阵和建议自动重算：PASS。
- 后台 CSV 导入后观测数 `81 -> 82`，三阶段字段进入分析且无需页面刷新：PASS。
- 390px 移动视口无页面级横向溢出：PASS。
- 页面错误和控制台错误：0。
- 52 个账号资产、50 条真分页、凭据状态筛选、邮箱搜索和批量停用/启用：PASS。
- 2 个账号 × 5 个国家的 10 个运行单元、完成 8、实际请求 7、跳过 1：PASS。

截图：`desktop-factor-dashboard.png`、`mobile-factor-dashboard.png`。

## 注册流程真实浏览器边界

证据：`.context-snapshots/e2e-register-terminal-final-0.0.26/chrome-e2e-result.json`

- 真扩展加载、设置页、随机邮箱模式、邮箱自动选择、Cookie 清理、Auth 链式代理、注册页打开和邮箱提交：PASS。
- Auth 实际出口验证：`127.0.0.1:28091`，流程日志记录为 IN；三阶段端口配置为 `28091/28092/28093`。
- 已进入 `https://auth.openai.com/email-verification`，验证码控件就绪：PASS。
- Acica API 与 Web 邮件列表均返回 HTTP 530，流程在配置的 30 秒等待后形成 `failed` 终态；`fullAutomationReachedTerminal=true`、页面错误 0、扩展控制台错误 0。
- 本轮因邮箱服务 HTTP 530 未进入 profile、Checkout、Billing 和命中链接入库，不能把该轮标记为“完整成功”；命中数据库没有新增真实链接。

## 代理阶段实测

证据：`.context-snapshots/e2e-proxy-stages-research-live-0.0.26/result.json`

- Auth、Checkout、Billing 均应用并验证独立阶段出口。
- 三阶段实际 IP/国家不同，Auth 阶段内保持黏性，下一周期重新验证通过：PASS。
- 该证据只证明阶段路由能力，不单独证明具体 IP 的资格主效应。

当前出口复测：`.context-snapshots/e2e-proxy-stages-live-qualification-fix-0.0.27/result.json`。Checkout/US `75.224.101.234` 验证成功，Auth/JP 与 Billing/IN 当前 `Failed to fetch`；Auth 阶段黏性仍通过。该结果记录 seed 健康波动，不覆盖此前三阶段全部成功证据。

## 0.0.33 处理真实性与在线复测

新增验证：

- `npm run compile`：PASS。
- `npm run test:payment-runner`：11/11 PASS。
- `npm run test:probe-readiness`：12/12 PASS；新增国家处理不匹配排除与覆盖矩阵隔离场景。
- `node tools/_eligibility_analysis_smoke.mjs`：PASS；账号、国家、出口、交互及三类受控效应均为 strong（合成数据）。
- `node tools/_eligibility_experiment_smoke.mjs`：PASS。
- `node tools/_multi_factor_experiment_smoke.mjs`：PASS。
- `node tools/_automation_qualification_smoke.mjs`：PASS（5 个零元、5 个非零）。
- `node scripts/e2e-eligibility-dashboard.mjs`：0.0.33 PASS，40 个检查项全部为 true，页面/控制台错误 0。
- `node scripts/e2e-automation-qualification.mjs`：0.0.33 PASS，10 个检查项全部为 true，零元资格链接成功入库。
- Chrome MV3、Firefox MV2 构建与 Firefox XPI 打包：PASS。

真实矩阵证据：`.context-snapshots/live-eligibility-0.0.32/result-quality-matrix-2x2-retry.json`。

- 2 个账号 × HK/JP，共执行 4 个单元；流程完成 4/4。
- 通用 SOCKS5 出口可用，目标域 TLS 探针失败；4 条均为 `network-proxy`，错误率 100%。
- HK 计划处理生效 2/2；JP 两条实际 Checkout 国家仍为 HK，处理未生效 0/2。
- 明确资格结果 0、可归因样本 0、支付方式提交 0、严格资格命中 0、有效终链 0。
- 该轮不支持账号、国家、IP、ASN、支付方式或随机性结论，只验证了处理一致性门和错误隔离。

当前版本最小在线证据：`.context-snapshots/live-eligibility-0.0.33/result-0.0.33-current-minimal.json`。

- 0.0.33 XPI 安装、1 个账号导入、任务保存、HK Checkout 出口验证和 1/1 单元执行完成。
- 通用出口健康；健康检查 IP `43.199.44.70/HK`，运行轮出口 `43.199.180.71/HK`。
- 目标域 TLS 失败，观测为错误 1、明确结果 0、可归因 0、资格命中 0、有效终链 0。
- 定量摘要按账号、计划/实际国家、Checkout IP、计划/提交支付方式分别输出；无明确结果时 rate 为 null、Wilson 区间 0%–100%。

执行器代理同步证据：

- 候选端口只读探测：`10808` 通用出口为 HK，但 ChatGPT TLS 失败；`18090–18093`、`28091–28093` 均由本地 HTTP 链返回 502。
- 白名单 API 临时提取的 HK、JP、US、IN 首个节点均同时通过 Cloudflare 与 ChatGPT trace，实际国家分别为 HK、JP、US、IN；说明新鲜短期节点可满足目标域与国家一致性门。
- 节点过期后再次探测返回 SOCKS5 认证拒绝；白名单 API 随后明确返回当前来源 IP 未登记。账号网关的 `sg2:443`、`sg:443`、`us2:3010`、`us:443` 在四个国家全部返回 502。
- `.context-snapshots/live-eligibility-0.0.33/result-hk-http-29090-minimal.json`：参数化 HTTP 前置成功访问目标域并完成 1×1 流程；修复前扩展代理仍为 `proxy-disabled`，样本为错误且未归因。
- `.context-snapshots/live-eligibility-0.0.33/result-proxy-sync-failure-smoke.json`：修复后 `proxySetup.saved=true`，Checkout 证据源为 `country-map`，实际 IP/国家和子网均入观测；目标域请求失败时仍为 `network-proxy + invalid`，可归因 0。
- 严格模式新增提前门：目标域预检失败、显式期望国家错位或扩展健康检查实际国家不匹配时，在账号实验前停止。

实现复核：请求错误和处理未生效样本保留在原始日志、错误率与漂移输入中，但不进入资格率、因素分组、匹配效应、覆盖矩阵、cooldown 或证据门。候选 Checkout 已创建但严格资格门未通过时，记录保留候选链接状态，同时 `qualificationVerified=false`、`linkUsable=false`。

## 交付包

当前版本：

- `dist/openai-plus-vxt-0.0.33.xpi`
- `dist/openai-plus-vxt-0.0.33-mullvad.xpi`
- SHA-256：`FE8DDA4DF4BA2F65828AF936712F4F5FDC57BEF484D1A2E944EBA0F31757E8A9`（两份制品一致）。

历史版本：

- `dist/openai-plus-vxt-0.0.28.xpi`
- `dist/openai-plus-vxt-0.0.28-mullvad.xpi`
- SHA-256：`4068C0B01A8C312D12FFDE726AFE26313B5F560275C32D69EB4A03AB9480211C`（两份制品一致）。
