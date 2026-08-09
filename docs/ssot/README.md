# SSOT 全域状态索引

本文件只负责跨领域状态与未完成项汇总。领域契约、任务和验收仍分别由各目录的 `README.md`、`TASKS.md`、`VERIFY.md` 管理；冲突时以领域文件中的行为契约和本索引中的跨域完成边界共同判定。

## 当前完成边界

- 版本：`0.0.37`。
- 本地实现：试用资格分类、严格晋级、十类支付方式候选与终链、保存支付方式、Plus 双 Checkout、Auth/Checkout/Billing 多阶段出口、恢复不重放、IndexedDB 归档、独立运营页面、隔离上下文调度和脱敏证据均已落地。
- 本地验证：TypeScript、145 项全量测试、6 项 SSOT 一致性测试、3 项 Saved Payment 后端测试、Chrome/Firefox 构建、Firefox lint 0/0/0、归档运营页 12/12、资格看板全部断言、自动化零元命中 10/10、自包含三阶段出口 E2E、Plus Closure 浏览器 fixture 和仓库质量复核均通过。
- 发布：fork 预发布 `v0.0.37-ssot.2`（`b29982b`）已包含本轮 Chrome ZIP、Firefox ZIP、sources ZIP、发布清单和回滚说明；`v0.0.37-ssot.1` 保留为上一基线。
- 质量策略：功能、安全、工作流和证据门为 PASS；QR-11 已统一 DOM 挂载并将 Firefox lint 清零，QR-12 已分层自动化终态与 live 身份门，QR-13 已建立 SSOT 自动一致性门，QR-14 已将失败终态 harness 从生产 E2E 入口迁至测试 support，QR-15 已分离历史 live 证据与当前外部门状态，QR-16 已建立显式全仓结构基线并消除 `runner-format` 复杂度告警；当前变更严格 change/shape gate 为 PASS。

## 领域状态

| 领域 | 实现状态 | 当前验证边界 |
| --- | --- | --- |
| `auth-cf-recovery` / `e2e-fpi` | 完成 | CF/业务 403 分类、出口轮换、FPI 清理和超时边界已验证 |
| `checkout-extraction-v2` | 完成 | 本地与历史在线失败分支已验证；CE2-14 仍需有效登录 Session 正例 |
| `e2e-acica-auto` / `e2e-mailbox-pool` / `register-tool-env` | 完成 | 邮箱同步、导入、选择、OTP 和 Session 交接已有浏览器证据 |
| `eligibility-factors` | 完成实现 | EF-15/EF-26/EF-27/EF-32/EF-39/EF-42 属于真实数据或外部环境缺口 |
| `multi-factor-experiments` | 完成实现 | MF-18 等待真实多国家出口恢复后运行平衡矩阵 |
| `operations-console` | 完成实现 | OC-10 IndexedDB/运营页和 OC-11 隔离调度契约已完成；OC-09 等待在线同轮命中 |
| `payment-runner` | 完成 | 强制筛查不晋级、未知副作用不重放、终链白名单已验证 |
| `quality-remediation` | 完成（本地范围） | AppSec 10/10、skills、stack-run、verify-evidence、QR-10..QR-16 focused regression 与总复核通过；Firefox lint 为 0 error / 0 notice / 0 warning |
| `runtime-log` | 完成 | 运行日志、失败分级、广播、导出和 UI 已验证 |
| `saved-payment-methods` | 完成 | test merchant 的 SetupIntent、attached/reusable/default 和回滚已验证 |
| `smart-automation` | 完成 | controlled production-like Plus Closure 完整；公网同轮资格命中仍是外部验证 |
| `three-lines` | 完成 | 流程线、逻辑线、业务线及注册到探测衔接已验证 |
| `trial-payment-probe` | 完成 | TPP-001..013 全部完成；live 入口必须显式配置才产生真实结论 |
| `upl-alignment` | 完成 | UPL 对齐证据保留为领域历史验证 |

## 未完成任务的唯一汇总

| 类别 | 任务 | 所需输入/验收 |
| --- | --- | --- |
| 公网资格正例 | CE2-14、EF-32、OC-09、QR-08 在线部分 | 有效 ChatGPT live profile、真实账号、可用 Session；同轮形成严格资格与命中入库证据 |
| 真实多阶段出口 | MF-18、EF-42 | 至少三个可验证且互异的真实出口，恢复来源白名单和上游认证；同账号跨至少 2 个国家、每单元跨时段 3 次 |
| 因果样本积累 | EF-15、EF-27、EF-39 | 至少 10 账号 x 4 出口 x 3 时段，并达到各组功效目标 |
| 历史原始观测 | EF-26 | 找回 729 条汇总对应的逐次原始记录并通过导入器复算 |
| 真实支付输入 | live Saved Payment / Plus Closure | `SPM_E2E_PROFILE_DIR`、`SPM_E2E_PUBLISHABLE_KEY`、`SPM_E2E_BILLING_NAME`、`SPM_E2E_CARD_NUMBER`、`SPM_E2E_CARD_EXPIRY`、`SPM_E2E_CARD_CVC`，以及 `SPM_E2E_BACKEND_BASE_URL` 或 `SPM_E2E_STRIPE_SECRET_KEY`；只在测试模式形成可复核证据 |
| 上游交付 | `suyancc/openai-plus-vxt` PR/推送 | 上游仓库写权限或具备创建 PR 权限的 GitHub Token |
| 商店发布 | Chrome/Firefox 商店提交 | 对应商店开发者凭据、签名和审核资料 |

任何真实账号、资格、支付或出口结论只由显式 live profile 的同次运行证据产生；本地 fixture 只证明流程、状态机和安全边界。

## 当前结构基线

2026-08-09 使用显式文件清单严格扫描 `src/`、`entrypoints/`、`scripts/` 与 `tests/support/`：168 个文件、91 个 finding（84 advisory、7 baseline）、0 blocker。`src/features/automation/runner-format.ts` 已从 65 个决策点拆分至严格门 0 finding。旧版“184 文件迁移”是当时的分支差异规模，不再作为当前任务数量或结构验收口径；其余 finding 是已登记的仓库 advisory，不等同于未完成任务 ID。

## 可选外部扩展验证

OC-11 的本地隔离调度契约已经完成；若扩展真实隔离适配器，需提供至少两个不同 `proxyContextId`、非空 `isolationProof` 和真实互异出口，内置单 profile 仍保持并发 1。
