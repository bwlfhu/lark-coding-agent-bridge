import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { LarkChannelEnvContext } from '../lark-channel-env';
import { askUserSocketPath } from './transport';

export const ASK_USER_INSTRUCTIONS = `
## ask_user — 等待飞书用户作决定
当前可用的 MCP 工具 lark_bridge.ask_user（名称可能显示为 mcp__lark_bridge__ask_user）可向本轮提问人发交互卡并等待答案。
调用参数必须使用 questions 数组，例如 {"questions":[{"id":"release","question":"审查是否拦截发布？","options":[{"label":"审查后才能发布"},{"label":"仅记录审查结果"}]}]}。
遇到影响任务方向、产品规则、发布策略或授权范围且无法从现有信息确定的选择，请调用此工具，提交简明问题、稳定 id 和选项；不要只在正文中列选项后继续执行。
工具等待期间不要执行依赖该决定的写入或外部操作。仅 status=answered 表示用户已回答；按 answers 中的选择/补充文字继续同一任务。
cancelled、expired、unavailable 和工具错误均不表示同意，不要猜默认答案、重试制造重复问题或自行扩张授权；说明尚未取得决定并结束本轮。
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
