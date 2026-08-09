# 多因素资格实验复核表

## 配置线

- [x] 旧研究模式任务载入后映射为 `attribution`。
- [x] 新模式保存后同步旧字段，重启扩展不丢失。
- [x] 流量比例非法或不满 100 时确定性归一。
- [x] 路由变体、支付方式和 seed 重复数均经过边界校验。

## 流程线

- [x] discovery 使用高命中优先与未知探索，并保留命中后跳过能力。
- [x] attribution 按账号×国家平衡排程并遵守跨时段冷却。
- [x] hybrid 同时生成利用、平衡、探索单元，单轮无重复单元。
- [x] 每个单元的三阶段路由、支付方式和 seed 序号进入真实执行参数。

## 数据线

- [x] 每次观测包含计划值和实际 Auth/Checkout/Billing 出口证据。
- [x] JSON 导出包含原始观测且不包含 access token。
- [x] CSV 导入识别新增字段，历史 CSV 保持兼容。
- [x] 因素看板显示模式、实验臂、路由、支付方式、seed 和设计单元覆盖。

## 质量线

- [x] TypeScript 编译通过。
- [x] 多因素排程 smoke 通过。
- [x] 资格分析和实验覆盖既有 smoke 通过。
- [x] Firefox 构建、lint 和浏览器看板 E2E 通过。
- [x] XPI 内 manifest 版本、关键脚本和设置页资源完整。

## 复核证据

- `npm run compile`：PASS。
- `node tools/_multi_factor_experiment_smoke.mjs`：PASS，10 个单元分为利用 4、平衡 4、探索 2；证据矩阵仅计 4 个 balanced 样本。
- 既有实验、因素分析、探测逻辑、运行时和 0 元资格 smoke：全部 PASS。
- `.context-snapshots/e2e-eligibility-dashboard-0.0.29/result.json`：全部检查 PASS，含 82 条 CSV 往返和导出无 token。
- `.context-snapshots/e2e-automation-qualification-0.0.29/result.json`：10/10 PASS，`US$0.00` 命中链接入库。
- `web-ext lint`：0 errors、0 notices、27 warnings。
- `dist/openai-plus-vxt-0.0.29.xpi` 与 Mullvad 版 SHA-256：`7231204F9B9325C7C08354F7C50B11C604F5270B3EBFAC25D10042B33048D6B5`。

## 0.0.31 增量复核

- [x] 单一健康出口时仅账号因素显示可开跑，国家/IP/ASN 明确阻塞。
- [x] 同出口多账号达到匹配样本门槛后，账号因素晋级为可归因。
- [x] 同账号跨两个实际国家/IP/ASN 后，对应因素才晋级为可归因。
- [x] 规则指纹变化后，当前报告只包含最新纪元样本。
- [x] 严重结构漂移把探索比例从 20% 提高到 50%。
- [x] CSV 包含结构指纹和规则纪元字段。
- [x] `pnpm compile` 通过。
- [x] `pnpm test:probe-readiness`：5/5 通过。
- [x] 真实动态前置出口账号实验形成 8 条观测：7 error、1 miss、0 hit。
- [ ] MF-18：多国家链式出口认证恢复并形成平衡交叉样本。
- [x] 0.0.31 Firefox 构建、Chrome 浏览器 E2E 与 XPI 复核。

### 真实证据

- `.context-snapshots/live-eligibility-0.0.31/result.json`：`ok=true`，8/8 单元完成，8 条观测；7 个账号被 401 撤销，1 个账号完成 create + promotion 后被严格页面门判为 miss。
- 2026-08-09 当前环境只读复测：直连与 `10808` 的 SG 出口对 Cloudflare/ChatGPT trace 均返回 HTTP 200，匿名出口等同性校验一致；`18090` 链转发监听按 SOCKS/HTTP 探测均失败，`7890` 未监听，仍未形成第二个实际国家。隔离 profile 的浏览器 Session 为 HTTP 403，默认 live session 目录无有效会话，未形成新的账号观测。
- `.context-snapshots/e2e-eligibility-dashboard-0.0.31/result.json`：全部 37 项检查通过，包含可识别性看板、CSV 往返、导出无 token、移动端无横向溢出。
- `pnpm test:probe-readiness`：7/7 通过。
- `pnpm test:payment-runner`：11/11 通过。
- `dist/openai-plus-vxt-0.0.31.xpi` 与 Mullvad 版 SHA-256：`9905B9F1E0CCF31A05A8CB810A0DE3C878BC833D13F5AD8BE8417ED327C7BDCC`。
