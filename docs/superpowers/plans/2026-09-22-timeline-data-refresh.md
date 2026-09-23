# Timeline Data Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有时间线 Tab 按需读取任务报告，并由用户点击确定性更新最新业务阶段。

**Architecture:** 增加受启动配置约束的报告索引；只读取所选任务的报告。`GET /api/timeline?task=<id>&refresh=state` 从最新权威台账构造内存展示，不写业务状态、不覆盖历史报告。阶段与原生日志的时间、版本、缺口分别展示。

**Tech Stack:** Node.js 22、原生浏览器模块、node:test；无新增依赖。

**Execution:** 2026-09-22 三个任务已完成。49 项定向测试通过；三个团队实际 API 验证、固件浏览器更新/回读/任务切换验证通过，页面无横向溢出、无 error/warn。三个旧服务 PID 实查已不存在，本次启动新版而未终止旧进程。回退在临时副本演练通过，E01 安装哈希不变。未提交推送。下方保留实施步骤原始清单，执行结果以本段及部署目录 `stage-refresh-20260922/verification.json` 为准。

## Global Constraints

- 不修改 E01、模型、派工或通知规则；不采集新的 Token/MCP/原生日志；不创建定时器。
- 不提交推送、不切分支；延续用户已授权的现有工作区及本地试用。
- 未知不填零；更新阶段不称作更新全部观测；缺少文件不能借用另一任务的报告。
- HTTP 保持 GET-only、原有鉴权及回环限制；请求不能提交路径。索引来自启动配置，显式绑定 teamId/taskId/path。
- 保留旧 `--timeline-report` 兼容入口；新增索引解除 32 份旧入口上限，仍有明确内存/文件大小限制。

### Task 1: Index and deterministic stage refresh

Files: `src/dashboard-timeline.mjs`, `src/dashboard-timeline-index.mjs`, `src/dashboard-live.mjs`, `test/dashboard-timeline-refresh.test.mjs`.

Interfaces: `readIndexedTimeline(indexPath,state,taskId,{refreshState,checkedAt})`; index JSON `{schemaVersion:1,teamId,reports:[{taskId,path}]}`，路径相对索引文件解析。最多 10000 条/4 MiB；报告 16 MiB。

- [ ] 红测：40 个索引条目，只有所选文件存在，必须成功且没有尝试加载其他报告。
- [ ] 红测：`refresh=state` 必须读取当前版本、无报告时也能生成阶段、旧报告及状态字节不变。
- [ ] 实现严格索引校验、精确任务匹配、选择性读取；过期/损坏报告分别说明。错团队索引拒绝，错任务报告不得渲染。
- [ ] 将原始报告读取和 renderer 分离；阶段刷新用 `buildStateTimeline`，空观测用 `buildTaskTimeline(...,[])`，不改已有工具事件/时间窗口。
- [ ] 通过 API 返回 `stageData`、`observations`、`checkedAt`，HTML 显示独立时间及覆盖边界。

### Task 2: UI and CLI

Files: `src/dashboard-client.mjs`, `src/dashboard-live.mjs`, `src/cli.mjs`, `test/dashboard-live.test.mjs`.

- [ ] 新增 `--timeline-index <index.json>`，与旧报告参数互斥；无效/重复参数拒绝。
- [ ] 时间线页新增「更新阶段数据」；「重新读取报告」读历史快照，前者携带 `refresh=state`。切换任务保持当前数据模式，按钮反馈和取消边界保持。
- [ ] 缺失状态/错误索引返回明确失败，不保留被误标为新数据的旧内容；不暴露路径或凭据。
- [ ] 执行定向测试：`node --experimental-test-isolation=none --test test/dashboard-*.test.mjs test/metrics-daily-tabs.test.mjs test/task-timeline-state.test.mjs`。

### Task 3: Local adoption and verification

Files: 开发工作区 `artifacts/dashboard-observation-20260922/` 的版本化部署脚本/回执、`artifacts/serve-team-portal.mjs`，以及 `docs/design/task-timeline.md`。

- [ ] 用原绑定文件生成显式索引；保留全部旧报告，无日志扫描。当前所有任务可通过刷新读取阶段，不伪造缺少的历史工具报告。
- [ ] 仅更新展示依赖；备份旧展示文件及启动脚本。执行 CLI/Skill/MCP 保持安装基线。
- [ ] 核对各服务 PID/命令/API 身份后重启三个看板；验证 Token/MCP 原截止时间不变。
- [ ] 浏览器验证时间线页、刷新、读取旧报告、任务切换、缺报告任务及独立数据时间；记录真实结果和回退入口。
