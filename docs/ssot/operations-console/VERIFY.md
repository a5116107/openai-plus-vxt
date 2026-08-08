# 验证矩阵

复核时间：2026-07-29

| 能力 | 证据 | 结果 |
|---|---|---|
| 运行模型与进度 | `node tools/_probe_runtime_smoke.mjs` | PASS |
| 健康剔除与国家计划 | `node tools/_probe_logic_smoke.cjs` | PASS |
| 因素分析 | `node tools/_eligibility_analysis_smoke.mjs` | PASS |
| 平衡实验排程 | `node tools/_eligibility_experiment_smoke.mjs` | PASS |
| 0 元金额判定 | `node tools/_automation_qualification_smoke.mjs` | PASS |
| TypeScript | `npm run compile` | PASS |
| Chrome 构建 | `npm run build` | PASS |
| 浏览器页面与后台交互 | `node scripts/e2e-eligibility-dashboard.mjs` | PASS（32/32） |
| 自动化 0 元命中入库 | `node scripts/e2e-automation-qualification.mjs` | PASS（10/10） |
| Firefox 构建与 lint | `npm run build:firefox`、`web-ext lint` | PASS |
| Firefox XPI | `npm run zip:firefox` | PASS |

浏览器证据目录：`.context-snapshots/e2e-eligibility-dashboard-0.0.28/` 与 `.context-snapshots/e2e-automation-qualification-0.0.28/`。结果 JSON 必须满足页面错误 0、控制台错误 0；看板移动端无整页横向溢出，资格 E2E 必须验证命中记录持久化和完整字段关联。

交付制品 `dist/openai-plus-vxt-0.0.28.xpi` 与 `dist/openai-plus-vxt-0.0.28-mullvad.xpi` 的 SHA-256 均为 `4068C0B01A8C312D12FFDE726AFE26313B5F560275C32D69EB4A03AB9480211C`。

## 尚未满足的验收

- 在线上游真实产生了 `US$0.00` Checkout，但修复前逻辑未入库；修复后确定性真扩展 E2E 已入库，线上重跑受 Cloudflare challenge 和 seed 连接失败影响，所以“修复版在线完整成功证据”保持待复测。
- 当前历史样本支持 Checkout 国家/路线具有较强稳定关联，但具体 IP、账号主效应和随机性仍存在混杂，继续按平衡实验积累。
- 仓库存在大量会话前已有改动，发布工作流的 clean-worktree 门禁作为工作区例外记录，不覆盖本轮编译、E2E、lint 和制品哈希证据。
