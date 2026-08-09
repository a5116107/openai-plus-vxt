# 智能自动化 0.0.28 复核

复核时间：2026-07-29

## 业务链路

| 项目 | 结果 | 证据 |
|---|---|---|
| 注册阶段启用出口1链式代理 | PASS | `e2e-extension-session-target-tab/chrome-e2e-result.json`：`registrationChainProxyApplied=true`，出口1 `127.0.0.1:18092` |
| 空池同步与随机邮箱 | PASS | `e2e-extension-fast-rotation-2/`：Acica 同步、失败邮箱轮换、域健康随机 |
| 自动取件与 OTP 提交 | PASS | `e2e-extension-otp-submit-retry/`：验证码提交后进入 `/about-you` |
| Acica Web 回退解析 | PASS | `.context-snapshots/e2e-otp-local-0.0.24/result.json`：外部接口 504 后从 Web 详情解析 HTML 分段验证码 `801735` |
| 验证码自动回填与提交 | PASS | 同上：`trustedFillReportedSuccess/otpFilled/continueSubmitted/pageAdvanced=true` |
| 取件失败分类 | PASS | `mail_not_arrived/otp_not_found/provider_error` 仅记录暂时异常，不永久剔除邮箱；`account_deactivated` 仍标记失败 |
| Session 绑定注册标签页 | PASS | `e2e-extension-session-target-tab/`：读取 session 成功，不再误选侧栏 |
| 注册结果导入探测池 | PASS | 同上：`sessionHandoffToProbe=true`，`probeAccountCount=1` |
| 出口2用于结账阶段 | PASS | 同上：`create/open/submit checkout` 日志使用 `127.0.0.1:18093` |
| Auth/Checkout/Billing 独立出口 | PASS | `.context-snapshots/e2e-proxy-stages-two-cycles/result.json`：三阶段均 applied/verified/distinct |
| 阶段内固定出口 | PASS | 同上：`authStickyWithinStage=true` |
| 下一账号/轮次动态轮换 | PASS | 同上：`nextCycleRotated=true`，三阶段 IP 均发生变化 |
| 失败 seed 自动跳过 | PASS | `applyAutomationProxyStage` 将 trace 验证失败作为候选失败并继续尝试 |
| 换邮箱新建代理 cycle | PASS | `handleUnavailableRegistrationAccount` 重置 `cycleId` 与业务阶段 |
| 结账链接生成 | PASS | 同上：成功生成并打开 checkout 链接 |
| requireZero 非零拦截 | PASS | 同上：检测 `US$20.00`，未点击提交并终止当前资格路径 |
| 线上真实 0 元资格识别 | PASS | `.context-snapshots/e2e-full-flow-live-0.0.27/chrome-e2e-result.json` 读取 `US$0.00` |
| 修复版线上真实命中入库 | 待复测 | 旧逻辑未入库；修复后在线重跑分别受 Cloudflare challenge 与 Auth seed 失败影响 |
| 确定性真扩展 0 元入库 | PASS | `.context-snapshots/e2e-automation-qualification-0.0.28/result.json`，10/10 |

## 智能规划与看板

| 项目 | 结果 | 证据 |
|---|---|---|
| 命中后链接写入数据库 | PASS | `appendProbeHitAndMaybePersist` + `saveHitToDatabase`；`tools/_final_check.cjs` |
| 命中库查询/导出/看板 | PASS | runtime message、数据库筛选与导出检查全部 OK |
| 健康失败出口剔除 | PASS | `tools/_probe_logic_smoke.cjs` 覆盖 fail/skip 与全部失败场景 |
| 高命中国家优先 | PASS | 达阈值国家排在本轮计划前部 |
| 实验国家保留 | PASS | 默认每轮保留 2 个未知/低样本国家 |
| 实验国家轮换 | PASS | `round` 偏移轮换候选，避免固定实验同一组国家 |
| 探索策略可配置 | PASS | 设置页提供“保留实验性国家探测”和“每轮实验国家数” |
| 支付方式按探测结果推荐 | PASS | method detections 与 recommendation 代码、看板和导出已接通 |
| 任务运行中心 | PASS | 2 账号×5 国家，完成 8/10、请求 7、跳过 1，分层状态与进度一致 |
| 账号资产中心 | PASS | 52 账号、50 条分页、健康筛选、搜索、批量停用和启用 |
| 命中去重 | PASS | runtime smoke 验证重复命中只保留 1 条 |

## 构建与浏览器

