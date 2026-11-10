# 飞书连接官方 DeepSeek Harness Desktop

`0.8.3-beta.2` 新增显式 Desktop transport。运行链为：飞书 → 已有 bridge → 私有 Unix socket → 官方 Electron 内的 bridge 插件 → 官方 PTC Agent 和 Computer Use。插件使用官方 Cordis/sessionController 扩展点；不修改 Electron 安装包，不启动另一个 headless Agent。

## 安装

1. 从 [DeepSeek 官方仓库](https://github.com/deepseek-ai/deepseek-harness) 或官方下载地址安装并启动 Desktop。macOS Apple Silicon 下载为 `https://download.deepseek.com/desktop/dsh-latest-macos-arm64.dmg`。本版本针对 Desktop `0.2.2-rc.1` 验证；这些扩展 API 仍可能变化。
2. 安装 bridge `npm install -g @bwlfhu/lark-channel-bridge@0.8.3-beta.2`。
3. 退出 Desktop，使用应用自带 CLI 安装官方 CUA bundle 和本包的 Host 插件：

```sh
DSH_CLI='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
"$DSH_CLI" plugin --profile desktop add '@deepseek-ai/dsh-cua-bundle@0.2.2-rc.1'
"$DSH_CLI" plugin --profile desktop add '@bwlfhu/lark-channel-bridge@0.8.3-beta.2'
```

4. 重开 Desktop，在插件页确认 Computer Use 的三个组件和 bridge Host 均运行。在 macOS 系统设置中给 **DSH Computer Use.app** 授予辅助功能、屏幕录制。各应用的访问仍由官方 CUA 单独询问，可通过当前飞书会话回答。
5. 在 Desktop 配置现有 CLI 的 provider/API endpoint、模型目录及凭据变量名。复用官方凭据存储，勿把 key 放入 bridge 插件、仓库或模型提示。截图推理要求实际模型和网关支持 image 输入；仅增加声明并不能赋予模型视觉能力。

## 配置与启动

停止同一飞书应用的旧 bridge，修改其 profile 的 `dsh` 字段。示例仅为字段片段，保留现有账号和权限：

```json
{
  "binaryPath": "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh",
  "transport": "desktop",
  "profile": "desktop"
}
```

省略 provider 时跟随 Desktop 的当前默认模型。保留 `dsh.provider` 时只选择其 provider/model，**不会**把 CLI patch 注入正在运行的 Desktop；需先在 Desktop 配好同名 provider。`dsh.patches` 仅适用于 CLI transport。默认 socket 为 `$DSH_HOME/lark-desktop.sock`；自定义需 Desktop 的 `DSH_LARK_DESKTOP_SOCKET` 与 bridge 的 `dsh.desktopSocketPath` 一致。Desktop 必须保持运行，并处于已登录的 macOS 图形会话；锁屏、系统弹窗和受保护输入可能阻止操作。

重启该 bridge profile 后，先发一轮简短文本，再续聊，确认两轮显示同一 Desktop 会话。随后测试 Calculator、截图回传、飞书授权卡片和 `/stop`。新任务创建官方 PTC 会话；原 CLI session ID 首次接入时映射到新的 Desktop 会话，**旧 CLI 对话历史不会自动导入**。Desktop 中会话标题以“飞书 ·”开头，停止 bridge 任务不会退出整个 Desktop。

## 行为与边界

- bridge 的会话、卡片、群权限和路由继续使用现有 channel，不创建第二个飞书消费者。
- Host 将桥接任务串行执行。当前 Feishu 任务的 user question / approval 发回原聊天，卡片答案绑定活跃路由、卡片、选项、有效期，并经过原有 actor ACL。
- 官方工具结果中的最后三张图片在任务结束后回传飞书。Feishu 发来的原生图片输入暂不支持，会在预检明确拒绝。
- 每次任务传递当前 profile 的非密钥环境信息，Host 生成 0600 shell 环境文件，并提示 Agent 在 Bash 命令前 source。lark-cli 身份仍保存在该 profile 的独立目录；不修改整个 Electron 进程的动态环境。此步骤依赖 Agent 遵循运行提示，操作个人资源前应核对当前身份。
- socket 权限 0600；会话映射和请求收据位于 `$DSH_HOME/integrations/lark-channel-bridge`。它们包含本地会话信息和最终结果，不随 npm 发布。
- 断连会取消当前任务，不自动重放。请求收据阻止同一 request ID 再次执行；已完成请求只返回保存的终态。未知执行结果先在 Desktop 核实，再发送新的明确指令。
- Desktop 中独立手动任务仍可能与桥接任务同时操作应用，使用期间请避免让多个任务控制同一个界面。
- DSH 完成提醒 judge 继续停用，不通过 Desktop 为 judge 开放工具。

## 升级与回滚

发布部署建议将插件安装到固定版本的 release 目录，避免长期 link 开发目录。升级 Host 前退出 Desktop、更新插件再重开；不要在任务运行中卸载。

回滚时先停止当前 bridge，恢复之前的 bridge release 路径和 profile 配置，将 transport 改为 `cli`（或移除此字段）、profile 改回原 headless，并恢复其 binaryPath。重启后确认只有一个消费者。桌面会话和 CLI 会话各自保留。若需要恢复原 CLI 对话，可恢复迁移前的 bridge sessions 备份；不要把 Desktop session 当作 headless session 重放。
