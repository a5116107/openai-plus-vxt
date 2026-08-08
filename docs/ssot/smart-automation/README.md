# 智能自动化总流程 SSOT（openai-plus-vxt）

> 统一试用资格、多支付方式筛查与终链提取的 canonical 编排见 [试用资格与多支付提链 SSOT](../trial-payment-probe/README.md)。本文件保留自动化领域流程细节。

> 版本锚点：0.0.28
> 目标：把「环境接入 → 账号准备 → 撞资格探测 → 链接富化 → 入库看板 → 反馈优化」串成可自动运转的闭环。

---

## 0. 一句话目标

**同一账号，在不同出口/阶段/支付方式下自动“撞资格”，命中优惠/试用/0 元链接后入库，并依据健康度与命中率自动收敛到高价值路径。**

---

## 1. 系统分层

```text
┌────────────────────────────────────────────────────────────┐
│  UI 控制台（automation-settings）                          │
│  代理 / 探测任务 / 命中库 / 方式看板 / 实时日志 / 报表       │
└───────────────────────────┬────────────────────────────────┘
                            │ runtime messages
┌───────────────────────────▼────────────────────────────────┐
│  Background 编排层                                          │
│  proxy · probe · run-log · automation · checkout · payment  │
└───────┬─────────────┬──────────────┬───────────┬───────────┘
        │             │              │           │
   代理三段式     撞资格探测      注册自动化    支付富化
   front/exit1/2  国家×账号轮询   邮箱/手机链路  detect+final
        │             │              │           │
        └─────────────┴──────┬───────┴───────────┘
                             ▼
                    本地存储 + 看板 + 导出
```

### 核心模块

| 模块 | 职责 |
|---|---|
| `proxy` | 三段代理、国家出口映射、方式三池、seed 健康、Register-Tool 导入 |
| `probe` | 定时/单轮撞资格、国家计划、命中库、报表、方式推荐 |
| `link-extractor/checkout` | 直链 checkout + UPL 三阶段 pipeline |
| `payment` | 支付方式探测、终链提取、可选 stripe confirm |
| `run-log` | 结构化实时事件流（可过滤/导出） |
| `automation` | 邮箱/手机注册到支付页的逐步自动化 |
| `oauth-phone / sms` | 手机验证与接码 |

---

## 2. 智能自动化主闭环（推荐运行姿态）

```text
[A 环境就绪]
  接入 Register-Tool / 本地链式代理
        │
        ▼
[B 资源准备]
  导入账号 token · 勾选国家 · 配置任务策略
        │
        ▼
[C 智能规划]
  健康检查剔除坏出口
  高命中率国家优先 + 未知国家实验探索
  方式探测结果推荐支付方式
        │
        ▼
[D 执行探测]
  账号 × 国家 轮询
  入口代理预热 → 出口跟随国家
  可选 UPL 三阶段 checkout
        │
        ├─ 未命中 / 可重试 ──► 分级日志 + 重试/换出口
        │
        └─ 命中 ──► 方式探测 → 终链提取 → 打开嗅探 → 入库提醒
                        │
                        ▼
[E 反馈学习]
  更新 stats / seed 健康 / 账号报表 / 方式看板
  下一轮自动用更高价值国家与方式
```

这就是“智能”的来源：**不是一次写死路径，而是每轮用健康度、命中率、探测到的支持方式改写下一轮计划。**

---

## 3. 流程 A：环境与代理智能接入

### 3.1 三段式代理模型

```text
前置 front（本地海外环境入口，常见 7890/10808，可开关）
   │
   ├─ 出口1 exit1（任意国家/用途，常作 checkout/bootstrap）
   └─ 出口2 exit2（任意国家/用途，常作 provider/confirm）

附加：
- countryExits：CC → 具体出口（follow-country 用）
- methodPools：按支付方式的 bootstrap/promotion/provider 三池
- seedHealth：失败冷却 / 达阈值剔除
```

链路模式：
- `direct-exit`：浏览器直接切到对应出口
- `front-gateway`：浏览器始终走前置，由本地客户端切上游出口

### 3.2 Register-Tool 配置环境映射

来源：`GPT-Register-Tool/config.json` + `chain_proxy_*`

| 来源 | 插件落点 |
|---|---|
| mailbox_proxy / proxy.default | front |
| paypal.checkout（或 JP chain :18092） | exit1 |
| paypal.provider/confirm（或 US chain :18093） | exit2 |
| TH/IN/JP/US 链式端口 | countryExits |
| paypal/upi.stage_proxies | methodPools |
| paypal.proxy_health | seed 冷却参数 |

