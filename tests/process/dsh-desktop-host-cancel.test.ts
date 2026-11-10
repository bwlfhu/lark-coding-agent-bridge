import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { frameReader, writeFrame } from '../../dsh-desktop/ipc.js';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe('Desktop Host cancellation contract', () => {
  it.each(['stop', 'disconnect', 'shutdown'] as const)('passes an official cancellation cause on %s', async (operation) => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-cancel-'));
    const socketPath = join(dir, 'host.sock');
    vi.stubEnv('DSH_HOME', dir);
    vi.stubEnv('DSH_LARK_DESKTOP_SOCKET', socketPath);
    vi.resetModules();
    // @ts-expect-error The Host runs inside DSH's Cordis runtime; this test supplies that runtime fixture.
    const { apply } = await import('../../dsh-desktop/host.js');
    const listeners = new Map<string, Set<(...args: any[]) => void>>();
    const on = (event: string, listener: (...args: any[]) => void) => {
      const current = listeners.get(event) ?? new Set();
      listeners.set(event, current);
      current.add(listener);
      return () => current.delete(listener);
    };
    let finishIdle!: () => void;
    const idle = new Promise<void>(resolve => { finishIdle = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const session = { seq: 0, eventAt: () => undefined };
    let running = false;
    const cancel = vi.fn((cause) => {
      for (const listener of listeners.get('session/event') ?? []) {
        listener(session, { type: 'turn/end', data: { turn: 1, reason: cause ? { kind: 'aborted', reason: cause } : null } });
      }
      finishIdle();
    });
    const agent = {
      session, cancel,
      whenIdle: () => running ? idle : Promise.resolve(),
      model: { select: vi.fn() },
      ctx: { on: () => () => {} },
    };
    let dispose!: () => Promise<void>;
    const ctx = {
      on,
      effect: (effect: () => () => Promise<void>) => { dispose = effect(); },
      get: () => undefined,
      sessionController: {
        create: async () => ({ sessionId: 'cancellation-session' }),
        rename: async () => {},
        resolveAgent: async () => ({ agent }),
        prompt: async () => { running = true; markStarted(); },
      },
      sessions: { flush: async () => {} },
      agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock' }) },
      llm: { resolveModelInfo: async () => ({}) },
    };
    let socket: net.Socket | undefined;
    let disposed = false;
    try {
      await apply(ctx);
      socket = net.createConnection(socketPath);
      const frames: any[] = [];
      const closed = new Promise<void>(resolve => socket!.once('close', () => resolve()));
      socket.on('error', () => {});
      frameReader(socket, frame => frames.push(frame));
      await new Promise<void>(resolve => socket!.once('connect', resolve));
      writeFrame(socket, { op: 'run', requestId: `cancel-${operation}`, cwd: dir, prompt: 'diagnostic' });
      await started;
      if (operation === 'stop') writeFrame(socket, { op: 'cancel' });
      else if (operation === 'disconnect') socket.destroy();
      else { await dispose(); disposed = true; }
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
      expect(cancel).toHaveBeenCalledWith({ kind: operation === 'shutdown' ? 'disposed' : 'user' });
      await closed;
      if (operation === 'stop') {
        expect(frames).toContainEqual(expect.objectContaining({
          type: 'final', reason: { kind: 'aborted', reason: { kind: 'user' } },
        }));
      }
    } finally {
      socket?.destroy();
      if (!disposed && dispose) await dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
