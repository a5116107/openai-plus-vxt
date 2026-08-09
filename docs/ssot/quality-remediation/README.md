# 仓库质量门修复 SSOT

## 缺口分类

| 类别 | 根因 | 处理 |
| --- | --- | --- |
| 代码/运行 | 平衡实验执行器此前缺失 | 已实现账号×出口排程、错位顺序、跨时段块、覆盖门和测试 |
| 安全文档 | 缺少 `docs/standards/APPSEC_BASELINE.md` 与 10 个控制项 | 按扩展真实边界补齐适用性、证据、验证和残余风险 |
| 门禁运行时 | 根包为 ESM，CommonJS guardrail `.js` 加载失败 | 在 `scripts/guardrails/package.json` 声明局部 `commonjs` |
| 证据时效 | P1-P4 命令证据旧于代码 | 所有实现完成后重新执行 execute/verify 链刷新 |
| 工作流工具 | bootstrap guardrail 与根 ESM 边界冲突 | 通过局部 CommonJS 边界修复；memory、stack-run 和 evidence 链均可执行 |
| 验证范围 | 自动探测把 `.ref_upl` 参考仓库及根目录一次性 Python 迁移脚本识别为产品 Python 变更，其上游语法错误导致证据门失败 | 从 `WORKFLOW_STACK` 移除参考样本，并通过 `.gitignore` 隔离 `.ref_upl/` 与 `/_*.py`；保留根扩展与真实邮箱服务验证 |

## 验收原则

- 业务能力以编译、合成排程测试和真实扩展浏览器 E2E 为准。
- AppSec 以 10 个控制项可解析、守卫命令实际运行和残余风险公开为准。
- skills consistency、stack-run、quality-guard 必须保留命令输出；本地 bootstrap 代理使用 Git 本地排除清单，不进入产品提交。
- 本地交付验证使用 `--no-chain` 停在 verify，避免把未请求的 GitHub 同步和部署事务作为 XPI 验收前置条件。
- 0.0.37 Chrome ZIP 与 Firefox XPI 已发布到 fork 预发布，并记录 SHA-256 与回滚说明。
- 当前结构事实由显式全仓扫描维护：168 个文件、91 个 finding（84 advisory、7 baseline）、0 blocker；旧版“184 文件迁移”仅是历史分支差异规模，不再充当当前任务清单或验收口径。

## 2026-07-29 全流程回归补充

- 原 `18091/18092/18093` 链路的上游鉴权已失效；本轮使用独立 `28091/28092/28093` 白名单动态出口完成真实浏览器三阶段验证，分别落在 IN/JP/US，且同阶段在下一 cycle 保持黏性。
- 浏览器主流程确认了扩展加载、Acica 邮箱池一键同步、随机选邮箱、注册链式代理、开始前清理、会话交接和 Checkout 链接阶段均可实际推进。随机邮箱会因上游 OTP 超时或账号不可用触发轮换，属于上游数据结果，不等同于扩展故障。
- 清理阶段曾在读取目标标签页时存在无界等待。`triggerStartCleanup()` 现有 5 秒边界；受控失效目标标签页回归已确认该路径仍继续后续自动化，不再占满全流程超时。
- 本轮未获得真实优惠命中，`hitDatabase` 为 0；命中保存与看板仅通过合成/浏览器看板回归，真实命中入库维持未验证状态。
- E2E 证据输出已改为递归脱敏，避免将邮箱、验证码、会话令牌或查询参数写入新结果文件。

## 2026-08-08 0.0.37 收口

- `docs/specs/WORKFLOW_STACK.json` 与 `docs/standards/APPSEC_BASELINE.md` 已纳入版本控制，AppSec 控制项 10/10。
- `scripts/guardrails/package.json` 将 guardrail `.js` 限定为 CommonJS，消除了根包 ESM 导致的 `require is not defined` 连锁失败。
- `quality-guard review-entry --no-chain` 返回 SUCCESS；spec、quality、verify-evidence、proof bundle 和 review loop blocker 均为 0。
- TypeScript、125 项测试、3 项后端测试、双端构建、三阶段出口 E2E 和 Plus Closure fixture 全部通过。

## 2026-08-09 QR-11 收口

