import net from 'node:net';
import { mkdir, readFile, writeFile, rename, chmod, unlink } from 'node:fs/promises';
import { claimRequest } from './request.js';
import { join } from 'node:path';
import { frameReader, writeFrame, rpc, hostSocket, bridgeSocket, integrationDir, removeStaleSocket } from './ipc.js';

export const name = 'lark-channel-bridge-desktop';
export const inject = ['sessionController', 'agents', 'sessions', 'userQuestions', 'agentDefaultModel', 'llm', 'attachments'];

export function projectEvent(event) {
  const d = event.data;
  if (event.type === 'turn/start') return [{ type: 'status', phase: 'turn_start', turn: d.turn }];
  if (event.type === 'turn/end') return [{ type: 'status', phase: 'turn_end', turn: d.turn, reason: d.reason }];
  if (event.type === 'assistant/message') return d.message.content.flatMap(b =>
    b.type === 'text' ? [{ type: 'text', text: b.text }] : b.type === 'reasoning' ? [{ type: 'thinking', text: b.text }] : []);
  if (event.type === 'tool/call') {
    let input = d.arguments;
    try { input = JSON.parse(d.arguments || '{}'); } catch {}
    return [{ type: 'tool_call', callId: d.callId, tool: d.name, input }];
  }
  if (event.type === 'tool/result' && event.surfaceOp === 'append') return [{
    type: 'tool_result', callId: d.message.toolCallId,
    status: d.message.isError ? 'error' : 'completed',
    result: d.message.content.filter(b => b.type === 'text').map(b => b.text).join(''),
  }];
  return [];
}

