# Eve browser-control loop

## Goal

A user can give Astra a browser task in the side panel. Eve observes the selected tab, chooses only grounded browser tools, receives a fresh DOM and screenshot after each page-changing action, and continues until it finishes or reports a clear failure.

This spec connects the existing Eve 0.44.4 conversation to the completed extension-owned browser runtime. The first build remains a local demo. It does not claim a production-safe remote browser bridge.

## User flow

1. The user opens the Astra side panel. The panel attaches the active supported tab and resumes its current Eve session when one exists.
2. Once Eve creates or resumes the session, the extension service worker binds that session to the local browser-control bridge.
3. The user asks Astra to do something in the browser.
4. Eve calls `browser_observe`. The extension returns one atomic browser state containing tabs, URL, title, scroll state, semantic DOM, grounded refs, and the highlighted JPEG screenshot.
5. Eve chooses an action using the returned `{ tabId, snapshotId, ref }` when the action targets an element. The extension validates and executes it through the existing action coordinator.
6. The tool result reports the action outcome and completion evidence. After any action that may have changed the page, the same tool call also returns a fresh observation for the next model step.
7. Eve repeats the loop until it can answer with the completed result. Tool calls and failures remain visible in the side panel.
8. Stop cancels the Eve turn and the currently mapped browser action. A lost extension, unavailable tab, stale ref, timeout, or disconnected bridge returns a typed failure instead of hanging or guessing.

## Requirements

### Session and transport

- Keep the Eve chat stream in the visible side panel through `useEveAgent()`. Do not proxy the NDJSON conversation stream through the MV3 worker.
- Let the extension service worker own the browser-control bridge client because it already owns `BrowserContext`, Puppeteer, action queues, and cancellation. Keep consuming bridge commands while earlier actions settle so a later cancellation command can reach the existing action coordinator.
- Use custom Eve HTTP routes for extension request leasing and result delivery. Eve tools and those routes exchange requests through an application-owned broker, not a module-global socket map. The local broker uses atomic filesystem records under an OS temporary directory so tool and route code can run in separate Eve processes on the same machine.
- Bind exactly one extension browser connection to one Eve `sessionId`. Persist the session ID in `chrome.storage.session`. On panel reopen, attach `useEveAgent` to that session from stream index zero and replay Eve's durable stream instead of storing DOM, screenshots, or tool payloads in extension storage.
- Set `minimum_chrome_version` to `118`, where an active `chrome.debugger` session keeps the worker alive. Keep each long-poll response below Chrome's 30-second fetch limit, retry transport failures with bounded backoff, and still recover cleanly if Chrome terminates the worker.
- Keep the bridge local-only in this spec. Accept the exact loopback Eve origin and configured `chrome-extension://` origin. On bind, issue an opaque connection-generation token; require it on lease and result routes, and invalidate it on rebind. Reject missing, malformed, cross-origin, wrong-session, expired, oversized, and unknown-version requests.
- Use request IDs on every bridge command. Map Eve `ctx.callId` to the existing browser `actionId`; the model never supplies either value.
- Keep a bounded `chrome.storage.session` ledger for mutating request IDs and their results. Write the dispatched marker before handing the request to the browser runtime. A replay returns the recorded result. A dispatched request without a terminal result returns `action_replay_uncertain` and never runs the mutation again. Prefer a false uncertain result over a duplicate mutation. Observation and other read-only requests may run again.

### Eve tools and model context

