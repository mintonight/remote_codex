# Remote SSH 拖放再次异常的现场复核

本地日期：2026-09-22。平台：Linux x64。本轮仅诊断、运行定向测试和记录待验收项，
没有修改实现、重新安装补丁、重载窗口或另起 SSH 认证。用户反馈远程工作区拖动再次
异常，具体 UI 表现及重载后结果尚待确认。

## 当前资产

| 组件 | 实际观测 |
| --- | --- |
| VS Code | 1.138.0，读取当前安装 package.json |
| Controller | 0.3.88，code --locate-extension 定位当前安装 |
| 官方扩展 | 26.5917.61114-linux-x64，code --locate-extension 定位当前安装 |
| Webview | app-initial-c21e521188d8.js |
| Remote Executor | window7 日志报告 package/runtime 均为 0.2.21 |

Workbench 与 Webview 当前文件均匹配受管 patchedSha256，各自原件备份均匹配
originalSha256；product.json 匹配受管 productPatchedSha256。从校验过的原件调用
当前源码生成器，两端均为 patchable，生成结果与当前受管补丁哈希相同。因此本轮
没有发现资产缺失、未知改写或生成器落后，不能照搬此前升级后补丁丢失的结论。

## 日志时序

日志根目录为 `~/.config/Code/logs/20260921T215651/`，以下时间为日志本地时间。

- window7 的 renderer 日志指向 `ssh-remote+x2_n1`、`/home/humanoid`。Bridge 日志
  第 18 行在 16:38:51.688 记录最后一次激活；官方 Codex 日志第 29 行在
  16:38:52.440 启动 app-server，第 37 行在 16:39:15.431 收到 initialize。
- window7 Bridge 日志第 25-27 行：16:38:57.646 Webview 补丁状态为 patched，
  16:38:58.281 Workbench 为 already-patched，随后明确提示 manual window reload
  required。第 28-29 行：16:39:16.288 达到 ready，Shim 与 app-server 初始化已确认。
- 第 30-31 行：16:54:34 再次启用时两端均为 already-patched。读取截至本地
  16:59，未见该窗口后续激活或 phase.workbench.drop.begin。
- window5 第 146-157 行另有 16:55:01 的本机目录拖放成功记录，source 为
  system-file-manager，attached=1、failed=0、local=1、remote=0；审计在
  2026-09-23T01:55:01.216Z 记录 codex_context.drop succeeded。
  这是本地路径处理证据，不是远程文件拖放通过证据。

初步假设：window7 可能仍持有补丁写入前加载的 Webview。激活时序不能单独证明
Webview 的实际加载字节，故尚未把它定为根因，也不把静态 already-patched 当作
运行页面已应用补丁。已请用户在出问题的 Remote SSH 窗口手动 Reload Window，
等待连接恢复后再次拖入文件；未代替用户操作。

## 验证及退出条件

```bash
npx vitest run test/workbench-drop-patch.test.ts test/codex-inline-mention-patch.test.ts test/workbench-drop-compatibility.test.ts test/codex-inline-mention-compatibility.test.ts test/controller-reconfigure.test.ts
```

本轮结果：5 个测试文件、55 项测试通过，无跳过；包含当前官方安装资产探针。
未运行完整 npm run check，未构包、提交或推送集成修复。

- 用户确认 Remote SSH 窗口重载并重新连接，拖放生成唯一原生 @；日志出现完整
  phase.workbench.drop.begin / phase.attach.complete 序列，远程文件应为 remote=1。
- 官方任务实际读取该远程引用，Shim 与审计证明操作发生在正确远程工作区。
- 回归远程文件/目录、系统文件管理器来源及再次重载；真实 UI 与 Windows 均待补测。
- 若重载仍失败，继续区分 Workbench 捕获、Webview 就绪握手、官方插入和远程 stat
  阶段，不能仅因两端文件存在而宣布恢复，亦不应盲目重新安装或修改工作区 URI。
