# E2E / 邮箱池补齐 (0.0.20)

## 实测问题（用户截图 + 反馈）
1. FPI cookie 清理已过（0.0.19）
2. 注册卡在：没有可用邮箱，请先在自动化设置页添加邮箱
3. 用户反馈：邮箱代理不是已经配置好了嘛（从别的项目复制过来的）

## 根因
- 复制/接入的是 Register-Tool 的 **mailbox_proxy（邮箱请求代理）**
- 插件注册链需要的是 **邮箱池账号**（Outlook 行：email----password----client_id----refresh_token）
- 两者不是同一配置面

## 修复（0.0.20）
1. `src/features/automation/import-register-tool-mailboxes.ts`
   - 规范化 Register-Tool 邮箱文件
   - 支持 mailbox_tokens `---` 三段式自动补 client_id
2. `src/features/register/account-input.ts`
   - 解析层兼容 `---` / `----`
3. 设置页
   - 邮箱池：导入 Register-Tool 邮箱
   - 代理接入：仅导入邮箱文件文本
   - JSON 导入可选同步 config 内嵌单账号

## 全流程实测清单
1. 安装 `dist/openai-plus-vxt-0.0.20-mullvad.xpi`
2. 设置 → 邮箱池 → 导入 Register-Tool 邮箱
   - 粘贴 `mailbox_acica_export.txt` 或 `mailbox_tokens.txt`
   - 点保存设置
   - 顶部应显示 N 个邮箱（不再是 0）
3. 代理：一键本机链式默认（若尚未）
4. 自动化：自动执行
   - Cookie 清理不硬失败
   - 选择邮箱成功
5. 本地 Outlook API `http://127.0.0.1:8787` 需可用，才能自动收码
