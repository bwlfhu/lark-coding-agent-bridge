import { describe, expect, it } from 'vitest';
import { getShowToolCalls, getToolDisplayMode, type AppConfig } from '../../../src/config/schema';
import { normalizeProfileConfig } from '../../../src/config/profile-schema';

describe('tool display compatibility', () => {
  it.each([
    [{}, 'full'],
    [{ showToolCalls: true }, 'full'],
    [{ showToolCalls: false }, 'hidden'],
    [{ toolDisplayMode: 'live-only', showToolCalls: false }, 'live-only'],
    [{ toolDisplayMode: 'hidden', showToolCalls: true }, 'hidden'],
    [{ toolDisplayMode: 'invalid', showToolCalls: false }, 'hidden'],
  ])('resolves %j to %s', (preferences, expected) => {
    const cfg = { preferences } as AppConfig;
    expect(getToolDisplayMode(cfg)).toBe(expected);
    expect(getShowToolCalls(cfg)).toBe(expected !== 'hidden');
  });

  it.each(['full', 'live-only', 'hidden', 'invalid'])('normalizes %s', (mode) => {
    const cfg = normalizeProfileConfig({
      schemaVersion: 2, agentKind: 'claude',
      accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' } },
      preferences: { toolDisplayMode: mode, showToolCalls: false },
    });
    expect(cfg.preferences.toolDisplayMode).toBe(mode === 'invalid' ? undefined : mode);
    expect(cfg.preferences.showToolCalls).toBe(false);
  });
});
