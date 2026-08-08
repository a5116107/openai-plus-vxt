# E2E / FPI Cookie Cleanup Fix (0.0.19)

## 实测问题（用户截图）
开始前清理触发失败：
First-Party Isolation is enabled, but the required 'firstPartyDomain' attribute was not set.

影响：注册自动化卡在第1步“清除 Cookie”，主链无法进入选邮箱/打开注册页。

## 根因
Firefox / Mullvad 开启 First-Party Isolation 后：
- `browser.cookies.getAll({ domain })` 与 `cookies.remove(...)` 必须带 `firstPartyDomain`
- 旧实现未传该字段，异常冒泡到 runtime message，表现为“清理触发失败”

## 修复
1. `entrypoints/background.ts`
   - `listDomainCookiesForClear`：多变体查询（空 firstPartyDomain / 显式 first-party host）
   - `removeCookieCompatible`：多策略删除
   - `clearDomainsViaBrowsingData`：browsingData 回退
2. `wxt.config.ts` 增加 `browsingData` 权限
3. `runner.ts`：清理失败/异常不再硬阻断注册主链（尽量执行后继续）

## 全流程实测清单
1. 安装 `dist/openai-plus-vxt-0.0.19-mullvad.xpi` 并重载扩展
2. 代理页：一键本机链式默认 -> 保存应用前置
3. 注册自动化：启动全自动
   - 期望：不再出现 firstPartyDomain 硬失败
   - 日志可为“已尽量执行/兼容清理”，但应进入“选择邮箱/打开注册页”
4. 读 session 后：探测池应自动出现账号（handoff）
5. 探测页：智能开跑一轮
   - 实时日志出现 ROUND_START / PROBE_START
6. 命中后：命中库/方式看板有数据

## 结果
- tsc PASS
- zip:firefox PASS
- package: dist/openai-plus-vxt-0.0.19-mullvad.xpi
