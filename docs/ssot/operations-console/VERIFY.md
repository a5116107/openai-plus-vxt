# 验证矩阵

复核时间：2026-08-09

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
| IndexedDB 归档与迁移 | `npx tsx --test tests/probe-archive-worker.test.ts` | PASS（迁移幂等、分页/筛选、导出/清理、降级） |
| 隔离上下文调度 | `npx tsx --test tests/probe-archive-worker.test.ts` | PASS（同 context 串行、异 context 并发、失败/取消释放） |
| OC-10/11 TypeScript | `npm run compile` | PASS |
| 归档运营页扩展 E2E | `npm run test:e2e-operations-console` | PASS（12/12，迁移、分页、筛选、导出、保留策略、桌面/390px、页面/控制台错误 0） |
| 既有资格看板回归 | `node scripts/e2e-eligibility-dashboard.mjs` | PASS（32/32，页面/控制台错误 0） |
| 自动化零元命中回归 | `node scripts/e2e-automation-qualification.mjs` | PASS（10/10，命中库及账号/国家/币种/链接关联） |
| 三阶段出口回归 | `npm run test:e2e-proxy-stages` | PASS（阶段应用、互异性、元数据和下一周期） |
| Plus Closure fixture | `npm run test:e2e-plus-closure` | PASS（保存卡缺失门、账单字段、重复提交保护） |

浏览器证据目录：`.context-snapshots/e2e-eligibility-dashboard-0.0.28/` 与 `.context-snapshots/e2e-automation-qualification-0.0.28/`。结果 JSON 必须满足页面错误 0、控制台错误 0；看板移动端无整页横向溢出，资格 E2E 必须验证命中记录持久化和完整字段关联。

交付制品 `dist/openai-plus-vxt-0.0.28.xpi` 与 `dist/openai-plus-vxt-0.0.28-mullvad.xpi` 的 SHA-256 均为 `4068C0B01A8C312D12FFDE726AFE26313B5F560275C32D69EB4A03AB9480211C`。

## 尚未满足的验收

- 在线上游真实产生了 `US$0.00` Checkout，但修复前逻辑未入库；修复后确定性真扩展 E2E 已入库，线上重跑受 Cloudflare challenge 和 seed 连接失败影响，所以“修复版在线完整成功证据”保持待复测。
- 当前历史样本支持 Checkout 国家/路线具有较强稳定关联，但具体 IP、账号主效应和随机性仍存在混杂，继续按平衡实验积累。
- 0.0.37 隔离收口工作树已 clean，`quality-guard review-entry --no-chain` 为 SUCCESS；在线完整成功证据仍按 OC-09 保持待复测。
- 当前内置代理适配器是 `browser-global`，所以本地验证只证明安全串行和隔离 Worker 契约；真实多 profile/外部 Worker 并发吞吐需要接入提供 `isolationProof` 的适配器后追加环境证据。
- 归档保留策略 E2E 使用 65 条样本，其中 1 条超过 30 天，执行后 IndexedDB 观测计数为 64，热状态未被清理。
