# Reference browser resilience: stale elements, frames, and waits

## Scope and conclusion

This report traces three mechanisms in `packages/reference`: element re-resolution after a DOM handle dies, iframe handling, and waiting for page state changes after an action. The source snapshot is the repository state at commit `6a32141e22d638f95aab1d3f647aa9276a3070d6`.

The short version:

| Area | What exists | What does not exist |
| --- | --- | --- |
| Element re-resolution | Every normal indexed action rebuilds page state, maps the model's index to a fresh `DOMElementNode`, then locates it by generated CSS with XPath as a fallback. History replay can remap an old index by exact DOM hashes. | No backend node ID, CDP node/object ID, frame ID, snapshot version, live-handle recovery, role/name lookup, text lookup, or bounds-based lookup. A dead handle is retried with the same dead handle. |
| Frames | Same-origin iframe contents are walked in-page. Failed iframe reads trigger per-frame `chrome.scripting` execution, tree stitching, and Puppeteer `contentFrame()` traversal during actions. | A DOM node does not retain `frameId` or a stable frame identity. Cross-origin tree stitching guesses the iframe from dimensions and optional name, URL, and title. |
| Waiting | A custom request/response tracker waits for a filtered network quiet period. Some actions call it, element input has a bounding-box stability check, and the action loop sleeps for one second. | No DOM mutation observer, no document generation check, no action-scoped lifecycle barrier, no request-finished or request-failed accounting, and no general post-click stability wait. |

## Dispatch path

`AgentExecutor` builds `ActionBuilder`, registers its defaults with `NavigatorActionRegistry`, and passes that registry to `NavigatorAgent` (`packages/reference/chrome-extension/src/background/agent/executor.ts:71-79`). The navigator parses model output and sends the action list to `doMultiAction()` (`packages/reference/chrome-extension/src/background/agent/agents/navigator.ts:195-205`). For each action, `doMultiAction()` retrieves the registry entry and calls `Action.call()` (`packages/reference/chrome-extension/src/background/agent/agents/navigator.ts:386-409`). `Action.call()` validates input with Zod before invoking the registered handler (`packages/reference/chrome-extension/src/background/agent/actions/builder.ts:53-71`).

The element path for click is:

```text
model action index
  -> NavigatorAgent.doMultiAction
  -> ActionBuilder click handler
  -> Page.getState
  -> state.selectorMap.get(index)
  -> Page.clickElementNode
  -> Page.locateElement
  -> Puppeteer Frame.$(CSS), then Frame.$(XPath)
  -> ElementHandle.click, then ElementHandle.evaluate(click) on failure
```

The click handler rebuilds state and resolves `input.index` before calling `clickElementNode()` (`packages/reference/chrome-extension/src/background/agent/actions/builder.ts:223-248`). Input follows the same fresh-state and selector-map path (`packages/reference/chrome-extension/src/background/agent/actions/builder.ts:279-292`).

## Element re-resolution and fallback

### Normal actions resolve a description, not a retained handle

The observation model stores `DOMElementNode` objects in `selectorMap`, keyed by `highlightIndex` (`packages/reference/chrome-extension/src/background/browser/dom/service.ts:408-427`). `Page.getState()` calls `waitForPageAndFramesLoad()`, rebuilds the DOM state, and caches it (`packages/reference/chrome-extension/src/background/browser/page.ts:341-375`). The click and input handlers call `getState()` again immediately before they look up the supplied index. This avoids keeping an `ElementHandle` between model turns, but it does not prove that the same index still names the same logical element.

If extraction fails, `_updateState()` returns the last known `_state` instead of invalidating it (`packages/reference/chrome-extension/src/background/browser/page.ts:378-407`, `packages/reference/chrome-extension/src/background/browser/page.ts:434-437`). That fallback can put an old selector map back into the action path.

`DOMElementNode` retains these fields:

- tag name, boundary-relative XPath, all copied attributes, tree parents and children, interaction flags, shadow-root status, highlight index, and optional coordinate records (`packages/reference/chrome-extension/src/background/browser/dom/views.ts:68-123`)
- a generated CSS selector derived from XPath, classes, and a safe attribute allowlist that includes `id`, `name`, `type`, ARIA attributes, `role`, `alt`, `title`, `href`, and selected `data-*` attributes (`packages/reference/chrome-extension/src/background/browser/dom/views.ts:449-548`)

