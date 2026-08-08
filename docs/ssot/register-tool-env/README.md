# Register-Tool 配置环境接入 SSOT

## Source
`H:\Root\jiaoben\haochi\2951461586__GPT-Register-Tool`

## Mapping
| Register-Tool | Plugin |
|---|---|
| mailbox_proxy / proxy.default (10808) | front（邮箱请求代理，不是账号） |
| paypal.stage_proxies.checkout (JP chain :18092) | exit1 |
| paypal.stage_proxies.provider/confirm (US chain :18093) | exit2 |
| stage_proxy_countries + chain ports TH/IN/JP/US | countryExits |
| paypal/upi.stage_proxies | methodPools (hosted/paypal/upi) |
| paypal.proxy_health | seedFailSkipAfter / seedFailCooldownSec |
| mailbox_acica_export.txt / mailbox_tokens.txt | 自动化邮箱池 rawEmails |

## 关键澄清
- **邮箱代理 ≠ 邮箱池**
- `mailbox_proxy=127.0.0.1:10808` 只解决“收信请求走前置代理”
- 注册自动化第 2 步“选择邮箱”读的是插件本地 `emails[]` / `rawEmails`
- 所以一键本机链式默认后，仍需导入邮箱文件，否则会报：没有可用邮箱

## UI
- 代理配置 →「接入 GPT-Register-Tool 配置环境」
  - 一键本机链式默认 / 从粘贴 JSON 导入
  - 仅导入邮箱文件文本
- 邮箱池 →「导入 Register-Tool 邮箱」
  - 支持 `----` 四段式与 `---` 三段式（自动补 client_id）

## Acceptance
1. 一键本机默认填充 front=127.0.0.1:10808, exit1=:18092, exit2=:18093
2. 国家映射含 TH/IN/JP/US
3. 可粘贴真实 config.json 导入代理
4. 可保存并应用前置
5. 粘贴 mailbox_acica_export.txt 后邮箱池 count > 0，保存后自动执行可过“选择邮箱”
