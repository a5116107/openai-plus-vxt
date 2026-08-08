# 保存支付方式任务 DAG

状态枚举：`待开始`、`进行中`、`完成`、`阻塞`。任务只有在 `VERIFY.md` 对应证据存在时才能标记完成。

| ID | 依赖 | 任务 | 主要产物 | 验收信号 | 状态 |
| --- | --- | --- | --- | --- | --- |
| SPM-01 | - | 固定三轴模型、状态机、错误和数据边界 | README/TASKS/VERIFY | SSOT 三件套互相回链 | 完成 |
| SPM-02 | SPM-01 | 实现方式/Intent/渠道能力类型与矩阵 | `types.ts`、`capabilities.ts` | Card、钱包、一次性方式行为测试 | 完成 |
| SPM-03 | SPM-01 | 持久化真实 ChatGPT accountId，并以其优先匹配账号 | probe type/state/import | session 导入和旧数据兼容测试 | 完成 |
| SPM-04 | SPM-02 | 对候选 PK 与目标 Checkout 做只读归属验证 | `stripe-key-ownership.ts` | mode mismatch、provider reject、verified、脱敏测试 | 完成 |
| SPM-05 | SPM-03,SPM-04 | 定义 ChatGPT 后端 transport：create/list；default 由列表复核 | `transport.ts` | mock transport 覆盖成功、401、5xx、未知副作用 | 完成 |
| SPM-06 | SPM-05 | 扩展 PK 验证到明确 SetupIntent/client secret | ownership adapter | 错误 PK 被拒绝；正确 PK 可 retrieve 同一 seti | 完成 |
| SPM-07 | SPM-02,SPM-05 | 实现页面世界 Elements 桥 | `element-bridge.ts` + content entry | origin/version/attempt/account 摘要门通过 | 完成 |
| SPM-08 | SPM-07 | Card Element/Payment Element mount 与 confirmSetup | card adapter | 卡数据不经过扩展存储；confirm 仅一次 | 完成 |
| SPM-09 | SPM-05,SPM-08 | 实现七阶段 orchestrator 和账号切换失效 | `orchestrator.ts` | 全阶段、失败出口、恢复路径行为测试 | 完成 |
| SPM-10 | SPM-09 | Intent + 服务端列表 + default 三方复核 | reconcile module | attached/reusable/default 分开记录 | 完成 |
| SPM-11 | SPM-02,SPM-10 | PayPal、银行借记、银行跳转、UPI capability probe | adapters/evidence | 未满足 mandate 证据时不升级 supported | 完成 |
| SPM-12 | SPM-02,SPM-10 | 钱包、Link、一次性方式的展示与阻断规则 | adapter policies | UI 不把钱包账户/一次性方式标成商户凭据 | 完成 |
| SPM-13 | SPM-09,SPM-10 | 支付面板：添加、处理中、需操作、已保存、失败状态 | payment panel | 键盘/窄屏/账号切换状态无重叠 | 完成 |
| SPM-14 | SPM-09 | 观测、脱敏、attempt 审计和迁移 | state/log/export | 无 secret/完整 PK/Cookie/卡数据落盘 | 完成 |
| SPM-15 | SPM-05..SPM-14 | 聚焦单测、集成测试、回归和构建 | tests + command evidence | compile、SPM、Runner、Hosted 测试通过 | 完成 |
| SPM-16 | SPM-15 | 测试环境 E2E、功能开关、打包与回滚 | XPI + evidence | 测试账号真实绑定并可从列表复核 | 完成 |

## 执行批次

1. 批次 A：SPM-01..04，形成可编译、可测试、无写支付副作用的基础内核。
2. 批次 B：SPM-05..10，交付 Card SetupIntent 纵向闭环。
3. 批次 C：SPM-11..14，扩展方式、UI 和观测。
4. 批次 D：SPM-15..16，完成全量验证、测试环境 E2E 和交付。

## 关键路径

`SPM-01 -> SPM-03 -> SPM-05 -> SPM-07 -> SPM-08 -> SPM-09 -> SPM-10 -> SPM-13 -> SPM-15 -> SPM-16`

## 停止条件

- ChatGPT 后端未提供 SetupIntent 创建或已保存方式列表入口：SPM-05 标记阻塞，保留 Hosted setup 调研，不伪造本地保存。
- SetupIntent 与 ChatGPT accountId/Customer 的归属无法复核：停止进入 UI 正式开关。
- 页面桥需要读取原始卡字段：退回 Element 托管设计。
- provider 返回结果不明确：进入 retrieve/list，只读收敛，不重复 confirm。
