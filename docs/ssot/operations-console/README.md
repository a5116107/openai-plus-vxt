# 运营控制台 SSOT

> 版本锚点：0.0.37

## 目标

把批量资格探测的运行过程、账号资产和最终命中放在同一可核查的数据链中，运营人员能够回答：正在跑什么、进度是否真实、哪个账号在哪个国家失败、凭据是否健康、哪些链接已经入库。

## 数据链

```text
ProbeTask
  └─ runId / cycleId
       └─ accountId
            └─ unitId(account × country) / attemptId
                 ├─ status / stage / message
                 ├─ Auth / Checkout / Billing 出口证据
                 └─ result → observation → deduped hit database
```

## 口径

| 指标 | 定义 |
|---|---|
| 总单元 | 本轮账号 × 国家排程数 |
| 完成单元 | 成功、未命中、失败或跳过的终态单元 |
| 实际请求 | 真正执行了探测请求的单元，不包含预先跳过 |
| 跳过 | 因禁用、冷却、已有命中等策略未发起请求 |
| 命中 | 去重后的有效资格/优惠链接 |

进度固定使用 `completedUnits / totalUnits`；`processed` 只表示实际请求量。单浏览器代理是 profile 全局资源，因此 `browser-global` 上下文并发固定为 1。只有外部适配器提供非空 `isolationProof` 且每个 Worker 使用不同 `proxyContextId` 时，调度器才开放大于 1 的有效并发。

## 持久化边界

- `browser.storage.local` 保存控制面和有界热数据，继续兼容现有设置页、后台任务与恢复路径。
- IndexedDB `opx-probe-archive` 保存完整观测、命中记录和带单元快照的运行历史；在浏览器提供独立隐私扩展上下文时使用独立数据库命名空间。
- 首次读取执行 `legacy-local-v1` 幂等迁移；中断后重复写入使用稳定主键覆盖，不产生重复记录。
- IndexedDB 打开、事务或查询失败时，后台继续使用本地热数据，并通过 `archiveStatus.degraded/backend/lastError` 暴露降级状态。
- 清理归档不会删除热数据；因素数据和命中库的业务清理会同步清理对应归档。

## 页面组成

1. 任务运行中心：总进度、请求/跳过/命中/错误摘要，按账号折叠到国家单元。
2. 账号资产中心：来源、启用状态、凭据健康、最近探测、成功率、命中数；支持搜索、状态筛选、50 条分页和批量操作。
3. 命中链接数据库：运行缓存与持久库统一去重，支持查询和导出。
4. 资格因素看板：只基于独立观测做相关性、漂移、功效与探索建议。
5. 独立运营页面：`operations-console.html` 提供观测、命中、运行三类归档的摘要、50 条分页、搜索、国家/结果筛选、JSON 导出、分域清理和按天保留策略。

## 并发隔离契约

`ProbeProxyContextScheduler` 以 `proxyContextId` 作为租约键，同一上下文的任务在成功、失败和取消路径上均严格串行并释放租约。`resolveProbeWorkerPlan` 只接受带证明的 `isolated` 上下文进入并发池；当前扩展内置适配器声明为 `browser-global`，所以配置中的高并发值不会造成多个国家同时修改全局代理。

## 证据边界

浏览器种子 E2E 证明页面、存储和后台消息的真实交互；阶段 smoke 证明三阶段出口证据关联。在线上游完整成功仍要求同一 `runId/cycleId` 串起注册、OTP、Session、三阶段和命中入库，并保留最终链接。
