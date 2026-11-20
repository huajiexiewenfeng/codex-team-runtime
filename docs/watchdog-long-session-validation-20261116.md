# 长期 Manager 聊天兼容验证与单事项测试（2026-11-16）

## 结论

长期聊天兼容验证通过，并在固件 Manager 的真实聊天中完成一个独立新测试事项的受控巡检闭环。未把创建版本加入通用放行名单；正常生产部署入口仍保留原门槛。本次兼容候选未更新到已安装 bundle，未合并，未启动任何常驻服务。

## 方法与边界

- session_meta.cli_version 保留实际创建版本 0.153.4；队列客户端仍固定版本与 SHA256。
- 先只读核对精确日志身份、近期原生字段，再发送带唯一 nonce 的受控短答探测。程序从真实 queue attribution、用户元数据及 task_complete 生成精确日志能力证据；该证据不是授权或身份认证。
- 严格识别实际观察到的 environments.environment_context / harness / hook=false 元数据；提醒须为 user.text / user。未知类型、重复用户消息、缺失元数据继续 unknown，不用正文字符串判断。
- 测试台账与三个业务台账分开，只含一个新测试事项。共两条真实消息：兼容探测一次、测试事项提醒一次。没有 Worker 消息或旧任务恢复。

## 实际结果

| 项目 | 结果 |
|---|---|
| 兼容探测 | 唯一原生 queue 轮次完成；原消息未重发 |
| 新测试事项 | 程序发现模拟待审、发送一次、确认消费和原生完成 |
| 重复检查 / 重建适配器 | 保留同一 attempt，没有新增发送 |
| off | 不发送 |
| 测试事项显式收口 | sleeping；审批仅为测试程序对 fixture 的操作 |
| 真实业务台账 | 三份文件前后 SHA256 一致 |
| 最终独立回归 | 89 项通过，0 失败、0 跳过；git diff --check 通过 |

## 必须保留的限制

1. 第二条提醒原生轮次耗时 414,694 ms，约 6 分 55 秒，无工具调用；中间已输出短答但仍未 task_complete。不能把短答视为完成，不能推断延迟根因，也不能据此承诺低 Token 或低唤醒成本。
2. 自动闭环的 180 秒有界测试在消费后退出，随后仅对原 attempt 对账完成剩余验收，发送入口被禁用。不是一次连续运行在 180 秒内全部通过。
3. 第一次探测曾因大日志基线校验使 idle 证据过期而在发送前拒绝；续接保留原 attempt/nonce，先校验基线，再采集新 idle，未放宽 30 秒有效期。
4. 旧测试硬截止曾留下空锁；父节点确认探测进程退出后仅归档测试锁。候选改为合作取消和 finally 释放，不改变通用锁恢复策略。
5. 本次使用明确限制为 fixture 的测试适配器，未开放长期真实业务台账的生产自动接入。没有绕过生产部署门槛。将精确能力证据正式接入生产入口仍需单独收口验证。
6. 当前已安装版本及回退 bundle 保持不变。后续安装需带上本次验证修正，保持独立版本和回退，不接管历史待办。

## 证据

本地证据目录：artifacts/watchdog-long-session-20261116（候选外，不提交日志）。关键文件：bounded-preflight.json、probe-first-attempt-not-sent.json、computed-queue-profile.json、reconcile-only-latest.json、fixture-results.json、real-manager-fixture-native-observation.json、business-state-final.json、parent-final-regression.tap。报告不包含对话正文、业务源码或原生会话历史。
