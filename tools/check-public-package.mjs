#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadPrivacyPatterns,
  PRIVACY_PATTERN_ENV,
  scanPackageEntries,
  scanPrivacyTarget,
} from './privacy-denylist-lib.mjs';

// Public heuristics deliberately do not substitute for an operator's exact denylist.
const SECRET_RULES = [
  ['private-key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{60,255})\b/],
  ['npm-token', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{24,}\b/],
  ['api-key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/],
  ['literal-app-secret', /["']?(?:app_secret|appSecret)["']?\s*[:=]\s*["'][A-Za-z0-9_-]{24,}["']/],
  ['npm-auth-token', /(?:_authToken|_auth)\s*=\s*(?!\$\{)[A-Za-z0-9_+\/-]{24,}/],
];
const PRIVATE_PATH = /(?:^|\/)(?:\.lark-channel|\.codex|\.dsh|\.ssh)(?:\/|$)|(?:^|\/)(?:\.credentials(?:\.[^/]*)?|secrets\.enc|\.keystore\.salt|id_rsa|id_ed25519|config\.(?:local|private)\.json)$/i;

export async function scanPublicPackage({ mode, root, tarball }) {
  return scanPackageEntries({ mode, root, tarball, scanEntry(content, path) {
    const findings = [];
    const normalized = path.replaceAll('\\', '/').replace(/^tarball:/, '');
    const basename = normalized.split('/').at(-1);
    if (PRIVATE_PATH.test(normalized) ||
        (/^\.env(?:\.|$)/i.test(basename) && !/^\.env\.(?:example|sample|template)$/i.test(basename))) {
      findings.push({ path, label: 'local-configuration' });
    }
    const text = content.toString('utf8');
    for (const [label, pattern] of SECRET_RULES) {
      if (pattern.test(text)) findings.push({ path, label });
    }
    return findings;
  } });
}

export async function checkPublicPackage(options) {
  const findings = await scanPublicPackage(options);
  assertClean('public package', options.mode, findings);
  console.log(`public package ${options.mode} scan passed: 0 findings`);
  if (!options.withPrivate) return;
  const patternFile = options.patternFile ?? process.env[PRIVACY_PATTERN_ENV];
  if (!patternFile) {
    console.log('private exact denylist scan skipped: no protected patterns configured');
    return;
  }
  const patterns = await loadPrivacyPatterns(patternFile);
  assertClean('private exact denylist', options.mode, await scanPrivacyTarget({ ...options, patterns }));
  console.log(`private exact denylist ${options.mode} scan passed: ${patterns.length} protected patterns, 0 findings`);
}

function assertClean(gate, mode, findings) {
  if (!findings.length) return;
  // Never print matched secret bytes.
  throw new Error(`${gate} ${mode} scan found ${findings.length} finding(s); first: ${findings[0].path} (${findings[0].label})`);
}

function parseArgs(argv) {
  const modes = argv.filter((arg) => ['--tree', '--dist', '--tarball'].includes(arg));
  if (modes.length !== 1) throw new Error('choose exactly one mode: --tree, --dist, or --tarball <path>');
  const value = (flag) => {
    const index = argv.indexOf(flag);
    if (index === -1) return undefined;
    if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`${flag} requires a value`);
    return argv[index + 1];
  };
  return {
    mode: modes[0].slice(2),
    root: value('--root') ?? process.cwd(),
    tarball: value('--tarball'),
    patternFile: value('--patterns-file'),
    withPrivate: argv.includes('--with-private') || argv.includes('--patterns-file'),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    await checkPublicPackage(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`package scan failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
