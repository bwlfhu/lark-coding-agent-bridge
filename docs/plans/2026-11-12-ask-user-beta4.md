# Codex / Claude ask_user · 0.8.3-beta.4

## Problem and contract

A prose list is not an interactive question. Add a real MCP `ask_user` tool to Codex and Claude task runs. Its result is returned to the same blocked tool call, without starting a second agent turn or guessing choices from Markdown. DSH keeps its existing Desktop interaction protocol.

## Implementation

1. Start a profile-private IPC question broker with the existing Feishu channel. Route binding is created by Bridge from the verified inbound human, original message/topic, live run handle and opaque route lease; the model cannot supply recipient IDs.
2. Inject a packaged stdio MCP server only into normal IM task runs with a route. Configure Codex's per-invocation `mcp_servers.lark_bridge` and Claude's `--mcp-config`; keep user MCP configuration and existing sessions. Completion judge and unrelated CLI invocations do not receive the tool.
3. Tool input: 1–5 questions, stable IDs, optional 2–5 labelled options with descriptions, single/multiple selection and free text. Bridge validates sizes/duplicates and renders CardKit 2.0 forms plus cancellation. No implicit answer, default acceptance or approval-policy change.
4. Keep the tool call pending for up to 10 minutes. Click bypasses the normal pending chat queue, after the normal ACL and exact requester/card/chat/route/run/expiry validation. Each question accepts one answer, the whole call resolves once. Cancel, timeout, run stop, IPC disconnect and Bridge restart return a non-answered result; cards become terminal and old buttons cannot revive work.
5. Teach both models to use this tool for material unresolved choices, wait for its result, and avoid executing dependent writes without an answered result. A missing tool falls back to asking clearly and ending the turn.
6. Translate Codex MCP start/completion events so its idle watchdog recognizes a pending tool. Existing Claude tool events already support this. Show a waiting status rather than generic output where available.

## Verification and release

- Unit/process: input validation, MCP discovery/call, options/free text/multiple questions/cancel; wrong actor/chat/card/token; stale/expired route and revoked access; concurrent double-submit; stop/disconnect; no tool injection into judges; fresh/resumed backend invocation.
- Full tests, typecheck, build, package privacy scan, one verified tarball clean installation. Recheck new MCP entry point from installed tarball.
- Real Codex and Claude models discover/call the tool, deliver real Feishu cards, receive a human choice, and continue the same session. Check real timeout/cancel and native DSH smoke. Do not replay old business tasks or deploy the PMS project.
- Publish exactly the verified `0.8.3-beta.4` tarball with npm `beta` tag (preserve `latest`), record registry integrity/version.
- Back up profile/session/service state outside the repository. Wait for active work to finish, install beta.4 in its own release directory, update the three services, check PIDs, loaded version, backend, WS ready and preserved workspaces. Keep rollback artifacts.

## Evidence anchors

Base HEAD: 8c28f89. GitNexus upstream analysis: startChannel/runAgentBatch/card dispatcher low; adapter classes high due to startup/resume/judge and interface dispatch. Avoid changing the shared RouteLease schema (critical blast radius); maintain requester binding in the broker instead.

Official contracts checked: https://developers.openai.com/codex/mcp/ (stdio MCP configuration and tool_timeout_sec); https://code.claude.com/docs/en/mcp (--mcp-config, stdio lifecycle and MCP_TOOL_TIMEOUT).
