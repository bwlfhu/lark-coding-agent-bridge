import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const runner = resolve('tools/pack-and-verify.mjs');
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('pack-and-verify runner', () => {
  it('packs, publicly scans, and clean-installs without a private denylist', async () => {
    const root = await temporaryRoot();
    const source = join(root, 'source');
    const output = join(root, 'verified.tgz');
    await mkdir(join(source, 'dist'), { recursive: true });
    await writeFile(join(source, 'package.json'), JSON.stringify({
      name: 'fictional-package-fixture',
      version: '1.2.3',
      type: 'module',
      files: ['dist'],
    }), 'utf8');
    await writeFile(join(source, 'dist/index.js'), 'export const ready = true;\n', 'utf8');

    const result = spawnSync(process.execPath, [
      runner,
      '--source',
      source,
      '--output',
      output,
    ], {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        // pnpm test injects these; npm 11 rejects allow-scripts for local installs.
        npm_config_allow_scripts: '*',
        npm_config_verify_deps_before_run: 'false',
        LARK_BRIDGE_PRIVACY_DENYLIST_FILE: '',
      },
    });

    expect(result.status, result.stderr).toBe(0);
    await expect(stat(output)).resolves.toMatchObject({ size: expect.any(Number) });
    expect(result.stdout).toContain('verified package artifact written');
    expect(result.stdout).toContain('public package tarball scan passed');
    expect(result.stdout).toContain('private exact denylist scan skipped');
    expect(result.stdout).not.toContain('private exact denylist tarball scan passed');
    expect(await readFile(output)).not.toHaveLength(0);
  }, 60_000);

  it('does not skip bundled Channel checks when the bridge package is renamed', async () => {
    const { verifyInstalledPackage } = await import('../../../tools/pack-and-verify.mjs');
    const root = await temporaryRoot();
    const source = join(root, 'source');
    const install = join(root, 'install');
    const installed = join(install, 'node_modules/@allcam/bridge');
    await mkdir(source, { recursive: true });
    await mkdir(installed, { recursive: true });
    const manifest = {
      name: '@allcam/bridge', version: '1.0.0',
      dependencies: { '@larksuite/channel': 'file:vendor/channel.tgz' },
      bundleDependencies: ['@larksuite/channel'],
    };
    await writeFile(join(source, 'package.json'), JSON.stringify(manifest));
    await writeFile(join(installed, 'package.json'), JSON.stringify(manifest));
    await expect(verifyInstalledPackage(install, source)).rejects.toThrow();
    const channel = join(installed, 'node_modules/@larksuite/channel');
    await mkdir(channel, { recursive: true });
    await writeFile(join(channel, 'package.json'), JSON.stringify({ version: '0.6.0-qp.1' }));
    await expect(verifyInstalledPackage(install, source)).rejects.toThrow();
    const sdk = join(installed, 'node_modules/@larksuiteoapi/node-sdk');
    await mkdir(sdk, { recursive: true });
    await writeFile(join(sdk, 'package.json'), JSON.stringify({ version: '1.0.0', main: 'index.js' }));
    await writeFile(join(sdk, 'index.js'), 'module.exports = {};');
    await expect(verifyInstalledPackage(install, source)).resolves.toBeUndefined();
  });

  it('fails closed when an explicitly supplied private denylist is unavailable', async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, 'dist'));
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
    const result = spawnSync(process.execPath, [
      runner, '--source', root, '--patterns-file', join(root, 'missing-private.json'),
    ], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('privacy denylist input is unreadable');
    expect(result.stdout).not.toContain('private exact denylist scan skipped');
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pack-and-verify-test-'));
  temporaryRoots.push(root);
  return root;
}
