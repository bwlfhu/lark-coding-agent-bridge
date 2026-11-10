import { describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import {
  buildCompletionReminderJudgePrompt,
  parseCompletionReminderDecision,
} from '../../../src/agent/completion-judge';
import {
  completionReminderRecipient,
  completionReminderSendOptions,
  COMPLETION_REMINDER_THRESHOLD_MS,
  maybeSendCompletionReminder,
  shouldJudgeCompletionReminder,
} from '../../../src/bot/completion-reminder';

describe('completion reminder candidate', () => {
  const isHumanSender = (candidate: NormalizedMessage) => candidate.senderType === 'user';

  it('targets the original human after an explicit group @ of this bot', () => {
    expect(completionReminderRecipient([message()], {
      isGroup: true,
      isReaction: false,
      isDirectCorrection: false,
      isHumanSender,
    })).toEqual({ openId: 'ou_requester', name: 'Requester' });
  });

  it.each([
    ['direct chat', { isGroup: false, isReaction: false, isDirectCorrection: false }],
    ['reaction run', { isGroup: true, isReaction: true, isDirectCorrection: false }],
    ['direct correction', { isGroup: true, isReaction: false, isDirectCorrection: true }],
  ])('skips %s', (_label, overrides) => {
    expect(completionReminderRecipient([message()], {
      ...overrides,
      isHumanSender,
    })).toBeUndefined();
  });

  it('skips bot messages, messages without a bot mention, and mixed-sender batches', () => {
    const options = {
      isGroup: true,
      isReaction: false,
      isDirectCorrection: false,
      isHumanSender,
    };
    expect(completionReminderRecipient([message({ senderType: 'bot' })], options)).toBeUndefined();
    expect(completionReminderRecipient([message({ mentionedBot: false })], options)).toBeUndefined();
    expect(completionReminderRecipient([
      message(),
      message({ messageId: 'om_other', senderId: 'ou_other' }),
    ], options)).toBeUndefined();
    expect(completionReminderRecipient([
      message(),
      message({ messageId: 'om_bot', senderType: 'bot' }),
    ], options)).toBeUndefined();
  });

  it('requires a valid open id', () => {
    expect(completionReminderRecipient([message({ senderId: 'not-an-open-id' })], {
      isGroup: true,
      isReaction: false,
      isDirectCorrection: false,
      isHumanSender,
    })).toBeUndefined();
  });
});

describe('completion reminder judge contract', () => {
  it('uses a 30 second initial threshold', () => {
    expect(COMPLETION_REMINDER_THRESHOLD_MS).toBe(30_000);
  });

  it('judges only successful, visible results at or beyond the threshold', () => {
    const input = {
      hasRecipient: true,
      elapsedMs: COMPLETION_REMINDER_THRESHOLD_MS,
      terminal: 'done',
      question: 'question',
      answer: 'answer',
    };
    expect(shouldJudgeCompletionReminder(input)).toBe(true);
    expect(shouldJudgeCompletionReminder({ ...input, elapsedMs: COMPLETION_REMINDER_THRESHOLD_MS - 1 })).toBe(false);
    expect(shouldJudgeCompletionReminder({ ...input, terminal: 'error' })).toBe(false);
    expect(shouldJudgeCompletionReminder({ ...input, hasRecipient: false })).toBe(false);
    expect(shouldJudgeCompletionReminder({ ...input, answer: ' ' })).toBe(false);
  });

  it('accepts only a single boolean notify field', () => {
    expect(parseCompletionReminderDecision('{"notify":true}')).toBe(true);
    expect(parseCompletionReminderDecision('{"notify":false}')).toBe(false);
    expect(parseCompletionReminderDecision('decision: {"notify":true}')).toBe(false);
    expect(parseCompletionReminderDecision('{"notify":true,"reason":"long"}')).toBe(false);
    expect(parseCompletionReminderDecision('{"notify":"true"}')).toBe(false);
  });

  it('bounds the input included in a judge prompt', () => {
    const prompt = JSON.parse(buildCompletionReminderJudgePrompt('q'.repeat(5000), 'answer')) as {
      question: string;
      final_answer: string;
    };
    expect(prompt.question.length).toBeLessThan(5000);
    expect(prompt.final_answer).toBe('answer');
  });

  it('builds a native mention while preserving topic reply routing', () => {
    expect(completionReminderSendOptions(
      { openId: 'ou_requester', name: 'Requester' },
      'om_input',
      true,
    )).toEqual({
      replyTo: 'om_input',
      replyInThread: true,
      mentions: [{
        key: 'completion-reminder-requester',
        openId: 'ou_requester',
        name: 'Requester',
        isBot: false,
      }],
    });
  });

  it('sends only after a positive judge decision and keeps send errors isolated', async () => {
    const send = vi.fn(async () => {});
    const judge = vi.fn(async () => true);
    await expect(maybeSendCompletionReminder({
      recipient: { openId: 'ou_requester', name: 'Requester' },
      elapsedMs: COMPLETION_REMINDER_THRESHOLD_MS,
      terminal: 'done',
      question: 'Please do the work',
      answer: 'The work is done.',
      replyTo: 'om_input',
      replyInThread: true,
      judge,
      send,
    })).resolves.toBe(true);
    expect(judge).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      '任务已完成，请查看上方回复。',
      expect.objectContaining({
        replyTo: 'om_input',
        replyInThread: true,
        mentions: [expect.objectContaining({ openId: 'ou_requester' })],
      }),
    );

    const noSend = vi.fn(async () => {});
    await expect(maybeSendCompletionReminder({
      recipient: { openId: 'ou_requester' },
      elapsedMs: COMPLETION_REMINDER_THRESHOLD_MS,
      terminal: 'done',
      question: 'Please do the work',
      answer: 'The work is done.',
      replyTo: 'om_input',
      replyInThread: false,
      judge: async () => false,
      send: noSend,
    })).resolves.toBe(false);
    expect(noSend).not.toHaveBeenCalled();
  });
});

function message(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    messageId: 'om_input',
    chatId: 'oc_group',
    chatType: 'group',
    senderId: 'ou_requester',
    senderName: 'Requester',
    senderType: 'user',
    content: 'Please do the task',
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: true,
    createTime: Date.now(),
    ...overrides,
  };
}
