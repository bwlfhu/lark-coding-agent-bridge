#!/usr/bin/env node

import { execFile } from 'node:child_process';
import {
  copyFile,
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PRIVACY_PATTERN_ENV } from './privacy-denylist-lib.mjs';
import { checkPublicPackage } from './check-public-package.mjs';

const execFileAsync = promisify(execFile);

export async function packAndVerify({
  source = process.cwd(),
  output,
  patternFile,
} = {}) {
  const sourceRoot = resolve(source);
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'bridge-package-verify-'));
  try {
    const requestedInput = patternFile ?? process.env[PRIVACY_PATTERN_ENV];
    const protectedInput = requestedInput ? resolve(requestedInput) : undefined;
    const releaseSource = join(temporaryRoot, 'source');
    await copyReleaseSource(sourceRoot, releaseSource);

    const scan = (mode, tarball) => checkPublicPackage({
      mode, root: releaseSource, tarball, patternFile: protectedInput, withPrivate: true,
    });
    await scan('tree');
    await scan('dist');

    const manifest = JSON.parse(await readFile(join(releaseSource, 'package.json'), 'utf8'));
    const hasLock = await access(join(releaseSource, 'package-lock.json')).then(() => true, () => false);
    if (!hasLock && manifest.dependencies?.['@larksuite/channel']) {
      throw new Error('package-lock.json is required for the npm release layout; generate and commit it before packaging');
    }

    await runNpm([
      ...(hasLock ? ['ci'] : ['install', '--package-lock=false']),
      '--install-links=true',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ], releaseSource, protectedInput);

    const packDirectory = join(temporaryRoot, 'pack');
    await mkdir(packDirectory, { recursive: true });
    const { stdout } = await runNpm(
      ['pack', '--silent', '--pack-destination', packDirectory],
      releaseSource,
      protectedInput,
    );
    const packedName = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    if (!packedName?.endsWith('.tgz')) {
      throw new Error('npm pack did not return a tarball name');
    }
    const tarball = join(packDirectory, packedName);
    await scan('tarball', tarball);

    const verifyDirectory = join(temporaryRoot, 'install');
    await mkdir(verifyDirectory, { recursive: true });
    await runNpm([
      'install',
      '--prefix',
      verifyDirectory,
      '--install-links=true',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      tarball,
    ], verifyDirectory, protectedInput);
    await verifyInstalledPackage(verifyDirectory, releaseSource);

    if (output) {
      const destination = resolve(output);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(tarball, destination);
      console.log(`verified package artifact written: ${destination}`);
      return destination;
    }

    console.log('package verification passed: one tarball scanned and clean-installed');
    return undefined;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function copyReleaseSource(sourceRoot, destination) {
  const tracked = await gitTrackedFiles(sourceRoot);
  if (!tracked) {
    await cp(sourceRoot, destination, {
      recursive: true,
      filter: (source) => {
        const name = source.slice(sourceRoot.length).split(/[\\/]/).filter(Boolean)[0];
        return !name || !new Set(['.git', 'node_modules']).has(name);
      },
    });
    return;
  }

  await mkdir(destination, { recursive: true });
  for (const path of tracked) {
    const source = join(sourceRoot, path);
    const target = join(destination, path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }
  await cp(join(sourceRoot, 'dist'), join(destination, 'dist'), { recursive: true });
}

async function gitTrackedFiles(root) {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', root, 'ls-files', '-z'],
      { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout.toString('utf8').split('\0').filter(Boolean);
  } catch {
    return undefined;
  }
}

function runNpm(args, cwd, patternFile) {
  // pnpm lifecycle commands export config into the environment. npm 11 rejects
  // allow-scripts for project installs; retain registry, auth, and proxy config.
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^npm_config_(?:allow[_-]scripts|verify[_-]deps[_-]before[_-]run)$/i.test(key)) {
      delete env[key];
    }
  }
  return execFileAsync('npm', args, {
    cwd,
    env: {
      ...env,
      [PRIVACY_PATTERN_ENV]: patternFile,
    },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
}

export async function verifyInstalledPackage(verifyDirectory, sourceRoot) {
  const expected = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'));
  const installedRoot = join(verifyDirectory, 'node_modules', ...expected.name.split('/'));
  const installed = JSON.parse(await readFile(join(installedRoot, 'package.json'), 'utf8'));
  if (installed.version !== expected.version) {
    throw new Error(`installed package version mismatch for ${expected.name}`);
  }

  const binPath = typeof expected.bin === 'string'
    ? expected.bin
    : expected.bin?.[Object.keys(expected.bin ?? {})[0]];
  if (binPath) {
    const { stdout } = await execFileAsync(
      process.execPath,
      [join(installedRoot, binPath), '--version'],
      { encoding: 'utf8' },
    );
    if (stdout.trim() !== expected.version) {
      throw new Error(`installed CLI version mismatch for ${expected.name}`);
    }
  }

  if (!expected.dependencies?.['@larksuite/channel']) return;
  const bundled = installed.bundleDependencies ?? installed.bundledDependencies ?? [];
  if (!bundled.includes('@larksuite/channel')) {
    throw new Error('packed bridge does not declare the bundled Channel dependency');
  }
  const channelPackage = JSON.parse(
    await readFile(join(installedRoot, 'node_modules/@larksuite/channel/package.json'), 'utf8'),
  );
  if (!channelPackage.version) {
    throw new Error('packed bridge is missing the bundled Channel dependency');
  }
  const sdkPackage = JSON.parse(await readFile(
    join(installedRoot, 'node_modules/@larksuiteoapi/node-sdk/package.json'), 'utf8',
  ).catch(() => {
    throw new Error('packed bridge is missing the Channel SDK dependency');
  }));
  if (!sdkPackage.version) throw new Error('packed Channel SDK has no package version');
  createRequire(join(installedRoot, 'node_modules/@larksuite/channel/package.json'))
    .resolve('@larksuiteoapi/node-sdk');
}

function parseArgs(argv) {
  return {
    source: optionValue(argv, '--source') ?? process.cwd(),
    output: optionValue(argv, '--output'),
    patternFile: optionValue(argv, '--patterns-file'),
  };
}

function optionValue(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    await packAndVerify(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(
      `package verification failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
