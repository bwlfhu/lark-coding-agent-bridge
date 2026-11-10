import net from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
export const integrationDir = join(dshHome, 'integrations/lark-channel-bridge');
export const hostSocket = process.env.DSH_LARK_DESKTOP_SOCKET || join(dshHome, 'lark-desktop.sock');
export const bridgeSocket = join(homedir(), '.dsh/lark-desktop-bridge.sock');
export const MAX_FRAME = 24 * 1024 * 1024;

export function frameReader(socket, handler) {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX_FRAME) { socket.destroy(new Error('IPC frame exceeds limit')); return; }
    let pos;
    while ((pos = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, pos); buffer = buffer.slice(pos + 1);
      if (!line) continue;
      try { handler(JSON.parse(line)); } catch { socket.destroy(new Error('Invalid IPC message')); }
    }
  });
}

export function writeFrame(socket, value) {
  if (!socket.destroyed && socket.writable) socket.write(JSON.stringify(value) + '\n');
}

export function rpc(path, request, { signal, timeoutMs = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort); socket.destroy();
      error ? reject(error) : resolve(value);
    };
    const onAbort = () => finish(signal.reason ?? new Error('Cancelled'));
    const timer = setTimeout(() => finish(new Error('Desktop bridge request timed out')), timeoutMs);
    socket.on('connect', () => writeFrame(socket, request));
    socket.on('error', error => finish(error));
    socket.on('close', () => { if (!settled) finish(new Error('Desktop bridge disconnected')); });
    frameReader(socket, value => value.ok === false ? finish(new Error(value.error)) : finish(null, value));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export async function removeStaleSocket(path) {
  const { lstat, unlink } = await import('node:fs/promises');
  let original;
  try { original = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!original.isSocket()) throw new Error('Refusing to replace a non-socket path');
  const alive = await new Promise(resolve => {
    const socket = net.createConnection(path);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', error => { socket.destroy(); resolve(error.code !== 'ENOENT' && error.code !== 'ECONNREFUSED'); });
  });
  if (alive) throw new Error('Desktop connector is already running');
  const current = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (current && (current.ino !== original.ino || !current.isSocket())) throw new Error('Socket path changed during startup');
  if (current) await unlink(path);
}