export async function apply(ctx) {
  await mkdir(integrationDir, { recursive: true, mode: 0o700 });
  const statePath = join(integrationDir, 'session-map.json');
  let aliases = {};
  try { aliases = JSON.parse(await readFile(statePath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const persist = async () => {
    await writeFile(statePath + '.tmp', JSON.stringify(aliases, null, 2), { mode: 0o600 });
    await rename(statePath + '.tmp', statePath);
  };
  const active = new Map();
  const sockets = new Set();
  let tail = Promise.resolve();
  let closing = false;

  async function status() {
    let permissions;
    try { permissions = await ctx.get('cuaAccess')?.systemStatus(); } catch (e) { permissions = { error: e.message }; }
    return { ok: true, version: '0.8.3-beta.2', protocolVersion: 1, hostPid: process.pid,
      model: ctx.agentDefaultModel.currentSelection(), sessions: aliases, active: [...active.keys()],
      cua: !!ctx.get('cuaAccess'), permissions };
  }

  async function execute(request, socket, lifetime) {
    lifetime.signal.throwIfAborted();
    if (closing) throw new Error('Desktop is shutting down');
    const receipt = await claimRequest(integrationDir, request);
    if (receipt.replay) { for (const frame of receipt.replay) writeFrame(socket, frame); return; }
    let sessionId = request.sessionId && aliases[request.sessionId];
    if (!sessionId) {
      const created = await ctx.sessionController.create({ cwd: request.cwd, agentPreset: 'ptc' });
      sessionId = created.sessionId;
      aliases[sessionId] = sessionId;
      if (request.sessionId) aliases[request.sessionId] = sessionId;
      await persist();
      await ctx.sessionController.rename({ sessionId, title: '飞书 · ' + (request.botName || 'DeepSeek Harness') });
    }
    const resolved = await ctx.sessionController.resolveAgent(sessionId);
    if (resolved.error) throw resolved.error;
    const agent = resolved.agent;
    if (active.has(sessionId)) throw new Error('This desktop session already has an active task');
    await agent.whenIdle();
    lifetime.signal.throwIfAborted();
    writeFrame(socket, { type: 'session', sessionId, cwd: request.cwd, desktop: true });
    let text = '', reason, failure;
    const stopEvent = ctx.on('session/event', (session, event) => {
      if (session !== agent.session) return;
      if (event.type === 'turn/end') reason = event.data.reason;
      for (const frame of projectEvent(event)) {
        if (frame.type === 'text' && frame.text.trim()) text = frame.text;
        writeFrame(socket, frame);
      }
    });
    const stopError = ctx.on('agent/error', value => { if (value.agent === agent) failure = value.error; });
    const answer = async (questions, signal) => {
      const result = await rpc(request.controlSocketPath || bridgeSocket, { op: 'question', routeId: request.routeId,
        bridgePid: request.bridgePid, sessionId, questions }, { signal, timeoutMs: 600000 });
      return result.answer;
    };
    // Scope the answerers to this exact live Agent; other desktop sessions keep the GUI answerer.
    const stopQuestion = agent.ctx.on('user-questions/request', async (question, next) => {
      if (!request.routeId || question.agent !== agent) return next();
      return answer(question.questions, question.signal ?? lifetime.signal);
    }, { prepend: true });
    const stopApproval = agent.ctx.on('approval/request', async (approval, next) => {
      if (!request.routeId || approval.agent !== agent) return next();
      const response = await answer([{ id: 'approval', question: approval.reason || `允许执行 ${approval.toolName}？`,
        options: [{ label: '拒绝' }, { label: '允许一次' }],
        intent: { kind: 'approval', approve: '允许一次', reject: '拒绝' } }], approval.signal ?? lifetime.signal);
      return response.answers[0]?.selected.includes('允许一次') ? 'allowed-once' : 'rejected';
    }, { prepend: true });
    const cancel = () => agent.cancel();
    lifetime.signal.addEventListener('abort', cancel, { once: true });
    active.set(sessionId, { agent, requestId: request.requestId });
    try {
      lifetime.signal.throwIfAborted();
      const selection = request.model ?? ctx.agentDefaultModel.currentSelection();
      const model = await ctx.llm.resolveModelInfo(selection.provider, selection.model);
      if (!model) throw new Error('Configured model is unavailable');
      agent.model.select(selection);
      // Preserve the existing bridge full-access setting; application consent remains independent.
      const permissions = ctx.get('permissionPresets');
      if (request.permissionMode) permissions?.set(agent.session, request.permissionMode);
      const from = agent.session.seq;
      await ctx.sessionController.prompt({ sessionId, requestId: request.requestId, mode: 'queue',
        content: [{ type: 'text', text: request.prompt + `\n\n## 当前飞书 profile 的 shell 环境\n执行 Bash 时请在每条命令开头加入：source '${receipt.envPath}'\n这会设置当前 profile 的 lark-cli 配置目录及桥接路由；不要输出配置密钥。仅对当前任务使用。` }], clientTimeZone: 'Asia/Shanghai' }, lifetime.signal);
      await agent.whenIdle();
      await ctx.sessions.flush(agent.session);
      if (failure && !reason) throw failure;
      const images = [];
      for (let i = from; i < agent.session.seq; i++) {
        const e = agent.session.eventAt(i);
        if (e?.type !== 'tool/result') continue;
        for (const block of e.data.message.content) if (block.type === 'image' && block.attachment) images.push(block.attachment);
      }
      if (images.length && request.routeId) {
        for (const ref of images.slice(-3)) {
          try {
            const stored = await ctx.attachments.readImage(ref);
            await rpc(request.controlSocketPath || bridgeSocket, { op: 'image', routeId: request.routeId, bridgePid: request.bridgePid,
              sessionId, mimeType: ref.mediaType, data: Buffer.from(stored.data).toString('base64') }, { timeoutMs: 30000 });
          } catch (error) { writeFrame(socket, { type: 'thinking', text: `截图回传失败：${error.message}` }); }
        }
      }
      if (!reason) throw new Error('Desktop task ended without a terminal turn event');
      const final = { type: 'final', sessionId, reason, text };
      await receipt.complete([{ type: 'session', sessionId, cwd: request.cwd, desktop: true }, final]);
      writeFrame(socket, final);
    } finally {
      lifetime.signal.removeEventListener('abort', cancel);
      stopEvent(); stopError(); stopQuestion(); stopApproval();
      active.delete(sessionId);
    }
  }

  await removeStaleSocket(hostSocket);
  const server = net.createServer(socket => {
    sockets.add(socket);
    const lifetime = new AbortController();
    let started = false, finished = false;
    socket.on('error', () => {});
    socket.on('close', () => { sockets.delete(socket); if (!finished) lifetime.abort(new Error('Bridge disconnected')); });
    frameReader(socket, request => {
      if (request.op === 'status') { void status().then(v => writeFrame(socket, v), e => writeFrame(socket, { ok: false, error: e.message })).finally(() => socket.end()); return; }
      if (request.op === 'cancel') { lifetime.abort(new Error('User stopped task')); return; }
      if (request.op !== 'run' || started) { writeFrame(socket, { ok: false, error: 'Invalid operation' }); socket.end(); return; }
      started = true;
      if (!request.prompt?.trim() || typeof request.cwd !== 'string' || typeof request.requestId !== 'string') {
        writeFrame(socket, { type: 'error', code: 'BAD_REQUEST', message: 'Missing prompt, cwd or requestId' }); socket.end(); return;
      }
      const task = tail.catch(() => {}).then(() => execute(request, socket, lifetime));
      tail = task.catch(() => {});
      void task.catch(error => writeFrame(socket, { type: 'error', code: error.code || 'DESKTOP_ERROR', message: error.message }))
        .finally(() => { finished = true; socket.end(); });
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(hostSocket, resolve); });
  await chmod(hostSocket, 0o600);
  ctx.effect(() => async () => {
    closing = true;
    for (const { agent } of active.values()) agent.cancel();
    for (const socket of sockets) socket.destroy();
    await tail;
    await new Promise(resolve => server.close(resolve));
    await unlink(hostSocket).catch(() => {});
  });
}
