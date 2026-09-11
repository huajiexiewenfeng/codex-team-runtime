# Registry 迁入增量验证

本记录区分代码验证、安装与真实团队迁入。实现已通过隔离验证与最终独立复审；
这些结果不代表真实团队已迁入或跨月召回已验证。

## 已完成的实现验证

- Node：显式枚举仓库测试文件，196/196 通过；审查修复后相关 25/25 通过。
- Python：首次完整 127/127；审查修复后迁入专项 31/31，既有 Registry/stdio
  58/58，最终完整 133/133 通过，71.79 秒；每次使用新的独立临时目录。
- 真实跨语言调用覆盖 Node adapter、Python exporter、MCP SDK stdio、政策版本与
  readiness、开放轮次退出检查、备份/提交/激活异常恢复和共同锁协议。
- 实际进程终止测试验证遗留锁不被自动抢占：先确认测试子进程已退出，再由测试
  明确处理自己拥有的锁，随后才恢复。这不是无人值守故障恢复承诺。
- Skill 格式校验通过；只读入口 5/5 通过。独立 guided reference 检查能正确区分
  connected 与派工授权、本人 onboarding、busy/FIFO 和禁止 legacy 绕过。
  这不是自然续接/压缩后的召回率测试。

裸 Node 自动扫描会收集 artifacts 中现有 Python 环境的两个第三方 win32com
JScript 测试；它们不是项目测试。应使用迁入指南中的显式 test/*.test.mjs 枚举，
不删除第三方环境来消除该扫描现象。

## 历史版本拒绝新格式

提交前复验（2026-09-11）：显式枚举 `test/*.test.mjs` 的 Node 全量测试通过；
Python `python/tests` 全量 134/134 通过，197.69 秒，使用新的独立 basetemp、
禁用 pytest cache。此轮包含新增的三成员初始化与自定义成员 ID 用例。
Skill 格式校验与 Git 差异空白检查通过。这些仍是隔离测试，不代替真实团队验收。

用 `git archive` 导出精确旧提交
`c1c790b4c6958af6ba06441993dfd2e47d634688`，在完全合成、由当前真实迁入实现产生的
Node schema 2 / Registry schema 3 文件上执行：

| 旧入口 | 实际结果 |
| --- | --- |
| Node readState / transact | 拒绝 Unknown field；状态字节未改变 |
| Python read / manage | 拒绝 REGISTRY_CORRUPT: Unsupported registry schemaVersion；注册表字节未改变 |

使用的是旧源码与当前本机解释器，不是保存的旧解释器/操作系统镜像，也未启动
旧原生 MCP 客户端。这些检查覆盖旧存储入口的拒写边界。

## 独立审查与修复

首次整体审查为 Changes requested，3 个 Important：

1. 共享 Registry 升级 schema 3 后，第二个无冲突团队被错误拒绝迁入（已复现）。
2. prepared 恢复未在提交 Registry 前完整核对当前状态，损坏数据会过早提交
   Registry（已复现）。
3. Registry 文件别名可能使 Python 锁/替换与 Node 链接目标分裂（代码路径确认；
   本机创建真实文件 symlink 受权限限制）。

新增 5 个针对性失败用例全部先复现再修复。第二团队可迁入且保持唯一性校验；
prepared 状态先完整 Node 校验并与原备份的预期准备态全对象比对，再提交 Registry；
active 重试不回写旧状态。Registry 在构造时一次规范化，读/锁/替换/链接共用目标。
文件别名测试采用受控 Path.resolve fixture，验证实际目标锁、读取与替换；没有
声称完成本机真实 symlink 实测。原审查者针对性复审确认 3 项关闭，结论 Approved。

## 尚未证明的能力

没有真实团队迁入、原生成员 onboarding、native MCP 新版本加载或跨月自然召回
证据。安装仅放置代码，不得复制团队状态；原 Manager 才能执行获授权迁入。
不保证跨主机/网络文件系统锁、断电目录持久性、调用者认证、自动消息送达，
也不会自动启用 hook、定时器或后台巡检。
