import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CardActionEvent } from '@larksuite/channel';
import { CodexAdapter } from '../../src/agent/codex/adapter';
import { ClaudeAdapter } from '../../src/agent/claude/adapter';
import { startAskUserBroker } from '../../src/agent/ask-user/broker';
import { createRouteLease } from '../../src/runtime/route-lease';
import type { AgentEvent, AgentAdapter } from '../../src/agent/types';

// Real installed models + the packaged MCP server, simulated card callback.
// This complements (does not replace) the real Feishu click acceptance.
describe.runIf(process.env.LARK_ASK_USER_LIVE === '1')('native ask_user model contract', () => {
  for (const kind of ['codex', 'claude'] as const) it(`${kind}: waits for an answer, continues and resumes the same session`, async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ask-live-'));
    const profileDir = join(rootDir, 'profiles', kind);
    const cwd = join(rootDir, 'workspace');
    await mkdir(cwd, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    let broker: Awaited<ReturnType<typeof startAskUserBroker>>;
    let sent = 0;
    const channel = {
      send: async (_chat: string, content: { card?: unknown }) => {
        sent++;
        const card = content.card as { body: { elements: { behaviors?: { value: Record<string, unknown> }[] }[] } };
        const payload = card.body.elements.find(e => e.behaviors)?.behaviors?.[0]?.value;
        setTimeout(() => { if (payload) void broker.handleCard({ chatId: 'oc_live_fixture', messageId: `om_live_${sent}`, operator: { openId: 'ou_live_fixture' } } as CardActionEvent, payload); }, 300);
        return { messageId: `om_live_${sent}` };
      },
      updateCard: async () => {},
    };
    broker = await startAskUserBroker(channel as never, profileDir);
    const context = { rootDir, profile: kind, bridgePid: process.pid };
    const adapter: AgentAdapter = kind === 'codex'
      ? new CodexAdapter({ binary: process.env.LARK_CHANNEL_CODEX_BIN ?? 'codex', profileStateDir: profileDir, larkChannel: context, sandbox: 'read-only', stdoutIdleProbeMs: 0 })
      : new ClaudeAdapter({ larkChannel: context });
    let sessionId: string | undefined;
    let threadId: string | undefined;
    try {
      for (let round = 0; round < 2; round++) {
        const lease = await createRouteLease(profileDir, { chatId: 'oc_live_fixture', replyTo: 'om_live_trigger', bridgePid: process.pid });
        if (!lease) throw new Error('route unavailable');
        broker.bindRoute(lease.routeId, { actorId: 'ou_live_fixture', isActive: () => true });
        const run = adapter.run({ runId: `ask-live-${round}`, cwd, routeId: lease.routeId, sessionId, threadId,
          prompt: `This is an isolated tool integration test. Do not read/write files, use shell, or contact other services. Call the lark_bridge ask_user MCP tool exactly once now with {"questions":[{"id":"color","question":"集成测试：请选择颜色","options":[{"label":"蓝色"},{"label":"绿色"}]}]}. Wait for its result. Then reply with LIVE_ANSWER and the selected label. ${round ? 'This is a second question in the same session.' : ''}` });
        const events: AgentEvent[] = [];
        const deadline = setTimeout(() => { void run.stop(); }, 150000);
        try {
          for await (const event of run.events) {
            events.push(event);
            if (event.type === 'system') { sessionId = event.sessionId ?? sessionId; threadId = event.threadId ?? threadId; }
          }
          console.log(JSON.stringify({ backend: kind, round, cards: sent, terminal: events.filter(e => e.type === 'done' || e.type === 'error'), text: events.filter(e => e.type === 'text').map(e => e.delta).join('').slice(-1000) }));
          expect(events.filter(e => e.type === 'error')).toEqual([]);
          expect(events).toContainEqual(expect.objectContaining({ type: 'done', terminationReason: 'normal' }));
          const text = events.filter(e => e.type === 'text').map(e => e.delta).join('');
          expect(text).toContain('LIVE_ANSWER');
          expect(text).toContain('蓝色');
          expect(sent).toBe(round + 1);
          console.log(JSON.stringify({ backend: kind, round, cards: sent, sessionId, threadId, toolEvents: events.filter(e => e.type === 'tool_use').map(e => e.name) }));
        } finally { clearTimeout(deadline); await run.waitForExit(3000); broker.cancelRoute(lease.routeId); }
      }
    } finally { await broker.close(); await rm(rootDir, { recursive: true, force: true }); }
  }, 320000);
});
