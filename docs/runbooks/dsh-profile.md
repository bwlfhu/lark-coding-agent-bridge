# DeepSeek Harness（DSH）部署

本维护版在 KeepSilenceQP 的基础上支持 `claude`、`codex`、`dsh`。DSH 是本机运行的代理程序；模型可以来自其现有 API、兼容网关或本机推理服务。安装 DSH 不代表模型已经离线部署。

## 安装与检查

使用 Node.js >=20.19（推荐当前 LTS）和 pnpm 10.33。先按 DeepSeek 官方说明安装并配置 DSH，确保 `dsh --profile headless --help` 可用。已验证 DSH `0.2.1-rc.2` 的新会话与 `--session-id` 续接；不同版本需重新运行下述实机测试。

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
node bin/lark-channel-bridge.mjs profile create dsh --agent dsh
```

向导会探测 DSH 路径。可用 `LARK_CHANNEL_DSH_BIN` 指定可执行文件。也可以在 Web UI 中选择 DSH。保留原有 Codex profile，用独立 DSH profile 保存自己的会话和权限。复用同一个飞书应用时，先停止旧 profile 再启动新的；两个桥接进程不能同时消费同一应用。应用 secret 只留在本机受保护配置中，不写入仓库。

## 两种模型配置方式

省略 `dsh.provider` 时，不生成 provider/model 覆盖，继承所选 DSH profile。`dsh.profile` 默认 `headless`，`dsh.dshHome` 默认使用现有 `DSH_HOME` 或 `~/.dsh`。这要求该 profile 本身已经能成功执行 headless 任务。默认 headless 禁用了文件凭据插件，通常需要启动环境中的对应 key；桌面/Web profile 的模型配置不自动等同于 headless 的配置。此模式在 bridge 模型选择器中仅提供“跟随 DSH 配置”。

显式配置 `dsh.provider` 时，bridge 生成临时配置层，声明 provider、默认模型，并启用 DSH 的本地 `credentials` 插件。凭据按 `apiKeyEnv` 名称从现有 DSH 存储或启动环境读取；bridge 不读取或复制密钥值，也不改写 DSH 的全局 profile。下例是 profile 内的 `dsh` 字段片段，按本机实际端点和模型名填写：

```json
{
  "binaryPath": "/absolute/path/to/dsh",
  "profile": "headless",
  "provider": {
    "id": "local-deepseek",
    "apiKeyEnv": "LOCAL_LLM_API_KEY",
    "api": "openai-completions",
    "baseURL": "http://127.0.0.1:8000/v1",
    "defaultModel": "your-local-model-id",
    "models": [{ "id": "your-local-model-id" }]
  }
}
```

`api` 必须是 DSH 支持的 API family，模型必须列入 `models`。`apiKeyEnv` 是变量名称，不能填真实 key。如果本机推理端点忽略 Authorization，可为此名称设置该服务允许的非空本地占位值；真正需要认证的端点应使用对应有效凭据。launchd 不自动继承交互终端临时 export 的变量，优先使用 DSH 自己的凭据存储。不要把本机服务端口开放到公网来满足配置。

`dsh.patches` 可追加可信本地 YAML 覆盖，应用顺序在生成层之后；它们能修改 provider、工具和权限，维护者需自行审阅。生成文件位于该 bridge profile 的 `dsh/` 子目录，权限为 0600。

## 启动和验收

```sh
node bin/lark-channel-bridge.mjs run --profile dsh
```

在飞书发送一个无工具的简短问题，再问一个依赖上文的问题；检查第二轮使用相同 session ID。测试 `/new` 创建新会话，`/resume` 只展示 bridge 当前 DSH 会话，不读取 Claude 历史。需要在同一应用间切换后端时应先停止服务，再切换 profile，最后验证新消息的后端标识。

可选实机测试会花费模型 token。provider 文件只含上面 `provider` 对象中的端点、模型和凭据变量名；不得包含 key 值，且放在仓库外：

```sh
LARK_CHANNEL_DSH_LIVE=1 \
LARK_CHANNEL_DSH_BIN=/absolute/path/to/dsh \
LARK_CHANNEL_DSH_LIVE_PROVIDER_FILE=/outside/repository/provider.json \
pnpm exec vitest run tests/process/dsh-live.test.ts
```

2026-10-19 的实机验收通过了本机 DSH 0.2.1-rc.2、用户现有兼容 API 配置的新建与续接。这证明 DSH 协议接入，未测试上例中的任意本机推理服务。

## 支持边界和恢复

DSH 任务走 stdin，stdout JSONL 转成 bridge 的增量卡片事件，最终全文不会重复追加。原生图片输入会在启动前明确拒绝；没有假装图片已发送。DSH 无法弹出交互审批时会失败，权限模式由 bridge 策略传入 DSH，但额外 patch 可覆盖原生行为。群提示词通过任务前缀注入，DSH 不提供 Codex 的 developer-instructions 层级隔离。

发生断流会明确报告失败并保留已显示的进度，不自动重放可能已经写文件或执行命令的任务。保留 session ID 后先核实已有执行结果，再决定继续。未知 JSONL 类型会记录协议漂移；新版本 DSH 需复测文本、工具结果、停止和错误路径。

DSH 自带独立的反馈/遥测机制，bridge 自身的设置不等同于 DSH 的设置。DSH 和本机代理以当前系统用户执行工具，因此能访问该用户可读的文件；应只给可信飞书用户/群访问权限。
