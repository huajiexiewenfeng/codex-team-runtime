# Windows 登录恢复

登录恢复绑定一个明确安装版本及一个明确生产部署；团队数量来自生产 manifest。不会删除业务状态、杀进程或自动重试身份不明的旧锁。默认只检查，注册任务不会立即启动服务。

先安装包含这些脚本的新包。安装器会将恢复脚本、PowerShell transaction guard、注册器和离线测试一起写入版本目录。旧版安装不具备此能力，不能只把入口指向旧包。

以下命令由用户显式执行。将路径替换为本机绝对路径，哈希取已审查包的 manifest.json SHA256（等于已安装 INSTALL-MANIFEST.json），生产部署哈希取已审查 production manifest 的原始字节 SHA256。不要在每次登录时重新计算接受值。

~~~powershell
$binding = 'D:/CodexHome/skills/watchdog/runtime-root.json'
$installationHash = '<64位已审核安装清单SHA256>'
$deployment = 'D:/watchdog/production-manifest.json'
$deploymentHash = '<64位已审核生产清单SHA256>'
$rt = Get-Content -LiteralPath $binding -Raw | ConvertFrom-Json
& $rt.nodeExecutable (Join-Path $rt.runtimeRoot 'scripts/watchdog-login-recover.mjs') --binding $binding --installation-sha256 $installationHash --manifest $deployment --manifest-sha256 $deploymentHash --check
& (Join-Path $rt.runtimeRoot 'scripts/watchdog-login-task.ps1') -Action Register -TaskName Watchdog-Login-Production -BindingPath $binding -InstallationSha256 $installationHash -ManifestPath $deployment -ManifestSha256 $deploymentHash
# 禁用未来登录触发；不停止正在运行的服务：
& (Join-Path $rt.runtimeRoot 'scripts/watchdog-login-task.ps1') -Action Disable -TaskName Watchdog-Login-Production
~~~

注册使用当前交互用户、有限权限、隐藏窗口、并发 IgnoreNew；已有同名任务拒绝覆盖。实际恢复延迟45秒。手工执行上述 Node 命令改用 --apply 可立即进入同一流程（仍默认延迟）。--no-delay 仅供明确手工操作。

健康要求同一生产清单路径/哈希、认证控制端点的 PID/nonce/start、控制 lease、完整团队注册及全部同一 ownerToken 的新鲜心跳。旧租约恢复要求 PID 确认不存在、端口拒绝连接且系统无监听、完整一致的过期团队 lease/心跳。非空或本次开机后产生、活动句柄、硬链接或重定向的 transaction.lock 一律拒绝。可恢复 transaction 通过独占 Windows 文件句柄核验开机前零字节身份，按句柄归档，防止路径替换。

任何未知或身份漂移都会停止。恢复前取得 guard 和 launch.lock，二次比对快照；归档保留审计证据。发生变更后的失败保留 recovery guard/journal，需人工检查，不自动清理再试。业务状态、提醒去重及回执文件均保留。普通后台启动不应与登录恢复同时手工触发；launch.lock 阻止正常并发启动。

验证：node --test test/watchdog-login-recovery.test.mjs；Windows PowerShell -NoProfile -File test/watchdog-login-transaction-guard.test.ps1（隔离临时 sidecar，替换测试进程的 CIM 开机时钟，不接触生产）。
