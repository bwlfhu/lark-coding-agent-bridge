import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { claimRequest, shellEnvironment } from '../../dsh-desktop/request.js';
import { removeStaleSocket } from '../../dsh-desktop/ipc.js';

describe('Desktop durable request delivery', () => {
  it('never reexecutes accepted work and replays only its completed terminal result', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-r-'));
    try {
      const request = { requestId: 'run-1', cwd: dir, prompt: 'control Calculator' };
      const claimed = await claimRequest(dir, request);
      await expect(claimRequest(dir, request)).rejects.toThrow('already accepted');
      if (!claimed.complete) throw new Error('expected new claim');
      await claimed.complete([{ type: 'final', text: '3' }]);
      expect((await claimRequest(dir, request)).replay).toEqual([{ type: 'final', text: '3' }]);
      await expect(claimRequest(dir, { ...request, prompt: 'different action' })).rejects.toThrow('different content');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('quotes shell values without executing them and excludes arbitrary environment keys', () => {
    const script = shellEnvironment({ LARK_CHANNEL_PROFILE: "test' $(printf wrong)", PATH: 'bad' });
    const output = execFileSync('/bin/bash', ['-c', script + 'printf "%s" "$LARK_CHANNEL_PROFILE"'], { encoding: 'utf8' });
    expect(output).toBe("test' $(printf wrong)");
    expect(script).not.toContain('export PATH');
  });

  it('preserves ordinary files supplied as a socket path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-s-'));
    try {
      const path = join(dir, 'important'); await writeFile(path, 'keep');
      await expect(removeStaleSocket(path)).rejects.toThrow('non-socket');
      expect(await readFile(path, 'utf8')).toBe('keep');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
