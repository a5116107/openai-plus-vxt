# Checkout 提链任务清单

| ID | 线别 | 任务 | 验收信号 | 状态 |
| --- | --- | --- | --- | --- |
| CE2-01 | 逻辑线 | 结构化 minor-unit 金额解析 | wrapper、invoice、lineItems 行为测试通过 | 完成 |
| CE2-02 | 流程线 | Checkout 页面 React Router 回退 | 生产解析器读取流式 HTML fixture 并得到 0 PHP | 完成 |
| CE2-03 | 状态线 | invalid_promotion 丢弃 Session 后完整重建 | 本地 HTTP 行为测试得到第二个 oaics Session | 完成 |
| CE2-04 | 业务线 | hosted/custom/both 可选 | 设置页三选项，both 真实执行两次 create | 完成 |
| CE2-05 | 数据线 | Hosted 与 Custom 分别保存 | 生产拆分函数生成两条独立链接记录 | 完成 |
| CE2-06 | 身份线 | 每账号 Cookie/设备/Session 快照 | Session 捕获、账号池持久化、运行前恢复和请求头传递 | 完成 |
| CE2-07 | 指标线 | Checkout/Update/完整流程/CF 四层指标 | Observation、CSV、命中库和看板字段一致 | 完成 |
| CE2-08 | 看板线 | 流程与模式转化率 | 真扩展 E2E 显示创建→资格→可用及 Hosted/Custom 资格率 | 完成 |
| CE2-09 | 质量线 | 编译、行为测试、扩展 E2E、构建和 XPI | VERIFY 记录命令、结果和哈希 | 完成 |
| CE2-10 | 身份线 | 当前 ChatGPT 登录会话一键同步 | 设置页同步 AT + Cookie 快照，并区分 Cookie 就绪与仅 AT | 完成 |
| CE2-11 | 流程线 | `oaics_` 短链解析 Hosted/Stripe 资源 | 身份恢复、邮箱校验、页面/资源提取与状态持久化 | 完成 |
| CE2-12 | 证据线 | PayPal/MoMo/KakaoPay 实际暴露门 | 仅页面或 Stripe init 实际暴露的方式进入 Runner | 完成 |
| CE2-13 | 数据线 | Hosted 解析状态看板与 CSV | identity_required/mismatch、checkout_loaded、resolved_hosted 可查询导出 | 完成 |
| CE2-14 | 在线线 | 有 Cookie 的 Hosted 正例回归 | 当前用户配置未登录；失败分支已实测，正例等待形成登录 session | 待在线正例 |
| CE2-15 | 认证线 | AT 失效细分（invalid_jwt / token_rejected / cloudflare） | classifyTokenAuthFailure 行为测试区分三类，CF 403 不再误判账号过期 | 完成 |
| CE2-16 | 认证线 | 组合认证：Cookie -> /api/auth/session 刷新 AT | 有 cookie 快照账号探测前刷新 accessToken 并回写，刷新失败不阻塞 AT-only | 完成 |
| CE2-17 | 认证线 | 运行中 401 自动剔除失效账号 | Checkout/update/taxes 任一返回 token 失效即标记账号 invalid 并停止本轮 | 完成 |
| CE2-18 | 认证线 | Checkout/update/taxes 请求携带 Cookie 头 | buildCheckoutHeaders 注入快照 Cookie，行为测试验证请求头 | 完成 |
| CE2-19 | 认证线 | AT 引导网页 Session 的协议级否决验证 | A/B 对照：authorize 带/不带 Bearer 返回一致 login_start；Token Exchange 四形态均被授权服务拒绝（token_expired/invalid_grant/empty_string/invalid_value），结论落 SSOT | 完成 |
