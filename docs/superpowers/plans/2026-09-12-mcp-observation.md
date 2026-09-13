# MCP 最小事件采集计划

> 使用 subagent-driven-development / TDD 执行并独立审查；不提交推送或安装。

Goal：补足exec封装造成的MCP调用盲区，提供服务端已处理调用、声明原因、返回分类的可信本地证据。

Architecture：在现有Python MCP transport增加显式按团队启用的旁路观测，不改变身份权限、Registry schema或业务返回。通过调用开始时的Registry精确身份投影决定记录归属；每次工具执行完成写独立不可变JSON文件，不追加共享JSONL。没有身份/授权范围时不创建记录。

Tech Stack：现有Python >=3.10、MCP SDK、pytest、标准库。

## Global Constraints

- 默认关闭；仅operator配置绝对root和精确team allowlist时启用，工具调用参数不能改变采集范围。
- 不保存正文/业务request/capsule，不改业务行为，不调用LLM解释原因。
- reason为可选枚举及agent-declared来源；不能声称确定的心理因果或系统自动召回。
- 未登记/非allowlist无写入，Registry不可验证时不猜身份。不能观测SDK拒绝和未登记调用的缺口必须说明。
- 输出失败只记录固定stderr告警，不改变业务返回，不污染stdio stdout，不覆盖旧文件。
- 每次调用独立UUID；时间UTC，历时单调时钟；runtimeRevision若由operator提供需标明声明来源。
- 本轮仅代码与合成集成测试，不在真实团队启用、不安装Hook/定时器或修改Codex配置。

## Task 1：先修复已确认UI

- [x] Token与MCP分为两个可键盘操作的Tab，统一数值表头/单元格和明细列宽。
- [x] 相关日报回归通过，生成新快照并独立审查；保留浏览器安全策略拒绝导致的视觉验收缺口。全Metrics98项通过，大整数列宽P2已关闭。

## Task 2：服务端采集

Files：python/src/codex_team_context/observations.py、server.py、team_registry.py；python/tests/test_observations.py、test_observation_stdio.py；docs/mcp-observations.md。

- [x] 写RED测试：旧调用兼容、默认无写入、team隔离、reason声明、结果分类、敏感sentinel排除、并发文件完整、失败不影响业务、CLI组合验证。
- [x] 实现Recorder、Registry窄身份读取和三工具包装，新增operator参数，不变更旧业务返回。
- [x] 真stdio验证read/manage/startup与旧required参数；覆盖原测试，核对当前源码路径而非安装副本。新增12项通过；旧stdio基线10项分组验证通过。
- [x] 独立审查并修复重要发现；保存受控样例事件与使用文档。异常旁路隔离、legacy参数拒绝与unmatched竞态均已覆盖，代码/文档复审通过。

## 后续阶段

将服务端事件按确切身份/事件ID导入日报MCP Tab；保留原生日志直接调用与服务端事件来源关系，缺少精确关联不能简单相加。再增加独立应召回节点与行为证据，计算有定义分母的召回覆盖率；金额和真实团队采集授权另行落实。

接入检查项（本阶段尚不实现）：

- 导入必须显式指定 registryId + teamId；不同 Registry 中相同 teamId 不能合并。事件时刻角色沿用事件投影，不以当前成员名单覆盖历史。
- eventId 重复且内容一致时幂等，内容冲突拒绝；不同 eventId 的真实重试保留。没有精确跨来源关联时，服务端与原生日志分别统计，不汇总成“真实总次数”。
- 日归属沿用 Asia/Shanghai；保留 startedAt/completedAt，明确统计以完成时刻归日，asOf 之后的完成事件不提前显示。
- 声明原因、服务端结果和后续行为分列；matched 仅为身份读取命中，不升级成“有效召回”。reason=unknown 不自动推断为 resume 或 post_compaction。
- 当前 HTML 的 sourceKinds/assessment 字段有严格校验，接入时需显式升级报告契约并兼容旧输入；不可直接把新事件塞入旧的 usage-record-attribution 行。
- 新采集的错误/覆盖缺口应显示为健康提示；无事件仍无法区分未启用、无调用或采集失败，不把空目录解释为零消耗或召回率100%。
