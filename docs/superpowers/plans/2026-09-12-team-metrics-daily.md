# 每日团队观测第一阶段实施计划

> **For agentic workers:** 使用 subagent-driven-development，按任务实施并独立审查。用户已授权继续开发，不自动提交、推送或安装。

**Goal:** 将已有用量与 observation 转成可查看的每日角色成本和 MCP 调用事实表，为后续结构化召回评估提供基线。

**Architecture:** Node 纯函数复用 buildMetrics 权威归因，按北京时间自然日聚合。独立 JSON/离线 HTML 输出不修改旧报告 schema、业务 state 或 MCP Registry。完整目标和分阶段边界见 ../../design/team-metrics-daily.md。

**Tech Stack:** Node.js >=22、node:test、原生 HTML/CSS。

## Global Constraints

- 不扫描日志目录，不读取未授权成员日志，不安装定时器或 Hook。
- 缺失值不记 0；缓存输入包含于输入、推理输出包含于输出。
- 默认 Asia/Shanghai；历史版本无证据为 unknown，不以当前生成器版本替代。
- 数据覆盖率、召回原因和角色行为没有证据则未知，禁止生成改善结论。
- 保留已有改动，不更换分支，不自动提交、推送或安装。

## Task 1: 每日成本聚合

Files: src/metrics-daily.mjs、test/metrics-daily.test.mjs。审查调整：抽取 src/metrics-rollup.mjs 并由原 metrics.mjs 与每日模块共用，旧报告行为不变。Asia/Shanghai 使用 IANA 时区；未知模型分组保留 null。

接口：buildDailyMetrics(state, ledger, {from,to,asOf,timeZone?})，返回独立 schemaVersion=1 的 days（totals/byRole/byMember/byModel/approvedTasks/coverage）。from/to 为有效自然日，最多366天，不允许未来日。asOf 采用现有 canonical UTC 约定。覆盖列表包括空白日。归因由 buildMetrics 返回 assignments 唯一决定。

- [x] 写失败测试：UTC 15:59:59.999 和16:00:00落在两个北京时间日；三种角色与 Unknown；无记录日 null；真实0；缺字段；多模型；归因与日总和守恒；验收事件时间；非法日期/范围；未来记录排除；输入不变；溢出拒绝。
- [x] 运行 node --experimental-test-isolation=none --test --test-reporter=spec test/metrics-daily.test.mjs，确认因缺失功能失败。
- [x] 实现唯一输入验证、日桶与安全数值聚合，不复制身份推断。
- [x] 运行上述测试及 test/metrics.test.mjs，保存证据，独立审查。修复后42项联合测试通过，复审无遗留发现。

## Task 2: 每日可见表格与 CLI

Files: src/metrics-daily-export.mjs、src/cli.mjs、test/metrics-daily-export.test.mjs、test/metrics-daily-cli.test.mjs、docs/team-metrics.md。

接口：renderDailyMetrics(report, ledger) 生成完整离线 HTML；exportDailyMetrics(report,ledger,directory) 生成新目录 report.json、index.html、READY。工具观察只读取已验证 ledger，不能把任意字符串匹配为 MCP。metrics-daily 与 metrics-daily-export 命令接收 state/ledger/options JSON 路径，后者增加新输出目录。页面包含每日趋势、每日角色/成员/模型、MCP 调用列表及明确未评估的召回效果区，日期链接跳到对应 detail。

- [x] 先写失败测试：HTML 四区、日期定位、缺失标签、HTML转义、MCP exact allowlist、事件日期与记录日期分开、已知调用但未知结果、无观测时未知不是零、输出冲突不覆盖、CLI 参数与JSON契约。
- [x] 实现独立渲染/导出，不添加第三方依赖和网络请求；费用显示未配置；召回效果显示未评估，不能生成比例。
- [x] 测试旧CLI/metrics-export未破坏，用合成数据导出样例。全Metrics94项通过，最终独立复审通过。
- [ ] 浏览器验证日期入口和表格可读性：file URL被浏览器安全策略拒绝，未绕过；交互/视觉验收明确未完成。
- [x] 更新使用文档，准确标注本阶段不含自动采集、价格估算与完整效果评估。

## 后续阶段（本计划不声称完成）

MCP 可选触发原因及最小结果观测；独立应召回事件分母；历史成员范围与完整覆盖声明；价格版本；多团队授权日志刷新；接入固定工作台入口。这些模块需各自的兼容性/隐私验证，不能由第一阶段的占位列冒充已实现。
