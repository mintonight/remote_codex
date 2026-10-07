# 灰屏局部重载失败复核

本地时间：2026-09-08 18:26-18:28，America/Adak。
用户确认执行 `Developer: Reload Webviews` 后，右侧 Codex 灰屏未恢复。

## 复核结果

- 原 Codex 日志仍停在 18:19:34.642，没有观察到新的 Codex 页面初始化。
- 最新 Crashpad 转储仍为 18:19:36 的 PID `104346` renderer 崩溃，没有新转储。
  不能把局部重载失败描述为“重载后再次崩溃”。
- `code --status` 中有新的匿名页面进程 `130213`，但没有证据将其关联到 Codex；
  不以该进程出现推断 Codex 页面已重新创建。
- 检查当前 `/usr/share/code/resources/app/out/vs/workbench/workbench.desktop.main.js`：
  `reload()` 调用 `doUpdateContent(this._content)`，后者通过 `_send("content", ...)`
  更新已有 Webview。该方法本身不重建 iframe 或已死亡的 renderer。因此它与完整窗口
  重载不同，本次没有恢复已经崩溃的 Codex 页面。

## 完整窗口重载前基线

- 工作区：`/home/zkbot/work/train/Zklab`。
- Shim：PID `105270`，`lifecycle=ready`。
- app-server：PID `105310`，`startedAtMs=1788916442600`。
- 原线程：`01a06646-2428-7892-abb5-942c7279c940`；受管 upstream 只读查询为 `idle`。
- 未提交输入、启动 turn、终止进程、修改安装资产或代替用户执行重载。

已请用户仅在 Zklab 窗口执行 `Developer: Reload Window`，不关闭其他窗口。
执行后需验证新页面显示、旧 app-server 身份保持、原线程恢复及 handoff 审计；
这仍是恢复操作，不代表 renderer 崩溃根因已修复。当前结果为待用户执行和复核。
