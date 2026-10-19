import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';

const tool = resolve('tools/check-public-package.mjs');
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('public package scan', () => {
  it('detects common credentials and private keys without printing their values', async () => {
    const root = await temporaryRoot();
    const token = `ghp_${'a'.repeat(36)}`;
    const keyHeader = ['-----BEGIN', 'OPENSSH PRIVATE KEY-----'].join(' ');
    await writeFile(join(root, 'accidental.txt'), `${token}\n`);
    const result = run(['--tree', '--root', root]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('github-token');
    expect(result.stderr).not.toContain(token);
    expect(result.stderr).not.toContain(keyHeader);
    await writeFile(join(root, 'accidental.txt'), `${keyHeader}\n`);
    const keyResult = run(['--tree', '--root', root]);
    expect(keyResult.status).not.toBe(0);
    expect(keyResult.stderr).toContain('private-key');
    expect(keyResult.stderr).not.toContain(keyHeader);
  });

  it('detects local configuration paths even when their content looks harmless', async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, '.env.local'), 'PORT=3000\n');
    const result = run(['--tree', '--root', root]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('.env.local (local-configuration)');
  });

  it('permits an example env file and reports the private gate as skipped', async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, '.env.example'), 'API_KEY=${API_KEY}\n');
    const result = run(['--tree', '--root', root, '--with-private']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('public package tree scan passed');
    expect(result.stdout).toContain('private exact denylist scan skipped');
  });

  it('fails when a supplied private gate cannot be loaded', async () => {
    const root = await temporaryRoot();
    const result = run(['--tree', '--root', root, '--patterns-file', join(root, 'missing.json')]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('privacy denylist input is unreadable');
    expect(result.stdout).not.toContain('private exact denylist scan skipped');
  });

  it('checks dist separately and scans paths inside the exact tarball', async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, 'dist'));
    await writeFile(join(root, 'dist/index.js'), `const key = "sk-${'b'.repeat(40)}";`);
    const dist = run(['--dist', '--root', root]);
    expect(dist.status).not.toBe(0);
    expect(dist.stderr).toContain('api-key');
    const tarball = join(root, 'fixture.tgz');
    await writeFile(tarball, gzipSync(singleFileTar('package/.dsh/config.yaml', 'local: true')));
    const packed = run(['--tarball', tarball]);
    expect(packed.status).not.toBe(0);
    expect(packed.stderr).toContain('tarball:package/.dsh/config.yaml (local-configuration)');
  });
});

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), 'public-package-test-'));
  roots.push(root);
  return root;
}

function run(args: string[]) {
  return spawnSync(process.execPath, [tool, ...args], {
    encoding: 'utf8', env: { ...process.env, LARK_BRIDGE_PRIVACY_DENYLIST_FILE: '' },
  });
}

function singleFileTar(name: string, text: string) {
  const body = Buffer.from(text);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write('0', 156, 1, 'ascii');
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(padded);
  return Buffer.concat([header, padded, Buffer.alloc(1024)]);
}
