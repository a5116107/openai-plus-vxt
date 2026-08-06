# 试用与多支付提链验证矩阵

验证分为静态、单元、集成、浏览器和交付五层。命令必须记录真实退出码和关键输出；live 验证使用本地 fixture 或显式配置，不把网络可达性当作资格证据。

## 1. 静态与文档检查

```powershell
rg -n "trial-payment-probe|qualificationPreserved|methodOffered|provider-final" docs/ssot src/features
rg -n "(token|accessToken|client_secret|cardNumber|cvv)" docs/ssot/trial-payment-probe
git diff --check -- docs/ssot/trial-payment-probe docs/ssot/smart-automation/README.md docs/ssot/payment-runner/README.md docs/ssot/eligibility-factors/README.md docs/ssot/multi-factor-experiments/README.md
```

预期：入口链接唯一、没有敏感值、无空白错误；领域文档不复制本 SSOT 的状态定义。

## 2. 资格解析矩阵

| Fixture | 预期类型 | 预期等级 | 预期结果 |
|---|---|---|---|
| structured amount=0 + currency | `zero_amount` | `strict-response` | 可进入方式探测 |
| `free_trial` / `trial_period` | `free_trial` | `strict-response` | 可进入方式探测 |
| promo/coupon + amount=0 | `promo_zero` | `strict-page` | 可进入方式探测 |
| first period=0, recurring>0 | `intro_discount_zero` | `strict-page` | 记录续费金额 |
| amount>0 | `nonzero` | `strict-response` | `qualification_lost` |
| amount missing/conflicting | `unknown` | `candidate/page` | 不执行写操作 |

## 3. 支付方式矩阵

对 `hosted`、`paypal`、`momo`、`gopay`、`ideal`、`upi`、`pix`、`blik`、`twint`、`kakao` 各运行一次：

- detected + offered + reused session -> `provider-final` 或明确 runner 失败；
- detected but qualification revalidate fails -> `qualification_lost`，无 confirm；
- unlisted + `forceUnlistedPaymentMethodProbe` -> `forcedProbe=true`，不得进入生产候选；
- final URL 不匹配白名单、含凭据、端口或 hash -> `finalLinkVerified=false`；
- Hosted 只验证长链和源资格，不伪造 native Runner 结果。

## 4. 会话与写副作用

| 场景 | 验收 |
|---|---|
| `reuse_eligibility_session` | `sourceSessionReused=true`，同一 session 重新验证资格 |
| `independent_checkout` | session ID 不同、账号身份相同、独立金额为 0/trial |
| confirm 超时/断连 | 生成 `unknown_side_effect`，只查询原 session |
| approve 失败 | 不重试第二次 approve，保留 provider 响应 |
| 重启 | checkpoint 恢复只读阶段，不重复成功写操作 |
| 账号切换 | 浏览器上下文、Cookie、代理锁隔离 |

## 5. 多阶段出口

构造一组 `RouteVariant`，分别改变 Auth、Checkout、Billing、Runner 出口，验证：

1. 每阶段快照包含 proxy、实际 IP、国家、ASN、时间。
2. 阶段顺序固定，confirm/approve 期间不切换出口。
3. 浏览器全局代理锁使有效并发为 1；第二个任务排队或明确 `skipped`。
4. 任一阶段身份/资格漂移后停止本单元，并产生 drift 事件。

## 6. 调度、统计与安全

- `discovery`、`attribution`、`hybrid` 三模式均能生成可重放 seed。
- hybrid 默认 60/25/15 比例在足够样本后统计误差可解释。
- 预算、速率、连续失败阈值和冷却会阻止超额请求。
- 报表展示分子、分母、失败分类和置信区间，不展示无分母命中率。
- 日志、数据库、导出和截图不包含 token、完整支付参数、个人地址或卡敏感字段。

## 7. 工程命令