| 项目 | 结果 | 证据 |
|---|---|---|
| TypeScript | PASS | `npm run compile` |
| Chrome MV3 构建 | PASS | `npm run build` |
| Firefox MV2 构建 | PASS | `npm run build:firefox` |
| Firefox manifest lint | PASS | `web-ext lint`：0 errors，0 notices；25 个 innerHTML warning + 2 个最低版本兼容 warning |
| Firefox 实装 | PASS | `.context-snapshots/firefox-webext-0.0.22.log`：`installTemporaryAddon` 成功 |
| 资格因素、任务与资产看板 | PASS | `.context-snapshots/e2e-eligibility-dashboard-0.0.28/result.json`，32/32 |
| XPI | PASS | `dist/openai-plus-vxt-0.0.28.xpi` |
| Mullvad XPI | PASS | `dist/openai-plus-vxt-0.0.28-mullvad.xpi` |
| 仓库级 spec / quality / proof | PASS | 当前请求指纹 `06ea161d70766098` 的最新 `spec.verdict`、`quality.verdict`、`verify.evidence` 均为 PASS；任务复核 5/5、0 blocking |
| review closeout / release | SUPERSEDED | 该 0.0.28 历史门已由下方 2026-08-08 集成交付记录取代 |

本轮发布包 SHA-256：Chrome ZIP `a2c39b055a5fb2fc2712d869562c9818ff235526a8946a4cdca7b7e3b0b8739d`；Firefox XPI `9ea3f1c1cddbeb2aa6d7451337d5f9299f6ad00a475c714b7e09e021128efbba`。

## 2026-08-08 SSOT 集成交付

- 集成内容：已合并 `codex/tpp-delivery` 的 forced-probe、完成 checkpoint 不重放和三阶段代理夹具修复，并完成 workflow/AppSec 收口。
- 验证：TypeScript `125/125`、Saved Payment 后端 `3/3`、Chrome/Firefox 构建、三阶段代理、Plus closure、Saved Payment UI、自动化资格和资格看板夹具均通过。
- 发布：fork `a5116107/openai-plus-vxt` 的 `main` 与 `codex/full-ssot-integration` 均指向集成提交；预发布 `v0.0.37-ssot.1` 已上传 Chrome ZIP、Firefox XPI、发布清单和回滚说明。
- 产物 SHA-256：Chrome ZIP `4fa4db10814dd4c8514d2f357311ef100e7a2b3a3af1db31730a671a8fd74693`；Firefox XPI `5739225446632b2e613ea9185216ecdeacb30c551a29456861f6d9a5e946f008`。
- 上游状态：`suyancc/openai-plus-vxt` 写入返回 403，当前令牌也缺少创建上游 PR 的权限；上游 `main` 仍为 `d856454f82e7fce14c35603a72e0f2f3e1ca69e9`。
- 最新质量复核：`quality-guard review-entry --no-chain` 为 SUCCESS，spec/quality/verify-evidence/proof/review blocker 均为 0；当前全仓结构基线为 168 文件、91 finding（84 advisory、7 baseline）、0 blocker，其余结构 finding 未伪造为零债务。

## Plus 双 Checkout 闭环

状态：IMPLEMENTED / VERIFIED；SPM-16 与 controlled production-like 全闭环统一证据均已通过。

本节只记录 `PLUS_CHECKOUT_CLOSURE.md` 和 `TASKS.md` 定义的集成增量。既有 0.0.28 证据不自动证明本闭环。

### 计划门

| 项目 | 预期证据 | 当前状态 |
| --- | --- | --- |
| 集成 SSOT、唯一任务板、验收矩阵 | 三份文档互相回链 | PASS |
| 计划边界 | `planOnly=true`、`completionBoundary=plan` | PASS |
| 代码事实基线 | `oaics_`、test-only、PayPal 偏好、单 Checkout、网络证据缺口均有代码锚点 | PASS |
| 实现与本地验证 | execute、113 项测试、浏览器夹具、双端构建和脱敏发布包 | PASS |
| production-like 联机闭环 | 同一 closureRunId 十项证据 | PASS |

### 实现验证矩阵

