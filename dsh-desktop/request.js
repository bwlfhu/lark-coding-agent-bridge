import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ENV_KEYS = new Set(['LARK_CHANNEL', 'LARK_CHANNEL_PROFILE', 'LARK_CHANNEL_BRIDGE_PID', 'LARK_CHANNEL_ROUTE_ID', 'LARK_CHANNEL_HOME', 'LARK_CHANNEL_CONFIG', 'LARKSUITE_CLI_CONFIG_DIR']);
export function shellEnvironment(env = {}) {
  return Object.entries(env).filter(([key, value]) => ENV_KEYS.has(key) && typeof value === 'string')
    .map(([key, value]) => `export ${key}='${value.replaceAll("'", "'\\''")}'`).join('\n') + '\n';
}

/** An accepted request is never executed twice, including after a Desktop restart. */
export async function claimRequest(dir, request) {
  const key = createHash('sha256').update(request.requestId).digest('hex');
  const fingerprint = createHash('sha256').update(JSON.stringify([request.cwd, request.prompt, request.sessionId ?? null])).digest('hex');
  const receipts = join(dir, 'requests');
  await mkdir(receipts, { recursive: true, mode: 0o700 });
  const path = join(receipts, key + '.json');
  try {
    await writeFile(path, JSON.stringify({ fingerprint, status: 'accepted' }), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const receipt = JSON.parse(await readFile(path, 'utf8'));
    if (receipt.fingerprint !== fingerprint) throw new Error('Request ID was reused with different content');
    if (receipt.status !== 'completed') throw new Error('Request was already accepted; inspect Desktop before issuing a new task');
    return { replay: receipt.frames };
  }
  const envPath = join(receipts, key + '.env.sh');
  await writeFile(envPath, shellEnvironment(request.larkEnv), { mode: 0o600 });
  return { envPath, complete: frames => writeFile(path, JSON.stringify({ fingerprint, status: 'completed', frames }), { mode: 0o600 }) };
}
