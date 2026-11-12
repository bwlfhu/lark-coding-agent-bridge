import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CardActionEvent } from '@larksuite/channel';
import { startAskUserBroker } from '../../src/agent/ask-user/broker';
import { parseQuestions } from '../../src/agent/ask-user/schema';
import { askUserRpc, askUserSocketPath } from '../../src/agent/ask-user/transport';
import { askUserMcpConfig, codexAskUserArgs } from '../../src/agent/ask-user/config';
import { CodexJsonlTranslator } from '../../src/agent/codex/jsonl';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

async function fixture(timeoutMs = 2000) {
  const dir = await mkdtemp(join(tmpdir(), 'ask-'));
  const routeId = 'route-test';
  const leasePath = join(dir, 'route-leases', routeId + '.json');
  await mkdir(join(dir, 'route-leases'));
  const lease = { routeId, bridgePid: process.pid, chatId: 'oc_test', threadId: 'omt_test', replyTo: 'om_trigger', expiresAt: new Date(Date.now() + 60000).toISOString() };
  await writeFile(leasePath, JSON.stringify(lease));
  const send = vi.fn().mockImplementation(async () => ({ messageId: `om_card_${send.mock.calls.length}` }));
  const updateCard = vi.fn().mockResolvedValue(undefined);
  const broker = await startAskUserBroker({ send, updateCard }, dir, { timeoutMs });
  let active = true;
  broker.bindRoute(routeId, { actorId: 'ou_owner', isActive: () => active });
  cleanups.push(async () => { await broker.close(); await rm(dir, { recursive: true, force: true }); });
  const questions = [{ id: 'release', question: '发布策略？', options: [{ label: '审查后发布' }, { label: '仅记录' }] }];
  const request = (qs: unknown = questions) => askUserRpc(askUserSocketPath(dir), { routeId, bridgePid: process.pid, questions: qs });
  const event = (id = 'om_card_1') => ({ chatId: 'oc_test', messageId: id, operator: { openId: 'ou_owner' } }) as CardActionEvent;
  const payload = (index = 0, button = 1) => send.mock.calls[index]![1].card.body.elements[button].behaviors[0].value as Record<string, unknown>;
  return { dir, routeId, leasePath, lease, broker, send, updateCard, request, event, payload, questions, stop: () => { active = false; } };
}

