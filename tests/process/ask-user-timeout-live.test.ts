import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexAdapter } from '../../src/agent/codex/adapter';
import { ClaudeAdapter } from '../../src/agent/claude/adapter';
import { startAskUserBroker } from '../../src/agent/ask-user/broker';
import { createRouteLease } from '../../src/runtime/route-lease';
import type { AgentEvent, AgentAdapter } from '../../src/agent/types';

// Real installed backends and stdio MCP; simulated card delivery, no click.
// A short broker deadline tests continuation without waiting ten minutes.
describe.runIf(process.env.LARK_ASK_USER_LIVE === '1')('native timeout recommendation contract', () => {
  for (const kind of ['codex', 'claude'] as const) it(`${kind}: continues after automatic recommendation without a human click`, async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ask-timeout-live-'));
    const profileDir = join(rootDir, 'profiles', kind);
    const cwd = join(rootDir, 'workspace');
    await mkdir(cwd, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    let cards = 0;
    const updates: string[] = [];
    const broker = await startAskUserBroker({
      send: async () => ({ messageId: `om_timeout_${++cards}` }),
      updateCard: async (_id: string, card: unknown) => { updates.push(JSON.stringify(card)); },
    }, profileDir, { timeoutMs: 300 });
    const lease = await createRouteLease(profileDir, { chatId: 'oc_timeout_fixture', replyTo: 'om_trigger', bridgePid: process.pid });
    if (!lease) throw new Error('route unavailable');
    broker.bindRoute(lease.routeId, { actorId: 'ou_fixture', isActive: () => true });
    const context = { rootDir, profile: kind, bridgePid: process.pid };
    const adapter: AgentAdapter = kind === 'codex'
      ? new CodexAdapter({ binary: process.env.LARK_CHANNEL_CODEX_BIN ?? 'codex', profileStateDir: profileDir, larkChannel: context, sandbox: 'read-only', stdoutIdleProbeMs: 0 })
      : new ClaudeAdapter({ larkChannel: context });
    const run = adapter.run({ runId: 'timeout-test', cwd, routeId: lease.routeId,
      prompt: 'Isolated tool integration test. Do not access files, shell or other services. Call lark_bridge ask_user exactly once with {"questions":[{"id":"color","question":"超时测试：请选择颜色","options":[{"label":"绿色"},{"label":"蓝色","recommended":true}]}]}. WAIT for the tool result. A timeout recommendation is authorized. After status=answered continue and reply TIMEOUT_CONTINUED followed by the selected label and answer source. Do not ask again.' });
    const events: AgentEvent[] = [];
    const timer = setTimeout(() => { void run.stop(); }, 150000);
    try {
      for await (const event of run.events) events.push(event);
      const text = events.filter(e => e.type === 'text').map(e => e.delta).join('');
      console.log(JSON.stringify({ backend: kind, cards, terminal: events.filter(e => e.type === 'done' || e.type === 'error'), text: text.slice(-1000) }));
      expect(events.filter(e => e.type === 'error')).toEqual([]);
      expect(events).toContainEqual(expect.objectContaining({ type: 'done', terminationReason: 'normal' }));
      expect(cards).toBe(1);
      expect(text).toContain('TIMEOUT_CONTINUED');
      expect(text).toContain('蓝色');
      expect(text).toContain('timeout_recommendation');
      expect(updates.join('')).toContain('超时，已按推荐项自动选择：蓝色');
    } finally {
      clearTimeout(timer);
      await run.waitForExit(3000);
      await broker.close();
      await rm(rootDir, { recursive: true, force: true });
    }
  }, 170000);
});