| Gate | 必须证明 | 建议命令/证据 | 状态 |
| --- | --- | --- | --- |
| V-01 URL | `oaics_`、`cs_`、verify、success 统一解析 | 全量测试中的 4 项 Checkout reference fixture | PASS |
| V-02 回归 | 旧 `cs_live_` 和 PayPal 流程未破坏 | `pnpm tsx --test tests/*.test.ts`，125/125 | PASS |
| V-03 Checkout policy | direct/staged/server 使用同一请求模型 | Checkout pipeline policy/strict-zero tests | PASS |
| V-04 server 出口 | 返回实际 IP/country/colo/ASN/verified | server trace fixture 严格信任显式 `verified` | PASS |
| V-05 SPM-16 | test SetupIntent succeeded、attached/reusable/default | immutable `saved-payment-live-e2e/pcc-live-7b2c128f-cab4-4121-8146-85eff4931b85.json`：succeeded，三项复核均为 true，服务端列表 contains/default 一致 | PASS |
| V-06 live key policy | 无硬编码 key，candidate ownership verified，日志只有 fingerprint | SPM ownership tests + package sensitive-shape scan | PASS |
| V-07 Checkout A | 同账号、预期计划、PH/PHP、零金额 | closure strict gate fixtures | PASS |
| V-08 Checkout B | sessionId distinct，资格保持 | closure distinct/drift fixtures | PASS |
| V-09 Saved Card | 目标后四位被选中并回读 selected 状态 | browser fixture：4242 selected，错误后四位明确失败 | PASS |
| V-10 billing | 美国地址完整填写并回读 | browser fixture：US、5 字段填写、4/4 必需字段匹配，姓名/地址/城市/州/邮编均存在 | PASS |
| V-11 submit | 所有门通过后只点击一次 | browser fixture：重复命令后 clickCount=1 | PASS |
| V-12 verify | Processing 不算成功，原 SetupIntent 被跟踪 | unknown-submit 只读复核与不重放测试 | PASS |
| V-13 Plus | 服务端 session/entitlement 明确为 Plus | FSM final session plan gate fixture | PASS |
| V-14 恢复 | 账号切换、资格漂移、未知副作用不重放写操作 | 21 项 closure/contracts/runner 定向测试 | PASS |
| V-15 脱敏 | evidence/state/log/package 无 secret、Cookie、卡数据 | `package:saved-payment` + 34 个 build 文件扫描 | PASS |
| V-16 浏览器 | Chrome/Firefox、窄屏、页面桥和 CSP | 双端 build/zip + browser fixture + 4 张截图复核 | PASS |
| V-17 全闭环 | 同一 closureRunId 具备十项最终证据 | `plus-checkout-closure/pcc-live-7b2c128f-cab4-4121-8146-85eff4931b85.live.json` 十门均为 true | PASS |

### 2026-08-06 实施复核证据

