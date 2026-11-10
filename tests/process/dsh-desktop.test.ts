import net, { type Server, type Socket } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopDshAdapter } from '../../src/agent/dsh/desktop-adapter';
import { startDesktopControl } from '../../src/agent/dsh/desktop-control';
import { normalizeDshConfig } from '../../src/agent/dsh/config';
import { createRuntimeAgent } from '../../src/runtime/agent-runtime';
import { createDefaultProfileConfig } from '../../src/config/profile-schema';
import { frameReader, rpc, writeFrame } from '../../dsh-desktop/ipc.js';
import type { AgentEvent } from '../../src/agent/types';
import type { CardActionEvent } from '@larksuite/channel';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

async function fixture(handle: (socket: Socket, frame: Record<string, unknown>) => void) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-d-'));
  const path = join(dir, 'host.sock');
  const sockets = new Set<Socket>();
  const server: Server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    frameReader(socket, frame => {
      if (frame.op === 'status') { writeFrame(socket, { ok: true, version: '0.8.3-beta.2' }); socket.end(); }
      else handle(socket, frame);
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  cleanups.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  return { dir, path, adapter: new DesktopDshAdapter({ socketPath: path, controlSocketPath: join(dir, 'control.sock') }) };
}

describe('Desktop DSH transport', () => {
  it('delivers a new task and resumes the exact Desktop session through the existing event vocabulary', async () => {
    const requests: Record<string, unknown>[] = [];
    const f = await fixture((socket, request) => {
      requests.push(request);
      writeFrame(socket, { type: 'session', sessionId: 'session-desktop', cwd: request.cwd });
      writeFrame(socket, { type: 'text', text: requests.length === 1 ? 'first' : 'continued' });
      writeFrame(socket, { type: 'status', phase: 'turn_end', reason: { kind: 'completed' } });
      writeFrame(socket, { type: 'final', sessionId: 'session-desktop', text: requests.length === 1 ? 'first' : 'continued', reason: { kind: 'completed' } });
      socket.end();
    });
    for (const sessionId of [undefined, 'session-desktop']) {
      const options = { runId: `run-${sessionId ?? 'new'}`, prompt: 'task', cwd: f.dir, sessionId };
      await f.adapter.prepareRun(options);
      const run = f.adapter.run(options);
      const events: AgentEvent[] = [];
      for await (const event of run.events) events.push(event);
      expect(events.filter(e => e.type === 'done')).toHaveLength(1);
      expect(events.find(e => e.type === 'system')).toMatchObject({ sessionId: 'session-desktop' });
      expect(await run.waitForExit(1000)).toBe(true);
    }
    expect(requests[0]?.sessionId).toBeUndefined();
    expect(requests[1]?.sessionId).toBe('session-desktop');
    expect(requests[0]?.requestId).toBe('bridge-run-new');
  });

  it('reports a dropped connection as failure and never replays the task', async () => {
    let calls = 0;
    const f = await fixture(socket => { calls++; socket.destroy(); });
    const run = f.adapter.run({ runId: 'drop', prompt: 'task', cwd: f.dir });
    const events: AgentEvent[] = [];
    for await (const event of run.events) events.push(event);
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', terminationReason: 'failed' }));
    expect(events.some(e => e.type === 'done')).toBe(false);
    expect(calls).toBe(1);
  });

  it('cancels the Host task when stopped without terminating Desktop', async () => {
    const cancel = vi.fn();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const f = await fixture((socket, frame) => {
      if (frame.op === 'run') { writeFrame(socket, { type: 'session', sessionId: 'session-stop' }); started(); }
      if (frame.op === 'cancel') { cancel(frame.requestId); socket.end(); }
    });
    const run = f.adapter.run({ runId: 'stop', prompt: 'task', cwd: f.dir });
    const events: AgentEvent[] = [];
    const consume = (async () => { for await (const event of run.events) events.push(event); })();
    await ready; await run.stop(); await consume;
    expect(cancel).toHaveBeenCalledWith('bridge-stop');
    expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'interrupted' });
    expect((await f.adapter.checkAvailability()).ok).toBe(true);
  });

  it('fails preflight when Desktop is unavailable', async () => {
    const adapter = new DesktopDshAdapter({ socketPath: join(tmpdir(), 'missing-dsh-desktop.sock'), controlSocketPath: 'unused' });
    await expect(adapter.prepareRun({ runId: 'offline', prompt: 'task', cwd: tmpdir() })).rejects.toThrow('Desktop Host is unavailable');
  });

  it('preserves CLI configuration defaults and selects Desktop only explicitly', () => {
    expect(normalizeDshConfig({ binaryPath: '/bin/dsh' })).not.toHaveProperty('transport');
    expect(() => normalizeDshConfig({ binaryPath: '/bin/dsh', transport: 'http' })).toThrow('dsh.transport');
    const profile = createDefaultProfileConfig({ agentKind: 'dsh', accounts: { app: { id: 'cli_test', secret: 'test', tenant: 'feishu' } },
      dsh: { binaryPath: '/bin/dsh', transport: 'desktop', desktopSocketPath: '/tmp/test.sock' } });
    const agent = createRuntimeAgent(profile, { profileDir: '/tmp/profile' });
    expect(agent).toBeInstanceOf(DesktopDshAdapter);
    expect((agent as DesktopDshAdapter).socketPath).toBe('/tmp/test.sock');
  });
});

