# Auth Cloudflare 403 验证记录

日期：2026-08-01

## 自动验证

- `pnpm compile`：PASS。
- `pnpm test:auth-cf`：6/6 PASS。
- `pnpm test:payment-runner`：15/15 PASS。
- `pnpm test:probe-readiness`：16/16 PASS。
- `pnpm test:checkout-pipeline`：5/5 PASS。
- `pnpm build`、`pnpm build:firefox`、`pnpm zip:firefox`：PASS。
- XPI：`dist/openai-plus-vxt-0.0.35.xpi`，377,419 bytes。
- SHA-256：`0C2C75DD6060F535C2051EE36BB3DC5F13A44F1D78663858BA2B6E8BB6EB621F`。

## 真实浏览器证据

- `.context-snapshots/e2e-auth-cf-recovery-0.0.35/chrome-e2e-result.json`：同一 SG 出口下 OTP validate 成功，随后 `create_account 400 registration_disallowed`。
- `.context-snapshots/e2e-auth-cf-recovery-rerun-0.0.35/chrome-e2e-result.json`：validate 的 `403 application/json account_deactivated` 与 `email-otp/send 403 text/html` 同轮出现，证明两类 403 必须拆分。
- `.context-snapshots/e2e-auth-cf-recovery-final-0.0.35/chrome-e2e-result.json`：账号自动轮换后第二个随机邮箱完成 OTP、Profile、Session、Checkout，流程到达 Stripe 页面；Auth 不再是终点。
- `.context-snapshots/e2e-auth-exit-rotation-0.0.35/result.json`：真实扩展经 `10808` 验证初始 IP `13.250.103.251`；排除后连续三次仍相同，返回 `AUTH_EXIT_NOT_ROTATED`；看板显示拒绝 3 次。

## 当前结论

Cloudflare 403 与出口信誉、出口复用、请求频率、Cookie/Session、账号状态和时间窗口共同相关。现有证据否定“验证码值错误”和“该 IP 永久固定失败”两种单因解释；但 `10808` 在失败恢复时没有形成新 IP，是真实恢复链的直接缺口。