The action locator first walks iframe ancestors. It then queries the target frame with the generated CSS selector. If that returns no handle, it queries the same frame with Puppeteer's XPath selector syntax (`packages/reference/chrome-extension/src/background/browser/page.ts:1027-1098`). This is the only normal fallback sequence.

The `click_element` and `input_text` schemas accept an optional `xpath` field (`packages/reference/chrome-extension/src/background/agent/actions/schemas.ts:46-64`), but their handlers never read it. They use only the rebuilt state's `DOMElementNode` (`packages/reference/chrome-extension/src/background/agent/actions/builder.ts:223-248`, `packages/reference/chrome-extension/src/background/agent/actions/builder.ts:279-292`).

### Metadata inventory

| Candidate metadata | Declared or populated | Used to relocate a normal action | Notes |
| --- | --- | --- | --- |
| XPath | Yes | Yes, second choice | XPath stops at a shadow-root or iframe boundary (`packages/reference/chrome-extension/public/buildDomTree.js:390-415`). |
| Generated CSS selector | Yes | Yes, first choice | Recomputed from XPath and attributes for each lookup (`packages/reference/chrome-extension/src/background/browser/dom/views.ts:449-548`). |
| Attributes, including role and accessible labels | Yes | Indirectly in CSS | `role`, `aria-label`, and related fields may become selector predicates. There is no accessibility-name or role locator. |
| Text content | Available through the tree | No | History hashing defines a text hash helper, but matching does not use it (`packages/reference/chrome-extension/src/background/browser/dom/history/service.ts:27-55`, `packages/reference/chrome-extension/src/background/browser/dom/history/service.ts:143-149`). |
| Backend node ID or CDP DOM node ID | No | No | `RawDomElementNode` has no such field (`packages/reference/chrome-extension/src/background/browser/dom/raw_types.ts:10-25`). |
| Runtime object ID | No | No | The raw and parsed node models contain no object identifier (`packages/reference/chrome-extension/src/background/browser/dom/raw_types.ts:10-25`, `packages/reference/chrome-extension/src/background/browser/dom/views.ts:68-123`). |
| Frame ID | Transient during tree construction | No | `FrameInfo.frameId` exists only in the stitching service (`packages/reference/chrome-extension/src/background/browser/dom/service.ts:26-33`). It is not copied into `RawDomElementNode` or `DOMElementNode`. |
| Bounds | Types exist, values are not carried into the parsed node | No | Raw and parsed types declare viewport/page coordinates (`packages/reference/chrome-extension/src/background/browser/dom/raw_types.ts:20-24`, `packages/reference/chrome-extension/src/background/browser/dom/views.ts:82-122`), but `_parse_node()` does not pass either coordinate field into the constructor (`packages/reference/chrome-extension/src/background/browser/dom/service.ts:463-507`). The injected builder also does not assign them in `nodeData` (`packages/reference/chrome-extension/public/buildDomTree.js:1346-1367`). |
| Snapshot or document version | No | No | `PageState` contains tab, URL, title, screenshot, and scroll data, but no generation or document identity (`packages/reference/chrome-extension/src/background/browser/views.ts:95-103`). |

### History replay has a separate exact-match remapper

After a normal indexed action, `doMultiAction()` converts the element from the browser state captured at the start of the batch into a `DOMHistoryElement` and stores it on the result (`packages/reference/chrome-extension/src/background/agent/agents/navigator.ts:371-373`, `packages/reference/chrome-extension/src/background/agent/agents/navigator.ts:414-423`). The history record includes tag, XPath, prior index, full parent tag path, attributes, generated CSS, optional coordinates, and viewport data (`packages/reference/chrome-extension/src/background/browser/dom/history/view.ts:35-61`; conversion at `packages/reference/chrome-extension/src/background/browser/dom/history/service.ts:7-21`).

