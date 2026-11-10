import { describe, expect, it } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { ProcessPool } from '../../../src/bot/process-pool';
import type { RunPolicyAllow } from '../../../src/policy/run-policy';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { FakeAgentAdapter } from '../../helpers/fake-agent';

describe('RunExecutor policy runtime options', () => {
  it('passes policy sandbox and permission mode into each agent run', async () => {
    const agent = new FakeAgentAdapter({
      events: [{ type: 'done', terminationReason: 'normal' }],
    });
    const executor = new RunExecutor({
      agent,
      pool: new ProcessPool(() => 1),
      activeRuns: new ActiveRuns(),
      createRunId: () => 'run-policy',
      now: () => 1000,
      postDoneExitGraceMs: 10,
    });

    const execution = await executor.submit({
      scopeId: 'scope-policy',
      reasoningEffort: 'high',
      serviceTier: 'fast',
      policy: policy({
        sandbox: 'workspace-write',
        permissionMode: 'acceptEdits',
      }),
    });

    expect(agent.runOptions[0]).toMatchObject({
      runId: 'run-policy',
      reasoningEffort: 'high',
      serviceTier: 'fast',
      sandbox: 'workspace-write',
      permissionMode: 'acceptEdits',
    });

    await collect(execution.subscribe());
  });

  it('passes an optional system prompt addendum without altering the user prompt', async () => {
    const agent = new FakeAgentAdapter({
      events: [{ type: 'done', terminationReason: 'normal' }],
    });
    const executor = new RunExecutor({
      agent,
      pool: new ProcessPool(() => 1),
      activeRuns: new ActiveRuns(),
      createRunId: () => 'run-prompt',
      now: () => 1000,
      postDoneExitGraceMs: 10,
    });

    const execution = await executor.submit({
      scopeId: 'scope-prompt',
      policy: policy({ prompt: 'dynamic turn' }),
      systemPromptAddendum: 'group contract',
    });

    expect(agent.runOptions[0]).toMatchObject({
      prompt: 'dynamic turn',
      systemPromptAddendum: 'group contract',
    });

    await collect(execution.subscribe());
  });
});

describe('RunExecutor completion reminder judge', () => {
  it('runs an isolated read-only classifier without a prior session', async () => {
    const agent = new FakeAgentAdapter({
      events: [
        { type: 'text', delta: '{"notify":true}' },
        { type: 'done', terminationReason: 'normal' },
      ],
    });
    const executor = new RunExecutor({
      agent,
      pool: new ProcessPool(() => 1),
      activeRuns: new ActiveRuns(),
    });

    await expect(executor.evaluateCompletionReminder({
      question: 'Implement the requested change',
      answer: 'The requested change is complete.',
      model: 'configured-model',
    })).resolves.toBe(true);

    expect(agent.runOptions[0]).toMatchObject({
      purpose: 'completion-judge',
      model: 'configured-model',
      reasoningEffort: 'low',
      sandbox: 'read-only',
    });
    expect(agent.runOptions[0]).not.toHaveProperty('sessionId');
    expect(agent.runOptions[0]).not.toHaveProperty('threadId');
    expect(agent.runOptions[0]?.prompt).toContain('Implement the requested change');
    expect(agent.runOptions[0]?.prompt).toContain('The requested change is complete.');
    expect(agent.runOptions[0]?.cwd).not.toBe('/tmp/repo');
  });

  it('fails closed when the judge calls a tool or returns non-JSON output', async () => {
    for (const events of [
      [
        { type: 'tool_use' as const, id: 'tool-1', name: 'command_execution', input: {} },
        { type: 'text' as const, delta: '{"notify":true}' },
        { type: 'done' as const, terminationReason: 'normal' as const },
      ],
      [
        { type: 'text' as const, delta: 'yes, notify them' },
        { type: 'done' as const, terminationReason: 'normal' as const },
      ],
    ]) {
      const agent = new FakeAgentAdapter({ events });
      const executor = new RunExecutor({
        agent,
        pool: new ProcessPool(() => 1),
        activeRuns: new ActiveRuns(),
      });
      await expect(executor.evaluateCompletionReminder({
        question: 'Question',
        answer: 'Answer',
      })).resolves.toBe(false);
    }
  });

  it('skips the judge for DSH because the backend cannot enforce a no-tools run', async () => {
    const agent = new FakeAgentAdapter({
      id: 'dsh',
      events: [
        { type: 'text', delta: '{"notify":true}' },
        { type: 'done', terminationReason: 'normal' },
      ],
    });
    const executor = new RunExecutor({
      agent,
      pool: new ProcessPool(() => 1),
      activeRuns: new ActiveRuns(),
    });

    await expect(executor.evaluateCompletionReminder({
      question: 'Question',
      answer: 'Answer',
    })).resolves.toBe(false);
    expect(agent.runOptions).toHaveLength(0);
  });
});

function policy(overrides: Partial<RunPolicyAllow> = {}): RunPolicyAllow {
  return {
    ok: true,
    prompt: 'hello',
    requestedCwd: '/tmp/repo',
    cwdRealpath: '/tmp/repo',
    accessMode: 'workspace',
    sandbox: 'workspace-write',
    permissionMode: 'acceptEdits',
    access: { ok: true, reason: 'allowed-user' },
    attachments: [],
    policyFingerprint: 'fp',
    expiresAt: 2000,
    ...overrides,
  };
}

async function collect(events: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const event of events) out.push(event);
  return out;
}
