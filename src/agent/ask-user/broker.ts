import net, { type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, rmdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CardActionEvent, LarkChannel } from '@larksuite/channel';
import { removeStaleSocket } from '../../../dsh-desktop/ipc.js';
import { validateRouteLease } from '../../runtime/route-lease';
import { log } from '../../core/logger';
import { ASK_USER_TIMEOUT_MS, parseQuestions, recommendedOptions, type AskUserResult, type UserAnswer, type UserQuestion } from './schema';
import { askUserSocketPath, readFrames, writeFrame } from './transport';

interface Binding { actorId: string; isActive(): boolean }
interface Pending {
  routeId: string;
  binding: Binding;
  chatId: string;
  socket: Socket;
  questions: UserQuestion[];
  answers: Map<number, UserAnswer>;
  cards: Map<string, number>;
  timer: NodeJS.Timeout;
  expiresAt: number;
  settling: boolean;
}

export interface AskUserBroker {
  bindRoute(routeId: string, binding: Binding): void;
  cancelRoute(routeId: string): void;
  handleCard(event: CardActionEvent, payload: Record<string, unknown>, form?: Record<string, unknown>): Promise<boolean>;
  close(): Promise<void>;
}

export function questionCard(q: UserQuestion, token: string, index: number, status?: string): object {
  const value = (extra: object) => ({ __ask_user_answer: true, token, index, ...extra });
  const recommendations = recommendedOptions(q);
  const optionLabel = (o: NonNullable<UserQuestion['options']>[number]) => o.recommended === true ? `${o.label}（推荐）` : o.label;
  const elements: object[] = [{ tag: 'markdown', content: `**${q.question}**` }];
  if (status) elements.push({ tag: 'markdown', content: status });
  else {
    for (const o of q.options ?? []) if (o.description) elements.push({ tag: 'markdown', content: `**${o.label}** — ${o.description}` });
    if (!q.multiSelect) {
      for (const [i, o] of (q.options ?? []).entries()) elements.push({ tag: 'button', text: { tag: 'plain_text', content: optionLabel(o) },
        type: 'default', behaviors: [{ type: 'callback', value: value({ selected: String(i) }) }] });
    }
    const form: object[] = [];
    if (q.multiSelect) form.push({ tag: 'multi_select_static', name: 'choices', placeholder: { tag: 'plain_text', content: '选择一个或多个选项' },
      options: q.options!.map((o, i) => ({ text: { tag: 'plain_text', content: optionLabel(o) }, value: String(i) })) });
    form.push({ tag: 'input', name: 'answer', placeholder: { tag: 'plain_text', content: q.options ? '其他答案或补充说明' : '输入你的回答' } });
    form.push({ tag: 'button', name: 'submit', action_type: 'form_submit', text: { tag: 'plain_text', content: '提交回答' }, value: value({ form: true }) });
    elements.push({ tag: 'form', name: 'ask_user_form', elements: form });
    elements.push({ tag: 'button', text: { tag: 'plain_text', content: '取消本次提问' }, type: 'danger', behaviors: [{ type: 'callback', value: value({ cancel: true }) }] });
    elements.push({ tag: 'markdown', content: recommendations.length
      ? `等待本轮提问人回答 · 10 分钟内有效 · 超时将自动选择推荐项：${recommendations.map(o => o.label).join('、')}，并继续任务。`
      : '等待本轮提问人回答 · 10 分钟内有效 · 此题无明确推荐项，超时不会编造答案。' });
  }
  return { schema: '2.0', header: { title: { tag: 'plain_text', content: status ? '问题已结束' : '需要你的选择' }, template: status ? 'grey' : 'blue' }, body: { elements } };
}

