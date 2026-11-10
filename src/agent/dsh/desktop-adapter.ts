import net from 'node:net';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { frameReader, rpc, writeFrame } from '../../../dsh-desktop/ipc.js';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { composeBridgeSystemPrompt } from '../bridge-system-prompt';
import { createPromptRedactor } from '../prompt-redaction';
import { AgentPreflightError, type AgentAvailability } from '../preflight';
import type { AgentAdapter, AgentBotIdentity, AgentEvent, AgentRun, AgentRunOptions } from '../types';
import type { DshProviderConfig } from './patches';
import { DshJsonlTranslator } from './jsonl';

export interface DesktopDshOptions {
  socketPath?: string;
  controlSocketPath: string;
  dshHome?: string;
  provider?: DshProviderConfig;
  sandbox?: string;
  stopGraceMs?: number;
  larkChannel?: LarkChannelEnvContext;
}

/** One private control socket per bridge profile; no public listener is opened. */
export function desktopControlSocketPath(profileDir: string, home = join(homedir(), '.dsh')): string {
  const identity = createHash('sha256').update(profileDir).digest('hex').slice(0, 16);
  return join(home, `lark-bridge-${identity}.sock`);
}

/** Connects tasks to the existing Desktop Host without launching another DSH runtime. */
export class DesktopDshAdapter implements AgentAdapter {
  readonly id = 'dsh';
  readonly displayName = 'DeepSeek Harness Desktop';
  readonly socketPath: string;
  private identity: AgentBotIdentity | undefined;

  constructor(private readonly options: DesktopDshOptions) {
    const home = options.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
    this.socketPath = options.socketPath ?? join(home, 'lark-desktop.sock');
  }

  setBotIdentity(identity: AgentBotIdentity): void { this.identity = identity; }

  async checkAvailability(): Promise<AgentAvailability> {
    try {
      const status = await rpc(this.socketPath, { op: 'status' }, { timeoutMs: 5000 });
      if (status.ok !== true || typeof status.version !== 'string') throw new Error('Invalid Desktop Host response');
      return { ok: true, version: status.version };
    } catch {
      const diagnostic = { code: 'agent-version-check-spawn-failed' as const, agentId: 'dsh' as const,
        agentName: this.displayName, command: 'desktop-host', binaryPath: this.socketPath };
      return { ok: false, diagnostic, error: new AgentPreflightError(diagnostic,
        'DeepSeek Harness Desktop Host is unavailable. Open Desktop and enable the bridge Desktop plugin.') };
    }
  }

  async isAvailable(): Promise<boolean> { return (await this.checkAvailability()).ok; }

  async prepareRun(options: AgentRunOptions): Promise<void> {
    if (!options.cwd) throw new Error('cwd is required for Desktop DSH');
    if (options.images?.length) throw new Error('DSH Desktop bridge image prompts are not supported yet; desktop screenshots remain available to CUA.');
    if (options.model && (!this.options.provider || !this.options.provider.models.some(m => m.id === options.model))) {
      throw new Error('Desktop model must be declared in dsh.provider.models');
    }
    const availability = await this.checkAvailability();
    if (!availability.ok) throw availability.error;
  }

  run(options: AgentRunOptions): AgentRun {
    if (!options.cwd) throw new Error('cwd is required for Desktop DSH');
    const instructions = composeBridgeSystemPrompt(this.identity, options.systemPromptAddendum) + '\n## 当前执行环境\n当前任务运行在官方 DeepSeek Harness Desktop 的 PTC 会话中。使用已安装的官方 Computer Use 操作本机应用。先观察界面，再执行操作，并核对结果。涉及应用授权时向当前飞书用户提问。\n';
    const stopGraceMs = options.stopGraceMs ?? this.options.stopGraceMs ?? 5000;
    const redact = createPromptRedactor([options.prompt, instructions]);
    const translator = new DshJsonlTranslator();
    const queue: AgentEvent[] = [];
    let wake: (() => void) | undefined, ended = false, stopped = false;
    let resolveClosed!: () => void;
    const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
    const emit = (events: AgentEvent[]): void => {
      queue.push(...events.map(event => event.type === 'error' ? { ...event, message: redact(event.message) } : event));
      wake?.(); wake = undefined;
    };
    const socket = net.createConnection(this.socketPath);
    socket.on('connect', () => {
      if (stopped) { socket.destroy(); return; }
      const provider = this.options.provider;
      writeFrame(socket, { op: 'run', requestId: `bridge-${options.runId}`, sessionId: options.sessionId,
        cwd: options.cwd, prompt: `${instructions}\n\n${options.prompt}`,
        ...(provider ? { model: { provider: provider.id, model: options.model ?? provider.defaultModel ?? provider.models[0]?.id } } : {}),
        larkEnv: buildLarkChannelEnv({ ...this.options.larkChannel, routeId: options.routeId }),
        routeId: options.routeId, bridgePid: process.pid, controlSocketPath: this.options.controlSocketPath,
        permissionMode: options.sandbox ?? this.options.sandbox ?? 'danger-full-access', botName: this.identity?.name,
      });
    });
    frameReader(socket, frame => emit(translator.translate(frame)));
    socket.on('error', () => emit(translator.fail('DSH Desktop connection failed; the task was not replayed.')));
    socket.on('close', () => {
      emit(translator.finish(stopped ? 'interrupted' : 'failed'));
      ended = true; wake?.(); wake = undefined; resolveClosed();
    });
    return {
      runId: options.runId,
      events: (async function* () {
        try {
          while (!ended || queue.length) {
            const next = queue.shift();
            if (next) yield next;
            else await new Promise<void>(resolve => { wake = resolve; });
          }
        } finally { if (!ended) socket.destroy(); }
      })(),
      async stop() {
        if (ended) return;
        stopped = true;
        writeFrame(socket, { op: 'cancel', requestId: `bridge-${options.runId}` });
        const timer = setTimeout(() => socket.destroy(), stopGraceMs);
        try { await closed; } finally { clearTimeout(timer); }
      },
      async waitForExit(timeoutMs: number) {
        if (ended) return true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([closed.then(() => true), new Promise<boolean>(resolve => {
            timer = setTimeout(() => resolve(false), timeoutMs);
          })]);
        } finally { if (timer) clearTimeout(timer); }
      },
    };
  }
}
