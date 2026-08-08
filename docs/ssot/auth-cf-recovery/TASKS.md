# Auth Cloudflare 403 任务清单

| ID | 任务 | 状态 | 验收信号 |
|---|---|---|---|
| ACF-01 | 观测 Auth 三个关键接口 | 完成 | webRequest 按 tab 保存状态、类型和时间，不保存 OTP/body |
| ACF-02 | 区分 Cloudflare 403 与 JSON 业务 403 | 完成 | HTML 403 为 `AUTH_CF_CHALLENGE`，JSON 403 保持业务错误 |
| ACF-03 | Cloudflare 403 优先轮换出口 | 完成 | 主循环在邮箱轮换之前处理 challenge，邮箱不被淘汰 |
| ACF-04 | 排除失败 Auth IP | 完成 | 请求支持 `excludeIps`、`requireDifferentIp` |
| ACF-05 | 阻止伪动态轮换 | 完成 | 同 IP 达到上限返回 `AUTH_EXIT_NOT_ROTATED` |
| ACF-06 | 可观测性 | 完成 | 日志和设置看板显示旧 IP、重复 IP 与拒绝次数 |
| ACF-07 | 账号轮换清理稳定性 | 完成 | 无目标窗口时仅清 Cookie，不关闭扩展运行窗口 |
| ACF-08 | 行为与真实浏览器验证 | 完成 | 单测、回归、真实注册和真实出口轮换均有证据 |
| ACF-09 | Firefox XPI | 完成 | 构建、打包、哈希复核通过 |
