# E2E / Acica 自动取邮箱+取件 (0.0.21)

## 用户反馈
为什么要那么麻烦，不应该自动从网站取邮箱和取件吗？

## 结论
是的。主路径是 mail.acica.top：
- GET /api/external/accounts 自动拉邮箱池
- GET /api/external/otp?email=... 自动取验证码

手工粘贴 token 只是兜底。

## 0.0.21 落地
1. src/features/mailbox/acica.ts
2. background: opx:acica-sync-emails + OTP 优先 Acica
3. 选择邮箱：池空自动同步
4. 设置页：从 Acica 自动同步
5. 本机 smoke：同步 485 个邮箱 PASS

## 实测
1. 安装 dist/openai-plus-vxt-0.0.21-mullvad.xpi
2. 直接自动执行（或先点从 Acica 自动同步）
3. 期望：自动同步并选择邮箱，验证码走 Acica

## 2026-08-03：E2E mailbox URL 通道

- `OPX_E2E_MAILBOX_URL` 可为单次浏览器 E2E 注入一个只读邮件页面，支持 HTML 和 JSON 响应；扩展后台优先轮询该页面并复用统一的 ChatGPT OTP 解析规则。
- URL 仅写入独立测试 Profile 的 `opx.e2e.mailboxUrl`，不进入自动化设置、发布配置、日志或证据 JSON；未注入时仍走 Acica/Outlook 原路径。
- E2E 驱动校验 URL 为 HTTP(S)，并要求路径与 `OPX_E2E_EMAIL` 对应；证据只记录 `e2eMailboxUrlConfigured=true`。
- `OPX_E2E_PROFILE_DIR` 可保留成功登录的独立 Profile；未设置时继续使用并删除临时目录。
- 本轮真实验证：首轮完成邮箱提交、邮件到达、验证码识别/提交；第二轮完成 ChatGPT session、checkout 创建/打开、Probe 会话交接与命中持久化，所有布尔检查通过。
- 解析器测试：`pnpm exec tsx --test tests/mailbox-url-otp.test.ts`，HTML 空邮箱、HTML OTP、JSON OTP 共 3/3 通过。
