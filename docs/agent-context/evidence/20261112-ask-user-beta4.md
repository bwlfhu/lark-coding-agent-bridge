# ask_user beta.4 验证记录

日期：2026-11-12。方案见 `docs/plans/2026-11-12-ask-user-beta4.md`。

- 全量回归：176 个文件通过，1846 项通过，36 项显式跳过；类型检查及构建通过。
- 新工具测试覆盖：受限工具目录、真实 stdio MCP 请求、原题/原卡/原聊天/原提问人绑定、并发重复点击、多题/多选/文字、过期、取消、run 中止和当前 ACL；原 Codex/Claude/DSH 回归保持通过。
- 真实本地 Codex 和 Claude：各两轮，发现工具、等待模拟卡片回调、收到答案后正常结束；第二轮复用原生 session/thread ID。该测试仅证明原生模型/MCP，不等同于飞书实测。
- 真实飞书 Codex 私聊：模型实际调用 ask_user，原生卡片可见，点击选项后 Broker 记录 answered；同一任务返回 `BETA4_CODEX_OK 蓝色`。
- 真实飞书 Claude 私聊：表单提交后 Broker 记录 answered；同一任务返回 `BETA4_CLAUDE_OK` 和提交文字。另一次中文完整性复核确认输入框、工具返回与最终回复均保留 `beta4文字回传成功-完整`。
- 真实超时：首次卡片在回调配置完成前超过 10 分钟，Broker 返回 expired，卡片转为“等待超时，未取得决定”；Codex 明确停止且没有默认同意或自动重问。
- 首次真实点击发现现有 PersonalAgent 没有 card.action.trigger。使用 SDK 官方 addons 增量配置为原应用添加“卡片回传交互”，后续真实点击成功；据此补充 `setup-interactions` CLI 和部署说明。
- SDK 默认 MCP 审批会拒绝非交互 Codex 的 ask_user；只对该专用工具设置 per-tool approval_mode=approve 后真实调用成功，命令审批策略不变。
- 初次全量回归发现 Darwin socket 路径超长；修复为受保护的短路径后全量通过。
- 打包：公开源码/dist/tarball 扫描均 0 命中；tarball 干净安装与 CLI 版本验证通过。未配置私人精确 denylist，不能把该项写成已通过。

真实消息/回调日志、原生会话 ID、服务定义和状态备份保留在本机仓库外；此记录不包含应用凭据、用户 ID、群 ID 或业务提示词。
