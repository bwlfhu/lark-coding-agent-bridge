import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ASK_USER_INPUT_SCHEMA, parseQuestions } from './schema';
import { askUserRpc } from './transport';

const server = new Server({ name: 'lark-bridge-ask-user', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
  name: 'ask_user',
  description: 'Ask the verified Feishu requester and WAIT. Input: {"questions":[{"id":"q1","question":"Your question?","options":[{"label":"A","recommended":true},{"label":"B"}]}]}. Mark your recommended choice with recommended:true (one for single choice, one or more for multi-select). After 10 minutes, unanswered choices automatically use these recommendations; status=answered with answer.source=timeout_recommendation means CONTINUE the same task using that selection. Human answers are preserved. Free text cannot be invented. cancelled/expired/unavailable are not consent. No recipient or routing IDs are accepted.',
  inputSchema: ASK_USER_INPUT_SCHEMA,
}] }));
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  try {
    if (request.params.name !== 'ask_user') throw new Error('Unknown tool');
    const questions = parseQuestions(request.params.arguments);
    const path = process.env.LARK_ASK_USER_SOCKET;
    const routeId = process.env.LARK_ASK_USER_ROUTE;
    const bridgePid = Number(process.env.LARK_ASK_USER_PID);
    if (!path || !routeId || !Number.isSafeInteger(bridgePid) || bridgePid < 1) throw new Error('No live Bridge context');
    const result = await askUserRpc(path, { routeId, bridgePid, questions }, extra.signal);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch {
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ status: 'unavailable', reason: 'ask_user could not obtain a verified answer; stop dependent work and ask again in a later turn.' }) }] };
  }
});
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void server.close().finally(() => process.exit(0)); });
await server.connect(new StdioServerTransport());
