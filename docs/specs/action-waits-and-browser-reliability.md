# Action waits and browser reliability

## Goal

Astra can tell when a browser action has settled without relying on a fixed sleep. Every action returns evidence showing what changed, whether the page became quiet, and whether the wait completed, timed out, was cancelled, or failed.

This spec makes the Spec 5 action catalog reliable inside the extension-owned Puppeteer and CDP runtime. It does not add the Eve loop.

## User flow

1. A caller submits one validated browser action to the selected tab. It may include an action ID and a bounded semantic expectation for an element to appear or disappear.
2. Astra reserves the supplied action ID, or creates one when omitted, and installs the relevant navigation, frame, network, DOM, layout, tab, and scroll watchers before it dispatches the action.
3. A mutating action invalidates its executable snapshot before the first page change. The action then runs once.
4. Astra waits on an action-specific completion policy. A navigation, popup, DOM-only update, failed request, or scroll can each satisfy a different policy.
5. Astra stops the barrier when the required signals settle, the timeout expires, the caller cancels the action, the tab disconnects, or the action fails.
6. The result includes the final URL, snapshot state, elapsed time, signals observed, and any unfinished or ignored work. A timeout never looks like confirmed stability.
7. The caller observes the affected tab again before using another grounded target.

## Requirements

### Wait barrier and signals

- Run at most one action per tab. Queue later actions for that tab, while actions on separate attached tabs remain independent.
- Give each action a unique `actionId`. A caller may supply it so a second runtime message can cancel that action while the first call is pending. Generate one when omitted. Reject duplicate live IDs. Spec 7 may map turn cancellation onto this individual cancellation message later.
- Install every watcher before dispatch so fast navigation, frame, request, popup, and DOM events cannot be missed. Remove listeners, observers, timers, and abort handlers in `finally`.
- Track main-frame and child-frame commits, same-document navigation, URL changes, and new-tab creation. Reuse `FrameGraphTracker` identity instead of inferring navigation from URL alone.
- Track in-flight `document`, `xhr`, `fetch`, `script`, `stylesheet`, and iframe requests. Remove each request on both `requestfinished` and `requestfailed`. Exclude WebSocket, EventSource, media, and other long-lived traffic from the quiet condition, but count excluded requests in timeout evidence.
- Measure DOM mutation quiet in every live frame that Astra can observe. Reinstall the observer after a frame navigation destroys its execution context. A frame that detaches must stop contributing to the wait.
- Measure bounded layout stability from the affected element, viewport, and scroll container when they still exist. Scroll actions complete only after the requested position is reached and remains stable.
- Support an optional exact semantic expectation for an element with a role and accessible name to appear or disappear. Use it only as a wait condition, never as an action target. Multiple matches do not satisfy the condition.
- Use named constants for the total timeout, DOM quiet window, network quiet window, layout tolerance, and required stable samples. Production defaults are a 10-second total timeout, 300 milliseconds of DOM quiet, 500 milliseconds of network quiet, and two stable layout samples at least 100 milliseconds apart. Clamp caller timeout overrides to 1 through 30 seconds.

### Action-aware completion

- `browser_navigate`, `browser_back`, and `browser_refresh` start their barrier before the Puppeteer call. Completion requires a main-frame or same-document navigation signal, a policy-approved final URL, and DOM plus relevant network quiet. A load event alone is not enough.
- `browser_click` completes on a new tab, a navigation followed by quiet, a satisfied element expectation followed by quiet, or DOM and layout stability after the click. Keep popup detection alive for the full bounded barrier.
- `browser_type`, `browser_clear_input`, `browser_keypress`, and `browser_select_option` wait for navigation when it occurs. Otherwise they require tracked network and DOM quiet after their last activity, plus layout stability where applicable.
- `browser_scroll` and `browser_scroll_to_text` verify the final document or container position and wait for scroll stability. They must not use a fixed post-scroll delay.
- `browser_open_tab`, `browser_switch_tab`, and `browser_close_tab` reuse Chrome tab events but return the same completion-evidence shape. Opening waits for a controllable URL and attachment, switching waits for activation and attachment, and closing waits for confirmed removal before local state is discarded.
- `browser_get_select_options` remains read-only. It returns immediate completion evidence and does not invalidate its snapshot.
- After any action-induced navigation, enforce the existing URL policy on the final URL. An unsupported redirect fails closed, invalidates the tab's snapshots, and does not get reported as a settled success.

### Results, timeouts, cancellation, and retries

