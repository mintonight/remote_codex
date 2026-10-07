# Codex 灰屏现场：renderer 原生崩溃

用户于 2026-09-08 America/Adak 晚间提供灰屏截图：右侧 Codex 页面整块灰色，编辑器、
文件树和终端仍显示。Codex 于 18:20 起只读采集，未主动重载、关闭窗口或终止用户进程。

## 直接证据

- 新转储：`~/.config/Code/Crashpad/completed/24a1eed7-aa1b-4d58-8d62-7d956bfd1b03.dmp`。
- 转储内部时间为 `2026-09-09T03:19:36Z`，即本地 `2026-09-08 18:19:36`；
  大小 299888 字节，SHA-256
  `0d841300161fae6bbd3807ff1ccf92d7d8148679d5428b3394ec1e76f0d612d2`。
- 按 Crashpad/Minidump 结构读取 MiscInfo、ExceptionStream 和白名单注释：
  PID/TID 均为 `104346`，`ptype=renderer`、`process_type=renderer`，Electron `42.10.0`。
  该 PID 在此前现场采样中存在，本次已不存在；主窗口 renderer `15770`、Extension Host
  `104325`、Bridge Shim `105270` 和 app-server `105310` 仍存在。
- exception code 为 `0x5`；上下文 RIP 位于 `/usr/share/code/code + 0x3f73f8c`。
  同一安装二进制在此前一字节位置存在 `int3`，RIP 处为 `ud2`。ELF Build ID
  `84d14fbf4d74e4a378924f71e4b5ea9008046d44` 与转储 CodeView 记录相同。
  缺少匹配符号，不能用被剥离二进制的最近导出符号名称当作真实崩溃函数。
- 转储注释另有 `compression_stream_deflate_format=gzip`。这只是线索，不能据此认定
  gzip、线程快照或压缩代码是崩溃根因；未发现足够证据确认 GPU 或 OOM 原因。

转储可能包含进程内存，本轮仅解析结构和限定元数据，没有复制入仓库、上传到外部服务
或输出其中的任意内存字符串。原转储仍在用户本机 Crashpad 目录。

## 日志与后台

- `20260908T011339/window1/exthost/openai.chatgpt/Codex.log` 中最近一条前端
  ResizeObserver 错误为 18:19:34.642，接近 renderer 崩溃时间；时间相关不证明因果。
- `window1/renderer.log:329` 起显示 Extension Host 于 18:15:51.989 无响应，
  18:16:41.338 恢复；18:17:43.026 再次无响应，18:17:53.784 恢复。
  这两次卡顿先于 renderer 崩溃，不应混称为同一个进程的崩溃。
- 使用受管 upstream 只读查询原线程
  `01a06646-2428-7892-abb5-942c7279c940`，返回 `status=idle`，cwd 为
  `/home/zkbot/work/train/Zklab`。没有提交输入、启动 turn 或改变订阅。
- 当前系统约 49.25 GiB 空闲内存。崩溃后主窗口 RSS 659204 KiB，Extension Host RSS
  1146260 KiB，app-server RSS 227400 KiB；这些不是已死亡 renderer 的崩溃前内存峰值，
  不能用于排除其内部堆耗尽。

## 恢复建议与验收

现有源码中确认 `workbench.action.webview.reloadWebviewAction` 的命令名称为
`Developer: Reload Webviews`，对当前窗口的所有 Webview 调用 `reload()`；它不是
`Reload Window`。已请用户手动执行此更小范围的恢复操作，并反馈是否恢复 Codex 页面。
恢复结果待补测，不把“可以重载”当成灰屏已根治。

`0.3.80` 的 app-server 保活和快照校正不能自行复活已经崩溃的 renderer。后续需匹配的
VS Code 定制 Electron 符号解析原生栈，并隔离验证官方页面、Bridge 快照负载和宿主运行时。
公开 Electron/code 符号端点对应此 Build ID 的查询均返回 404，未下载或上传用户转储。
保留既有集成修改为待验收状态，不提交、不推送。

## 格式与诊断来源

- [Crashpad MinidumpCrashpadInfo](https://crashpad.chromium.org/doxygen/structcrashpad_1_1MinidumpCrashpadInfo.html)
- [Crashpad 模块注释](https://crashpad.chromium.org/doxygen/structcrashpad_1_1MinidumpModuleCrashpadInfo.html)
- [Crashpad 类型化注释格式](https://crashpad.chromium.org/doxygen/structcrashpad_1_1MinidumpAnnotation.html)
- [VS Code 官方原生崩溃诊断](https://github.com/microsoft/vscode/wiki/Native-Crash-Issues)：
  Stable/Insiders 需匹配其定制 Electron 符号，不能直接套用公开 Electron 的不同构建。
