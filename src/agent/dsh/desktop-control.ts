import net, { type Socket, type Server } from 'node:net';
import { randomBytes } from 'node:crypto';
import { chmod, unlink } from 'node:fs/promises';
import type { CardActionEvent, LarkChannel } from '@larksuite/channel';
import { frameReader, removeStaleSocket, writeFrame } from '../../../dsh-desktop/ipc.js';
import { validateRouteLease, type RouteLease } from '../../runtime/route-lease';

interface Question {
  id: string;
  question: string;
  detail?: string;
  options?: { label: string }[];
  multiSelect?: boolean;
  intent?: { kind: string; approve?: string; reject?: string };
}
interface Answer { id: string; selected: string[]; custom?: string }
interface Pending {
  route: RouteLease;
  socket: Socket;
  questions: Question[];
  answers: Map<number, Answer>;
  cards: Set<string>;
  expiresAt: number;
}

export interface DesktopControl {
  handleCard(event: CardActionEvent, payload: Record<string, unknown>, form?: Record<string, unknown>): boolean;
  close(): Promise<void>;
}

function questionsOf(value: unknown): Question[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10) throw new Error('Invalid questions');
  for (const q of value) {
    if (!q || typeof q.id !== 'string' || typeof q.question !== 'string' || q.question.length > 20000 ||
      (q.options !== undefined && (!Array.isArray(q.options) || q.options.length > 30 || q.options.some((o: { label?: unknown }) => typeof o?.label !== 'string')))) {
      throw new Error('Invalid question content');
    }
  }
  return value as Question[];
}

export function desktopQuestionCard(question: Question, token: string, index: number): object {
  const value = (extra: object) => ({ __dsh_desktop_answer: true, token, index, ...extra });
  const button = (label: string, extra: object) => ({ tag: 'button', text: { tag: 'plain_text', content: label },
    type: question.intent?.reject === label ? 'danger' : 'default', behaviors: [{ type: 'callback', value: value(extra) }] });
  const elements: object[] = [{ tag: 'markdown', content: `**${question.question}**${question.detail ? '\n\n' + question.detail : ''}` }];
  if (question.multiSelect) {
    elements.push({ tag: 'form', name: 'answer_form', elements: [
      { tag: 'multi_select_static', name: 'desktop_choices', placeholder: { tag: 'plain_text', content: '选择答案' },
        options: (question.options ?? []).map(o => ({ text: { tag: 'plain_text', content: o.label }, value: o.label })) },
      { tag: 'button', name: 'submit_choices', action_type: 'form_submit', text: { tag: 'plain_text', content: '提交选择' }, value: value({ multi: true }) },
    ] });
  } else {
    for (const option of question.options ?? []) elements.push(button(option.label, { selected: option.label }));
  }
  if (!question.intent) elements.push({ tag: 'form', name: 'custom_form', elements: [
    { tag: 'input', name: 'custom_answer', placeholder: { tag: 'plain_text', content: '输入补充回答' } },
    { tag: 'button', name: 'submit_custom', action_type: 'form_submit', text: { tag: 'plain_text', content: '提交回答' }, value: value({ custom: true }) },
  ] });
  elements.push({ tag: 'markdown', content: '本机 DeepSeek Harness 桌面会话 · 此请求 10 分钟后失效。' });
  return { schema: '2.0', header: { title: { tag: 'plain_text', content: question.intent?.kind === 'approval' ? '桌面操作授权' : '桌面任务需要你的回答' }, template: 'blue' }, body: { elements } };
}

/** Bridges pending Desktop questions using the current profile's existing channel and actor ACL. */
export async function startDesktopControl(channel: Pick<LarkChannel, 'send'>, profileDir: string, socketPath: string): Promise<DesktopControl> {
  const pending = new Map<string, Pending>();
  const sockets = new Set<Socket>();
  await removeStaleSocket(socketPath);
  const server: Server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let started = false;
    frameReader(socket, request => {
      if (started) return; started = true;
      void (async () => {
        if (request.op === 'status') { writeFrame(socket, { ok: true, bridgePid: process.pid, pending: pending.size }); socket.end(); return; }
        if (typeof request.routeId !== 'string' || !/^route-[A-Za-z0-9-]+$/.test(request.routeId) || request.bridgePid !== process.pid) throw new Error('Invalid route');
        const validated = await validateRouteLease(profileDir, request.routeId, process.pid);
        if (!validated.ok) throw new Error('Desktop route is no longer active');
        const route = validated.lease;
        const options = { replyTo: route.replyTo, ...(route.threadId ? { replyInThread: true } : {}) };
        if (request.op === 'image') {
          if (typeof request.data !== 'string' || request.data.length > 20 * 1024 * 1024) throw new Error('Invalid image');
          const image = Buffer.from(request.data, 'base64');
          if (!image.length) throw new Error('Empty image');
          await channel.send(route.chatId, { image: { source: image } }, options);
          writeFrame(socket, { ok: true }); socket.end(); return;
        }
        if (request.op !== 'question') throw new Error('Invalid operation');
        const questions = questionsOf(request.questions);
        const token = randomBytes(24).toString('base64url');
        const record: Pending = { route, socket, questions, answers: new Map(), cards: new Set(), expiresAt: Date.now() + 600000 };
        pending.set(token, record);
        const timer = setTimeout(() => { pending.delete(token); writeFrame(socket, { ok: false, error: 'Desktop question expired' }); socket.end(); }, 600000);
        socket.once('close', () => { clearTimeout(timer); pending.delete(token); });
        try {
          for (let i = 0; i < questions.length; i++) {
            const sent = await channel.send(route.chatId, { card: desktopQuestionCard(questions[i]!, token, i) }, options);
            record.cards.add(sent.messageId);
          }
        } catch (error) { clearTimeout(timer); pending.delete(token); throw error; }
      })().catch(() => { writeFrame(socket, { ok: false, error: 'Desktop interaction could not be delivered' }); socket.end(); });
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await chmod(socketPath, 0o600);
  return {
    // The dispatcher must apply its existing DM/group authorization before calling this method.
    handleCard(event, payload, form) {
      if (typeof payload.token !== 'string' || typeof payload.index !== 'number') return false;
      const record = pending.get(payload.token);
      if (!record || record.expiresAt <= Date.now() || record.route.chatId !== event.chatId || !record.cards.has(event.messageId)) return false;
      const index = payload.index;
      const question = Number.isInteger(index) ? record.questions[index] : undefined;
      if (!question || record.answers.has(index)) return false;
      let answer: Answer;
      if (payload.custom === true && !question.intent) {
        if (typeof form?.custom_answer !== 'string' || !form.custom_answer.trim() || form.custom_answer.length > 10000) return false;
        answer = { id: question.id, selected: [], custom: form.custom_answer };
      } else {
        const selected = payload.multi === true && question.multiSelect ? form?.desktop_choices : [payload.selected];
        if (!Array.isArray(selected) || selected.length === 0 || selected.some(s => typeof s !== 'string' || !question.options?.some(o => o.label === s))) return false;
        answer = { id: question.id, selected: [...new Set(selected)] as string[] };
      }
      record.answers.set(index, answer);
      if (record.answers.size === record.questions.length) {
        pending.delete(payload.token);
        writeFrame(record.socket, { ok: true, answer: { answers: record.questions.map((_, i) => record.answers.get(i)) } });
        record.socket.end();
      }
      return true;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await unlink(socketPath).catch(() => {});
    },
  };
}
