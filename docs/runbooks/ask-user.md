# Codex / Claude 的 ask_user

从 0.8.3-beta.4 起，Bridge 为正常飞书 IM 任务临时注入 stdio MCP 服务 `lark_bridge`，仅暴露 `ask_user`。它收集任务提问人的决定并阻塞当前工具调用，收到答案后原任务继续；不是普通消息排队后的新任务，也不是命令执行审批。

首次使用先运行 `lark-channel-bridge setup-interactions --profile <name>`，按链接确认对原应用增加 `card.action.trigger` 回调。不会重新创建应用或覆盖本地凭据。若飞书点击按钮提示“该应用尚未配置卡片回调”，请使用此命令；部分 PersonalAgent 的客户端快捷配置入口会误报应用不存在。确认后再次点击未过期卡片，超时则在新一轮重新提问。

工具参数示例：

```json
{"questions":[{"id":"release_policy","question":"审查是否拦截发布？","options":[{"label":"通过审查才能发布","description":"把审查结果作为发布门禁","recommended":true},{"label":"只留审计记录","description":"不改变发布条件"}]}]}
```

一次 1–5 个问题。每题可给 2–5 个选项，`multiSelect: true` 启用多选；没有 options 时使用文字回答。所有题都保留补充文字入口，取消会结束整个请求。

从 **0.8.3-beta.5** 起，选择题用 `recommended: true` 标记推荐项，单选最多一个、多选可以多个。卡片标出推荐项和超时规则：**10 分钟未回答，自动采用推荐方案并继续当前任务**。已回答的题目保留原答案，只补齐未回答的题目。返回 `status: answered`，自动补齐的每项答案包含 `source: timeout_recommendation`；卡片和日志均明确记录自动选择，不伪装成人工点击。为兼容已有调用，也识别选项末尾的 `（推荐）` / `(Recommended)`；单选推荐不明确时不猜第一个选项。

只有 `status: answered` 带有 `answers`，Agent 应按返回选择继续，不能因 `source: timeout_recommendation` 再次询问或停止。纯文字题、没有推荐项或单选推荐不明确的未答题无法自动补齐，仍返回 `expired`。主动取消、`/stop`、任务结束、路由过期、断连、未完整送达问题卡片及工具错误不会转换成自动同意；这些情况仍须明确回答。此功能不替代本机工具权限/审批机制。Bridge 不扫描普通 Markdown 列表猜测待选项，也不保证模型会为所有需要澄清的场景正确调用工具。

路由由 Bridge 绑定：原聊天/话题、触发消息、当前运行、唯一可确认的真人提问人。点击先通过当前 profile 的 DM/群访问权限，再核对提问人、卡片、问题、有效期和活跃 run；其他群成员不能代替提问人点击。重复点击只会消费一次。混合真人发起人或没有可确认真人的任务不提供可作答上下文。`/stop`、结束任务、断开连接和重启都会使待答卡片失效，不会自动续跑或重放。

Codex 使用每次调用的 `mcp_servers.lark_bridge`，其中只对 `ask_user` 设置 `approval_mode = approve`；不修改全局 Codex 配置或命令审批策略。Claude 使用临时 `--mcp-config` 并允许该 MCP 工具，同时禁用无法回传的内置 `AskUserQuestion`。完成提醒 judge 不注入该工具，DSH 继续原有 Desktop 问答机制。旧版本 CLI 对这些配置的兼容性需重新验证。

IPC 使用本机受保护 socket（Windows named pipe）。macOS 下 profile 路径过长时使用临时目录中的独立 0700 目录和 0600 socket，避免 Unix socket 的路径长度限制。它以当前 OS 用户运行，不提供对同一 OS 用户恶意进程的安全隔离。

验证：`pnpm build` 后运行 `pnpm exec vitest run tests/process/ask-user.test.ts tests/integration/card/callback-dispatch.test.ts`。真实本地模型测试需显式设置 `LARK_ASK_USER_LIVE=1`，会消耗 token，但卡片回调使用测试 fixture；飞书真实点击须另做验收，不能用 fixture 代替。
