import { describe, expect, it } from 'vitest';
import { renderCard } from '../../../src/card/run-renderer';
import { renderText } from '../../../src/card/text-renderer';
import { initialState, reduce, type RunState } from '../../../src/card/run-state';

function running(): RunState {
  let s = reduce(initialState, { type: 'text', delta: '开始检查（保留 echo command）' });
  s = reduce(s, { type: 'thinking', delta: '检查思路' });
  s = reduce(s, { type: 'tool_use', id: 'old', name: 'Bash', input: { command: 'old-command' } });
  s = reduce(s, { type: 'tool_result', id: 'old', output: 'SECRET-OUTPUT', isError: false });
  return reduce(s, { type: 'tool_use', id: 'new', name: 'command_execution', input: { command: 'current-command' } });
}

describe('tool display projections', () => {
  const renderers = {
    card: (s: RunState, mode: 'full' | 'live-only' | 'hidden') => JSON.stringify(renderCard(s, { toolDisplayMode: mode })),
    text: (s: RunState, mode: 'full' | 'live-only' | 'hidden') => renderText(s, { toolDisplayMode: mode }),
  };
  for (const [kind, render] of Object.entries(renderers)) {
    it(`${kind}: shows only the active command, then clears it before the turn ends`, () => {
      const s = running();
      const live = render(s, 'live-only');
      expect(live).toContain('current-command');
      expect(live).toContain('开始检查');
      expect(live).not.toContain('old-command');
      expect(live).not.toContain('SECRET-OUTPUT');
      const completed = reduce(s, { type: 'tool_result', id: 'new', output: 'MORE-SECRET', isError: true });
      const after = render(completed, 'live-only');
      expect(after).not.toContain('current-command');
      expect(after).not.toContain('MORE-SECRET');
      expect(render(s, 'hidden')).not.toContain('current-command');
      expect(render(s, 'hidden')).not.toContain('正在调用工具');
      expect(render(s, 'full')).toContain('old-command');
      expect(s.blocks.some((b) => b.kind === 'tool' && b.tool.output === 'SECRET-OUTPUT')).toBe(true);
    });

    it(`${kind}: handles parallel tools, unknown results and bounded escaped commands`, () => {
      const s = reduce(running(), { type: 'tool_use', id: 'parallel', name: 'Bash', input: { command: 'long\n`[*<cmd>] '.repeat(100) } });
      const out = render(s, 'live-only');
      expect(out).toContain('另有 1 项运行中');
      expect(out).not.toContain('current-command');
      expect(out.length).toBeLessThan(2000);
      const unknown = reduce(s, { type: 'tool_result', id: 'unknown', output: 'UNMATCHED', isError: false });
      expect(render(unknown, 'live-only')).toBe(out);
      const latestDone = reduce(s, { type: 'tool_result', id: 'parallel', output: '', isError: false });
      expect(render(latestDone, 'live-only')).toContain('current-command');
    });

    it.each(['done', 'error', 'interrupted', 'idle_timeout'] as const)(`${kind}: terminal %s removes unfinished tools`, (terminal) => {
      const s = { ...running(), terminal, errorMsg: 'agent failed', idleTimeoutMinutes: 2 };
      const out = render(s, 'live-only');
      expect(out).toContain('开始检查');
      expect(out).not.toContain('current-command');
      expect(out).not.toContain('SECRET-OUTPUT');
      if (terminal === 'error') expect(out).toContain('agent failed');
      if (terminal === 'interrupted') expect(out).toContain('已被中断');
      if (terminal === 'idle_timeout') expect(out).toContain('已自动终止');
    });

    it(`${kind}: tool-only completion has a visible empty-answer marker`, () => {
      const s = { ...running(), blocks: running().blocks.filter((b) => b.kind === 'tool'), reasoning: { content: '', active: false }, terminal: 'done' as const };
      expect(render(s, 'live-only')).toContain('未返回内容');
    });
  }
});
