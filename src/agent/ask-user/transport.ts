import net, { type Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ASK_USER_TIMEOUT_MS } from './schema';

export function askUserSocketPath(profileDir: string): string {
  const digest = createHash('sha256').update(profileDir).digest('hex').slice(0, 16);
  if (process.platform === 'win32') return `\\\\.\\pipe\\lark-ask-user-${digest}`;
  const local = join(profileDir, 'ask-user.sock');
  // Darwin sockaddr_un has a 104-byte path limit, including its trailing NUL.
  return Buffer.byteLength(local) < 100 ? local : join(tmpdir(), `lark-ask-${digest}`, 'rpc');
}

export function readFrames(socket: Socket, handle: (value: Record<string, unknown>) => void): void {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 64 * 1024) { socket.destroy(); return; }
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const value: unknown = JSON.parse(line);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        handle(value as Record<string, unknown>);
      } catch { socket.destroy(); return; }
    }
  });
}

export function writeFrame(socket: Socket, value: unknown): void {
  if (!socket.destroyed) socket.write(JSON.stringify(value) + '\n');
}

export function askUserRpc(path: string, request: unknown, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    let settled = false;
    const finish = (error?: Error, value?: unknown): void => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const abort = (): void => finish(new Error('ask_user cancelled'));
    const timer = setTimeout(() => finish(new Error('ask_user transport timed out')), ASK_USER_TIMEOUT_MS + 15_000);
    socket.on('connect', () => writeFrame(socket, request));
    socket.on('error', () => finish(new Error('ask_user bridge is unavailable')));
    socket.on('close', () => finish(new Error('ask_user bridge disconnected')));
    readFrames(socket, value => finish(undefined, value));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