- Add `browser_observe` plus one Eve tool for every existing action name: `browser_navigate`, `browser_back`, `browser_refresh`, `browser_click`, `browser_type`, `browser_clear_input`, `browser_keypress`, `browser_scroll`, `browser_scroll_to_text`, `browser_get_select_options`, `browser_select_option`, `browser_open_tab`, `browser_switch_tab`, and `browser_close_tab`.
- Preserve the Spec 5 schemas. Element tools require the complete grounded target. Do not expose selectors, coordinates, backend node IDs, frame IDs, arbitrary JavaScript, or a generic escape-hatch action.
- Allow the existing bounded wait policy where it helps. The model may provide a timeout or one exact role-and-name appearance/disappearance expectation, but it may not provide an action ID or bypass the 1 through 30 second clamp.
- Build every tool on one shared bridge helper. Keep file-per-tool Eve definitions because Eve derives tool names from their paths; do not copy transport and error handling into each file.
- `browser_observe` sends the semantic browser state as text and the JPEG as an Eve image content part. Do not stringify the base64 image into the DOM text block or send a screenshot without its matching snapshot identity.
- After every dispatched mutating action, tab switch, or tab lifecycle action, request a fresh observation before the tool completes. Return the action result even when re-observation fails, with a separate `post_action_observation_failed` error so the model knows the page may have changed.
- Preserve truthful uncertainty. A post-dispatch wait timeout remains a successful dispatch with `completion.status: "timed_out"`; cancellation after dispatch and `action_replay_uncertain` must tell Eve to observe before deciding what happened. Never replay a mutation to make the result look cleaner.
- Bound model and stream payloads. Reuse the existing semantic-tree pruning, ref limits, screenshot encoding, select-option limit, error-message bounds, and completion-evidence bounds. Eve file content uses raw base64 with `image/jpeg` and stays below Eve's 3 MiB warning threshold.
- Keep the existing disabled general-purpose tools disabled. This phase adds browser tools only. It does not enable shell, file, web search, web fetch, skills, or subagents.

### Cancellation and failure behavior

- Pass `ctx.abortSignal` through the bridge helper. When Eve cancels a turn, enqueue `browser.action.cancel` for the mapped action ID and stop waiting for later bridge responses. The worker must continue leasing commands while an action is pending so it receives that cancellation promptly.
- If cancellation happens before dispatch, report the existing pre-dispatch cancellation. If it happens after dispatch, preserve the invalidated snapshot and uncertain page state.
- On debugger detach, tab close, unsupported navigation, worker restart, bridge lease expiry, or Eve restart, settle every affected request with a stable typed error and clean up listeners, timers, pending promises, files, and action ownership.
- A bridge may wait briefly for the worker to bind after Eve creates the first session. After that bounded window, return `browser_unavailable`. Do not let a tool wait indefinitely for the extension.
- A stale or ambiguous grounded target fails without action. Browser instructions must tell Eve to observe again rather than alter the old target or invent a replacement ref.
- One tab still runs at most one action at a time. Parallel Eve tool calls must not bypass the existing per-tab coordinator.

### Instructions and side-panel evidence

- Add browser instructions that require observation before the first grounded action, use of refs only from the latest matching snapshot, fresh observation after stale or uncertain results, and a clear stop when the task is complete.
- Tell Eve that tool output is evidence, not a reason to claim success. It must not describe a click, form submission, navigation, or page value as complete unless the returned action and observation support it.
- Render Eve dynamic-tool parts in order with the action name and `requested`, `running`, `completed`, `timed out`, `cancelled`, or `failed` state. Show concise completion evidence and recovery text. Never render screenshot base64 or the full semantic DOM in the chat row.
- Keep the existing assistant text, reasoning, model selection, context usage, steering, cancellation, and recoverable Eve error behavior working.

## Implementation decisions

- Add a small workspace package under `packages/browser-control-contract/` for JSON-only bridge envelopes and public browser request/result types. Move or re-export the serializable contracts from the extension; keep Puppeteer handles, CDP sessions, frame trackers, and grounding records private to `chrome-extension/src/browser/`.
- Add origin-checked local routes in `packages/agent-core/agent/channels/browser-control.ts`: `POST /astra/v1/browser-control/bind`, `GET /astra/v1/browser-control/requests`, and `POST /astra/v1/browser-control/results`. Send the opaque connection token in a header, never the URL. This is a transport route, not a second conversation channel. Put atomic bind, enqueue, lease, cancel, result, timeout, and cleanup behavior in `packages/agent-core/agent/lib/browser-broker.ts`.
- Put shared Eve tool execution and `toModelOutput` conversion in `packages/agent-core/agent/lib/browser-control.ts`. Keep the 15 path-named tool definitions under `packages/agent-core/agent/tools/` thin.
- Extend `chrome-extension/src/background.ts` with the session-binding message, bounded command polling, result delivery, protocol validation, replay ledger, and routing into the existing `handleBrowserRuntimeMessage()` and `BrowserContext`. Do not construct a second browser runtime or block command intake while an earlier action settles.
- Extend the side panel only to persist and resume the Eve session, tell the worker when the session changes, and render dynamic-tool parts. It must not execute browser actions itself.
- Reuse the same allowlisted `http://127.0.0.1:2000` Eve host for the bridge routes. Configure the broker directory outside the repository and namespace it by app instance, Eve session, and request ID. Atomically claim requests, expire abandoned leases, cap retained terminal results, and remove stale files without touching unrelated temporary data.
- Use the installed Eve 0.44.4 contracts: `defineTool`, `ctx.session.id`, `ctx.session.turn.id`, `ctx.callId`, `ctx.abortSignal`, `toolOutput.content()`, `toolOutputPart.text()`, `toolOutputPart.file()`, and custom channel `GET()` and `POST()` routes. Do not invent client-executed Eve tools; Eve authored tools run in the app runtime and call the extension through this broker.
- Eve 0.44.4 persists the pending runtime-action batch before its dispatch step, so a retried dispatch reuses `ctx.callId`. Use that ID as the browser mutation idempotency key and lock the installed behavior with a focused retry regression before any Eve upgrade.
- Treat the extension ledger as the final at-most-once guard for browser mutations. Eve can retry an interrupted tool step, so server memory alone is not enough.