describe('ask_user broker', () => {
  it('returns only the requester’s real choice exactly once, in the original topic', async () => {
    const f = await fixture();
    const result = f.request();
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    expect(f.send.mock.calls[0]?.[2]).toEqual({ replyTo: 'om_trigger', replyInThread: true });
    const value = f.payload();
    expect(await f.broker.handleCard({ ...f.event(), operator: { openId: 'ou_other' } } as CardActionEvent, value)).toBe(false);
    expect(await f.broker.handleCard({ ...f.event(), chatId: 'oc_other' }, value)).toBe(false);
    expect(await f.broker.handleCard(f.event('om_wrong'), value)).toBe(false);
    expect(await f.broker.handleCard(f.event(), { ...value, selected: '999' })).toBe(false);
    const outcomes = await Promise.all([f.broker.handleCard(f.event(), value), f.broker.handleCard(f.event(), value)]);
    expect(outcomes.sort()).toEqual([false, true]);
    expect(await result).toEqual({ status: 'answered', answers: [{ id: 'release', selected: ['审查后发布'] }] });
    await vi.waitFor(() => expect(f.updateCard).toHaveBeenCalled());
    expect(JSON.stringify(f.updateCard.mock.calls)).not.toContain('__ask_user_answer');
  });

  it('waits for all questions, accepts free text and multiple choices without defaults', async () => {
    const f = await fixture();
    let resolved = false;
    const result = f.request([
      { ...f.questions[0], multiSelect: true },
      { id: 'detail', question: '补充要求？' },
    ]).then(v => { resolved = true; return v; });
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
    const form = f.send.mock.calls[0]![1].card.body.elements[1].elements;
    const value = form.at(-1).value;
    expect(await f.broker.handleCard(f.event(), value, {})).toBe(false);
    expect(await f.broker.handleCard(f.event(), value, { choices: ['0', '1'], answer: '仅用于测试' })).toBe(true);
    expect(resolved).toBe(false);
    const freeValue = f.send.mock.calls[1]![1].card.body.elements[1].elements.at(-1).value;
    expect(await f.broker.handleCard(f.event('om_card_2'), freeValue, { answer: '不修改业务文件' })).toBe(true);
    expect(await result).toEqual({ status: 'answered', answers: [
      { id: 'release', selected: ['审查后发布', '仅记录'], text: '仅用于测试' },
      { id: 'detail', selected: [], text: '不修改业务文件' },
    ] });
  });

  it('expires without consent, rejects stale clicks and refuses an expired route', async () => {
    const f = await fixture(150);
    const result = f.request();
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    const value = f.payload();
    expect(await result).toMatchObject({ status: 'expired' });
    expect(await f.broker.handleCard(f.event(), value)).toBe(false);
    await writeFile(f.leasePath, JSON.stringify({ ...f.lease, expiresAt: '2020-01-01T00:00:00Z' }));
    expect(await f.request()).toMatchObject({ status: 'unavailable' });
    expect(f.send).toHaveBeenCalledOnce();
  });

  it('cancels on user cancel or originating run end, and rejects inactive runs', async () => {
    const f = await fixture();
    const first = f.request();
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    const cancel = f.send.mock.calls[0]![1].card.body.elements.at(-2).behaviors[0].value;
    expect(await f.broker.handleCard(f.event(), cancel)).toBe(true);
    expect(await first).toMatchObject({ status: 'cancelled' });
    const second = f.request();
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
    f.broker.cancelRoute(f.routeId);
    expect(await second).toMatchObject({ status: 'cancelled' });
    expect(await f.request()).toMatchObject({ status: 'unavailable' });
  });

  it('refuses a choice if the run was interrupted while the card was open', async () => {
    const f = await fixture();
    const result = f.request();
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    f.stop();
    expect(await f.broker.handleCard(f.event(), f.payload())).toBe(false);
    f.broker.cancelRoute(f.routeId);
    expect(await result).toMatchObject({ status: 'cancelled' });
  });

  it('validates shape, duplicate identifiers, and explicit choices', () => {
    for (const value of [{ questions: [] }, { questions: [{ id: 'a', question: 'q', options: [{ label: 'same' }, { label: 'same' }] }] },
      { questions: [{ id: 'a', question: 'q' }, { id: 'a', question: 'q2' }] }, { questions: [{ id: 'a', question: 'q', multiSelect: true }] },
      { questions: [{ id: 'a', question: 'q' }], chatId: 'oc_arbitrary' }]) expect(() => parseQuestions(value)).toThrow();
  });
});

describe('packaged MCP entry point', () => {
  it('discovers ask_user over real stdio and resumes the exact pending MCP call with a verified answer', async () => {
    const f = await fixture();
    const client = new Client({ name: 'acceptance', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/ask-user-mcp.js')],
      env: { ...process.env as Record<string, string>, LARK_ASK_USER_SOCKET: askUserSocketPath(f.dir), LARK_ASK_USER_ROUTE: f.routeId, LARK_ASK_USER_PID: String(process.pid) } });
    cleanups.push(() => client.close());
    await client.connect(transport);
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(['ask_user']);
    const response = client.callTool({ name: 'ask_user', arguments: { questions: f.questions } });
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    expect(await f.broker.handleCard(f.event(), f.payload(0, 2))).toBe(true);
    expect(JSON.stringify(await response)).toContain('仅记录');
  });

  it('builds invocation-only config and translates native Codex MCP tool flight', () => {
    expect(askUserMcpConfig(undefined, 'route-test')).toBeUndefined();
    const config = askUserMcpConfig({ rootDir: '/root/bridge', profile: 'codex', bridgePid: 12 }, 'route-test')!;
    expect(codexAskUserArgs(config)).toContain('mcp_servers.lark_bridge.tool_timeout_sec=630');
    const t = new CodexJsonlTranslator();
    const item = { id: 'mcp1', type: 'mcp_tool_call', server: 'lark_bridge', tool: 'ask_user', arguments: {} };
    expect(t.translate({ type: 'item.started', item })).toEqual([{ type: 'tool_use', id: 'mcp1', name: 'mcp__lark_bridge__ask_user', input: {} }]);
    expect(t.translate({ type: 'item.completed', item: { ...item, result: { content: [] } } })).toMatchObject([{ type: 'tool_result', id: 'mcp1', isError: false }]);
  });
});