On replay, the navigator gets a new browser state and calls `updateActionIndices()` for every recorded interacted element (`packages/reference/chrome-extension/src/background/agent/agents/navigator.ts:501-536`). The remapper scans highlighted nodes and requires equality of three SHA-256 hashes: parent tag path, the complete attribute record, and XPath (`packages/reference/chrome-extension/src/background/browser/dom/history/service.ts:27-55`, `packages/reference/chrome-extension/src/background/browser/dom/history/service.ts:80-99`). If it finds the node, it replaces the old action index with the node's current highlight index (`packages/reference/chrome-extension/src/background/agent/agents/navigator.ts:630-676`).

This mechanism is strict replay matching, not a fallback for a dead `ElementHandle`. It ignores the stored CSS selector, text, coordinates, and viewport metadata. Any changed attribute, XPath, or parent tag path prevents a match. Replay then throws `Could not find matching element`, retries the whole step up to three times with a one-second default delay, and eventually returns an error when `skipFailures` is true (`packages/reference/chrome-extension/src/background/agent/agents/navigator.ts:532-547`, `packages/reference/chrome-extension/src/background/agent/agents/navigator.ts:551-623`).

### Failure behavior after a handle dies

`locateElement()` catches selector or handle errors, logs them, and returns `null` (`packages/reference/chrome-extension/src/background/browser/page.ts:1065-1098`). Callers usually convert `null` into an action-specific error. Click and input throw `Element ... not found` (`packages/reference/chrome-extension/src/background/browser/page.ts:1112-1115`, `packages/reference/chrome-extension/src/background/browser/page.ts:1296-1299`). Dropdown reads and writes throw their own not-found errors (`packages/reference/chrome-extension/src/background/browser/page.ts:921-947`, `packages/reference/chrome-extension/src/background/browser/page.ts:970-1024`).

If Puppeteer's click fails after a handle was found, `clickElementNode()` calls `evaluate(el.click())` on the same handle (`packages/reference/chrome-extension/src/background/browser/page.ts:1304-1328`). It does not call `locateElement()` again. A detached handle therefore fails both attempts. The method wraps the failure again (`packages/reference/chrome-extension/src/background/browser/page.ts:1330-1334`), and the action handler turns it into an `ActionResult.error` described to the user as no longer available (`packages/reference/chrome-extension/src/background/agent/actions/builder.ts:266-271`). Input has no second resolution attempt. Its outer catch wraps and rethrows the handle error (`packages/reference/chrome-extension/src/background/browser/page.ts:1184-1190`).

For a multi-action model response, the navigator rebuilds state before every indexed action after the first and compares the set of branch-path hashes with the original set. If a new path appears, it stops the batch instead of trusting subsequent indices (`packages/reference/chrome-extension/src/background/agent/agents/navigator.ts:391-407`). This detects one class of DOM growth. It does not detect removals because the test asks whether the new set is a subset of the old set, and it does not remap a normal action to the original element.

## Frames and iframes

### Observation path

The DOM service checks whether `buildDomTree.js` exists in every script-accessible frame and injects it into missing frame IDs (`packages/reference/chrome-extension/src/background/browser/dom/service.ts:581-633`). It first runs `buildDomTree()` in the main frame (`packages/reference/chrome-extension/src/background/browser/dom/service.ts:136-159`).

Inside the page, the builder treats an iframe as a distinct boundary. It stores the iframe's attributes and computed dimensions (`packages/reference/chrome-extension/public/buildDomTree.js:1369-1379`, `packages/reference/chrome-extension/public/buildDomTree.js:1405-1410`). It skips 1-by-1 or offscreen frames, marks restrictive sandbox frames with an error, and directly walks `contentDocument` when access succeeds (`packages/reference/chrome-extension/public/buildDomTree.js:1411-1447`). XPath generation stops at the iframe boundary, so descendants carry an XPath local to their current document (`packages/reference/chrome-extension/public/buildDomTree.js:390-415`).

