# 0.3.84 桌面端仍有 writer 冲突

本地日期：2026-09-10；现场日志时间为 2026-09-11T03:52Z。
本轮只读核验，不重启桌面端、不终止用户后台、不修改会话数据库或令牌。

## 现场证据

| 入口 | 实际链路 |
| --- | --- |
| VS Code | 当前 launcher -> 0.3.84 Shim 883481 -> 独立服务 883494 -> native app-server 189420 |
| 桌面端 | /usr/lib/chatgpt/ChatGPT 325605 -> /usr/lib/chatgpt/resources/codex 326107，stdio |

Bridge 审计在 `2026-09-11T03:52:45.057Z` 记录 `service.client_attached`，
servicePid=883494、appServerPid=189420。该服务的 ready 描述符与 loadedThreadIds
包含 `01a06646-2428-7892-abb5-942c7279c940`。经过私有凭据连接网关，只调用
initialize 与 thread/read(includeTurns=false)，返回该线程的 Zklab 工作区、idle
状态与 canAcceptDirectInput=true。未调用 resume、turn/start 或 interrupt。

桌面日志：
`~/.local/state/codex/logs/2026/09/11/codex-desktop-29d1ac87-800f-4cee-9d1c-184ab365b634-325605-t0-i1-000007-1.log`
在 `03:52:56` 记录同一线程 thread/resume 返回 -32600，消息为
`thread ... already has an active writer`，随后 Failed to resume conversation。
截图是这一后台冲突的前端提示，不是本次灰屏证据。

## 已确认的缺口

0.3.84 只统一了通过 Bridge 接入的客户端，没有把桌面端接入该服务。
服务重载和恢复成功不能推出桌面端跨客户端验收成功。桌面端继续启动自己的 native
进程，所以两个后台仍竞争同一线程。不能通过伪造 canAcceptDirectInput 或移除 writer
互斥解决，否则会允许两个引擎写同一会话。

当前桌面内置 CLI 为 0.153.4。只读检查安装包实现发现 CODEX_CLI_PATH、
CODEX_APP_SERVER_WS_URL 和 CODEX_APP_SERVER_USE_LOCAL_DAEMON 接入入口；当前
桌面进程均未设置。CLI 的 app-server daemon help 存在 bootstrap/start/restart/stop/
version 子命令；只读 version 查询因默认 control socket 不存在失败。因此本机尚未
运行该默认原生 daemon。入口存在不等于已受支持或已验收，本轮未启用它们。

## 后续退出条件

1. 把桌面端全部本地项目与 VS Code 的客户端接入纳入同一用户/配置执行域设计；不能
   简单把桌面端所有项目绑到 Zklab 专用服务，造成其他项目冲突或任务列表被过滤。
2. 优先核对官方 daemon/control socket 生命周期和能力，评估 Bridge 作为客户端接入；
   如需自建网关，必须兼容桌面认证、非前台线程、队列、审批和事件恢复。
3. 已存活的旧 writer 只能经过身份校验与有序排空/接管迁移，不按 PID 名称批量清理，
   不在服务发现失败时新开竞争后台。
4. 用户手动完成首次桌面端重启后，验证双端同 thread 可查看、追加、排队、停止和
   接回审批；双方轮流重载/关闭，后台执行和其他项目不受影响。

结论：VS Code 接入新服务已获得现场证据；桌面跨客户端目标仍失败，整体修复未闭环。
