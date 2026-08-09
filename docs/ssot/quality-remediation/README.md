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
- 184 文件迁移超过 change/shape budget 的事实保持 advisory 结构债务，不伪造严格预算 PASS。

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
- `pnpm compile`、135/135 全量测试、3/3 Saved Payment 后端、Chrome/Firefox 构建、`web-ext lint`（0 errors / 0 notices / 0 warnings）、运营控制台、资格看板、三阶段出口和 Plus Closure fixture 均通过。