When the main-frame walk records an error for a visible iframe, the service calls `chrome.webNavigation.getAllFrames()`. It executes a small probe in each subframe to collect `frameId`, dimensions, URL, `window.name`, and title (`packages/reference/chrome-extension/src/background/browser/dom/service.ts:166-193`). It then runs the builder directly in a matched failed frame with adjusted node and highlight counters, merges that frame's raw map into the parent map, and attaches the subframe root below the guessed iframe node (`packages/reference/chrome-extension/src/background/browser/dom/service.ts:212-292`). The function recurses when the subframe has its own unreadable iframe (`packages/reference/chrome-extension/src/background/browser/dom/service.ts:294-317`).

Cross-origin stitching does not use the Chrome frame hierarchy. A code comment asks whether it should check `parentFrameId` (`packages/reference/chrome-extension/src/background/browser/dom/service.ts:277-284`). `_locateMatchingIframeNode()` first compares iframe height, width, optional name, optional URL, and optional title. If strict comparison fails, it retries with approximate dimensions and ignores URL and title (`packages/reference/chrome-extension/src/background/browser/dom/service.ts:333-370`).

### Action path

Tree construction restores parent links between `DOMElementNode` objects (`packages/reference/chrome-extension/src/background/browser/dom/service.ts:408-455`). `Page.locateElement()` walks those parents, extracts iframe ancestors in outer-to-inner order, resolves each iframe by generated CSS in the current Puppeteer page or frame, calls `contentFrame()`, and moves into that frame. It then resolves the target inside the final frame (`packages/reference/chrome-extension/src/background/browser/page.ts:1033-1091`). This supports nested iframe actions when stitching and selectors are correct.

### Frame failure modes

- The DOM node has no `frameId`, document ID, loader ID, or parent frame ID. The action layer must rediscover every boundary by querying iframe elements (`packages/reference/chrome-extension/src/background/browser/dom/raw_types.ts:10-25`, `packages/reference/chrome-extension/src/background/browser/page.ts:1033-1061`).
- If the iframe selector returns no element, or `contentFrame()` returns `null`, `locateElement()` logs a warning and returns `null` (`packages/reference/chrome-extension/src/background/browser/page.ts:1045-1058`). The caller then reports an element-not-found action failure.
- If metadata matching cannot identify the iframe node, the code warns and leaves the merged subframe root unattached (`packages/reference/chrome-extension/src/background/browser/dom/service.ts:277-291`). `_constructDomTree()` still puts every highlighted raw node into `selectorMap` before it links the tree (`packages/reference/chrome-extension/src/background/browser/dom/service.ts:408-445`). An orphaned subframe element can therefore receive a model index without iframe parents, after which `locateElement()` searches for it in the top page and fails.
- Two same-sized frames with absent or changing names, URLs, or titles can match the wrong iframe. The loose pass compares only approximate size plus optional name (`packages/reference/chrome-extension/src/background/browser/dom/service.ts:347-369`).
- The code has no explicit out-of-process iframe session or CDP frame target management. It relies on Chrome script execution for observation and Puppeteer's `contentFrame()` for interaction.

## Wait and state-change handling

### Configured timings

The defaults are 250 milliseconds minimum page wait, 500 milliseconds of network quiet, a 5-second maximum page wait, and 500 milliseconds between actions in the configuration type (`packages/reference/chrome-extension/src/background/browser/views.ts:9-33`, defaults at `packages/reference/chrome-extension/src/background/browser/views.ts:81-86`). The navigator does not use `waitBetweenActions`; it has a separate hard-coded one-second sleep after each successful action (`packages/reference/chrome-extension/src/background/agent/agents/navigator.ts:424-431`).

`waitForPageAndFramesLoad()` calls `_waitForStableNetwork()`, checks URL policy, swallows non-policy wait failures, and pads the elapsed time to the configured minimum (`packages/reference/chrome-extension/src/background/browser/page.ts:1561-1593`). Despite its name, it has no separate frame lifecycle loop.

### Signals the network wait actually uses

`_waitForStableNetwork()` installs Puppeteer `request` and `response` listeners (`packages/reference/chrome-extension/src/background/browser/page.ts:1451-1528`). It tracks only `document`, `stylesheet`, `image`, `font`, `script`, and `iframe` resource types (`packages/reference/chrome-extension/src/background/browser/page.ts:1398-1407`). It ignores URLs and headers associated with analytics, ads, widgets, live chat, push, heartbeat, streaming, common CDNs, prefetch, video, and audio (`packages/reference/chrome-extension/src/background/browser/page.ts:1409-1483`). It also drops responses with an irrelevant or streaming content type, and responses over 5 MiB (`packages/reference/chrome-extension/src/background/browser/page.ts:1489-1523`).

