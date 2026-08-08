# Register-Tool 接入复核

| 项 | 期望 | 结果 |
|---|---|---|
| 代理 front 映射 mailbox_proxy | 10808 | PASS（代码/导入器） |
| exit1/exit2 chain | JP18092 / US18093 | PASS |
| 国家映射 TH/IN/JP/US | 存在 | PASS |
| 邮箱代理 ≠ 邮箱池说明 | UI/文档明示 | PASS (0.0.20) |
| mailbox_acica_export 解析 | 485 行可用 | PASS（本机 smoke） |
| mailbox_tokens --- 三段式 | 自动补 client_id | PASS（本机 smoke） |
| 设置页导入按钮 | 导入 Register-Tool 邮箱 | PASS（构建产物含按钮） |
| 用户浏览器实测选邮箱 | 保存后 count>0 可过选择邮箱 | PENDING（需用户装 0.0.20 导入后重跑） |
