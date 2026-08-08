# 原生支付 Runner 任务清单

| ID | 流程线/逻辑线/业务线 | 任务 | 验收信号 | 状态 |
| --- | --- | --- | --- | --- |
| PR-01 | 流程线 | 固定七阶段状态机并统一事件 | 行为测试覆盖全部阶段和失败出口 | 完成 |
| PR-02 | 逻辑线 | 严格零元资格门支持缺失、冲突、非零分类 | gate 单元测试通过；写操作前均有 revalidate | 完成 |
| PR-03 | 逻辑线 | confirm/approve 单次提交与未知副作用只 poll | 结果不明测试中写调用次数为 1 | 完成 |
| PR-04 | 业务线 | PayPal、MoMo、GoPay、iDEAL、UPI、PIX、BLIK、TWINT、Kakao 适配器 | 方式、币种、终链白名单测试通过 | 完成 |
| PR-05 | 流程线 | 三角色代理路由接入既有 bootstrap/promotion/provider 池 | 阶段事件含角色；UI 可配置方式池 | 完成 |
| PR-06 | 业务线 | 命中后只保留方式专属验证终链 | 任意根站点/跨方式 URL 被拒绝 | 完成 |
| PR-07 | 数据线 | 持久化资格、方式提供、confirm、approve、终链指标 | 观测归一化、CSV 导出/导入字段一致 | 完成 |
| PR-08 | 业务线 | 看板分离 Runner 各阶段转化率与协议失败率 | 设置页显示六类独立指标 | 完成 |
| PR-09 | 质量线 | 行为测试、TypeScript 编译、Firefox 构建 | 命令输出 PASS；XPI 可解包校验 | 完成 |
| PR-10 | 交付线 | 版本升至 0.0.30 并生成 Firefox XPI/SHA-256 | manifest、文件、哈希记录到 VERIFY | 完成 |
| PR-11 | 资格保持线 | 新任务默认复用资格 Checkout；逐方式记录源资格、会话复用、方式暴露与资格保持证据 | 单元测试覆盖复用、独立对照、未暴露方式止步；CSV 保留审计字段 | 完成 |
| PR-12 | 探索线 | 可选筛查配置中存在但页面未暴露的支付方式 | 默认关闭；开启后标记 forcedProbe；严格门未通过时不进入写阶段 | 完成 |
| PR-13 | 能力线 | Hosted/PayPal 从固定 USD 档案扩展为 Checkout 上下文能力 | 65 个 Checkout 地区逐一验证国家与币种解析；PH/JP/DE 动态币种 Runner 通过 | 完成 |
| PR-14 | 逻辑线 | 默认生产候选只使用 Stripe 实际暴露方式 | 未暴露方式仅由显式实验开关进入；screen 严格门阻断写操作 | 完成 |
| PR-15 | 流程线 | 独立 Checkout、processor entity、billing 与三阶段代理使用动态能力结果 | 运行时不再回退 PayPal 固定 US/USD；TypeScript 与支付回归通过 | 完成 |
| PR-16 | 质量线 | 设置页暴露可交互 ready 信号，消除 E2E 提前点击竞态 | Acica 同步、随机邮箱和 OTP 在线流程可继续执行 | 完成 |