The loop polls every 100 milliseconds. It returns after no tracked requests remain and there has been no tracked activity for `waitForNetworkIdlePageLoadTime`, 500 milliseconds by default. It also returns, without throwing, after `maximumWaitPageLoadTime`, 5 seconds by default (`packages/reference/chrome-extension/src/background/browser/page.ts:1530-1558`).

This differs from browser lifecycle events or Puppeteer's built-in network-idle methods:

- `xhr` and `fetch` are absent from the allowed resource types, so most API-driven React updates do not extend the wait (`packages/reference/chrome-extension/src/background/browser/page.ts:1398-1407`, `packages/reference/chrome-extension/src/background/browser/page.ts:1451-1461`).
- A request leaves `pendingRequests` on `response`, not on request completion. There are no `requestfinished` or `requestfailed` listeners (`packages/reference/chrome-extension/src/background/browser/page.ts:1489-1528`). A failed tracked request stays pending until the five-second ceiling.
- The loop has no DOM mutation, render, layout, or accessibility-tree signal. A repository-wide search for `MutationObserver`, `waitForFunction`, `waitForSelector`, `LifecycleEvent`, `requestfinished`, and `requestfailed` finds no browser-runtime implementation. The bounded loop above is the full general stability mechanism.

### Waits by action

| Action path | Before or during action | After action | Failure behavior |
| --- | --- | --- | --- |
| `go_to_url`, reload, back, forward | Starts custom network wait and Puppeteer navigation together with `Promise.all()` (`packages/reference/chrome-extension/src/background/browser/page.ts:500-512`, `packages/reference/chrome-extension/src/background/browser/page.ts:529-575`). | The same network loop supplies the only stability signal. | Errors whose message contains `timeout` are logged and treated as usable pages; other errors throw (`packages/reference/chrome-extension/src/background/browser/page.ts:514-526`, `packages/reference/chrome-extension/src/background/browser/page.ts:535-588`). |
| `click_element` | Rebuilds state first. Scrolls into view, then races `ElementHandle.click()` against 2 seconds (`packages/reference/chrome-extension/src/background/agent/actions/builder.ts:228-248`, `packages/reference/chrome-extension/src/background/browser/page.ts:1296-1309`). | Only `_checkAndHandleNavigation()`, which checks URL allow/deny policy. It does not wait for navigation or stability (`packages/reference/chrome-extension/src/background/browser/page.ts:1310-1311`, implementation at `packages/reference/chrome-extension/src/background/browser/page.ts:1595-1620`). The navigator later sleeps one second. | On click failure, direct DOM click uses the same handle and performs no post-click URL check or wait (`packages/reference/chrome-extension/src/background/browser/page.ts:1311-1328`). |
| `input_text` | Waits up to 1.5 seconds for two bounding boxes 50 milliseconds apart to differ by less than 2 pixels, then scrolls into view (`packages/reference/chrome-extension/src/background/browser/page.ts:1117-1130`, stability loop at `packages/reference/chrome-extension/src/background/browser/page.ts:1193-1232`). | Calls the custom network wait after typing (`packages/reference/chrome-extension/src/background/browser/page.ts:1168-1185`). | A null bounding box ends the stability loop as if complete. Stability timeout only logs and proceeds (`packages/reference/chrome-extension/src/background/browser/page.ts:1208-1231`). |
| `send_keys` | Starts key press and custom network wait concurrently (`packages/reference/chrome-extension/src/background/browser/page.ts:723-745`). | No other state-change signal. | Network wait normally swallows non-policy failures inside `waitForPageAndFramesLoad()`. Key errors throw (`packages/reference/chrome-extension/src/background/browser/page.ts:746-758`). |
| dropdown selection | Resolves the element, sets its value, and dispatches `change` and `input` (`packages/reference/chrome-extension/src/background/browser/page.ts:951-1019`). | No page wait in the method. The navigator sleeps one second. | Returns or throws the selection message; no re-resolution (`packages/reference/chrome-extension/src/background/browser/page.ts:1017-1024`). |
| scroll | Calls smooth scroll for percentage and fixed delays only for `scroll_to_text` (`packages/reference/chrome-extension/src/background/browser/page.ts:596-633`, `packages/reference/chrome-extension/src/background/browser/page.ts:840-895`). | No mutation or scroll-end signal. The navigator sleeps one second. | Element scroll resolution failures throw. `scroll_to_text` uses a fixed 500-millisecond delay. |
| explicit `wait` | Sleeps for the requested seconds, default three (`packages/reference/chrome-extension/src/background/agent/actions/builder.ts:211-219`). | None. | No page condition is checked. |

