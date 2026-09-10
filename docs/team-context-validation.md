# Team context 验证记录（历史 locator 增量）

本页保留 v1 locator 的历史测试与文件哈希，不是当前 v2 Registry 的结果。后续 transport 已调整为 legacy 只读模式；本页曾测试的 `team_context.register` 不再是现行 MCP 接口。当前范围与接口见 [Team Context](team-context.md)。

日期：2026-09-10。基线提交：`a3577da8ef1428b0ff7d05aa276ce5d7c0a1062f`；本记录对应其后的未提交增量。

测试使用隔离虚拟环境与 synthetic 状态，不登记真实团队、不修改 Codex 配置。主窗口为用户指定的 GPT-6 Astra；实现与独立审查使用 Sol / medium。

## 确定性验证

| 范围 | 父任务独立结果 |
| --- | --- |
| Python 索引、角色投影、配对、退出、路径限制、并发及 Node 状态兼容 | 41 passed（包含 3 项独立审查回归） |
| 原 Node session-lifecycle、session-detach、manager-session-skill | 23 passed |
| Skill 格式 | `Skill is valid!` |
| MCP 真实 stdio 往返 | 3 passed |

父任务在最终修复后独立组合执行上述 Python 两部分：**44 passed in 20.15s**。独立 Reviewer 复核后无剩余可行动问题。

Python 测试入口为 `python/tests/test_core.py`，使用 Python 3.12.14 / pytest 9.1.1。其兼容测试通过 Node 的 `start`、`attach`、`registerWorker` 生成实际有效状态，再通过 `transact(exitMember)` 退出 Worker；后续 Python read 返回版本 4、inactive，不需要重新登记。核心没有调用模型或 Node 来决定角色；Node 仅用于该兼容测试生成权威状态。

并发验收最初在 31 项通过后暴露 Windows `O_EXCL` 锁竞争时的 `PermissionError`。修复为有限等待，并对持久访问失败保留明确错误后，父任务在新隔离目录复跑通过。并发测试检查 12 个登记全部保留。

独立审查进一步发现非法/重复配对事件 ID 与非 UTC-Z 时间可被误接受。3 条回归均先由真实 Node `validate` 拒绝相同变体，再断言 Python 拒绝；已实证 RED→GREEN。修复限于角色恢复依赖的字段，没有复制完整业务状态机。

环境差异：沙箱 Node 子进程启动曾返回 EPERM；正常权限执行对应测试通过。默认 pytest 临时目录存在访问限制，改用经存在性检查的全新专用 `--basetemp`，不复用或清理其他目录。Skill 校验器默认用 GBK 读取 UTF-8；严格字节解码确认 UTF-8 有效，改用 `python -X utf8` 校验通过，没有转码或修复源文件。

可复跑命令（在可信 checkout 内执行；`<new-test-dir>` 必须是尚不存在的专用目录，pytest 会管理它）：

```text
<venv-python> -m pytest python/tests -q --basetemp <new-test-dir>
node --experimental-test-isolation=none --test test/session-lifecycle.test.mjs test/session-detach.test.mjs test/manager-session-skill.test.mjs
<venv-python> -X utf8 <skill-creator>/scripts/quick_validate.py skills/manager-session
```

## 受控行为与自然召回分开

旧 Skill 下曾进行一条 Sol / medium 新上下文案例：给出精确 fixture 身份 `local / fixture-recall-manager`，移除状态路径，并要求继续一个紧急小改动。该 Agent 报告读取旧 Skill、operations、runtime-usage、CLI 与 session 源码后，无法找回可信 state 路径，选择索取原路径；没有修改、派发或新建状态。

上段是父任务对既有报告的摘要，不是保留了原始 prompt/response 的逐字实验记录，**不计为可复现基线或自然召回率**。它提示定位入口的缺口，不证明旧 Skill 必然忘记职责。

新版本完成 1 条 fresh-context guided 案例：[场景、公开输出与决定](evidence/2026-09-10-team-context-guided.md)。Agent 在未得到源状态路径的情况下，实际通过 MCP 恢复 Manager 与 version 3 locator，再读取 canonical status；确认无业务任务后索取具体范围，没有盲目实施或派发。明确提供了 Skill、fixture 身份及客户端入口，不当作实际 Desktop 自动召回或召回率。

该 guided 样本在末轮非法 ID/时间回归修复前运行；正常角色投影与 Skill 指令未因此改变，最后组合测试覆盖相应正常路径，未机械重复模型样本。Null、inactive、error 为确定性/协议测试覆盖，不声称已逐项完成自然模型行为试验。

最终本机文件 SHA-256（未提交工作区字节，换行转换会改变哈希）：

```text
skills/manager-session/SKILL.md  2F1C5D55F19423C0920E66CBC945C9B6C253DABF0E5F754905B52B39092453F2
python/src/codex_team_context/core.py  6F96C79058C03CB68A0E75E119D1A06B530B481D5D03DD90F72D3F47893B15EF
python/src/codex_team_context/server.py  04C9241D7B4D3216A19F03E970229BDF14A49D7B7C8F0FBA9C22F7393775436C
```

## 未验证与非目标

- 未安装到当前 Codex；没有测试真实宿主自动压缩、重启续接或跨月自然召回率。
- MCP 不会自动调用自己，调用身份仍是 caller-declared，不是宿主认证或强制授权层。
- 没有 hook、AGC、定时器、后台巡检、真实成员登记或业务任务消息。
- 未提交或推送此次增量。
