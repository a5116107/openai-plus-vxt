# 验证记录

| 验证项 | 命令 | 当前结果 |
| --- | --- | --- |
| TypeScript | `pnpm compile` | PASS，0 error |
| 全量测试 | `pnpm tsx --test tests/*.test.ts` | PASS，146/146 |
| Live readiness 单元 | `pnpm test:live-readiness` | PASS，4/4 |
| Live readiness 当前审计 | `pnpm audit:live` | PASS（审计完成）；`targetReachable=true`、`uniqueEgressCount=1`、`identityReady=false`、`paymentReady=false`、`fullLiveReady=false`，证据脱敏 |
| Saved Payment 后端 | `pnpm test:saved-payment-backend` | PASS，3/3 |
| 因素分析 | `node tools/_eligibility_analysis_smoke.mjs` | PASS |
| 平衡排程 | `node tools/_eligibility_experiment_smoke.mjs` | PASS |
| Chrome 构建 | `pnpm build` | PASS，Chrome MV3 1.51 MB |
| Firefox 构建 | `pnpm build:firefox` | PASS，Firefox MV2 1.51 MB |
| AppSec 基线 | `quality-guard appsec-baseline-entry` | PASS，10/10 |
| Skills consistency | `node scripts/guardrails/skills-consistency.js --strict` | PASS |
| SkillCompass | `node scripts/workflow/skills-quality-gate.mjs --format ai` | PASS，D1-D6 全 5/5 |
| Stack full | `node scripts/workflow/stack-run.mjs --profile full --format ai` | PASS |
| Execute 证据 | `dev-workbench patch-entry --phase execute --no-chain` | PASS，checkpoint 已刷新 |
| Verify evidence | `quality-guard verify-evidence-entry` | PASS，参考仓库未进入 `impactedPy` |
| 总质量门 | `quality-guard review-entry --phase verify --mode review-quality --no-chain` | PASS，spec/quality/evidence/proof/review blockers 为空 |
| 三阶段出口 fixture | `pnpm test:e2e-proxy-stages` | PASS，12 项阶段/元数据/黏性/去重断言为真，三组代理均收到 4 次请求 |
| Plus Closure fixture | `pnpm test:e2e-plus-closure` | PASS，Saved Card 4242、账单 5 字段、重复提交 clickCount=1 |
| 浏览器 E2E | `node scripts/e2e-eligibility-dashboard.mjs` | PASS，17/17 |
| 三阶段动态出口 | `OPX_E2E_AUTH_PORT=28092 OPX_E2E_CHECKOUT_PORT=28093 OPX_E2E_BILLING_PORT=28091 node scripts/e2e-proxy-stages.mjs` | PASS，Auth=JP、Checkout=US、Billing=IN；三阶段已验证、不同且阶段内黏性通过 |
| 主流程清理边界 | `OPX_E2E_FORCE_MISSING_CLEANUP_TARGET=1 node scripts/e2e-extension.mjs` | PARTIAL，清理未阻塞且推进至会话交接/Checkout；180 秒窗口内未形成终态命中 |
| Firefox lint（QR-11） | `pnpm dlx web-ext lint --source-dir .output/firefox-mv2` | PASS，0 errors / 0 notices / 0 warnings；动态模板统一经 `DOMParser + replaceChildren` 挂载，manifest `strict_min_version=142.0` 满足 `data_collection_permissions` 契约 |
| QR-10 focused regression | `pnpm tsx --test tests/qr10-structure.test.ts` | PASS，3/3；脱敏日志、国家出口解析、支付方式报告模块均通过 |
| QR-10/QR-11 shape delta | `git diff --stat` + `pnpm compile` + `pnpm tsx --test tests/qr10-structure.test.ts` | PASS；既有高风险入口拆分保留；新增 `src/app/dom.ts` 统一挂载职责，55 个赋值点迁移且无循环依赖 |
| QR-12 主流程终态 | `pnpm test:e2e-terminal-boundary` | PASS；失效 Auth 出口在 `cleanup-environment` 形成结构化失败终态，约 8 秒返回，`fullAutomationReachedTerminal=true`，不再额外等待里程碑超时 |
| QR-12 Saved Payment UI | `node scripts/e2e-saved-payment-ui.mjs` | PASS；420px/360px 无溢出、越界和标签裁切；真实 Session 401/403 单列为 `identityGate`，非身份错误仍阻断 |
| QR-12 源码契约 | `pnpm tsx --test tests/qr10-structure.test.ts` | PASS，5/5；终态短路、本轮证据、身份状态精确匹配和截图基线路径均有邻近回归断言 |
| QR-13/QR-15/QR-16/QR-17 SSOT 一致性 | `pnpm test:ssot` | PASS，6/6；领域三件套、非完成任务根汇总、未勾选外部门、live 输入完整性、当前证据时效、结构基线与可执行命令均通过 |
| QR-14 harness 拆分 | `pnpm test:e2e-terminal-boundary` + `pnpm tsx --test tests/qr10-structure.test.ts` | PASS；失败编排位于 `tests/support`，生产 E2E 入口不再包含子进程 harness，六项终态边界断言保持通过 |
| QR-15 外部门实测 | `pnpm test:e2e-saved-payment:check` + 临时隔离 profile 直连/SG 复测 + GitHub GraphQL/REST PR 创建 | PASS（边界判定）；默认 profile/支付输入/测试后端缺失，历史 profile 副本两条路径的 Session 均为 403 且无账号/AT，当前 `gh pr create` 再次为 GraphQL 403，未形成 live 支付或上游交付结论 |
| QR-16 formatter 回归 | `pnpm tsx --test tests/runner-format.test.ts` | PASS，3/3；全部字段顺序和文案、falsy 字段、非对象输入保持兼容 |
| QR-16 聚焦结构门 | `structural-quality --files src/features/automation/runner-format.ts,tests/runner-format.test.ts --strict` | PASS，0 finding / 0 blocker；原 65 决策点函数已拆分 |
| QR-16 全仓结构基线 | 显式 `git ls-files` 清单 + `structural-quality --strict` | PASS（基线判定），168 文件、91 finding（84 advisory、7 baseline）、0 blocker；`runner-format.ts` 告警为 0 |
| QR-17 可执行结构门 | `pnpm test:structural-baseline` | PASS，1/1；Git 派生范围 168 文件，91 finding（84 advisory、7 baseline）、0 blocker，`runner-format.ts` 告警为 0 |
| 接码超时清理可观测性 | `pnpm compile` + `tests/qr10-structure.test.ts` | PASS；平台取消、本地订单记账和清理失败均保留可观测结果 |
| 0.0.37 预发布 | `gh release view v0.0.37-ssot.1 --repo a5116107/openai-plus-vxt` | PASS，4 个资产已上传 |

交付 SHA-256：Chrome ZIP `4fa4db10814dd4c8514d2f357311ef100e7a2b3a3af1db31730a671a8fd74693`；Firefox XPI `5739225446632b2e613ea9185216ecdeacb30c551a29456861f6d9a5e946f008`。

结构预算说明：本轮在既有高风险入口拆分、fallback 收敛和 DOM 挂载治理基础上，新增可复跑的 168 文件全仓基线、收敛 `runner-format.ts` 并将基线接入自动测试；其余 91 个 finding 按 84 advisory、7 baseline 登记，不写成零债务或严格全仓无告警。