智能点：
- 若某阶段代理与前置相同，则按 `stage_proxy_countries` 自动回退到对应 chain port，避免“看起来配了出口、实际仍走前置”。

### 3.3 操作入口

自动化设置 → **代理配置（三段式）**
1. 一键本机链式默认 / 粘贴 config.json 导入
2. 保存并应用前置
3. （可选）方式三池、seed 健康导出

---

## 4. 流程 B：账号与任务准备

### 4.1 探测账号

```text
email----accessToken
或 session JSON / JWT
  → 解析保存为 ProbeAccount 池
```

### 4.2 探测任务关键旋钮

| 类别 | 配置 | 智能含义 |
|---|---|---|
| 调度 | interval / concurrency / retry | 轮询节奏与容错 |
| 代理 | entryProxy / exitProxy / follow-country | 预热与出口策略 |
| 国家 | 多选国家 + 高命中收敛 | 搜索空间 |
| 资格 | requireZero / channels / plan | 命中判定 |
| UPL | stagedPipeline / bootstrap·promotion·provider | 三阶段撞法 |
| 富化 | detectMethods / extractFinalUrl / stripeConfirm | 命中后提纯 |
| 反馈 | excludeUnhealthy / highHitRateOnly / minHitRate | 自动收敛 |
| 产出 | saveHitsToDatabase / autoOpen / notify | 结果处置 |

---

## 5. 流程 C：智能规划（开跑前 / 每轮前）

```text
selectedCountries
   │
   ├─ excludeUnhealthyExits?
   │     用 proxyHealth 去掉 fail/skip
   │
   ├─ highHitRateOnly?
   │     用历史 stats 优先命中率≥阈值 且 attempts≥最小次数的国家
   │     可截断到 maxHighRateCountries
   │     explorationEnabled 时每轮轮换保留 N 个未知/低样本国家
   │
   └─ 得到本轮 countryPlan + note
```

并行可选：
- **出口健康检查**：按国家切出口请求 trace，写 `proxyHealth`
- **方式推荐**：读 `methodDetections`，只推荐**实际探测到支持**的支付方式
- **账号报表**：看哪些号已有 zero/trial/promo，避免无效重复撞

---

## 6. 流程 D：撞资格执行引擎（核心）

### 6.1 轮次调度

```text
controlProbe(start|run-once|stop|refresh)
  └─ runProbeTask(taskId, reschedule)
        ├─ 选账号 selectAccounts
        ├─ 选国家 selectCountriesForProbe（智能规划）
        ├─ for account:
        │    for country:
        │       probeAccountCountry(...)
        │       recordProbeAttempt / 命中处理 / 错误分级日志
        └─ 完成 → alarm 预约下一轮（若定时）
```

约束：扩展代理进程级全局，**有效并发保持 1**，保证国家切换正确。

### 6.2 单次 account@country 逻辑

```text
1) 校验 token
2) applyProbeProxy(country)
     entry: front/exit1 预热
     exit : follow-country / fixed-exit2 / fixed-front
3) 循环 attempt ≤ retryCount
     ├─ stagedPipeline?
     │    runStagedCheckoutPipeline
     │      bootstrap(countryA) → promotion(countryB) → provider(countryC)
     │      每段 onBeforeStage：method pool seed 或国家出口
     │
     └─ 否则 createCheckoutLinkDirect(region=country)
4) 成功拿到 link/url
     ├─ classifyCheckoutHit（link/promo/trial/zero/channel）
     ├─ requireZero? 非 0 → warn 可重试（换出口继续撞）
     └─ maybeEnrichFinalUrl
          detectPaymentMethods → 写入方式看板
          autoApplyDetectedMethods → 仅用支持方式推荐
          extractFinalPaymentUrl → final 链
5) 失败
     classifyFailureLevel
       warn  = 可重试（超时/requireZero/冷却）
       error = 终态（token 无效/会话 409 等）
     + action 可行动文案
6) seed 结果回写（成功/失败冷却/剔除）
```

### 6.3 UPL 三阶段语义

```text
bootstrap  : 建 checkout session（常用目标国/选中国）
promotion  : checkout/update 推促销（常用 VN 或其他中段国）
provider   : checkout/taxes 或支付提供侧（可与 bootstrap 同国或支付国）
```

智能点：
- 选中国家可同时作为 bootstrap/provider
- 各段可走不同代理 seed（methodPools）
- stageTrace 进入实时日志，便于定位卡在哪一段

### 6.4 命中后处置

```text
hit
 ├─ autoOpenOnHit → 开页
 ├─ sniffCheckoutOnHit → 识别 0 元/试用文案
 ├─ saveHitsToDatabase → hitDatabase
 ├─ notify（声音/角标/置顶）
 ├─ skipAccountAfterHit → 本轮跳过该号剩余国家
 └─ run-log success 事件
```

