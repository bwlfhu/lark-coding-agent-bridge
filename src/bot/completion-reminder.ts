import type { NormalizedMessage, SendOptions } from '@larksuite/channel';

export const COMPLETION_REMINDER_THRESHOLD_MS = 30_000;

const OPEN_ID_PATTERN = /^(?:ou_|on_)[A-Za-z0-9_-]+$/;
const MAX_QUESTION_CHARS = 4_000;
const MAX_ANSWER_CHARS = 6_000;

export interface CompletionReminderRecipient {
  openId: string;
  name?: string;
}

export function shouldJudgeCompletionReminder(input: {
  hasRecipient: boolean;
  elapsedMs: number;
  terminal: string;
  question: string;
  answer: string;
}): boolean {
  return (
    input.hasRecipient &&
    input.elapsedMs >= COMPLETION_REMINDER_THRESHOLD_MS &&
    input.terminal === 'done' &&
    input.question.trim().length > 0 &&
    input.answer.trim().length > 0
  );
}

export function completionReminderRecipient(
  batch: readonly NormalizedMessage[],
  input: {
    isGroup: boolean;
    isReaction: boolean;
    isDirectCorrection: boolean;
    isHumanSender(message: NormalizedMessage): boolean;
  },
): CompletionReminderRecipient | undefined {
  const first = batch[0];
  if (
    !first ||
    !input.isGroup ||
    input.isReaction ||
    input.isDirectCorrection ||
    !batch.some((message) => message.mentionedBot) ||
    !OPEN_ID_PATTERN.test(first.senderId) ||
    !batch.every(
      (message) =>
        message.senderId === first.senderId && input.isHumanSender(message),
    )
  ) {
    return undefined;
  }

  return {
    openId: first.senderId,
    ...(first.senderName ? { name: first.senderName } : {}),
  };
}

export function completionReminderSendOptions(
  recipient: CompletionReminderRecipient,
  replyTo: string,
  replyInThread: boolean,
) {
  return {
    replyTo,
    ...(replyInThread ? { replyInThread: true } : {}),
    mentions: [
      {
        key: 'completion-reminder-requester',
        openId: recipient.openId,
        ...(recipient.name ? { name: recipient.name } : {}),
        isBot: false,
      },
    ],
  };
}

export async function maybeSendCompletionReminder(input: {
  recipient?: CompletionReminderRecipient;
  elapsedMs: number;
  terminal: string;
  question: string;
  answer: string;
  replyTo: string;
  replyInThread: boolean;
  judge(question: string, answer: string): Promise<boolean>;
  send(
    message: string,
    options: ReturnType<typeof completionReminderSendOptions> & SendOptions,
  ): Promise<void>;
}): Promise<boolean> {
  if (!shouldJudgeCompletionReminder({
    hasRecipient: Boolean(input.recipient),
    elapsedMs: input.elapsedMs,
    terminal: input.terminal,
    question: input.question,
    answer: input.answer,
  })) return false;
  if (!input.recipient || !(await input.judge(input.question, input.answer))) return false;

  await input.send(
    '任务已完成，请查看上方回复。',
    completionReminderSendOptions(input.recipient, input.replyTo, input.replyInThread),
  );
  return true;
}

