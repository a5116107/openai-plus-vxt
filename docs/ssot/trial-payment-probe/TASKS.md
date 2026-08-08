# 试用与多支付提链任务 DAG

本文件是 `trial-payment-probe/README.md` 的执行视图。状态初始为 `待实现`；完成项必须回写对应执行工件和验证证据。

## 依赖图

```text
TPP-001 -> TPP-002 -> TPP-003
TPP-003 -> TPP-004 + TPP-005 + TPP-006
TPP-006 -> TPP-007 + TPP-008
TPP-007 -> TPP-009
TPP-007 + TPP-008 -> TPP-010
TPP-004 + TPP-008 + TPP-010 -> TPP-011
TPP-005 + TPP-006 + TPP-011 -> TPP-012 -> TPP-013
```

## 任务清单

| ID | 批次 | 责任边界 | 依赖 | 交付与验收信号 | 状态 |
|---|---|---|---|---|---|
| TPP-001 | 契约 | `docs/ssot/trial-payment-probe` | - | README/TASKS/VERIFY 三件套存在，字段和不变量冻结 | 已完成（2026-08-06） |
| TPP-002 | 回归锁 | `src/features/link-extractor`, `src/features/probe` 测试 | TPP-001 | 现有零金额、trial、promo 测试基线可重复 | 已完成（2026-08-06；全量 123 项） |
| TPP-003 | 资格账本 | qualification types/evidence | TPP-002 | 8 类资格和 6 级证据可分类、晋级、降级 | 已完成（2026-08-06；资格账本测试） |
| TPP-004 | 严格解析 | checkout amount/HTML/API fixtures | TPP-003 | 结构化零金额、trial、promo、非零、未知均有 fixture | 已完成（2026-08-06；Checkout 8 项） |
| TPP-005 | 漂移 | factor tracking/drift store | TPP-003 | 金额、币种、身份、方式漂移生成事件并停止单元 | 已完成（2026-08-06；五类漂移测试） |
| TPP-006 | 方式发现 | payment detection/candidate selection | TPP-003 | detected/requested/forced 三层候选可审计，未暴露隔离 | 已完成（2026-08-06；readiness/candidate 测试） |
| TPP-007 | 复用 Checkout | native runner + probe service | TPP-006 | 复用源 session，资格保持失败不写支付 | 已完成（2026-08-06；Runner/证据门） |
| TPP-008 | 独立 Checkout | native runner + checkout factory | TPP-006 | 独立 session、身份一致、独立资格重验证 | 已完成（2026-08-06；distinct/identity/qualification 门） |
| TPP-009 | 终链白名单 | payment methods/adapters | TPP-007 | 10 类方式 URL 白名单、HTTPS 和敏感字段检查 | 已完成（2026-08-06；10 类 URL 矩阵） |
| TPP-010 | 一次写与恢复 | runner/checkpoint | TPP-007, TPP-008 | confirm/approve 单次、未知副作用只查询、重启可恢复 | 已完成（2026-08-06；脱敏持久检查点） |
| TPP-011 | 出口编排 | proxy/probe/UPL/runner | TPP-004, TPP-008, TPP-010 | Auth/Checkout/Billing/Runner 映射统一，代理锁并发=1 | 已完成（2026-08-06；阶段角色/处理锁测试） |
| TPP-012 | 调度与数据 | scheduler/dashboard/export | TPP-005, TPP-006, TPP-011 | hybrid 比例、预算、冷却、分母统计、脱敏导出通过 | 已完成（2026-08-06；60/25/15 + 浏览器看板） |
| TPP-013 | 浏览器与交付 | Chrome/Firefox/live fixture | TPP-012 | fixture/live、两浏览器构建、回滚和证据包通过 | 已完成（2026-08-06；双浏览器 + fixture + preflight） |

## 执行规则

- 每个任务只修改责任边界内文件；跨边界变更先在任务记录中登记。
- 每完成一个任务，写入 `command.outputs`、`checkpoint` 和对应测试结果；失败保留日志和恢复点。
- 任何试用资格成功必须同时满足源资格、方式呈现、资格保持、终链校验四类信号。
- Native 生产候选只消费 `provider-final` 及以上；Hosted 源长链必须具备严格源资格、同会话证据和终链白名单。`candidate/page/forced_probe` 仅用于研究和后续排程。
- 发现未知写副作用、身份错配、出口健康失败或连续资格漂移时，停止当前账号单元并等待人工复核。

## 任务完成信号

完成不是“代码已改”，而是：测试输出、脱敏证据哈希、状态机终态、任务回写和 `VERIFY.md` 对应勾选项同时存在。跨阶段问题回到最早失败的任务重跑，不通过追加兼容分支掩盖。
