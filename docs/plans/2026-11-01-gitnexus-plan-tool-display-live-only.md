# GitNexus Engineering Plan

> Task: Add configurable full/live-only/hidden tool display with live current-command status and no finalized tool results in live-only.
> Evidence verified at commit 6d083b52e9aacdcfaa3111a8060b5914f7f174cc; GitNexus index is pinned to the same commit and was indexed 2026-10-23 (source-weighted; no refresh needed for this compact plan).
> Evidence provenance schema 2; global dirty digest e60b9c69c2251550795b83736fc0f44b5397bfca15c85a4f209caf6df003ab7d; cited-path manifest 19 sorted entries; exact generated plan path excluded.

## Objective (§1)

[verified] Add a user-selectable tool-display mode to the bridge. In live-only, Feishu shows assistant text/reasoning plus a bounded bottom status for the currently running command; completed tool panels, arguments, and outputs disappear from the terminal user-facing message.

## Current Behaviour (§2–3)

[verified] Agent events are reduced into text, reasoning, and ToolEntry blocks; tool_result stores output in RunState (`src/card/run-state.ts:44-101`).
[verified] renderCard renders tool groups before the generic footer (`src/card/run-renderer.ts:24-67`); renderText emits every tool as a one-line summary (`src/card/text-renderer.ts:21-65`).
[verified] runAgentBatch already flushes every state transition to card/markdown streams and has a legacy boolean filter (`src/bot/channel.ts:3126-3136`, `3235-3388`).
[verified] COT publishes tool start, args, and result events; detailed mode includes tool output (`src/bot/cot.ts:261-330`).
[verified] Existing profiles default to full tool visibility when showToolCalls is absent; the current Codex profile has no explicit display preference.

## Findings (§4–5)

[graph] GitNexus impact(renderCard, upstream, depth 2) reports CRITICAL risk, 7 direct callers, 8 affected processes, and 4 modules; impact(renderText) reports HIGH risk, 3 direct callers, and 3 processes.
[graph] GitNexus impact(consumeCotEvents, upstream, depth 2) reports HIGH risk with runAgentBatch as the direct caller; impact(finalAnswerOnlyState, upstream) reports HIGH risk with one direct caller.
[verified] The renderers can derive a live tool from existing ToolEntry input/status without changing agent adapters. PDG flows show state.blocks feeds tool-group rendering while state.terminal gates footer output (`renderCard:24-55`).
[inferred] Mode filtering belongs in the rendering projection, not state mutation, so logs/diagnostics and tool timeout bookkeeping retain complete events.

## Proposed Changes (§6)

1. Add ToolDisplayMode = full | live-only | hidden and getToolDisplayMode. Explicit mode wins; legacy showToolCalls=true/false maps to full/hidden. Preserve existing default full.
2. Add a bounded running-tool summary helper. In live-only, card and markdown renderers omit tool groups and append the latest active command at the bottom; on terminal states they omit all tool content and keep assistant text/reasoning plus operational terminal markers.
3. Pass the resolved mode through runAgentBatch, sendFinalReply, stream readback verification, and fallback sends. Keep the existing processAgentStream flush cadence and stop control unchanged.
4. Update COT mapping: full remains unchanged; live-only emits a compact tool start/close lifecycle without args or result payload; hidden emits no tool events. Keep finalAnswerOnlyState as a final-answer safety boundary.
5. Replace the boolean picker in chat config and Web UI with three options, while accepting old form/API payloads. Persist the canonical mode and retain the legacy projection for older clients/config cards.
6. Update English/Chinese display documentation and add the current Codex profile rollout instruction without editing live credentials or restarting the daemon.

## Implementation Sequence (§7)

