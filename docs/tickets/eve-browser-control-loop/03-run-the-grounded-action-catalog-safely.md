# 03 - Run the grounded action catalog safely

## Goal

Eve can use every existing browser action through the service worker, receive a fresh observation after page-changing work, and never duplicate an uncertain mutation.

## Files

Create:
- `packages/agent-core/agent/tools/browser_navigate.ts`
- `packages/agent-core/agent/tools/browser_back.ts`
- `packages/agent-core/agent/tools/browser_refresh.ts`
- `packages/agent-core/agent/tools/browser_click.ts`
- `packages/agent-core/agent/tools/browser_type.ts`
- `packages/agent-core/agent/tools/browser_clear_input.ts`
- `packages/agent-core/agent/tools/browser_keypress.ts`
- `packages/agent-core/agent/tools/browser_scroll.ts`
- `packages/agent-core/agent/tools/browser_scroll_to_text.ts`
- `packages/agent-core/agent/tools/browser_get_select_options.ts`
- `packages/agent-core/agent/tools/browser_select_option.ts`
- `packages/agent-core/agent/tools/browser_open_tab.ts`
- `packages/agent-core/agent/tools/browser_switch_tab.ts`
- `packages/agent-core/agent/tools/browser_close_tab.ts`
- `packages/agent-core/tests/browser-action-tools.test.ts`
- `packages/agent-core/tests/eve-call-id-retry.test.ts`
- `chrome-extension/src/browser/bridge-ledger.ts`
- `chrome-extension/tests/browser-bridge-ledger.test.ts`
- `chrome-extension/tests/browser-eve-actions.integration.test.ts`

Modify:
- `packages/browser-control-contract/src/index.ts`
- `packages/agent-core/agent/lib/browser-control.ts`
- `packages/agent-core/agent/instructions.md`
- `packages/agent-core/package.json`
- `chrome-extension/src/background.ts`
- `chrome-extension/src/browser/bridge.ts`
- `chrome-extension/src/browser/actions/types.ts`
- `chrome-extension/src/browser/actions/validation.ts`
- `chrome-extension/src/browser/runtime.ts`
- `chrome-extension/package.json`

## Implementation notes

- Preserve the Spec 5 schemas exactly. Element tools require the complete `{ tabId, snapshotId, ref }`; expose no selector, coordinate, frame ID, backend node ID, arbitrary JavaScript, generic action, or model-authored action ID.
- Keep all 14 definitions as thin path-named Eve tools over `agent/lib/browser-control.ts`. Centralize schema translation, broker calls, bounded errors, result-to-model conversion, timeout clamping, and the optional exact role-and-name appearance or disappearance expectation.
- Map `ctx.callId` to the browser `actionId`. Lock Eve 0.44.4's stable call ID across a retried pending action dispatch with the focused regression before relying on it.
- Put a bounded mutation ledger in `chrome.storage.session`. Write `dispatched` before handing a mutation to `handleBrowserRuntimeMessage()`, then record its terminal result. Return a stored terminal result for a replay; return `action_replay_uncertain` and never dispatch when only the marker survives.
- Continue leasing while an action settles. If `ctx.abortSignal` fires, enqueue `browser.action.cancel` for the mapped action ID and stop the tool wait. Preserve whether dispatch started, snapshot invalidation, and uncertainty.
- After every dispatched mutation, tab switch, open, or close, obtain a fresh observation within the same tool call. Return both action result and new state. If observation fails, retain the action result and add `post_action_observation_failed`.
- Preserve truthful wait semantics: post-dispatch `completion.status: "timed_out"` is a successful dispatch with uncertain page state; a queue timeout is `action_wait_timeout`. Stale, ambiguous, cancelled-after-dispatch, and uncertain results instruct Eve to observe again.
- Update agent instructions to require observation before a grounded action, latest-snapshot refs only, evidence before success claims, and a clear stop at completion. Do not enable the existing bash, file, web, skill, or subagent tools.

## Blocked by

- 02 - Observe the selected page through Eve

## Done when

- Eve can navigate, go back, refresh, click, type, clear, press a key, scroll, find text, inspect and choose native options, and open, switch, or close tabs through the built service worker.
- Each page-changing or tab action returns its measured completion result and a fresh synchronized observation; read-only select inspection leaves its source snapshot executable.
- A stale ref fails without action, then a later observe supplies a new target. Parallel calls still obey the existing one-action-per-tab coordinator.
- Cancelling queued and dispatched work reaches the mapped browser action. Reusing a dispatched mutation ID returns its recorded result or `action_replay_uncertain` and does not mutate the page twice.
- `bun run check:agent` reports exactly the 15 browser tools and no general-purpose shell, file, web, skill, or subagent capability.
- The focused tool, Eve retry, ledger, and built-worker integration tests pass with package TypeScript checks, `bun run build:extension`, and `git diff --check`.
