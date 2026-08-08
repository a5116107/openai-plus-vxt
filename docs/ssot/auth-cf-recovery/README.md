# Auth Cloudflare 403 恢复 SSOT

## 结论

`Auth OTP validate` 的 403 必须按响应类型拆分：

- `403 + text/html` 或 Cloudflare 响应头：Cloudflare challenge，保留邮箱并更换 Auth 出口。
- `403 + application/json`：Auth 业务错误，继续按 `account_deactivated` 等结构化错误处理。

本机 `10808` 在 2026-08-01 实测连续三次均为 `SG 13.250.103.251`。生成新 cycleId 或重新应用同一端口不代表出口已经轮换。

## 恢复状态机

1. 后台监听 `email-otp/send`、`email-otp/validate`、`create_account` 的完成响应，不记录请求体和 OTP。
2. Auth 步骤失败时读取当前 tab 的最近网络观测。
3. Cloudflare challenge 返回 `AUTH_CF_CHALLENGE`，保留当前邮箱、清理 Auth Cookie、记录失败 IP。
4. 新 Auth 周期携带 `excludeIps` 和 `requireDifferentIp`。
5. 新 IP 与失败 IP 相同则拒绝 seed；达到上限返回 `AUTH_EXIT_NOT_ROTATED`。
6. JSON 业务错误不进入 Cloudflare 分支。

## 运维要求

Auth seed 池需要提供多个实际出口，或使用 `{SESSION}` 能触发上游会话轮换的代理账号。单一静态本地端口只能作为入口，扩展会验证其最终公网 IP 是否改变。