describe('Desktop interaction control', () => {
  it('binds approvals to the live route, carrier card and offered choices, and accepts only one answer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-c-'));
    const path = join(dir, 'control.sock');
    await mkdir(join(dir, 'route-leases'));
    const routeId = 'route-12345678-1234-1234-1234-123456789012';
    await writeFile(join(dir, 'route-leases', routeId + '.json'), JSON.stringify({ routeId, chatId: 'oc_test', replyTo: 'om_trigger', bridgePid: process.pid, expiresAt: new Date(Date.now() + 60000).toISOString() }));
    const send = vi.fn().mockResolvedValue({ messageId: 'om_approval' });
    const control = await startDesktopControl({ send }, dir, path);
    cleanups.push(async () => { await control.close(); await rm(dir, { recursive: true, force: true }); });
    const answer = rpc(path, { op: 'question', routeId, bridgePid: process.pid,
      questions: [{ id: 'consent', question: 'Allow Calculator?', options: [{ label: 'Reject' }, { label: 'Allow' }], intent: { kind: 'approval', approve: 'Allow', reject: 'Reject' } }] });
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    const card = send.mock.calls[0]?.[1].card;
    const value = card.body.elements[1].behaviors[0].value;
    const event = { chatId: 'oc_test', messageId: 'om_approval' } as CardActionEvent;
    expect(control.handleCard({ ...event, chatId: 'oc_other' }, value)).toBe(false);
    expect(control.handleCard(event, { ...value, selected: 'Always allow everything' })).toBe(false);
    expect(control.handleCard(event, { ...value, selected: 'Allow' })).toBe(true);
    expect(control.handleCard(event, { ...value, selected: 'Allow' })).toBe(false);
    expect(await answer).toMatchObject({ ok: true, answer: { answers: [{ id: 'consent', selected: ['Allow'] }] } });
  });

  it('refuses expired routes before sending an approval card', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-c-'));
    const path = join(dir, 'control.sock');
    await mkdir(join(dir, 'route-leases'));
    const routeId = 'route-expired';
    await writeFile(join(dir, 'route-leases', routeId + '.json'), JSON.stringify({ routeId, bridgePid: process.pid, expiresAt: '2020-01-01T00:00:00.000Z' }));
    const send = vi.fn();
    const control = await startDesktopControl({ send }, dir, path);
    cleanups.push(async () => { await control.close(); await rm(dir, { recursive: true, force: true }); });
    await expect(rpc(path, { op: 'question', routeId, bridgePid: process.pid, questions: [{ id: 'q', question: 'Allow?' }] })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});
