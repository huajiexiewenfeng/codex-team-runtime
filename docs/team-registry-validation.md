# Team Registry v2 基础层验证

日期：2026-09-10。结论：本次 context-only 基础层通过代码、协议和受影响 Skill
验证；不是现有团队迁移或长期自然召回的验收。未提交、推送或全局安装。

## 已验证范围

- Manager 维护团队和正式成员登记；Worker/Liaison 不能以自己的声明身份管理成员。
- 三种角色均可读取自身、团队、精确 leader、共同规则和角色职责；active Manager
  另读紧凑名册。未知身份返回精确 null，退出身份不恢复职责，只读不改登记文件。
- pending → 成员 read/receipt → Manager confirm_ready；ready 仍明确禁止据此派工。
- 持久化、显式退出保留、幂等历史回执、并发版本冲突、旧 policy 重新确认，以及
  初始化拒绝覆盖和失败后可重试。
- V2 read/manage 与旧 v1 只读 locator 模式互斥；没有隐式迁移或宽权限 register 工具。
- MCP 不带 server-wide instructions，无 AGC、hook、定时器或后台发消息行为。

## 最终测试与复审

| 验证 | 实际结果 |
| --- | --- |
| 父任务在修复冻结后运行完整 Python 套件 | **102 passed in 32.90s**，exit 0 |
| 受影响 Node/Skill 回归 | **23 passed**，exit 0 |
| Skill UTF-8 格式校验 | **Skill is valid!**，exit 0 |
| 独立核心修复复审及最终集成复审 | Spec compliance / Quality 均 PASS，无剩余可行动 finding |

完整 Python 命令在隔离 worktree 中运行，使用先确认不存在的新临时目录：

```text
artifacts/team-context-venv/Scripts/python.exe -m pytest python/tests
  -q -p no:cacheprovider
  --basetemp artifacts/registry-parent-final-a3fcd58b4b8042808acc665c352611dc
```

环境为 Windows、Python 3.12.14、MCP SDK 2.2.0、pytest 9.1.1。Windows stdio
子进程管道需要经过批准的测试执行权限；只使用隔离 fixture，不接触真实团队。

受影响回归命令：

```text
node --experimental-test-isolation=none --test
  test/session-lifecycle.test.mjs test/session-detach.test.mjs
  test/manager-session-skill.test.mjs
```

Skill 使用独立环境的 Python 加 `-X utf8` 运行 skill-creator 的
`scripts/quick_validate.py skills/manager-session`。上述 23 项和格式校验在本轮
共享规则修改后执行；之后没有修改 Node 源码或 Skill 主入口，未机械重跑全量 Node。

复审发现并关闭的五项问题：

1. 非 ASCII/畸形 receipt 先按精确格式拒绝，避免原始 TypeError；合法格式的外来
   receipt 仍是明确 mismatch，不写文件。
2. 依序重建历史并核对 actor、revision、成员/生命周期及最终快照，拒绝内部不一致
   的历史记录；保留旧 policy 回执可读、需重新确认的语义。
3. 初始化先完成临时文件 flush/fsync，再用同目录 hard link 原子且不覆盖地发布；
   故障注入验证目标不存在或原字节不变、安全重试和仅清理本次临时文件。
4. 文档不再承诺所有 SDK 错误都是 JSON。成功/核心 ContextError 保持 JSON；SDK
   顶层校验保留原生失败。真实 stdio 验证缺少 request、actor 类型错误、文件不变，
   并在同一连接继续 read，排除把进程崩溃误当校验成功。
5. manage 包含当前 API 不可撤回的 exit_member，采用保守的 destructiveHint true；
   该提示不是认证或授权控制。

独立审查者检查代码、测试和契约，未重复运行套件；最终 102 项由父任务独立运行。
原始分工、RED/GREEN 和复审记录保留在本轮 artifacts，不作为生产运行依赖。

## Agent 行为证据与限制

[无历史 Worker guided 样本](evidence/2026-09-10-team-registry-worker-guided.md)
在真实 stdio 下读取合成 fixture，正确回答角色、团队、精确汇报对象，并遵守 pending
及 disconnected 边界。提示明确提供了读取入口，不能证明自然触发或召回率。
该样本发生在最终加固前；本次最终套件覆盖了对应正常读取路径，未重复模型样本。

所有 v2 capsule 仍为 `executionIntegration: not-connected`、`dispatchAllowed: false`。
尚未全局安装、迁移“一键升级”等真实团队、接入 Node 身份投影或开放真实派工。
旧运行层的 consent、原 Worker 提交、忙碌队列和独立验收规则未改动。

host/thread 身份是 caller-declared；一致性验证、authorization_ref、receipt 均不是
宿主认证或理解证明。初始化依赖同目录 hard-link 支持，不做覆盖式降级。
MCP 不会调用自己；真实 Desktop 续接、上下文压缩、重启和跨月自然召回仍待验证。

下一增量是保留历史归属的 Node 投影/迁移与真实派工检查，再做受控端到端验收。
详见[当前接口与边界](team-context.md)；[早期 locator 证据](team-context-validation.md)
不替代本记录。
