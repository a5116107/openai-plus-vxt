# 任务状态

| ID | 任务 | 状态 | 验收信号 |
| --- | --- | --- | --- |
| QR-01 | 建立质量缺口分类 | 完成 | README 区分代码、文档、运行时、证据和工具 |
| QR-02 | 补齐 AppSec 10 项控制 | 完成 | AppSec 基线入口零缺失控制 |
| QR-03 | 修复 CommonJS guardrail 运行边界 | 完成 | skills/secrets/security 脚本不再因 `require` 退出 |
| QR-04 | 平衡实验专项与 E2E | 完成 | compile、2 个 smoke、浏览器看板全部 PASS |
| QR-05 | 刷新 execute/verify 证据 | 完成 | execute 检查点、P1-P4 与 verify-evidence 均为 PASS |
| QR-06 | 总质量门复核 | 完成 | spec、quality、proof bundle、review loop 全部 PASS，blockers 为空 |
| QR-07 | 0.0.37 双端交付 | 完成 | fork 预发布已包含 Chrome ZIP、Firefox XPI、SHA-256 清单和回滚说明 |
| QR-08 | 浏览器主流程与清理超时回归 | 部分完成 | 三阶段出口、邮箱池、随机选择、清理、会话交接已真实验证；真实优惠命中入库尚无样本 |
| QR-09 | workflow/AppSec 收口 | 完成 | workflow stack 与 AppSec 基线纳入版本控制，CommonJS guardrail 边界修复，总质量复核 blocker=0 |
| QR-10 | 跨迁移结构预算治理 | 完成（本地范围） | OAuth 日志、probe hit/report、国家出口解析已拆为职责模块；接码超时取消/本地记账失败显式进入日志和结果；剩余 184 文件迁移预算继续 advisory |
| QR-11 | Firefox lint 与 DOM 挂载契约 | 完成（本地范围） | 统一 `DOMParser + replaceChildren` 挂载 helper，入口与支付/面板不再直接赋值 `innerHTML`；Firefox minimum version 提升至 142；lint 0/0/0 |
| QR-12 | 全流程 E2E 终态与身份门分层 | 完成（本地范围） | 自动化失败终态不再伪等待 120 秒；Saved Payment UI 将预期 401/403 身份门与布局错误分离；基线截图只在显式开关下更新 |
| QR-13 | SSOT 全域一致性门 | 完成（本地范围） | 自动检查领域三件套、非完成任务根索引覆盖、未勾选验收白名单和 Saved Payment live 输入完整性 |
| QR-14 | E2E 失败 harness 职责拆分 | 完成（本地范围） | 确定性失败编排迁至 `tests/support`；生产入口只保留运行逻辑和终态识别，命令契约不变 |
| QR-15 | 外部门证据时效收口 | 完成（本地范围） | 历史 live profile 证据显式标注日期；当前 preflight、profile probe 与上游 PR 403 结果独立记录并由 SSOT 测试锁定 |
