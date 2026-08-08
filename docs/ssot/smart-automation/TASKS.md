# Plus 双 Checkout 闭环任务板

本文件是该集成增量的唯一任务状态源。领域既有任务继续由各自 TASKS 管理；本板只引用依赖，不复制其状态。

状态：`待开始`、`进行中`、`阻塞`、`完成`。只有 `VERIFY.md` 对应验收项存在真实命令或运行证据后才能标记完成。

外部依赖：`saved-payment-methods/SPM-16` 已完成，同一测试商户的真实 SetupIntent、attached/reusable/default 和服务端列表证据已形成。`PCC-17` 的统一 controlled production-like evidence bundle 已通过；功能开关仍按发布策略默认关闭。

| ID | 依赖 | 任务 | 主要所有者/文件 | 验收信号 | 状态 |
| --- | --- | --- | --- | --- | --- |
| PCC-01 | - | 固定集成 SSOT、状态机、不变量、错误码和脱敏边界 | `PLUS_CHECKOUT_CLOSURE.md` | README/TASKS/VERIFY 互相回链，plan check 通过 | 完成 |
| PCC-02 | PCC-01 | 建立统一 Checkout reference parser，覆盖 `oaics_`、`cs_`、verify、success | `link-extractor/checkout-reference.ts` | 四类 URL fixture 与旧 `cs_` 回归通过 | 完成 |
| PCC-03 | PCC-02 | 迁移 automation、content、autofill、runner URL 私有判断 | 4 个消费模块 | 不再出现业务层 `startsWith(...cs_)` 分叉 | 完成 |
| PCC-04 | PCC-01 | 统一 direct/staged/server Checkout 创建策略和响应模型 | `link-extractor/*`、background 薄接线 | 普通面板与自动化均可选择 staged；旧 direct 默认兼容 | 完成 |
| PCC-05 | PCC-04 | 定义 server Checkout 独立网络面与实际 trace 返回契约 | server transport、`proxy/*` | 参数国家与实际 country/IP/verified 分字段记录 | 完成 |
| PCC-06 | PCC-01,SPM-16 | 完成 test SetupIntent live E2E，并设计 live key candidate resolver/policy | `saved-payment-methods/*` | SPM-16 完成；无硬编码 key；ownership verified | 完成 |
| PCC-07 | PCC-06 | 新增 closure run state、迁移、功能开关和恢复点 | `automation/types.ts`、`state.ts`、新 FSM | 默认关闭；旧 state 可迁移；secret 扫描为空 | 完成 |
| PCC-08 | PCC-04,PCC-07 | 实现 Checkout A 创建和严格资格证据门 | closure FSM、checkout service | 非零/国家错位/网络未验证均在绑卡前停止 | 完成 |
| PCC-09 | PCC-06,PCC-08 | 把保存卡 attempt 接入 closure，并等待 attached/reusable/default 复核 | closure FSM、SPM orchestrator | 未决 confirm 只 retrieve/list，不创建第二 Intent | 完成 |
| PCC-10 | PCC-09 | 创建 Checkout B，校验 distinct、同账号和资格保持 | closure FSM、checkout service | A/B sessionId 不同；B 再次为零金额 | 完成 |
| PCC-11 | PCC-03,PCC-10 | 实现 Saved Card picker、后四位匹配和选中确认 | autofill、页面桥 | 找不到目标卡时不回退 PayPal/新卡 | 完成 |
| PCC-12 | PCC-11 | 拆分 billing fill/verify 与单次 submit | autofill service、runner | 地址回读完整且提交前门全部通过 | 完成 |
| PCC-13 | PCC-12 | 跟踪 verify SetupIntent，并以服务端账号状态判定 Plus | closure FSM、session service | Processing 不算成功；最终 plan/entitlement=Plus | 完成 |
| PCC-14 | PCC-07..PCC-13 | 补账号切换、资格漂移、未知副作用、取消和恢复 | FSM tests | 每个错误码均有确定恢复/终止断言 | 完成 |
| PCC-15 | PCC-05,PCC-13 | 形成统一脱敏 evidence bundle 和三网络面证据 | state/log/export | 十项最终验收可由同一 closureRunId 追溯 | 完成 |
| PCC-16 | PCC-14,PCC-15 | 单元、集成、浏览器 fixture、Chrome/Firefox 回归 | tests、Playwright | 测试矩阵全绿，无旧流程回归 | 完成 |
| PCC-17 | PCC-16 | production-like live E2E、打包、回滚和 SSOT 收口 | E2E/release/docs | 同次运行完成 A/save/B/Saved/billing/verify/Plus | 完成 |

## 执行批次

1. 批次 0：PCC-01..03，先统一 URL 和测试真相。
2. 批次 1：PCC-04..06，完成 Checkout transport、网络证据和 SPM-16。
3. 批次 2：PCC-07..13，交付 test-mode 最小纵向闭环。
4. 批次 3：PCC-14..17，硬化、live E2E 和发布。

## 关键路径

`SPM-16 -> PCC-06 -> PCC-07 -> PCC-08 -> PCC-09 -> PCC-10 -> PCC-11 -> PCC-12 -> PCC-13 -> PCC-15 -> PCC-16 -> PCC-17`

## 停止条件

- SPM-16 尚未证明 test SetupIntent attached/reusable：停止 live rollout，先修保存卡内核或环境。
- Checkout B 缺少 distinct 或资格保持证据：不进入 Saved Card/submit。
- Saved Card 页面状态读取不可靠：保留人工确认点，不猜测选中状态。
- server 实际出口没有 trace：严格模式不宣称网络面隔离。
- submit 后副作用不明：只查询原 verify/session，不重复点击。
- 工作树中的既有改动所有权不明确：按任务文件边界分批实施，不做全树清理。