普通自动化到达 Checkout 时先读取页面金额。金额明确为 0 时直接构造资格记录并写入命中数据库，保留账号、国家、币种、Checkout/Billing 实际出口和原始链接；该分支不再点击支付按钮，也不再等待 PayPal 跳转。非 0 或金额不明确时继续原支付流程。

---

## 7. 流程 E：反馈学习与看板

### 7.1 数据面

| 数据 | 用途 |
|---|---|
| `stats` | 国家×通道命中率，驱动高命中收敛 |
| `proxyHealth` | 自动剔除失败出口 |
| `seedHealth` | 方式池 seed 冷却/剔除 |
| `methodDetections` | 国家支持的支付方式与推荐 |
| `hitDatabase` | 命中链接资产库 |
| `accountReport` | 账号资格撞库结果 |
| `runLog.events` | 实时可观测性与排障 |

### 7.2 看板（自动化设置页）

1. 实时运行日志（连接态/过滤/导出）
2. 国家×通道成功率
3. 高命中国家推荐 / 本轮有效出口
4. 方式探测结果看板（仅展示探测到的支持方式）
5. 出口代理健康检查
6. 账号资格撞库报表
7. 命中链接数据库

### 7.3 自动优化策略（已实现）

| 策略 | 输入 | 输出 |
|---|---|---|
| 坏出口剔除 | proxyHealth | 下轮排除明确 fail/skip 的出口 |
| 探索/利用轮询 | stats + 阈值 + round | 高命中国家优先，每轮保留实验国家 |
| seed 冷却 | 失败次数 | 暂时跳过/剔除坏 seed |
| 方式推荐 | methodDetections | 任务 paymentMethod/channels |
| 失败分级 | 错误文案 | warn 继续撞 / error 换号 |

---

## 8. 流程 F：注册自动化（与探测并列的另一条主链）

邮箱模式主链：

```text
清环境 → 选邮箱 → 打开注册 → 填邮箱 → 收邮箱码
 → 填资料 → 读 session/token
 → 提取订阅链接 → 打开 → 提交 OpenAI 订阅页
 → PayPal 创建/填资料/接码
 → OAuth 链接与导出
```

手机注册模式：
- 走 phone registration step order（OAuth 手机接码能力复用）

与探测的关系：
- 注册链产出 **accessToken/session**
- 探测链消费 token 做多出口撞资格
- 二者可衔接：注册成功账号进入探测池

---

## 9. 智能自动化“标准作业程序”（SOP）

### 日常推荐顺序

1. **启动本地链式代理**（Register-Tool chain JP/US/IN…，前置 10808）
2. 插件代理页点 **一键本机链式默认** → 保存应用前置
3. 导入探测账号（email----token）
4. 勾选一批国家；开启：
   - 跟随目标国家
   - 剔除不健康出口
   - 高命中率轮询（有历史后）
   - requireZero（只要 0 元/试用时）
   - 方式探测 + 按探测支持推荐
   - 命中入库 + 实时日志
5. 先 **检查出口健康**
6. **立即跑一轮** 看实时日志与命中
7. 看方式看板，**应用推荐方式**
8. 启动定时，进入无人值守闭环

### 成功信号

- 实时日志出现 `ROUND_START` → `PROBE_START` → `success/hit`
- 命中库新增 link/zero/trial
- 高命中推荐国家列表趋于稳定
- seed 健康中失败出口进入冷却/剔除
- 方式看板按国家给出非空“支持方式”

### 失败分流

| 日志级别 | 典型原因 | 自动/人工动作 |
|---|---|---|
| warn | 超时、requireZero 非 0、seed 冷却 | 自动重试/换国家 |
| error | token 无效、会话 409 | 换号或重新登录 |
| methods-miss | 未探测到支付方式 | 检查 pk/出口后继续撞 |
| no-final-url | 终链提取失败 | 开 confirm 或换支持方式 |

---

## 10. 端到端时序总图

```text
Register-Tool 环境
    │ 导入
    ▼
Proxy Settings（front/exit1/exit2/country/methodPools）
    │
    ▼
Probe Task 智能规划（health + hit-rate + method rec）
    │
    ▼
Account × Country 执行
    │
    ├─ Proxy switch
    ├─ Checkout (direct or staged UPL)
    ├─ Classify hit / requireZero
    ├─ Detect methods / Final URL
    ├─ Open+Sniff / Notify / DB
    └─ RunLog + Stats + SeedHealth
            │
            └────────► 下一轮计划更聪明
```

---

## 11. 已实现能力清单（按智能自动化视角）

