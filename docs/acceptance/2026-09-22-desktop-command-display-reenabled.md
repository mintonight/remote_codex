# 桌面详细命令显示重新启用记录

日期：2026-09-22。平台：Linux x64。执行：Codex；界面验收待用户确认。

## 用户目标与变更

用户在启动恢复后再次明确要求详细显示命令。此前恢复 STEPS_PROSE 仅用于隔离
启动故障，不是对命令显示需求的最终处理。

- 个人 `~/.codex/config.toml` 的 `desktop.conversationDetailMode` 从 STEPS_PROSE
  改回 STEPS_COMMANDS；未改其他配置项或权限，未把个人配置纳入 Git。
- 保留已经安装的 0.3.88 桌面身份恢复 Shim；当前桌面 Shim PID 856178 的可执行文件
  与受管安装清单匹配，内容 SHA-256 校验通过。
- 未修改插件实现、再次变更版本、重启后台或重载 VS Code/Remote SSH。
- 原故障及回退记录保持不变，见 2026-09-22-release-0.3.88-desktop-identity-recovery.md。

## 实际验证

- 使用 smol-toml 解析确认模式为 STEPS_COMMANDS；修改后完整文件 SHA-256 等于仅替换
  目标设置的预期值，文件权限不变。
- 在新设置下启动已安装桌面 Shim 的只读接入探针，initialize 耗时 113 ms，
  bridge/service/status 确认仍接入原服务 PID 6344 / native PID 6368。
- 执行 `printf 'CODEX_DETAILED_COMMANDS_OK\n'`，退出码 0，输出
  `CODEX_DETAILED_COMMANDS_OK`。
- 以上证明配置更新及后台接入成功，不证明桌面已重新加载设置或显示了命令详情。

## 人工退出条件

- 桌面显示具体命令条目，而非只有概括性描述；可展开查看命令输出。
- 命令执行完成后仍能查看详情，手动完全退出并重开后设置保持生效。
- 若现有窗口未即时切换，由用户手动重开；不自动结束客户端或其他工作。
- 状态：待补测。活动索引位于 README 最后一个 TODO 节。
