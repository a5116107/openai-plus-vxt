# 验证记录

| 验证项 | 命令 | 当前结果 |
| --- | --- | --- |
| TypeScript | `pnpm compile` | PASS，0 error |
| 全量测试 | `pnpm tsx --test tests/*.test.ts` | PASS，125/125 |
| Saved Payment 后端 | `pnpm test:saved-payment-backend` | PASS，3/3 |
| 因素分析 | `node tools/_eligibility_analysis_smoke.mjs` | PASS |
| 平衡排程 | `node tools/_eligibility_experiment_smoke.mjs` | PASS |
| Chrome 构建 | `pnpm build` | PASS，Chrome MV3 1.48 MB |
| Firefox 构建 | `pnpm build:firefox` | PASS，Firefox MV2 1.48 MB |
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
| Firefox lint | `web-ext lint --source-dir .output/firefox-mv2` | PASS，0 error / 0 notice；23 warnings 待后续逐项消减 |
| 0.0.37 预发布 | `gh release view v0.0.37-ssot.1 --repo a5116107/openai-plus-vxt` | PASS，4 个资产已上传 |

交付 SHA-256：Chrome ZIP `4fa4db10814dd4c8514d2f357311ef100e7a2b3a3af1db31730a671a8fd74693`；Firefox XPI `5739225446632b2e613ea9185216ecdeacb30c551a29456861f6d9a5e946f008`。

结构预算说明：change/shape budget 对 184 文件迁移继续为 advisory；这不改变当前功能、安全、构建和证据门的 PASS，也不写成严格预算 PASS。
