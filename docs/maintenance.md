# 自有维护分支

维护仓库：<https://github.com/bwlfhu/lark-coding-agent-bridge>。CLI 仍为 `lark-channel-bridge`；npm 包为 `@bwlfhu/lark-channel-bridge`，首个整合版本为 `0.8.0-allcam.1`，最新 beta 为 `0.8.3-beta.1`。使用 `npm install -g @bwlfhu/lark-channel-bridge@0.8.3-beta.1` 安装 beta。

## 0.8.3-beta.1 完成提醒

- 群/话题里同一位真人明确 @ 当前 bot、任务正常完成且运行不少于 30 秒时，使用当前 agent/model 做一次独立 LLM 判断。
- 仅判断为值得回看时，发送独立原生 @ 提醒给固定的原提问人；快速回复、bot 来源、混合发起人、失败/中断和无法判断均不提醒。
- Judge 不续接原会话；Claude 关闭工具与会话持久化，Codex 使用 ephemeral、只读 sandbox 和隔离临时目录。DSH 暂不支持提醒判断，因为当前 CLI 没有可验证的禁用工具选项。
- 此 beta 默认启用提醒判断，没有用户配置开关；提醒消息发送失败不会影响原任务结果。

## 0.8.2 工具展示

- 新增 `toolDisplayMode: full | live-only | hidden`，保留旧布尔配置兼容与 full 默认。
- live-only 将当前命令放在底部，结束即移除，工具输出不进入最终消息。
- 卡片、Markdown、异常回退、聊天设置和 Web 控制台使用同一模式。
- COT 为持久事件记录，live-only 改用可更新卡片；hidden 不发布工具事件。
- 发布不升级或重启现有服务。升级后通过对应 profile 的 `/config` 选择“仅运行时显示”。

## 0.8.1 修复

- `c21cfb1`：agent 运行期间每 2 分钟续期路由凭证，修复任务超过初始 10 分钟有效期后 `at-bot`、`restart` 报 `context-unbound` 的问题；任务结束时停止续期，续期上限为 12 小时。
- `650f1ed`：保活检测发现连接卡住时，优先只重连 WebSocket，保留事件处理器和运行中的 agent；重连失败时，仅在没有运行中或已预约任务的情况下重启整个 bridge。

## 来源与同步基线

| 来源 | 固定基线 | 采用内容 |
| --- | --- | --- |
| KeepSilenceQP/lark-coding-agent-bridge | `44d4527185b72f1618fe4838b892a1a9e5b2d643`（0.7.1-qp.4） | 维护版完整基础，含卡片恢复、会话提示绑定及嵌套引用渲染修复 |
| rovertang/lark-coding-agent-bridge-dsh | `4fa1d5d9e405b6ec416d4a7b60ea0f8e602a21d2` | 选择性适配 DSH 的 src/tests 变更；未整体覆盖文档、发布配置或其他平台 daemon 改造 |
| zarazhangrui/lark-coding-agent-bridge | `589868119ce9a0a860aaf4936b5f9bac14e72681` | QP 与 DSH 的已知原始上游对齐参考 |

建议保留 `origin`（自己）、`upstream`（QP）、`original`、`dsh` 四个 remote。定期 fetch 后先检查新提交和依赖差异，再在功能分支选择性合入。不要用整个 DSH 分支覆盖本仓库，也不要依赖 GitHub ahead/behind 数字判断功能等价。每次同步更新本表及验收证据，保留 MIT attribution。

## 本轮额外修复

- 保留 Codex developer-instructions、QP 单流最终回复与 CardKit 恢复语义。
- DSH 不用虚构 provider 默认值；支持继承原生 headless 或显式 provider。显式 provider 启用现有 DSH 凭据存储。
- 统一前台/后台 adapter 工厂，防止 DSH 落入 Claude。
- 后端类型贯穿会话 ledger、旧会话迁移、群提示绑定、reset 与恢复，不能靠 ID 前缀推断后端。
- `/resume` 不把 Claude 历史当作 DSH 会话；DSH 模型入口按声明目录校验。
- DSH 最终全文按快照去重；prompt-bearing 错误在流结束时也脱敏；拒绝不支持的原生图片。

## 验证与打包

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
node tools/pack-and-verify.mjs --output /outside/repository/lark-bridge-verified.tgz
```

`pnpm-lock.yaml` 固定开发/构建依赖。`package-lock.json` 固定 npm release layout，供 `npm ci --install-links=true --ignore-scripts` 创建可打包的 bundled Channel 依赖。改依赖时更新两个锁并复核差异。

公开扫描和 clean-install smoke 不依赖原维护者私人的 denylist secret。公开扫描只能检测已定义的模式，不能证明绝无敏感信息；发布前仍需检查 diff 与归档清单。有真实私人 denylist 时通过 `LARK_BRIDGE_PRIVACY_DENYLIST_FILE` 或 `--patterns-file` 执行额外精确扫描；未提供时会明确显示跳过，不能声称该私人 gate 已通过。

推送提交或 tag 不会自动发布 npm。可以在本地以包维护者身份发布已经验证的 tarball：`npm publish /outside/repository/lark-bridge-verified.tgz --access public --tag latest`。手动 GitHub Actions 发布还需配置本仓库的 `NPM_PUBLISH_ENABLED=true`、`NPM_PACKAGE_NAME=@bwlfhu/lark-channel-bridge` 和 npm Trusted Publisher，然后选择已有的 `v<package.version>` tag 运行发布 workflow；不要复用上游的发布身份。

## 升级与回滚

每次升级先备份 bridge 的配置、profiles、session store/catalog/ledger 与正在使用的 release 路径（备份放仓库外，权限 0700/0600）。完成单元/集成/进程测试与原生模型的新建和续接后，停止旧服务，安装独立版本，指向原有配置，启动并验证。不得同时运行同一飞书应用的两个消息消费者。

本轮仓库整合不自动替换正在运行的 Codex 服务。保留旧 runtime 和状态备份；出现回归时停止新服务，恢复旧 runtime。若状态 schema 变化，按成对备份恢复状态，避免单独回退二进制读新状态。对有副作用的半途任务，先核查执行结果，再人工续接，禁止自动重放。