`Page.waitForPageLoadState()` wraps Puppeteer's `waitForNavigation()` with an 8-second default (`packages/reference/chrome-extension/src/background/browser/page.ts:1388-1391`), but no caller uses it. Chrome-based tab creation and unattached navigation use a different event barrier: URL, title, `status === 'complete'`, and activation must all arrive, with a 5-second default rejection timeout (`packages/reference/chrome-extension/src/background/browser/context.ts:139-218`). Attached Puppeteer navigation does not use that Chrome tab barrier (`packages/reference/chrome-extension/src/background/browser/context.ts:233-260`).

## Requirements for Astra's browser runtime

The reference is useful for the action catalog and iframe tree shape, but Astra should not copy its identity and waiting behavior as-is.

1. Give every observation an explicit identity. A snapshot should carry `tabId`, a monotonically increasing snapshot version, the main document or loader identity, and the frame graph version. Every ref should carry the snapshot version that created it.
2. Store a frame chain on every ref. Each segment needs Chrome `frameId`, parent frame ID, document identity, URL, and enough iframe-element metadata to recover when IDs change. Do not infer the parent frame from dimensions.
3. Keep multiple locator forms. Retain backend node ID where CDP supplies it, frame ID, CSS, boundary-relative XPath, tag, stable attributes, ARIA role and accessible name, normalized text, and last known bounds. Mark which values came from the same snapshot.
4. Resolve with verification. Try backend node resolution within the same document first, then selector and XPath in the recorded frame, then semantic and attribute matching, then bounded geometric matching. After each attempt, verify tag, role/name, text or stable attributes before acting.
5. Treat a detached handle as a recoverable resolution event. Dispose it, refresh the affected frame observation, resolve a new handle from metadata, verify identity, and retry the action once. Never call the fallback on the same dead handle.
6. Refuse stale ambiguity. If a snapshot version no longer matches or multiple fallback candidates score similarly, return a structured `stale_ref` or `ambiguous_ref` result. Do not let a recycled integer index click a different element.
7. Install the wait barrier before dispatch. For click, keypress, input, and form actions, start navigation, frame, network, and DOM watchers before the action so fast events cannot be missed.
8. Make waiting action-aware. Track navigation commits and lifecycle events, in-flight `document`, `xhr`, `fetch`, script, stylesheet, and frame requests, DOM mutation quiet time, and bounded layout stability. A click that opens a tab, a type action that triggers suggestions, and a pure scroll need different completion rules.
9. Account for request termination. Remove requests on both finished and failed events. Ignore long-lived connections by resource type, but report which ignored requests were present when a timeout occurs.
10. Return wait evidence with the action result. Record whether completion came from navigation, network quiet, DOM quiet, target appearance or disappearance, tab creation, or timeout. A timeout may still be recoverable, but it must not look like confirmed stability.
11. Re-observe only the affected tab and frame after an action, then publish a new snapshot atomically. Keep the previous snapshot available only for diagnostics and ref remapping, never as an unmarked fallback for execution.
12. Test the failure cases directly: React rerender between observation and click, detached handle during click, same-size sibling iframes, nested cross-origin frames, iframe navigation, failed API request, autocomplete driven by `fetch`, SPA route change without navigation, popup tab creation, and a page with a permanent websocket.

These requirements turn refs into checked capabilities tied to a document and frame. That is the missing layer between a compact DOM tree and reliable browser control.
