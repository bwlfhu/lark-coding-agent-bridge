import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { LarkChannelEnvContext } from '../lark-channel-env';
import { askUserSocketPath } from './transport';

export const ASK_USER_INSTRUCTIONS = `
## ask_user — 等待飞书用户作决定
当前可用的 MCP 工具 lark_bridge.ask_user（名称可能显示为 mcp__lark_bridge__ask_user）可向本轮提问人发交互卡并等待答案。
调用参数必须使用 questions 数组，例如 {"questions":[{"id":"release","question":"审查是否拦截发布？","options":[{"label":"审查后才能发布","recommended":true},{"label":"仅记录审查结果"}]}]}。
遇到影响任务方向、产品规则、发布策略或授权范围且无法从现有信息确定的选择，请调用此工具，提交简明问题、稳定 id 和选项；不要只在正文中列选项后继续执行。
选择题应给出你的推荐方案，用 recommended:true 明确标记；单选标记一个，多选可标记多个。用户已要求超时按推荐方案继续：10 分钟未回答时 Bridge 会自动选择推荐项并返回 status=answered，answers 中 source=timeout_recommendation 表示超时自动选择，不是用户点击；直接按返回选择继续原任务，不要因超时而终止或重复询问。
工具等待期间不要执行依赖该决定的写入或外部操作。status=answered 时按 answers 中的选择/补充文字继续同一任务，保留已有人工作答，不覆盖用户选择。
纯文字题或没有明确推荐方案的未答题无法自动补全；cancelled、expired、unavailable 和工具错误仍不表示同意，不要猜答案或重试制造重复问题。用户主动取消、停止任务或连接中断不能当作超时同意。
无须人为确认的日常实现选择仍自行判断。此工具收集用户决定，不替代本机工具权限/审批机制。如果当前工具不可用，清楚提出问题并结束本轮，等待用户回复。
`;

export function askUserMcpConfig(context: LarkChannelEnvContext | undefined, routeId: string | undefined) {
  if (!context?.rootDir || !context.profile || !context.bridgePid || !routeId) return undefined;
  return {
    command: process.execPath,
    args: [fileURLToPath(new URL(existsSync(new URL('./ask-user-mcp.js', import.meta.url)) ? './ask-user-mcp.js' : '../../../dist/ask-user-mcp.js', import.meta.url))],
    env: {
      LARK_ASK_USER_SOCKET: askUserSocketPath(join(context.rootDir, 'profiles', context.profile)),
      LARK_ASK_USER_ROUTE: routeId,
      LARK_ASK_USER_PID: String(context.bridgePid),
    },
  };
}

export function codexAskUserArgs(config: NonNullable<ReturnType<typeof askUserMcpConfig>>): string[] {
  return Object.entries({ ...config, tool_timeout_sec: 630, enabled: true, enabled_tools: ['ask_user'], 'tools.ask_user.approval_mode': 'approve' }).flatMap(([key, value]) => {
    // TOML inline tables use '=' instead of JSON's ':'. Environment keys are constants.
    const encoded = key === 'env'
      ? `{${Object.entries(config.env).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(',')}}`
      : JSON.stringify(value);
    return ['-c', `mcp_servers.lark_bridge.${key}=${encoded}`];
  });
}
