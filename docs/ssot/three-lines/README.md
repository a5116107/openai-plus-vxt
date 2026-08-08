# 三线 SSOT：流程线 · 逻辑线 · 业务线

> 版本锚点：0.0.18
> 评价维度：是否智能、是否自动化、是否合理
> 关联：docs/ssot/smart-automation · register-tool-env · runtime-log · upl-alignment

## 0. 总判词

| 维度 | 结论 | 说明 |
|---|---|---|
| 自动化 | 高 | 注册步骤链、探测定时、代理切换、命中入库、日志看板已闭环 |
| 智能 | 中高 | 健康剔除、高命中收敛、方式仅用探测支持、失败分级、seed冷却；注册到探测自动衔接 + 智能开跑 |
| 合理 | 高 | 三段代理/UPL/撞资格边界清晰；并发强制1符合浏览器代理全局限制 |

非阻塞边界：真多出口并行仍依赖外部隔离适配器；桌面级窗口监视需要原生宿主，不属于浏览器扩展可本地交付的能力。接码超时自动取消/本地订单记账已落地，平台侧退款结果仍以 provider API 回执为准。

## 1. 流程线

F1 环境接入 -> F2 供给准备(注册自动同步探测池) -> F3 智能规划 -> F4 执行探测 -> F5 反馈学习

| ID | 能力 | Status |
|---|---|---|
| F-01 | Register-Tool 接入 | done |
| F-02 | 三段代理模型 | done |
| F-03 | 探测调度 | done |
| F-04 | 国家智能规划 | done |
| F-05 | UPL 三阶段 | done |
| F-06 | 方式探测+终链 | done |
| F-07 | 命中库 | done |
| F-08 | 实时日志 | done |
| F-09 | 注册步骤链 | done |
| F-10 | 注册session自动进探测池 | done |
| F-11 | 智能开跑 | done |

## 2. 逻辑线

| ID | 逻辑 | Status |
|---|---|---|
| L-01 | 失败分级 warn/error+action | done |
| L-02 | requireZero | done |
| L-03 | seed 冷却/剔除 | done |
| L-04 | 方式仅探测支持 | done |
| L-05 | 同前置回退 chain port | done |
| L-06 | 并发=1 | done |
| L-07 | 健康全剔除保底 | done |
| L-08 | 高命中过滤 | done |
| L-09 | 智能开跑缺账号阻断 | done |

## 3. 业务线

A 撞资格资产：token -> 多出口命中链接入库
B 账号供给：注册自动化 -> session/token -> A
C 出口环境：Register-Tool 链式/配置 -> 支撑 A/B

| ID | 能力 | Status |
|---|---|---|
| B-01 | 撞资格产品面 | done |
| B-02 | 注册供给 | done |
| B-03 | 多看板 | done |
| B-04 | 安装包 | done |
| B-05 | 注册到探测闭环 | done |
| B-06 | 智能开跑入口 | done |

## 4. SOP

1. 一键本机链式默认
2. 注册或导入 token（注册会自动同步）
3. 智能开跑一轮
4. 看日志/方式看板/命中库
5. 智能启动定时

## 5. 锚点

- import-register-tool.ts
- probe/service.ts runProbeTask / ensureSmartProbeBootstrap / importSessionToProbePool
- runner-checkout.ts handoff
- selectCountriesForProbe / classifyFailureLevel / seed-health
- automation-settings 智能开跑按钮
