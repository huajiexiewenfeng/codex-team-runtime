# 协作优化设计索引

更新：2026-11-07。这里按问题整理已讨论、实现或验证的优化方案；当前近期源码收口基线为 `29cfbc4`。设计文档中的旧“待确认/未安装”是当时快照，当前实现与验证状态以[主线收口说明](../optimization/manager-optimization-rollup-20261107.md)和实际部署版本为准。

## 新提议（未实施）

- [当前登记任务锚点](current-task-anchor-proposal-20261109.md)：复用已有台账和角色恢复调用，降低压缩后误恢复旧任务的风险；不新增 Worker 启动/恢复调用。

## 已评审，暂不实施

- [独立新任务安全入队](independent-task-queue-review-20261111.md)：记录原生队列与后台加载实验、台账/去重候选及负向优化风险；未解决原始切页问题，决定暂不实施。

## 近期方案

| 日期 / 方案 | 解决的问题 | 设计与契约 | 当前边界 |
| --- | --- | --- | --- |
| 10-28 Manager 通用操作 | 反复拼装时间、事件 ID、版本参数造成机械往返 | [设计、跨团队矩阵与回退](manager-operations-optimization-20261028.md) · [调用说明](../manager-operations.md) | 核心与固定宿主流程已入主线；独立验收仍由 Manager 判断 |
| 10-29 轻量 RSI | 改进缺少持续、可承担的评估闭环 | [轻量方案](team-rsi-lightweight-20261029.md) · [流程图](../assets/team-rsi-lightweight-20261029.svg) · [早期完整设计](team-rsi.md) | 设计已入库；不代表自动优化、自动安装或后台实验已上线 |
| 11-05 Manager 入口与召回保留 | 职责回退、调用端过滤丢失 managerGuidance | [方案与边界](../optimization/manager-entry-recall-candidate-20261105.md) · [监督核心](../../skills/manager-session/references/manager-supervision.md) | 代码及规则已入主线；既有单次召回，不增加 Worker 启动/恢复步骤 |
| 11-06 P0 监督分层与交接回归 | 日常监督加载过多细节，组合交接缺少回归覆盖 | [具体修改计划](p0-implementation-plan-20261106.md) · [候选与审查记录](../optimization/p0-manager-supervision-candidate-20261106.md) · [观察表](../optimization/p0-observation-template.md) | 短核心、按需参考和组合测试已入主线；不新建在线采集服务 |
| 11-06 状态过滤与 notLoaded 就绪 | 原生状态形状误判、未加载会话阻止派发 | [设计与终态修订](../optimization/notloaded-readiness-candidate-20261106.md) · [就绪模板](../../skills/manager-session/scripts/functions-exec-thread-ready-template.js) | 同本地宿主、精确身份下最多打开一次、复核一次；异常保持等待，不强行发送 |
| 11-06 Manager 新旧入口统一 | 新固定入口与旧手写事件路径并存，模型仍绕回机械操作 | [独立设计](manager-entry-unification-20261106.md) · [主线收口](../optimization/manager-optimization-rollup-20261107.md) | receive 与 decision 分开；未知结果不自动回退旧写路径，不重放在途操作 |

## 前序协作基础

| 主题 | 文档 | 作用 |
| --- | --- | --- |
| 结构化提交与状态摘要 | [协商税第一批优化](../optimization/coordination-tax-opt-1-2.md) | 减少逐步编排与普通进度问答；结构化声明仍需验收 |
| 提交通知 | [E03](e03-notice-runtime.md) | 记录提交与通知过程，区分本地事实和宿主送达 |
| 派发与恢复 | [E04](e04-dispatch-runtime.md) | 保留任务占用、FIFO、幂等和未知投递保护 |
| 收件与前台续办 | [E05 设计](e05-manager-inbox-runtime.md) · [现行契约](../manager-inbox.md) | 持久待办和前台领取；显式启用，不等同自动唤醒 |
| 时间与成本证据 | [任务时间线](task-timeline.md) · [统计采集](../dashboard-stats.md) · [Dashboard v2](../dashboard-ui-v2.md) | 根据明确来源区分业务执行、等待、协作与未归因区间 |

## 共同约束与验收

- 只优化通用协作层，不把某团队的构建、业务审批或产品约定写进 Runtime。
- 确定性的身份/版本/状态/参数检查由程序执行；需求判断、证据解释和独立验收仍由模型负责，不改写原始语义。
- 不增加 Worker 的启动、恢复、必读文件、字段或普通进度汇报要求；不把 Manager 成本转嫁给 Worker。
- 安装、加载、实际采用与收益分开。主线整合回归为 Node 719 项、Python 270 项全部通过；两轮自然任务的收益仍须后续同口径观察。
- 保留原业务与审计事实。能力未知、部分生效或冲突时核对原操作；不盲目重发、换发送者或自动回退写路径。
- 看门狗、自动唤醒、定时器、全局 Hook、权限引擎和自动会话轮换不属于本次交付。

后续结果追加到[优化说明与本地观测](../optimization/README.md)，保留失败和证据缺口。原始日志、团队状态及回退备份不随设计文档公开。