```powershell
node C:/Users/Administrator/.codex/skills/dev-workbench/scripts/patch-entry.mjs --phase execute --mode default --format both
node C:/Users/Administrator/.codex/skills/quality-guard/scripts/review-entry.mjs --phase verify --mode review-quality --format both
npx tsx --test tests/*.test.ts
node --test tests/saved-payment-test-backend.test.mjs
npm run compile
npm run build
npm run build:firefox
node scripts/e2e-eligibility-dashboard.mjs
npm run test:e2e-plus-closure
npm run test:e2e-saved-payment:check
```

`patch-entry` 必须产生 `command.outputs.latest.json` 和 `checkpoint.latest.json`；`review-entry` 必须产生 `spec.verdict.latest.json`、`quality.verdict.latest.json`、`verify.evidence.latest.json`。命令失败时保留工件，按最早失败任务恢复。

## 8. 实际执行证据（2026-08-06）

| 层 | 命令/工件 | 结果 |
|---|---|---|
| 静态 | `npm run compile`、`git diff --check` | 退出码 0 |
| 单元/集成 | `npx tsx --test tests/*.test.ts` | 120/120 通过 |
| 本地后端 | `node --test tests/saved-payment-test-backend.test.mjs` | 3/3 通过 |
| Chrome | `npm run build` | Chrome MV3 成功，1.48 MB |
| Firefox | `npm run build:firefox` | Firefox MV2 成功，1.48 MB |
| 资格看板 | `.context-snapshots/e2e-eligibility-dashboard-0.0.37/result.json` | 全部检查为真，无页面/控制台错误 |
| 支付闭环 | `.context-snapshots/plus-checkout-closure/` | 桌面/移动 fixture 通过，重复提交总点击数仍为 1 |
| live 入口 | `.context-snapshots/saved-payment-live-e2e/preflight.latest.json` | preflight 正常；缺少显式 profile/支付测试输入，因此未产生 live 资格结论 |
| 脱敏 | 高风险密钥模式扫描 + 收据归一化测试 | 无命中；不持久化 token/payload |
| 质量复核 | `spec.verdict.latest.json`、`quality.verdict.latest.json`、`verify.evidence.latest.json` | 三项均 `pass`，0 issue |

母技能 release/GitHub/deploy 总事务因共享工作树存在 301 项既有变化而停在 clean-worktree 门；该门不改写上述代码、测试、构建和规格判定，也未执行 reset、stash、clean 或提交操作。

## 9. 隔离交付复核（2026-08-07）

方案 A 从基线 `d856454f82e7fce14c35603a72e0f2f3e1ca69e9` 创建本地分支 `codex/tpp-delivery`，只携带 TPP 领域、必要集成入口、直接依赖和对应测试。共享工作树保持原样，未执行推送或部署。

| 检查 | 结果 |
|---|---|
| `npm run compile` | 通过 |
| `npx tsx --test tests/*.test.ts` | 隔离范围 `63/63` 通过 |
| `npm run build` | Chrome MV3 成功，约 1.29 MB |
| `npm run build:firefox` | Firefox MV2 成功，约 1.29 MB |
| `node scripts/e2e-eligibility-dashboard.mjs` | 全部检查为真，无页面/控制台错误，移动端无横向溢出 |
| `git diff --check` | 通过 |
| 高风险密钥模式扫描 | 无命中；继承的 ACICA 默认 API key/网页登录口令已清空 |

隔离范围的 63 项只统计 TPP、支付 Runner、Checkout、资格与直接依赖测试；原共享工作树的 120 项全量证据仍作为跨 SSOT 回归记录，两者分母不混用。

## 10. 交付门禁

- [x] 文档链接、任务 ID、状态枚举和代码事实一致。
- [x] 10 类方式覆盖，成功终链均具备资格保持证据。
- [x] 复用/独立/强制筛查/未知副作用/恢复/漂移均有测试输出。
- [x] Auth/Checkout/Billing/Runner 出口映射和有效并发 1 有代码、测试与浏览器证据。
- [x] Chrome/Firefox 构建、fixture/live preflight、脱敏扫描、Git diff 和可回滚边界检查通过。
