# 验证记录

| 验证项 | 命令 | 当前结果 |
| --- | --- | --- |
| TypeScript | `npm run compile` | PASS |
| 因素分析 | `node tools/_eligibility_analysis_smoke.mjs` | PASS |
| 平衡排程 | `node tools/_eligibility_experiment_smoke.mjs` | PASS |
| Chrome 构建 | `npm run build` | PASS |
| AppSec 基线 | `quality-guard appsec-baseline-entry` | PASS，10/10 |
| Skills consistency | `node scripts/guardrails/skills-consistency.js --strict` | PASS |
| SkillCompass | `node scripts/workflow/skills-quality-gate.mjs --format ai` | PASS，D1-D6 全 5/5 |
| Stack full | `node scripts/workflow/stack-run.mjs --profile full --format ai` | PASS |
| Execute 证据 | `dev-workbench patch-entry --phase execute --no-chain` | PASS，checkpoint 已刷新 |
| Verify evidence | `quality-guard verify-evidence-entry` | PASS，参考仓库未进入 `impactedPy` |
| 总质量门 | `quality-guard review-entry --phase verify --mode review-quality --no-chain` | PASS，blockers 为空 |
| 浏览器 E2E | `node scripts/e2e-eligibility-dashboard.mjs` | PASS，17/17 |
| 三阶段动态出口 | `OPX_E2E_AUTH_PORT=28092 OPX_E2E_CHECKOUT_PORT=28093 OPX_E2E_BILLING_PORT=28091 node scripts/e2e-proxy-stages.mjs` | PASS，Auth=JP、Checkout=US、Billing=IN；三阶段已验证、不同且阶段内黏性通过 |
| 主流程清理边界 | `OPX_E2E_FORCE_MISSING_CLEANUP_TARGET=1 node scripts/e2e-extension.mjs` | PARTIAL，清理未阻塞且推进至会话交接/Checkout；180 秒窗口内未形成终态命中 |
| Firefox lint | `web-ext lint --source-dir .output/firefox-mv2` | PASS，0 error / 0 notice；23 warnings 待后续逐项消减 |
| Firefox XPI | `npm run zip:firefox` | PASS，0.0.26，已同步 Firefox/Mullvad 两份 XPI |

交付 SHA-256：`E3D5ED3E5031DC735A087A6A55BD54EC5D6576C7D949F1A09898F0941D012038`。