- Extend both success and failure results with JSON-safe completion evidence. It includes `actionId`, `status`, `elapsedMs`, observed signal records, final URL when available, pending and ignored request counts, and whether dispatch started.
- Use completion statuses `completed`, `timed_out`, `cancelled`, and `failed`. `timed_out` means the action ran but Astra could not prove the completion policy before the deadline. Preserve this distinction instead of converting it to `action_failed`.
- If dispatch succeeds but settling reaches the deadline, return `ok: true` with `completion.status: "timed_out"`. If the deadline expires while the action is still queued and dispatch never starts, return `ok: false` with `action_wait_timeout`. Cancellation returns `ok: false` with `action_cancelled`. Evidence must say whether cancellation happened before or after dispatch, because the latter leaves page state uncertain.
- Keep the snapshot invalidated after every dispatched mutating action, including timeout, cancellation, action failure, unsupported redirect, and disconnect. Never make the source refs executable again.
- Never retry click, type, clear, keypress, select, navigation, or tab mutation after dispatch. Preserve Spec 4's one retry for detached target resolution before dispatch. A failed read-only evidence probe may retry once inside the original deadline.
- If the tab closes, the debugger detaches, or the connection generation changes during the barrier, cancel the wait, clean up, and return the existing lifecycle error with failure evidence.
- Do not hide failure details behind raw Puppeteer or Chrome messages. Report bounded machine-readable signal data and stable error codes.

## Implementation decisions

- Add an action wait coordinator under `chrome-extension/src/browser/waits/`. It owns action IDs, per-tab serialization, abort state, watcher setup, action-specific policies, cleanup, and evidence assembly.
- Keep the coordinator page-scoped. `BrowserPage` supplies its Puppeteer `Page`, CDP session, `FrameGraphTracker`, snapshot store, and connection generation. `BrowserContext` supplies Chrome tab lifecycle events and routes cancellation to the owning page.
- Change Spec 5 action helpers to accept a prepared barrier or dispatch callback. The barrier starts before the helper mutates the page. Do not bolt a generic wait onto `dispatchBrowserAction()` after the action returns.
- Extend `BrowserActionResult` with a discriminated `completion` record rather than optional booleans. Keep action-specific data such as `newTabId` and scroll position in the existing `data` union.
- Add optional top-level `actionId` and wait input to the runtime action request instead of changing each action's input. The wait input may contain a clamped timeout and one exact semantic appearance or disappearance expectation. Existing requests remain valid.
- Use Puppeteer request lifecycle events for request accounting, CDP and `FrameGraphTracker` events for document and frame identity, page-installed `MutationObserver`s for DOM quiet, and measured geometry or scroll offsets for stability. Do not copy the reference package's filtered response accounting, unused navigation waiter, or global one-second sleep.
- Keep snapshot publication outside this spec. The action result marks the old snapshot invalid, and the existing observation path publishes the next snapshot atomically when the caller asks for it.

## Demo / acceptance

- [ ] A click that navigates immediately is caught because the barrier was installed first. The result reports the navigation signal, final URL, quiet durations, elapsed time, and an invalidated snapshot.
- [ ] A React autocomplete driven by `fetch` waits through request completion and DOM quiet, including a failed request, without waiting for a permanent WebSocket.
- [ ] A DOM-only update and same-document route change settle without requiring a full page load.
- [ ] Same-origin, cross-origin, and nested frame navigation contribute frame-specific evidence and do not leave dead observers or pending requests.
- [ ] A click-created tab is detected during the bounded wait even when it appears after `ElementHandle.click()` resolves.
- [ ] Document and grounded-container scrolling return only after the requested position is stable.
- [ ] Exact element appearance and disappearance expectations complete when one semantic match changes state and remain pending when matches are ambiguous.
- [ ] Timeout and cancellation before and after dispatch return distinct evidence, keep dispatched mutations invalidated, and clean up every watcher.
- [ ] A redirect to an unsupported URL fails closed. Tab close or debugger detach during a wait returns a lifecycle failure and clears the action from the per-tab queue.
- [ ] Tests prove request-finished and request-failed accounting, watcher-before-dispatch ordering, no mutating replay, per-tab serialization, cross-tab independence, and cleanup on every exit path.
- [ ] A real unpacked MV3 build completes navigation, SPA update, popup, fetch autocomplete, frame navigation, and scroll fixtures without fixed action sleeps.
- [ ] `bun test chrome-extension/tests`, the focused real-Chrome integration tests, `bunx tsc -p chrome-extension/tsconfig.json --noEmit`, `bun run build:extension`, and `git diff --check` pass. The built background bundle contains no Node-only imports.

## Out of scope

- Eve session binding, model tool schemas, observe-reason-act iteration, turn-level cancellation, tool-call display, and automatic post-action observation from Spec 7.
- Replacing the extension-owned Puppeteer and CDP runtime with MCP, PinchTab, or a companion daemon.
- New browser actions, multi-action batches, file upload execution, downloads, hover, drag and drop, coordinate clicks, arbitrary selectors, and arbitrary JavaScript.
- Approval policy, PII filtering, privacy inspector work, Watchtower, memory, skills as product capabilities, subagents, and messaging channels.