/** A private per-profile broker. Only Bridge binds recipients; the tool supplies questions only. */
export async function startAskUserBroker(
  channel: Pick<LarkChannel, 'send' | 'updateCard'>,
  profileDir: string,
  options: { timeoutMs?: number } = {},
): Promise<AskUserBroker> {
  const bindings = new Map<string, Binding>();
  const pending = new Map<string, Pending>();
  const sockets = new Set<Socket>();
  const path = askUserSocketPath(profileDir);
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const dirStat = await lstat(dirname(path));
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || dirStat.uid !== process.getuid?.()) throw new Error('ask_user socket directory is not private');
    await chmod(dirname(path), 0o700);
    await removeStaleSocket(path);
  }
  const timeoutMs = options.timeoutMs ?? ASK_USER_TIMEOUT_MS;
  const valid = async (routeId: string, binding: Binding) => {
    if (bindings.get(routeId) !== binding || !binding.isActive()) return undefined;
    const checked = await validateRouteLease(profileDir, routeId, process.pid);
    return checked.ok && Number.isFinite(Date.parse(checked.lease.expiresAt)) ? checked.lease : undefined;
  };
  const update = async (record: Pending, messageId: string, index: number, status: string): Promise<void> => {
    try { await channel.updateCard(messageId, questionCard(record.questions[index]!, '', index, status)); }
    catch { log.warn('ask-user', 'card-update-failed', { index }); }
  };
  const finish = (token: string, record: Pending, result: AskUserResult): void => {
    if (record.settling) return;
    record.settling = true; pending.delete(token); clearTimeout(record.timer);
    writeFrame(record.socket, result); record.socket.end();
    const label = result.status === 'answered' ? '已回答，当前任务将继续。' : result.status === 'expired' ? '等待超时，未取得决定。' : '本次提问已取消，未取得决定。';
    for (const [id, index] of record.cards) {
      const answer = result.status === 'answered' ? result.answers[index] : undefined;
      void update(record, id, index, answer?.source === 'timeout_recommendation'
        ? `超时，已按推荐项自动选择：${answer.selected.join('、')}，当前任务将继续。` : label);
    }
    log.info('ask-user', 'resolved', { status: result.status, questions: record.questions.length,
      ...(result.status === 'answered' ? { automaticAnswers: result.answers.filter(a => a.source === 'timeout_recommendation').length } : {}) });
  };
  const onTimeout = async (token: string, record: Pending): Promise<void> => {
    if (record.settling) return;
    const route = await valid(record.routeId, record.binding);
    if (record.settling) return;
    if (!route || !record.binding.isActive() || bindings.get(record.routeId) !== record.binding) {
      finish(token, record, { status: 'cancelled', reason: 'The originating run ended or its route expired' });
      return;
    }
    if (record.cards.size !== record.questions.length) {
      finish(token, record, { status: 'unavailable', reason: 'Not all question cards were delivered' });
      return;
    }
    const answers: UserAnswer[] = [];
    for (const [index, question] of record.questions.entries()) {
      const answered = record.answers.get(index);
      if (answered) { answers.push(answered); continue; }
      const choices = recommendedOptions(question);
      if (!choices.length) {
        finish(token, record, { status: 'expired', reason: 'An unanswered question has no unambiguous recommended option' });
        return;
      }
      answers.push({ id: question.id, selected: choices.map(o => o.label), source: 'timeout_recommendation' });
    }
    finish(token, record, { status: 'answered', answers });
  };
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    let started = false;
    readFrames(socket, request => {
      if (started) return; started = true;
      void (async () => {
        if (request.bridgePid !== process.pid || typeof request.routeId !== 'string' || !/^route-[A-Za-z0-9-]+$/.test(request.routeId)) throw new Error();
        const routeId = request.routeId;
        const binding = bindings.get(routeId);
        const route = binding && await valid(routeId, binding);
        if (!binding || !route || [...pending.values()].some(p => p.routeId === routeId)) throw new Error();
        const questions = parseQuestions({ questions: request.questions });
        if (socket.destroyed) return;
        const token = randomBytes(24).toString('base64url');
        const record: Pending = { routeId, binding, chatId: route.chatId, socket, questions, answers: new Map(), cards: new Map(),
          expiresAt: Date.now() + timeoutMs, settling: false,
          timer: setTimeout(() => { void onTimeout(token, record).catch(() => finish(token, record,
            { status: 'unavailable', reason: 'Could not verify the originating run at the question deadline' })); }, timeoutMs) };
        pending.set(token, record);
        socket.once('close', () => finish(token, record, { status: 'cancelled', reason: 'Question tool disconnected' }));
        try {
          for (const [index, q] of questions.entries()) {
            if (record.settling || !await valid(routeId, binding)) throw new Error();
            const sent = await channel.send(route.chatId, { card: questionCard(q, token, index) }, { replyTo: route.replyTo, ...(route.threadId ? { replyInThread: true } : {}) });
            record.cards.set(sent.messageId, index);
            if (record.settling) void update(record, sent.messageId, index, '本次提问已结束。');
          }
          log.info('ask-user', 'waiting', { questions: questions.length });
        } catch { finish(token, record, { status: 'unavailable', reason: 'Question delivery failed or run ended' }); }
      })().catch(() => { writeFrame(socket, { status: 'unavailable', reason: 'No verified live human question context' }); socket.end(); });
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  if (process.platform !== 'win32') await chmod(path, 0o600);
  return {
    bindRoute(routeId, binding) { bindings.set(routeId, binding); },
    cancelRoute(routeId) {
      bindings.delete(routeId);
      for (const [token, record] of pending) if (record.routeId === routeId) finish(token, record, { status: 'cancelled', reason: 'The originating run ended or stopped' });
    },
    async handleCard(event, payload, form) {
      if (typeof payload.token !== 'string' || !Number.isInteger(payload.index)) return false;
      const record = pending.get(payload.token);
      const index = payload.index as number;
      if (!record || record.settling || record.expiresAt <= Date.now() || record.chatId !== event.chatId ||
          record.binding.actorId !== event.operator.openId || record.cards.get(event.messageId) !== index || record.answers.has(index)) return false;
      if (!await valid(record.routeId, record.binding) || record.settling || record.answers.has(index)) return false;
      if (payload.cancel === true) { finish(payload.token, record, { status: 'cancelled', reason: 'The requester cancelled the question' }); return true; }
      const q = record.questions[index]!;
      let selected: unknown[] = [];
      let answer: string | undefined;
      if (payload.form === true) {
        if (form?.answer !== undefined && typeof form.answer !== 'string') return false;
        answer = (form?.answer as string | undefined)?.trim();
        if (answer && answer.length > 4000) return false;
        if (q.multiSelect && form?.choices !== undefined) {
          if (!Array.isArray(form.choices)) return false;
          selected = form.choices;
        }
      } else if (typeof payload.selected === 'string' && !q.multiSelect) selected = [payload.selected];
      else return false;
      if ((!answer && selected.length === 0) || selected.some(v => typeof v !== 'string' || !/^\d$/.test(v) || !q.options?.[Number(v)])) return false;
      const result: UserAnswer = { id: q.id, selected: [...new Set(selected.map(v => q.options![Number(v)]!.label))], ...(answer ? { text: answer } : {}) };
      record.answers.set(index, result);
      if (record.answers.size === record.questions.length) finish(payload.token, record, { status: 'answered', answers: record.questions.map((_, i) => record.answers.get(i)!) });
      else void update(record, event.messageId, index, '已记录，等待其他问题的回答。');
      return true;
    },
    async close() {
      bindings.clear();
      for (const [token, record] of pending) finish(token, record, { status: 'cancelled', reason: 'Bridge is disconnecting' });
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (process.platform !== 'win32') await unlink(path).catch(() => {});
      if (process.platform !== 'win32' && dirname(path) !== profileDir) await rmdir(dirname(path)).catch(() => {});
    },
  };
}