Primary references:

- [Eve and MV3 browser-control research](../research/eve-mv3-browser-control-loop.md)
- [Action waits and browser reliability](./action-waits-and-browser-reliability.md)
- [Browser action reference](../research/reference-browser-actions.md)
- [Observation and state reference](../research/reference-browser-observation-and-state.md)
- [Browser resilience reference](../research/reference-browser-resilience.md)

## Demo / acceptance

- [ ] `bun run check:agent` reports Eve 0.44.4, zero diagnostics, and exactly the 15 browser tools. The general-purpose shell, file, web, skill, and subagent capabilities remain absent.
- [ ] A real built MV3 extension binds its restored Eve session through the broker routes, and reopening the side panel replays the durable Eve stream and resumes the same running task without persisting page payloads.
- [ ] Asking Astra to summarize the open Wikipedia article causes a real `browser_observe` call with synchronized DOM and JPEG input, then returns a summary grounded in the page.
- [ ] Asking Astra to complete a local multi-field form produces visible observe and action tool rows, changes the real page through the service worker, re-observes after each mutation, and ends with page evidence that the requested values or success state exist.
- [ ] A rerender that stales a ref returns `stale_ref`; Eve observes again and never sends the old target a second time.
- [ ] A focused Eve retry test proves that the installed 0.44.4 dispatch reuses `ctx.callId`. A post-dispatch timeout, cancellation, or bridge interruption keeps the snapshot invalid and never replays the mutation. Reconnecting with the same request ID returns the ledger result or `action_replay_uncertain`.
- [ ] Stop during a queued and a dispatched action produces `turn.cancelled`, maps to the correct browser action cancellation, clears the per-tab queue, and leaves the same Eve session ready for another prompt.
- [ ] Closing the panel during a task does not kill the browser bridge while the debugger is attached. Stopping Eve, unloading the extension, terminating the worker, or losing the controlled tab returns a bounded `browser_unavailable` or lifecycle error instead of hanging.
- [ ] Tool rows show real requested, running, completion, timeout, cancellation, and failure states without exposing DOM or base64 payloads.
- [ ] Automated integration covers one deterministic Eve tool loop through the built extension worker, not direct tool helpers or a constructed `BrowserContext`. A human run with the configured model proves the same summarize and form flows.
- [ ] `bun test`, the focused real-Chrome integration tests, `bunx tsc --noEmit` for each changed package, `bun run build:extension`, `bun run check:agent`, and `git diff --check` pass. The built MV3 bundle contains no Node-only imports or remote executable code.

## Out of scope

- PII detection beyond the existing observation safeguards, screenshot redaction, privacy inspector UI, local vision models, and claims that outbound browser context is fully sanitized.
- Human approval policy for consequential browser actions.
- Hosted or multi-user browser bridging, production authentication, session ownership, a durable broker, horizontal Eve workers, and background tasks that survive a browser or machine restart.
- MCP, PinchTab, Watchtower, browser control from Telegram or WhatsApp, schedules, memory, skills, subagents, and artifact generation.
- New browser actions, file upload execution, downloads, hover, drag and drop, coordinate clicks, arbitrary selectors, and arbitrary JavaScript.
- Multiple concurrent Eve browser sessions, shared control across several extension installations, and unattended browser work after the extension disconnects.
