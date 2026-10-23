import { describe, expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuite/channel';
import { makeKeepaliveReconnect } from '../../../src/bot/keepalive';

function channelWith(forceReconnect?: () => Promise<void>): LarkChannel {
  return (forceReconnect ? { forceReconnect } : {}) as unknown as LarkChannel;
}

describe('keepalive force-reconnect', () => {
  it('reconnects only the WebSocket and never restarts the bridge while it succeeds', async () => {
    const ws = vi.fn().mockResolvedValue(undefined);
    const restartBridge = vi.fn().mockResolvedValue(undefined);
    const reconnect = makeKeepaliveReconnect({
      channel: channelWith(ws),
      activeRunCount: () => 1,
      restartBridge,
    });

    await reconnect();

    expect(ws).toHaveBeenCalledTimes(1);
    // A full restart calls activeRuns.stopAll() and SIGTERMs running agents.
    expect(restartBridge).not.toHaveBeenCalled();
  });

  it('defers the full restart while agent runs are active when the WebSocket reconnect fails', async () => {
    const ws = vi.fn().mockRejectedValue(new Error('handshake timeout'));
    const restartBridge = vi.fn().mockResolvedValue(undefined);
    const reconnect = makeKeepaliveReconnect({
      channel: channelWith(ws),
      activeRunCount: () => 2,
      restartBridge,
    });

    await expect(reconnect()).resolves.toBeUndefined();
    expect(restartBridge).not.toHaveBeenCalled();
  });

  it('falls back to a full restart only when no run would be interrupted', async () => {
    const ws = vi.fn().mockRejectedValue(new Error('handshake timeout'));
    const restartBridge = vi.fn().mockResolvedValue(undefined);
    const reconnect = makeKeepaliveReconnect({
      channel: channelWith(ws),
      activeRunCount: () => 0,
      restartBridge,
    });

    await reconnect();
    expect(restartBridge).toHaveBeenCalledTimes(1);
  });

  it('falls back to a full restart when the channel has no WebSocket-only reconnect and nothing is running', async () => {
    const restartBridge = vi.fn().mockResolvedValue(undefined);
    await makeKeepaliveReconnect({
      channel: channelWith(),
      activeRunCount: () => 0,
      restartBridge,
    })();
    expect(restartBridge).toHaveBeenCalledTimes(1);
  });

  it('propagates a failed full restart so the keepalive can log and retry', async () => {
    const reconnect = makeKeepaliveReconnect({
      channel: channelWith(),
      activeRunCount: () => 0,
      restartBridge: vi.fn().mockRejectedValue(new Error('config incomplete')),
    });
    await expect(reconnect()).rejects.toThrow('config incomplete');
  });
});

describe('the vendored channel exposes the WebSocket-only reconnect', () => {
  it('LarkChannel.prototype.forceReconnect exists', async () => {
    const mod = await import('@larksuite/channel');
    const channel = mod.createLarkChannel({ appId: 'cli_test', appSecret: 'secret' } as never);
    expect(typeof (channel as unknown as { forceReconnect?: unknown }).forceReconnect).toBe('function');
  });
});
