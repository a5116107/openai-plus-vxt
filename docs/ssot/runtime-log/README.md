# 实时运行日志 SSOT

- Source: 对方实时日志台（QQ 视频）可吸收逻辑 + 本插件探测/自动化可观测性缺口
- Goal: 把并发任务变成可追踪事件流（谁/哪步/状态/为何失败/下一步）

## 吸收决策

| 对方能力 | 吸收? | 本批 |
|---|---|---|
| 实时日志流 + 自动滚动 | YES | P0 |
| 账号标签 + 级别色 | YES | P0 |
| 结构化字段(订单/HTTP/阶段/进度) | YES | P0 |
| 失败可行动文案(可重试/终态) | YES | P0 |
| 日志导出 | YES | P0 |
| 按账号过滤 | YES | P0 |
| 显示浏览器窗口 | LATER | P1 |
| 接码超时自动退款 | LATER | 注册链路 P1 |
| 完整桌面级监视 | NO | - |

## Task DAG

- T-LOG-01 RunLog 模型 + 存储 + 广播
- T-LOG-02 探测流程关键阶段打点（含三阶段/detect/final/seed）
- T-LOG-03 失败分级（info/success/warn/error）与可行动文案
- T-LOG-04 UI 实时日志面板（连接态/自动滚动/过滤/清空/导出）
- T-LOG-05 Verify + package

## Acceptance

1. 任何探测轮次产生结构化 RunLog 事件流
2. 每条含 ts/level/account/stage/message，可选 code/meta/progress
3. UI 可实时看到、按账号/级别过滤、导出 CSV/JSONL
4. 失败分 warn(可重试) / error(终态)
5. VERIFY 每项 PASS + xpi

## 复核结论（0.0.16）

- 已吸收：实时日志流、账号标签、级别色、结构化阶段/进度、失败可行动文案、导出、按账号/级别过滤
- 未吸收（LATER）：浏览器窗口监视、接码超时自动退款
- 包：dist/openai-plus-vxt-0.0.16-mullvad.xpi
