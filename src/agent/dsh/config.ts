import type { DshProviderConfig, DshProviderModel } from './patches';

/**
 * Per-profile configuration for the DeepSeek Harness backend.
 *
 * `binaryPath` is the only required field: everything else has a working
 * default, so a profile created against a `dsh` that is not on PATH needs only
 * the resolved shim path recorded.
 */
export interface DshConfig {
  /** The `dsh` launcher: a `.cmd` shim on Windows, a shebang script elsewhere. */
  binaryPath: string;
  realpath?: string;
  version?: string;
  sha256?: string;
  owner?: number;
  mode?: number;
  /** DSH profile to boot; see {@link DSH_DEFAULT_PROFILE}. */
  profile?: string;
  /**
   * Optional provider declared by generated overlays. Omit to inherit the
   * selected DSH profile and its existing credential store.
   */
  provider?: DshProviderConfig;
  /**
   * Extra `--patch` overlays applied after the generated ones, for a profile
   * that needs further DSH tuning (tools mode, extra plugins, …).
   */
  patches?: string[];
  /** `DSH_HOME` override. When omitted DSH inherits the ambient one. */
  dshHome?: string;
}

export function normalizeDshConfig(input: unknown): DshConfig {
  const raw = (input ?? {}) as Partial<DshConfig> & { binaryPath?: unknown };
  const binaryPath = typeof raw.binaryPath === 'string' ? raw.binaryPath.trim() : '';
  if (!binaryPath) {
    throw new Error('dsh profile requires dsh.binaryPath');
  }

  const patches = Array.isArray(raw.patches)
    ? raw.patches.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
    : [];

  return {
    binaryPath,
    ...(typeof raw.realpath === 'string' ? { realpath: raw.realpath } : {}),
    ...(typeof raw.version === 'string' ? { version: raw.version } : {}),
    ...(typeof raw.sha256 === 'string' ? { sha256: raw.sha256 } : {}),
    ...(typeof raw.owner === 'number' ? { owner: raw.owner } : {}),
    ...(typeof raw.mode === 'number' ? { mode: raw.mode } : {}),
    profile: nonEmpty(raw.profile) ?? 'headless',
    ...(raw.provider ? { provider: normalizeDshProvider(raw.provider) } : {}),
    ...(patches.length ? { patches } : {}),
    ...(nonEmpty(raw.dshHome) ? { dshHome: raw.dshHome } : {}),
  };
}

function normalizeDshProvider(input: unknown): DshProviderConfig {
  const raw = (input ?? {}) as Partial<DshProviderConfig>;
  const models = normalizeDshModels(raw.models);
  const id = nonEmpty(raw.id);
  const apiKeyEnv = nonEmpty(raw.apiKeyEnv);
  const api = nonEmpty(raw.api);
  const baseURL = nonEmpty(raw.baseURL);
  const defaultModel = nonEmpty(raw.defaultModel) ?? models[0]?.id;
  if (!id || !apiKeyEnv || !api || !baseURL || !models.length) {
    throw new Error('dsh.provider requires id, apiKeyEnv, api, baseURL and models; omit provider to inherit DSH settings');
  }
  const url = new URL(baseURL);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('dsh.provider.baseURL must be an HTTP(S) endpoint without credentials, query or fragment');
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) throw new Error('invalid dsh.provider.apiKeyEnv');
  if (!models.some((model) => model.id === defaultModel)) throw new Error('dsh.provider.defaultModel must be declared in models');
  return { id, apiKeyEnv, api, baseURL, defaultModel, models };
}

function normalizeDshModels(input: unknown): DshProviderModel[] {
  if (!Array.isArray(input)) return [];
  const models: DshProviderModel[] = [];
  for (const entry of input) {
    const candidate = (entry ?? {}) as Partial<DshProviderModel>;
    const id = nonEmpty(candidate.id);
    if (!id) continue;
    const name = nonEmpty(candidate.name);
    models.push(name ? { id, name } : { id });
  }
  return models;
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