1. Change schema/resolvers and profile normalization; add compatibility tests before renderer work.
2. Implement the running-tool summary and renderer options; update card/text snapshots for all three modes.
3. Wire mode through runAgentBatch and every terminal/fallback/readback branch; verify mode changes are reread on subsequent flushes.
4. Update COT event lifecycle and tests, including detailed-mode redaction and error completion.
5. Update chat/Web settings surfaces, persistence tests, docs, and labels.
6. Run targeted tests, typecheck, build, full local CI, then GitNexus detect-changes before any commit or package/release step.

## Test Strategy (§8)

Cover full/live-only/hidden for running, completed, failed, interrupted, timeout, and no-text states; verify tool command text may appear only in the live footer and tool output never appears in live-only terminal content.
Cover Markdown streaming, card streaming, plain final reply, COT brief/detailed, fallback send, final readback, legacy config payloads, Web API persistence, and concurrent running tools.
Manual Feishu smoke test after packaging: issue a command that produces visible output, observe live footer updates, confirm completion leaves only assistant text, then repeat with COT enabled and with hidden mode.

## Implementation Context (§11)

```json
{
  "implementation_context": {
    "task_summary": "Add configurable full/live-only/hidden tool-display modes. In live-only, stream only the current running tool summary at the bottom and remove tool results from terminal messages while preserving assistant text, reasoning, diagnostics, and existing execution semantics.",
    "acceptance_criteria": [
      "full preserves current card, markdown, and COT tool visibility.",
      "live-only updates a bounded current-command footer on tool_use/tool_result and emits no finalized tool body or output in the user-facing message.",
      "hidden emits neither tool panels nor live tool status; existing assistant text and terminal error/interruption/timeout markers remain.",
      "legacy showToolCalls true/false configs and already-rendered config cards remain readable and map to full/hidden.",
      "card, streaming markdown, plain final reply, COT, chat config, Web UI config, docs, and tests agree on the same mode."
    ],
    "evidence_provenance": {
      "schema_version": 2,
      "head_commit": "6d083b52e9aacdcfaa3111a8060b5914f7f174cc",
      "generated_plan_path": "docs/plans/2026-11-01-gitnexus-plan-tool-display-live-only.md",
      "global_dirty_digest": {
        "algorithm": "sha256",
        "canonicalization": "gitnexus-evidence-provenance-v2 NUL-framed UTF-8 records",
        "value": "e60b9c69c2251550795b83736fc0f44b5397bfca15c85a4f209caf6df003ab7d"
      },
      "cited_path_manifest": [
        {
          "path": "README.md",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:c5d9f3bf6462d27b62a8dc1fc216873b70777f4bd0dc119b2bfdd977bd2e0d0e",
          "index_digest": "sha256:c5d9f3bf6462d27b62a8dc1fc216873b70777f4bd0dc119b2bfdd977bd2e0d0e",
          "worktree_digest": "sha256:c5d9f3bf6462d27b62a8dc1fc216873b70777f4bd0dc119b2bfdd977bd2e0d0e",
          "untracked_digest": "absent"
        },
        {
          "path": "README.zh.md",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:141dc0e73c91c7920fc5097f9dc1839a68e414978dde1069ec156ed284d251d0",
          "index_digest": "sha256:141dc0e73c91c7920fc5097f9dc1839a68e414978dde1069ec156ed284d251d0",
          "worktree_digest": "sha256:141dc0e73c91c7920fc5097f9dc1839a68e414978dde1069ec156ed284d251d0",
          "untracked_digest": "absent"
        },
        {
          "path": "package.json",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:474de3ca667f5e73740f42d0ad274566700b7fbdba8e31ee51a4fcf3387acf48",
          "index_digest": "sha256:474de3ca667f5e73740f42d0ad274566700b7fbdba8e31ee51a4fcf3387acf48",
          "worktree_digest": "sha256:474de3ca667f5e73740f42d0ad274566700b7fbdba8e31ee51a4fcf3387acf48",
          "untracked_digest": "absent"
        },
        {
          "path": "src/bot/channel.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:b74ad4f3d4dd1cc5f380308b4db03bb84369694225e83c33cb14ca17d1ca939c",
          "index_digest": "sha256:b74ad4f3d4dd1cc5f380308b4db03bb84369694225e83c33cb14ca17d1ca939c",
          "worktree_digest": "sha256:b74ad4f3d4dd1cc5f380308b4db03bb84369694225e83c33cb14ca17d1ca939c",
          "untracked_digest": "absent"
        },
        {
          "path": "src/bot/cot.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:d99c2371bc8d0aef475cc6f5deaff6198ed90fa0f572ec73932e46497f3ca38c",
          "index_digest": "sha256:d99c2371bc8d0aef475cc6f5deaff6198ed90fa0f572ec73932e46497f3ca38c",
          "worktree_digest": "sha256:d99c2371bc8d0aef475cc6f5deaff6198ed90fa0f572ec73932e46497f3ca38c",
          "untracked_digest": "absent"
        },
        {
          "path": "src/card/config-card.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:f5d64b8b8c5ccb9ea45fb24e7b120db54eb64a7371a16aa0192477a94f26f0ea",
          "index_digest": "sha256:f5d64b8b8c5ccb9ea45fb24e7b120db54eb64a7371a16aa0192477a94f26f0ea",
          "worktree_digest": "sha256:f5d64b8b8c5ccb9ea45fb24e7b120db54eb64a7371a16aa0192477a94f26f0ea",
          "untracked_digest": "absent"
        },
        {
          "path": "src/card/run-renderer.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:4de13aa56c47c35f16a0f343946b0c3c5c2af535e7dc2319a8c4e838c2fcab42",
          "index_digest": "sha256:4de13aa56c47c35f16a0f343946b0c3c5c2af535e7dc2319a8c4e838c2fcab42",
          "worktree_digest": "sha256:4de13aa56c47c35f16a0f343946b0c3c5c2af535e7dc2319a8c4e838c2fcab42",
          "untracked_digest": "absent"
        },
        {
          "path": "src/card/run-state.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:213661b2601bedac6c871e21d14b66be2e3b63d3053c859a563fa8e503fa0d5d",
          "index_digest": "sha256:213661b2601bedac6c871e21d14b66be2e3b63d3053c859a563fa8e503fa0d5d",
          "worktree_digest": "sha256:213661b2601bedac6c871e21d14b66be2e3b63d3053c859a563fa8e503fa0d5d",
          "untracked_digest": "absent"
        },
        {
          "path": "src/card/text-renderer.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:5096fcd917223ee2e8673182dbbb19759a69a828438fc28108b23b68850e8fcb",
          "index_digest": "sha256:5096fcd917223ee2e8673182dbbb19759a69a828438fc28108b23b68850e8fcb",
          "worktree_digest": "sha256:5096fcd917223ee2e8673182dbbb19759a69a828438fc28108b23b68850e8fcb",
          "untracked_digest": "absent"
        },
        {
          "path": "src/card/tool-render.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:2e5e7ec37b2484ca957d7e47911756869cd823e791e35a531709f50915746a59",
          "index_digest": "sha256:2e5e7ec37b2484ca957d7e47911756869cd823e791e35a531709f50915746a59",
          "worktree_digest": "sha256:2e5e7ec37b2484ca957d7e47911756869cd823e791e35a531709f50915746a59",
          "untracked_digest": "absent"
        },
        {
          "path": "src/commands/index.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:ee7aebb4039871a149fb5d20b9c763e0a13b1baa0f55cbdad34e144d25611330",
          "index_digest": "sha256:ee7aebb4039871a149fb5d20b9c763e0a13b1baa0f55cbdad34e144d25611330",
          "worktree_digest": "sha256:ee7aebb4039871a149fb5d20b9c763e0a13b1baa0f55cbdad34e144d25611330",
          "untracked_digest": "absent"
        },
        {
          "path": "src/config/profile-schema.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:2414721d929c0e0b700bed62fcced10c5cf671303643432600b08bc64e23db9e",
          "index_digest": "sha256:2414721d929c0e0b700bed62fcced10c5cf671303643432600b08bc64e23db9e",
          "worktree_digest": "sha256:2414721d929c0e0b700bed62fcced10c5cf671303643432600b08bc64e23db9e",
          "untracked_digest": "absent"
        },
        {
          "path": "src/config/schema.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:19d6f4ada684ec0fb990c0488f179b9fca09768adf81ba9b05bfea130f62e3ad",
          "index_digest": "sha256:19d6f4ada684ec0fb990c0488f179b9fca09768adf81ba9b05bfea130f62e3ad",
          "worktree_digest": "sha256:19d6f4ada684ec0fb990c0488f179b9fca09768adf81ba9b05bfea130f62e3ad",
          "untracked_digest": "absent"
        },
        {
          "path": "src/ui/api.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:cb405586e28901cd63472b75e0f6b4c111c5b2274446998f7679ae8630e90863",
          "index_digest": "sha256:cb405586e28901cd63472b75e0f6b4c111c5b2274446998f7679ae8630e90863",
          "worktree_digest": "sha256:cb405586e28901cd63472b75e0f6b4c111c5b2274446998f7679ae8630e90863",
          "untracked_digest": "absent"
        },
        {
          "path": "tests/integration/commands/profile-config-command.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:08d63678adc51b47f997763ac84ed4fd62180d6198afea87427e90da1609e5e6",
          "index_digest": "sha256:08d63678adc51b47f997763ac84ed4fd62180d6198afea87427e90da1609e5e6",
          "worktree_digest": "sha256:08d63678adc51b47f997763ac84ed4fd62180d6198afea87427e90da1609e5e6",
          "untracked_digest": "absent"
        },
        {
          "path": "tests/unit/bot/cot.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:e13cfba88801d3619272bd154f420288f22d5e26f942b99526f7849f8e640fd0",
          "index_digest": "sha256:e13cfba88801d3619272bd154f420288f22d5e26f942b99526f7849f8e640fd0",
          "worktree_digest": "sha256:e13cfba88801d3619272bd154f420288f22d5e26f942b99526f7849f8e640fd0",
          "untracked_digest": "absent"
        },
        {
          "path": "tests/unit/card/config-card.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:b84f03b173b0cf0f26316e6757e29b5cfeca54397d5869a39ccd53e6e16d92bc",
          "index_digest": "sha256:b84f03b173b0cf0f26316e6757e29b5cfeca54397d5869a39ccd53e6e16d92bc",
          "worktree_digest": "sha256:b84f03b173b0cf0f26316e6757e29b5cfeca54397d5869a39ccd53e6e16d92bc",
          "untracked_digest": "absent"
        },
        {
          "path": "tests/unit/card/run-renderer.snapshot.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:54875d92dfcad86731a157c3dec25edf8f3497f7c2d50223c56537ca825c3914",
          "index_digest": "sha256:54875d92dfcad86731a157c3dec25edf8f3497f7c2d50223c56537ca825c3914",
          "worktree_digest": "sha256:54875d92dfcad86731a157c3dec25edf8f3497f7c2d50223c56537ca825c3914",
          "untracked_digest": "absent"
        },
        {
          "path": "web/src/lib/types.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:7a32b52adf19b050b0b1804b3bdbb8bac88ce6d9a6960daccda851c187e5a4e4",
          "index_digest": "sha256:7a32b52adf19b050b0b1804b3bdbb8bac88ce6d9a6960daccda851c187e5a4e4",
          "worktree_digest": "sha256:7a32b52adf19b050b0b1804b3bdbb8bac88ce6d9a6960daccda851c187e5a4e4",
          "untracked_digest": "absent"
        },
        {
          "path": "web/src/views/ConfigView.tsx",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:f8de5177d8075ea1d33e882305c19a13b7e9ca1d88a810374b2ccf10f5e551a7",
          "index_digest": "sha256:f8de5177d8075ea1d33e882305c19a13b7e9ca1d88a810374b2ccf10f5e551a7",
          "worktree_digest": "sha256:f8de5177d8075ea1d33e882305c19a13b7e9ca1d88a810374b2ccf10f5e551a7",
          "untracked_digest": "absent"
        }
      ]
    },
    "primary_symbols": [
      {
        "symbol": "renderCard",
        "file": "src/card/run-renderer.ts",
        "lines": "24-67",
        "role": "card rendering and live footer placement"
      },
      {
        "symbol": "renderText",
        "file": "src/card/text-renderer.ts",
        "lines": "21-48",
        "role": "markdown/plain rendering and live footer"
      },
      {
        "symbol": "reduce",
        "file": "src/card/run-state.ts",
        "lines": "44-101",
        "role": "tool lifecycle state and retained output"
      },
      {
        "symbol": "runAgentBatch",
        "file": "src/bot/channel.ts",
        "lines": "3126-3424",
        "role": "mode resolution, streaming updates, final/fallback paths"
      },
      {
        "symbol": "consumeCotEvents",
        "file": "src/bot/cot.ts",
        "lines": "261-398",
        "role": "COT tool event visibility and result suppression"
      }
    ],
    "related_symbols": [
      {
        "symbol": "getToolDisplayMode (new)",
        "relationship": "configuration resolver",
        "relevance": "canonical mode with legacy showToolCalls fallback"
      },
      {
        "symbol": "finalAnswerOnlyState",
        "relationship": "CALLS from runAgentBatch",
        "relevance": "already strips tools for COT final answer"
      },
      {
        "symbol": "configFormCard / submitConfig",
        "relationship": "configuration UI and persistence",
        "relevance": "add three-state picker and legacy form mapping"
      },
      {
        "symbol": "ConfigView / parseConfigBody",
        "relationship": "Web UI API",
        "relevance": "keep browser settings consistent"
      },
      {
        "symbol": "toolHeaderText",
        "relationship": "CALLS from renderers",
        "relevance": "reuse bounded command summaries"
      }
    ],
    "execution_path": [
      "Agent adapters emit tool_use and tool_result events.",
      "reduce records ToolEntry status/input/output and updates the generic footer.",
      "runAgentBatch resolves the display mode and invokes card, markdown, plain, or COT paths.",
      "renderCard/renderText filter visible tool blocks and append a bounded live footer for live-only.",
      "terminal rendering drops tool entries while preserving assistant text and operational terminal markers.",
      "COT closes live tool events on matching results and omits TOOL_CALL_ARGS/TOOL_CALL_RESULT payloads in live-only."
    ],
    "pdg_constraints": [
      {
        "description": "renderCard state flows into reasoning, text, tool-group, terminal, and footer branches; state.terminal guards the footer.",
        "affected_statements": [
          "src/card/run-renderer.ts:27-55"
        ],
        "implementation_consequence": "Keep mode filtering inside rendering or pass an explicit render option; do not mutate away the active tool before footer derivation."
      },
      {
        "description": "runAgentBatch mode branches share the same processAgentStream state flush but have separate card, markdown, final, fallback, and COT paths.",
        "affected_statements": [
          "src/bot/channel.ts:3159-3424"
        ],
        "implementation_consequence": "Wire the mode through every branch and fallback, then test terminal and stream readback behavior."
      }
    ],
    "architectural_patterns": [
      {
        "pattern": "Preference resolver with backward-compatible fallback",
        "example_location": "src/config/schema.ts:getMessageReplyMode",
        "usage_guidance": "Use the same pattern for toolDisplayMode; explicit new value wins, legacy boolean is fallback."
      },
      {
        "pattern": "Pure state renderer with mode options",
        "example_location": "src/card/run-renderer.ts:renderCard",
        "usage_guidance": "Keep RunState complete for logs/diagnostics and control only user-facing projection."
      },
      {
        "pattern": "Config form plus Web API projection",
        "example_location": "src/commands/index.ts:showConfigForm and src/ui/api.ts:buildConfigView",
        "usage_guidance": "Persist one canonical mode while accepting legacy payloads."
      }
    ],
    "files_to_modify": [
      {
        "file": "src/config/schema.ts",
        "symbols": [
          "ToolDisplayMode",
          "AppPreferences",
          "getToolDisplayMode"
        ],
        "intended_change": "Define full/live-only/hidden and legacy resolution."
      },
      {
        "file": "src/card/run-state.ts",
        "symbols": [
          "ToolEntry",
          "RunState",
          "reduce"
        ],
        "intended_change": "Expose/reuse bounded running-tool derivation without removing retained output."
      },
      {
        "file": "src/card/run-renderer.ts",
        "symbols": [
          "renderCard",
          "footerStatus",
          "summaryText"
        ],
        "intended_change": "Project tool blocks by mode and show current command footer in live-only."
      },
      {
        "file": "src/card/text-renderer.ts",
        "symbols": [
          "RenderTextOptions",
          "renderText"
        ],
        "intended_change": "Match card behavior for markdown/plain output."
      },
      {
        "file": "src/bot/channel.ts",
        "symbols": [
          "runAgentBatch",
          "sendFinalReply",
          "renderMarkdownStreamText"
        ],
        "intended_change": "Resolve mode once and pass it through stream, final, readback, and fallback paths."
      },
      {
        "file": "src/bot/cot.ts",
        "symbols": [
          "consumeCotEvents",
          "finalAnswerOnlyState"
        ],
        "intended_change": "Suppress detailed result/args in live-only and close the live tool event on completion."
      },
      {
        "file": "src/card/config-card.ts",
        "symbols": [
          "ConfigFormOpts",
          "configFormCard",
          "configSavedCard"
        ],
        "intended_change": "Replace boolean picker with three-state display picker while accepting legacy values."
      },
      {
        "file": "src/commands/index.ts",
        "symbols": [
          "showConfigForm",
          "submitConfig"
        ],
        "intended_change": "Parse and persist new form field plus legacy mapping."
      },
      {
        "file": "src/ui/api.ts",
        "symbols": [
          "ConfigView",
          "parseConfigBody",
          "buildConfigView"
        ],
        "intended_change": "Expose and save the same mode for the Web UI."
      },
      {
        "file": "web/src/views/ConfigView.tsx",
        "symbols": [
          "ConfigView"
        ],
        "intended_change": "Render a three-option display selector."
      },
      {
        "file": "web/src/lib/types.ts",
        "symbols": [
          "ConfigView"
        ],
        "intended_change": "Type the new mode."
      },
      {
        "file": "README.md",
        "symbols": [
          "Reply display documentation"
        ],
        "intended_change": "Document modes and compatibility."
      },
      {
        "file": "README.zh.md",
        "symbols": [
          "回复展示与 COT"
        ],
        "intended_change": "Document Chinese user-facing behavior."
      }
    ],
    "tests": [
      {
        "file": "tests/unit/card/run-renderer.snapshot.test.ts",
        "scenarios": [
          "full + running tool → current existing panel/output behavior",
          "live-only + running tool → assistant/reasoning plus bottom command footer, no tool body",
          "live-only + done/error tool → no tool block/output after terminal",
          "hidden → no tool block or live footer",
          "parallel running tools → bounded deterministic footer"
        ]
      },
      {
        "file": "tests/unit/bot/cot.test.ts",
        "scenarios": [
          "full detailed → args/output retained",
          "live-only → tool start/close without args/result payload",
          "hidden → no tool events",
          "terminal error → COT finishes with error"
        ]
      },
      {
        "file": "tests/unit/card/config-card.test.ts",
        "scenarios": [
          "three picker values and saved labels",
          "legacy boolean still maps to full/hidden"
        ]
      },
      {
        "file": "tests/integration/commands/profile-config-command.test.ts",
        "scenarios": [
          "new field persists and reloads",
          "old show_tool_calls payload remains accepted",
          "mid-run preference reread still affects subsequent flushes"
        ]
      },
      {
        "file": "tests/unit/config/profile-schema.test.ts",
        "scenarios": [
          "valid mode normalization and invalid fallback"
        ]
      },
      {
        "file": "tests/unit/config/profile-store.test.ts",
        "scenarios": [
          "canonical mode survives save/load without dropping legacy fields"
        ]
      },
      {
        "file": "tests/unit/runtime/profile-runtime.test.ts",
        "scenarios": [
          "runtime config exposes the resolved mode for active profiles"
        ]
      }
    ],
    "verification_commands": [
      "pnpm exec vitest run tests/unit/card/run-renderer.snapshot.test.ts tests/unit/bot/cot.test.ts tests/unit/card/config-card.test.ts tests/unit/config/profile-schema.test.ts tests/unit/config/profile-store.test.ts tests/unit/runtime/profile-runtime.test.ts",
      "pnpm test:integration -- tests/integration/commands/profile-config-command.test.ts",
      "pnpm typecheck",
      "pnpm build",
      "pnpm ci:local",
      "node .gitnexus/run.cjs detect-changes --scope all --repo ."
    ],
    "risks": [
      "renderCard impact is CRITICAL by GitNexus summary (7 direct callers, 8 affected processes); renderText is HIGH (3 direct callers). Preserve all fallback/readback branches.",
      "consumeCotEvents and finalAnswerOnlyState are HIGH-impact shared COT paths; event ordering must remain valid.",
      "Claude can emit multiple concurrent tool_use events; the footer must be deterministic and bounded.",
      "Changing defaults could surprise existing profiles; keep new profiles/full behavior stable and roll out live-only through the current Codex profile setting.",
      "The active daemon runs 0.8.0-allcam.1 while source HEAD is 0.8.1; source validation does not deploy or restart the daemon."
    ],
    "assumptions": [
      "Preserve terminal error/interrupted/timeout notices in live-only/hidden because they are operational status, while suppressing tool payloads.",
      "For parallel tools, display the latest running command plus a bounded count of other active tools; do not expose their outputs.",
      "Tool outputs remain available to structured logs/doctor diagnostics; the change controls Feishu user-facing projections.",
      "Use the current profile config UI and Web UI as the rollout surface; no direct config file edit is part of implementation."
    ],
    "open_questions": [
      "Confirm the exact Chinese labels/icons for full, live-only, and hidden before changing the user-facing cards.",
      "Confirm whether current Codex profile should be switched to live-only immediately after deployment or only documented for manual selection."
    ],
    "avoid": [
      "Do not change agent adapters or tool event protocol.",
      "Do not delete retained tool output from RunState or logs.",
      "Do not bypass existing card/markdown fallback and final readback paths.",
      "Do not deploy/restart the active daemon as part of the plan."
    ]
  }
}
```

## Assumptions and Open Questions (§12)

Assumptions are carried in the context pack: preserve terminal operational markers, retain outputs in logs, bound parallel-tool summaries, and keep full as the compatibility default. Open items are the exact UI labels/icons and whether to switch the current Codex profile at rollout.

## Definition of Done (§13)

- All three modes produce the specified user-facing projection in card, markdown, plain, and COT paths.
- Legacy show/hide configs and stale submitted config cards continue to save without data loss.
- Targeted tests, integration config tests, typecheck, build, and ci:local pass.
- Manual Feishu smoke test confirms live footer behavior and absence of finalized tool results.
- GitNexus detect-changes is complete and reviewed; no package deployment or daemon restart occurs until separately approved.