- `pnpm compile`：PASS；`pnpm exec tsx --test tests/*.test.ts`：113/113；`pnpm test:saved-payment-backend`：3/3；新增 Stripe.js loader retry 定向测试通过；seal immutable/latest 指针冲突回归：1/1。
- Closure 阶段执行已拆分为 Checkout A、保存卡、Checkout B、选卡/账单、提交和 entitlement 验证边界；reconciled 卡证据缺少摘要或末四位时以 `CARD_RECONCILE_FAILED` 终止。恢复逻辑保留持久化 phase，并在 submit 点击前写入 `subscription_submitting`/`submitCount=1`；创建、绑卡或提交中断后只进入对应未知副作用复核，不重放写操作。持久化数值拒绝非有限值、负数和小数；checkpoint 消息覆盖 Cookie、Authorization/Bearer、裸 JWT、Stripe key/secret 与 Luhn PAN 脱敏。选卡、账单和 entitlement 适配器异常均形成脱敏 checkpoint，暂停态可在用户处理后继续且不重建 Checkout A。
- `pnpm test:e2e-plus-closure`：PASS；证据为 `.context-snapshots/plus-checkout-closure/browser-fixture.latest.json`，桌面/移动端 Checkout 与设置页均无可见重叠。
- `pnpm build`、`pnpm build:firefox`、`pnpm zip`、`pnpm zip:firefox`：PASS。
- `pnpm package:saved-payment`：PASS；2026-08-06 本轮产物 Chrome ZIP SHA-256 `156b65d156f2df97a295c2c578aa609358474f098aa9795bc40d07b0807b5b0a`，Firefox XPI SHA-256 `87a09cae487a7c64415bb954716cf9e34003d99cb8ad81633b17006a78ea7dc6`。
- `.output/chrome-mv3` 与 `.output/firefox-mv2` 共 34 个文件的 key/token/PAN 形态扫描为 PASS；发布脚本内置 secret key、完整 PK、SetupIntent secret、Luhn 卡号扫描 findings 为空。
- 共享 Checkout parser 之外的旧业务模块私有 `cs_*` 前缀分支扫描为 0；唯一 `cs_live_` 分类规则保留在 `checkout-reference.ts` 共享解析器内。
- browser fixture 在 checkout 导航前关闭独立随机地址自动填充，避免其与闭环显式 billing 指令竞态；回读 `matchedFields=4`，`fullName/line1/city/state/postalCode` 的实际值与固定 fixture 一致，提交首次与重复调用的 `clickCount=1`。
- `pnpm test:e2e-saved-payment:profile` 使用独立 `.context-snapshots/profiles/saved-payment-live` 直连 headed 探测为 PASS：session HTTP 200、account/access token present、服务端列表 HTTP 200、卡数量 0、default=false。
- `pnpm test:e2e-saved-payment`：PASS；`.context-snapshots/saved-payment-live-e2e/pcc-live-7b2c128f-cab4-4121-8146-85eff4931b85.json` 记录 `SAVED_PAYMENT_VERIFIED`、SetupIntent `succeeded`、attached/reusable/default 三项 true、服务端列表 HTTP 200 且 contains/default 一致；完整 key、client secret、Cookie 和卡数据未持久化。
- `pnpm test:e2e-plus-closure:live`：PASS；最新 FSM 与 seal 代码统一 `closureRunId=pcc-live-7b2c128f-cab4-4121-8146-85eff4931b85`，真实 Stripe test SetupIntent 与扩展页面交互、A/B distinct、Saved Card、US billing、单次 submit、verify/Plus FSM 和三网络面在同次运行内汇总；checkpoint 序列包含 `subscription_submitting`。
- 2026-08-09 live 补测保持 fail-closed：3 个本机 Chrome Cookie 候选的 headed 直连/SG Session 均 HTTP 200 但账号/access token 不存在、支付方式 0；Saved Payment preflight 缺少 profile、支付输入和测试后端，未执行任何支付写操作或公网 Plus 提链。
- `.context-snapshots/plus-checkout-closure/pcc-live-7b2c128f-cab4-4121-8146-85eff4931b85.live.json`：十项 gate 全部为 true；browser-auth、server-checkout、browser-billing 均为 `verified=true`，同次观测均记录 IP/country/colo/ASN；`phase=subscription_verified`、`submitCount=1`、`sensitiveFindings=[]`。同 ID 的 saved-payment 与 browser 子证据已按 runId 固化；普通 fixture 覆盖 mutable latest 指针后，`pnpm test:e2e-plus-closure:seal` 仍为 PASS。
- 2026-08-06 fresh live 复核先捕获一次 Stripe.js 短暂加载失败和一次 ASN 归属缺失；现已在支付写操作前验证 top/isolated 两个 Stripe.js 上下文，在页面加载器中执行失败脚本清理与最多三次重试，并将浏览器 ASN 归属改为按 Cloudflare trace IP 显式查询、最多三次重试和 IP 一致性校验。最终重跑 `compile`、113/113 全量 TypeScript、3/3 后端、Chrome/Firefox 构建、双端打包、browser fixture、live 与 immutable seal 均为 PASS。
- `dev-workbench patch-entry` 已重新生成 execute/checkpoint 并链式运行 `quality-guard review-entry`：`spec.verdict`、`quality.verdict`、`verify.evidence` 均为 PASS，`proof.bundle=success`、`closeAllowed=true`；task reconcile 5/5、0 blocking。顶层 blocked 仅对应共享脏工作树的严格 release transaction。
- 最新 `delivery-ops release-entry` 在 clean gate 处按设计停止：GitHub sync 与 deploy 均未启动，`delivery.done=blocked`。Git 状态为 139 个路径（39 tracked、100 untracked），release transaction 展开为 295 个变化项；worktree 保持 hold/keep，未批量提交、清理或覆盖共享改动。

### 推荐测试批次

1. 快速门：checkout reference、closure FSM、SPM、checkout pipeline、payment runner、TypeScript。
2. 集成门：双 Checkout fixture、server trace、Saved Card iframe、billing、verify/session。
3. 浏览器门：Chrome/Firefox 扩展、真实 MAIN-world bridge、窄屏 UI。
4. live 门：先 SPM-16 test merchant，再 production-like 完整闭环。
5. 交付门：secret scan、双包、回滚、SSOT/TASKS/VERIFY 状态一致性。

### 最终通过条件

`PLUS_CHECKOUT_CLOSURE.md` 第 17 节十项证据已由同一个脱敏 `closureRunId` 汇总，`PCC-17` 对应最新代码运行证据为 `.context-snapshots/plus-checkout-closure/pcc-live-7b2c128f-cab4-4121-8146-85eff4931b85.live.json`，本节状态为 PASS。
