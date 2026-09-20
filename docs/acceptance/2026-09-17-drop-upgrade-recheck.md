# 2026-09-17 拖放失效复核

范围：本机只读安装资产、升级记录、日志与定向测试。未修改官方资源、受管备份、锁或
全局设置，未重载窗口、重启进程、连接新 SSH 或构包。保留工作区既有修改。

## 兼容集合与触发

| 组件 | 本次观测 |
| --- | --- |
| VS Code | 1.138.0 / 7debcd0e2acdea1c52de81bf9ee1620444407dda / Linux x64 |
| 官方 Codex 扩展 | 26.5908.31748 Linux x64 |
| 内置 Codex | 0.154.0-alpha.6.1 |
| Bridge | 已安装 0.3.86；当前工作区仍有未提交候选修改 |
| Remote Executor/Remote SSH/OpenSSH | 本轮未重验，不沿用旧版本作为新验收结果 |

/var/log/dpkg.log:1737-1747 记录 20:28:31 从 1.137.0 升级到 1.138.0，20:28:35
安装完成。版本变化触发兼容性复核，但判断依据为源码能力与实际校验和，不是版本门禁。

## 根因证据

1. 当前 workbench.desktop.main.js 为未打接收补丁的官方文件，SHA-256 为
   0473f6505c5e547a4c484fa586678ce824a7910784f2d1060be4cb5b4010fe27，计算出的校验值
   与 product.json 的 Workbench checksum 一致。workbench-drop-compatibility 状态
   目录为空。纯源码探针返回 patchable，说明当前结构仍可识别，不是锚点失配。
2. 当前 Codex Webview app-initial-84c784f5e305.js 仍有受管引用补丁，SHA-256 为
   07c9cd67b462cde96403a34bad0a9c7181fe308fea999b2001b9d1134edc00e2，与 metadata 中
   patchedSha256 一致；原件备份也匹配 originalSha256。纯源码探针返回 compatible。
3. Webview 补丁会拦截支持的 drag/drop 并 postMessage 给 Workbench。Workbench 接收器
   缺失时，这条增强通道无法完成，且原生拖放可能已被 preventDefault/stopPropagation
   阻止。这是两端只启用一半的具体失败机制，不应笼统解释为 Codex 不支持拖放。
4. 日志 20260917T204755/window1 中，20:48:03 记录重新请求启用确认；所检查日志没有
   后续补丁安装成功记录。不能据此断言用户点了取消、权限拒绝或安装异常中的哪一种。
5. 同日志的 layout.integration result=unavailable 只对应视图位置修复命令，不是
   拖放补丁能力探针结果。当前 manifest 仍有两个预期 sidebar view ID 以及
   chatgpt.addFileToThread 命令，未发现这些标识改名。
6. 审计在 UTC 05:31:29.812（本地 20:31）仍有一次成功 codex_context.drop，之后
   新窗口日志显示上述状态。该时间线与升级后旧窗口仍能运行、重新打开后失效相符，
   但本轮没有读取旧窗口内存，不把这一解释写成已直接验证的内存状态。

## 验证与恢复边界

```bash
npx vitest run test/workbench-drop-patch.test.ts test/workbench-drop-compatibility.test.ts test/codex-inline-mention-patch.test.ts test/codex-inline-mention-compatibility.test.ts
```

结果：4 个文件通过，35 项通过、1 项跳过。跳过项仍是写死旧安装目录的 Webview
实装测试；本轮另对实际安装的当前 Webview 做了纯源码探针及原件/补丁哈希核验。
Workbench 当前安装资产与 product checksum 的测试实际执行并通过。

当前恢复路径是通过 VS Code 命令面板运行 Codex Bridge: Enable Native Codex Drop
Surface，完成启用确认和所需系统授权，再重载使 Workbench 补丁加载。用户应从
Explorer 和系统文件管理器各拖入文件与目录至少 3 次，验证唯一 @ 引用、turn 可读取、
再次重载后仍有效。未执行这些动作前，结论是根因已定位，功能未验证恢复。

后续健壮性目标：双端握手/健康检测，接收端不可用时不抢走原生拖放；对启用失败与
用户明确拒绝分别记录状态，允许明确重试；实装探针不绑定旧版本路径。

G0/G1 仅上述本机静态/定向项通过；G2 未构包；G3-G6 拖放、任务、Remote SSH、MCP
和重载恢复待补测；G7 未做完整安全负测；G8 Windows 未测；G9 未闭环。正式冷/热
启动、任务创建、远端操作、MCP、权限恢复等量化指标均待补测，不以零代替缺失样本。