### P0 已闭环
- 三段代理 + 国家映射 + 方式三池 + seed 健康
- Register-Tool 配置/链式默认一键接入
- 撞资格探测任务（定时/单轮/停止）
- UPL 三阶段 checkout
- requireZero、命中入库、健康剔除、高命中轮询
- 支付方式探测与“仅用支持方式”推荐
- 终链提取
- 实时运行日志（结构化、过滤、导出）
- 多看板（命中/方式/健康/账号报表）
- 普通自动化 Auth / Checkout（优惠评估）/ Billing 三阶段独立出口
- 每阶段独立 seed 池、`{SESSION}` 动态会话、阶段进入轮换、阶段内固定
- Cloudflare trace 出口 IP/国家证据、失败 seed 跳过、三阶段 IP 唯一性门禁
- 换账号时开启新代理 cycle，下一账号重新轮换三阶段出口
- 任务运行中心按总任务→账号→国家单元分层显示，进度以完成单元计数
- 账号资产中心支持凭据健康、搜索、筛选、分页和批量启停/删除
- 运行态和命中库双重去重，跳过单元不计入实际网络请求
- Checkout 明确 0 元时即时保存资格链接，跳过支付提交与 PayPal 等待

### 当前证据边界

- 已证明任务模型、后台消息交互、资产操作、看板和三阶段独立出口工作正常。
- 已证明真实注册可到验证码页，历史实测也覆盖 OTP 回填与 Session 交接。
- 线上真实流程已到达 `US$0.00` Checkout；该轮运行的是修复前逻辑，随后错误等待 PayPal，未写入命中库。
- 修复后的真扩展确定性 E2E 已证明 0 元链接即时入库；修复版线上重跑受 Cloudflare 挑战与动态出口故障影响，仍缺同轮在线写库成功证据。
- 账号、国家、具体 IP 和随机性对资格的独立影响仍需平衡样本；国家排行榜表示相关性，不直接表示因果。

### LATER（未作为本插件主闭环）
- 完整浏览器窗口监视桌面级 UI
- 接码超时自动退款
- 真正多进程并发多出口（受浏览器代理全局限制）

---

## 12. 代码锚点（便于继续开发）

| 流程 | 入口 |
|---|---|
| 代理应用 | `src/features/proxy/service.ts` |
| 三阶段业务出口 | `src/features/proxy/service.ts#applyAutomationProxyStage` |
| Register-Tool 导入 | `src/features/proxy/import-register-tool.ts` |
| 探测调度 | `src/features/probe/service.ts#runProbeTask` |
| 国家智能选择 | `src/features/probe/state.ts#selectCountriesForProbe` |
| 三阶段 checkout | `src/features/link-extractor/checkout.ts#runStagedCheckoutPipeline` |
| 方式/终链 | `src/features/payment/*` |
| 实时日志 | `src/features/run-log/*` |
| 注册自动化 | `src/features/automation/runner.ts` |
| 控制台 UI | `entrypoints/automation-settings/main.ts` |

---

## 13. 普通自动化三阶段出口 SSOT

```text
Auth（注册/OTP/资料）
  -> auth seed 池；阶段内 sticky
Checkout（Session/生成链接/优惠评估）
  -> checkout seed 池；进入阶段轮换
Billing（打开结账/地址/支付方式/确认）
  -> billing seed 池；进入阶段轮换
```

约束：

1. 每个账号对应一个 `cycleId`；自动换邮箱时创建新 cycle。
2. `verifyExitOnSwitch` 开启时，每次阶段切换必须取得实际 IP/国家；失败 seed 自动换下一条。
3. `requireDistinctExits` 开启时，同一 cycle 的三个阶段 IP 不得重复；超过最大尝试次数则停止当前步骤。
4. `stickyWithinStage` 开启时，同一阶段所有请求保持同一出口，避免 OTP、登录和 checkout 上下文断裂。
5. seed 代理用户名支持 `{SESSION}`，阶段进入时替换为新会话标识；多行 seed 按索引跨账号轮询。

---

## 14. Plus 双 Checkout 保存卡复用闭环

视频对齐所需的集成流程不归属于单一领域模块。canonical 契约位于：

- `PLUS_CHECKOUT_CLOSURE.md`：状态机、跨域契约、不变量、错误恢复、文件所有权与最终验收。
- `TASKS.md`：唯一集成任务状态源，任务前缀 `PCC-*`。
- `VERIFY.md` 的“Plus 双 Checkout 闭环”章节：唯一集成验收状态源。

领域 SSOT 继续管理各自内部行为；集成任务只引用这些依赖，不复制其完成状态。当前总判定为“规划完成，待显式执行授权”，不等于 live 闭环已经实现。