- 新增 `src/app/dom.ts`，所有入口和支付/面板的 HTML 挂载统一走 `DOMParser + replaceChildren`；源码不再直接赋值动态 `innerHTML`。
- Firefox manifest `strict_min_version` 提升至 `142.0`，与 `data_collection_permissions.required=['none']` 的 Firefox/Android 支持契约一致。
- `pnpm compile`、136/136 全量测试、3/3 Saved Payment 后端、Chrome/Firefox 构建、`web-ext lint`（0 errors / 0 notices / 0 warnings）、运营控制台、资格看板、三阶段出口和 Plus Closure fixture 均通过。

## 2026-08-09 QR-12 实测链收口

- 主流程 E2E 的启动里程碑同时观察自动化终态；出口或上游在早期失败时立即输出具体步骤、消息和进度轨迹，不再转化为额外 120 秒 harness 超时。
- `pnpm test:e2e-terminal-boundary` 使用失效 Auth 出口重复验证该边界，约 6 秒返回预期失败终态，六项 harness 断言全部通过。
- Saved Payment UI 将布局断言、身份门和其他控制台错误分层；默认截图写入 `.context-snapshots/saved-payment-ui/`，仓库基线只由 `OPX_SAVED_PAYMENT_UPDATE_BASELINES=1` 显式更新。

## 2026-08-09 QR-13 SSOT 一致性门

- `pnpm test:ssot` 自动枚举所有 `TASKS.md`，要求同目录存在 `README.md` 和 `VERIFY.md`。
- 所有非完成任务 ID 必须出现在根索引的唯一未完成汇总中；新增或遗漏状态会直接使测试失败。
- 未勾选验收仅允许保留已声明的外部门，Saved Payment live preflight 的全部必需变量必须在根索引显式列出。

## 2026-08-09 QR-14 E2E harness 拆分

- 确定性失败出口、子进程和本轮证据断言迁至 `tests/support/e2e-extension-terminal-boundary.mjs`。
- `scripts/e2e-extension.mjs` 不再承载自调用测试模式，生产入口只保留真实浏览器流程和自动化终态识别。
- `pnpm test:e2e-terminal-boundary` 的用户命令与六项验收保持不变，QR-12 源码契约同步锁定 support 边界。

## 2026-08-09 QR-15 外部门证据时效

- Saved Payment 历史 profile 成功证据标注为 2026-08-05 当次运行，不再表述为当前可用会话。
- 2026-08-09 preflight 与 profile probe 独立记录当前环境缺少 profile、支付输入和测试后端，且未触发支付写操作。
- 2026-08-09 进一步用历史隔离 profile 的临时副本完成直连和单一 SG 出口复测，两次 Session 均为 HTTP 403，账号/access token 不存在；副本已清理且没有支付写操作。
- 上游 PR 创建历史上同时验证 GraphQL 与 REST 路径均为 403；本轮再次通过 `gh pr create` 验证 GraphQL 仍为 `Resource not accessible by personal access token`，该权限门继续保持未完成。

## 2026-08-09 QR-16 显式结构基线

- 严格结构扫描通过 `git ls-files` 显式覆盖 `src/`、`entrypoints/`、`scripts/` 与 `tests/support/` 的 168 个源码文件，结果为 91 个 finding（84 advisory、7 baseline）、0 blocker。
- `summarizeActionData` 按页面、支付控件、输入发现、输入写入、输入状态和按钮提示拆分，最大复杂度从 65 降至严格门阈值以内，`runner-format.ts` 聚焦扫描为 0 finding。
- 3 项聚焦回归锁定全部字段顺序、中文文案、falsy 字段和非对象输入语义；旧版 184 文件分支差异不再写作当前可执行任务数量。

## 2026-08-09 QR-17 可执行结构回退门

- `pnpm test:structural-baseline` 从 Git 跟踪文件实时生成严格扫描范围，不依赖手写文件列表或聊天中的历史数字。
- 运行门要求覆盖文件保持 168、总 finding 不超过 91、advisory 不超过 84、baseline 不超过 7、blocker 为 0，且 `runner-format.ts` 不重新出现告警。
- 结构债务下降会直接通过；覆盖变化或 finding 增长必须先解释并显式更新 SSOT，避免无声漂移。
