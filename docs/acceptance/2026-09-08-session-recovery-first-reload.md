# 0.3.80 首次用户重载复核

日期：2026-09-08，America/Adak；观测时间约 16:14-16:16（UTC 为 2026-09-09 01:14-01:16）。
用户手动重载，Codex 只读核对本机进程、受管记录、官方协议及日志，没有启动 turn、
恢复额外订阅、终止进程或再次重载窗口。

## 已确认

- 活动 Shim PID `105270`，路径包含 `0.3.80-39206200242b8f73`；运行中可执行文件
  SHA-256 与本次 `dist/codex-bridge-shim` 相同，不只是磁盘上安装了新版本。
- app-server PID `105310`，执行文件与官方扩展 `26.5901.22334` 的内置 Codex 相同。
- 受管记录为 `ready`，工作区 `/home/zkbot/work/train/Zklab`。
- 通过当前受管 upstream 的只读 `initialize`、`thread/loaded/list` 和
  `thread/read(includeTurns=false)`，确认只有线程
  `01a06646-2428-7892-abb5-942c7279c940` 已加载，状态为 `idle`，cwd 与工作区相同。
  探针退出时关闭连接；没有将读取误当作恢复订阅或执行任务。
- 自本地时间 16:14:00 起的官方日志中，writer conflict 和 Bridge recovery error
  匹配数均为 0。本次审计有 `shim.start`、`external_cli.gateway`，没有
  `app_server.handoff`；因此只确认新候选启动和原会话可读，不宣称旧进程接管已实测通过。

## 前端异常线索

日志位置：`~/.config/Code/logs/20260908T011339/window1/exthost/openai.chatgpt/Codex.log`。

- 16:14:08.472 至 16:14:21.028 出现 42 条
  `ResizeObserver loop completed with undelivered notifications.`，其中多数集中在
  16:14:20-16:14:21。检查时之后未见新增；不能仅凭此断言前台仍卡住或确定根因。
- 另有 4 条 IPC broadcast 未配置 handler 的警告，以及 `/settings/user` 的 403。
  这些不是 writer conflict，也没有证据证明它们导致后台订阅失败。
- 需用户确认输入、滚动和内容刷新是否正常；若卡顿复现，采集对应 renderer 日志及
  服务端快照时间，区分协议恢复、布局循环和前台渲染的问题。

## 验收边界

本次确认 Linux 本地新候选已运行、原单线程加载成功；没有运行中的后台线程样本，
所以后台多线程保活、同 app-server PID 跨再次重载、30 秒快照刷新和长对话 UI 仍待补测。
下一步先启动正常后台任务并切换到另一条会话，记录线程集合和进程身份后再由用户重载。
Remote SSH 和 Windows 门禁不变；本轮不提交或推送待验收的集成实现。
