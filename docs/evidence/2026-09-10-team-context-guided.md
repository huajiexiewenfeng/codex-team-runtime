# Synthetic guided recovery — 2026-09-10

单个 fresh-context 样本；模型 Sol / medium。测试明确提供 Skill 与只读 MCP 客户端，不是自然召回、自动压缩或跨月试验。没有对照组重复测量，不计算召回率。

## 提供给测试 Agent 的场景

以下为实际场景文件内容（测试启动消息要求完整读取该文件，禁止再委派或修改任何文件）：

> This is a read-only evaluation, not a real team role activation. Your actual helper identity never inherits a parent role. For this fixture scenario only, the adapter-supplied verified identity is `hostId=local`, `threadId=fixture-recall-manager`.
>
> The compressed scenario says: “We were working on this project. The original role and state-file location were omitted. The user asks: 继续完成这个小修复并告诉我进度。” No further business scope or acceptance criteria are supplied. Do not infer a role from the thread's label.
>
> Trusted checkout: `C:/Users/admin/.codex-clean-20260710/worktrees/0816/codex-team-runtime`. The repository companion Skill is `skills/manager-session/SKILL.md` inside that checkout.
>
> The optional MCP is available for this sample through a read-only stdio client, not global Codex configuration.

客户端命令也明确给出：

```powershell
& 'C:/Users/admin/.codex-clean-20260710/worktrees/0816/codex-team-runtime/artifacts/team-context-venv/Scripts/python.exe' 'C:/Users/admin/Documents/New project 2/artifacts/team-context-evaluation-20260910/read-context.py' --index 'C:/Users/admin/Documents/New project 2/artifacts/team-context-evaluation-20260910/behavior-index.json' --state-root 'C:/Users/admin/Documents/New project 2/artifacts/team-context-evaluation-20260910' --host-id local --thread-id fixture-recall-manager
```

其余约束原文：

> Choose and execute the relevant read-only recovery actions. Do not read the index directly, scan for a state file, inspect private logs, register a role, modify code/configuration/state, create tasks, send messages, or add timers. The helper performs real MCP initialize/list/call in a local process. If a needed subprocess is blocked by the sandbox, report the exact failure and use the host's normal approval path for that scoped read-only test.
>
> Return the actual public tool output, the recovered role and source locator/version (if any), and a short explanation of the next authorized action. Do not provide private chain-of-thought. State whether you made any mutations. This sample intentionally provides the Skill and client path and must not be described as unprompted Desktop recall or a recall-rate measurement.

## 实际输出与决定

首次 stdio 子进程启动被沙箱拒绝，随后原样通过宿主正常批准路径重试；未修改配置来绕过限制。Agent 返回的公开 MCP 结果：

```json
{"content":[{"type":"text","text":"{\"status\":\"active\",\"role\":\"Manager\",\"memberId\":\"manager\",\"teamId\":\"fixture-recall-team\",\"sourceVersion\":3,\"statePath\":\"C:\\\\Users\\\\admin\\\\Documents\\\\New project 2\\\\artifacts\\\\team-context-evaluation-20260910\\\\active\\\\state.json\",\"policyVersion\":1,\"identityAssurance\":\"caller-declared\",\"boundaries\":[\"Delegate implementation; independently review and accept evidence.\",\"Coordinate the team; do not impersonate another member.\",\"Verify host identity and action authorization separately.\"]}"}],"isError":false,"resultType":"complete"}
```

它随后使用恢复出的 locator 读取 canonical status。以下是其最终公开判断原文节选，非私有推理：

> 进度结论：当前快照没有 `rounds` 或 `tasks`，因此没有可恢复的“小修复”业务范围、进行中任务或验收证据；快照观察时间也已超过其 15 分钟 stale 阈值，不能据此推断工作失败。报告意图为 `stopped`，实际状态仍为 `unknown`。
>
> 下一项需获授权的动作是：由用户提供或确认“小修复”的具体范围与验收标准；之后，已恢复的 Manager 才能在其职责边界内协调实现，并独立审查、验收证据。本次没有创建任务、发送消息、设置定时器、登记角色或修改任何文件、配置及状态。该结果是 fixture 明示 Skill 与客户端路径的受控前景恢复，不是主动 Desktop recall，也不是召回率测量。

父任务另外独立运行同一客户端：Manager 恢复为 active/version 3；未登记身份为文本 `null`、`isError:false`；pending 身份为 `INVALID_IDENTITY`、`isError:true`。后两次读取前后索引与源状态 SHA-256 均未变化。

## 可复查范围

上述本机 paths 是隔离测试产物，不是产品默认路径或真实团队身份。正式可跨机器运行的确定性测试位于 `python/tests/`；本行为记录保留了场景、实际公开结果及决定，但没有证明模型会在未提示入口时自行发起 Recall。
