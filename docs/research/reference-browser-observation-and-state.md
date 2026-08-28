# Reference browser observation, grounding, and tab state

## Scope

This report traces four parts of the Nanobrowser reference package:

1. page observation and compact DOM output
2. the numeric ref map used by actions
3. snapshot freshness and stale-ref handling
4. per-tab and browser-session state

The short version: the reference has a useful DOM extraction pipeline and a practical per-tab `Page` object, but it does not have versioned snapshots. Numeric refs are positions in the latest traversal, not stable element identities. A ref can silently target a different element after a React rerender or navigation.

## Source map

| Concern | Main symbols | Evidence |
| --- | --- | --- |
| In-page DOM extraction | `window.buildDomTree`, `buildDomTree`, `isInteractiveElement`, `isTopElement`, `handleHighlighting` | `packages/reference/chrome-extension/public/buildDomTree.js:1-16`, `541-781`, `790-885`, `1183-1225`, `1238-1504` |
| Script injection and frame stitching | `injectBuildDomTreeScripts`, `_buildDomTree`, `constructFrameTree` | `packages/reference/chrome-extension/src/background/browser/dom/service.ts:112-209`, `212-317`, `581-634` |
| Typed DOM and compact rendering | `DOMElementNode`, `DOMTextNode`, `clickableElementsToString` | `packages/reference/chrome-extension/src/background/browser/dom/views.ts:22-124`, `184-207`, `210-342` |
| Numeric ref map | `_constructDomTree`, `DOMState.selectorMap` | `packages/reference/chrome-extension/src/background/browser/dom/service.ts:408-455`; `packages/reference/chrome-extension/src/background/browser/dom/views.ts:557-560` |
| Ref consumption | `ActionBuilder` indexed actions, `Page.locateElement` | `packages/reference/chrome-extension/src/background/agent/actions/builder.ts:222-300`, `581-680`; `packages/reference/chrome-extension/src/background/browser/page.ts:1029-1099` |
| Page state | `Page._state`, `Page._cachedState`, `Page.getState`, `Page._updateState` | `packages/reference/chrome-extension/src/background/browser/page.ts:27-69`, `337-438` |
| Per-tab state | `BrowserContext._currentTabId`, `BrowserContext._attachedPages` | `packages/reference/chrome-extension/src/background/browser/context.ts:15-53`, `67-128`, `221-293` |
| Prompt projection | `BasePrompt.buildBrowserStateUserMessage`, navigator prompt format | `packages/reference/chrome-extension/src/background/agent/prompts/base.ts:29-95`; `packages/reference/chrome-extension/src/background/agent/prompts/templates/navigator.ts:9-30` |
| Multi-action change detection | `NavigatorAgent.doMultiAction` | `packages/reference/chrome-extension/src/background/agent/agents/navigator.ts:366-431` |
| Replay-only element matching | `DOMHistoryElement`, `HistoryTreeProcessor`, `updateActionIndices` | `packages/reference/chrome-extension/src/background/browser/dom/history/view.ts:35-61`; `packages/reference/chrome-extension/src/background/browser/dom/history/service.ts:7-99`; `packages/reference/chrome-extension/src/background/agent/agents/navigator.ts:501-548`, `630-676` |

## 1. Page observation and compact semantic output

### Extraction lifecycle

`Page.getState()` waits for the page and frames, then calls `_updateState()` to rebuild the observed state. `_updateState()` removes old visual highlights, calls `getClickableElements()`, captures an optional screenshot and scroll metrics, and replaces the tree and selector map on `Page._state` (`page.ts:341-375`, `378-433`).

`getClickableElements()` delegates to `_buildDomTree()` and returns a `DOMState` containing an `elementTree` and `selectorMap` (`dom/service.ts:93-110`). `_buildDomTree()` injects `buildDomTree.js`, runs `window.buildDomTree()` in the main frame, and converts the raw result into TypeScript node objects (`dom/service.ts:112-159`, `209`). If the in-page traversal could not read a visible iframe, the service enumerates Chrome frames, runs the same extractor in those frames, and stitches the raw maps together before constructing the typed tree (`dom/service.ts:166-207`, `212-317`).

The in-page extractor starts a fresh numeric counter and result object on every invocation (`buildDomTree.js:11-19`, `98-100`). It recursively walks `document.body`, text nodes, open shadow roots, and accessible iframe documents (`buildDomTree.js:1238-1311`, `1401-1478`). It returns `{ rootId, map }` after the traversal (`buildDomTree.js:1497-1504`). This is a full rebuild. There is no mutation observer or incremental patch stream.

### What the observer keeps

Each typed element stores:

- tag name, relative XPath, attributes, children, and parent link
- visibility, interactivity, top-layer, viewport, and shadow-root flags
- `highlightIndex`, which becomes the model-facing numeric ref
- optional viewport and page coordinates
- `isNew`, which is calculated later from hashes

The fields are declared on `DOMElementNode` (`dom/views.ts:68-124`). Text nodes retain trimmed text and visibility (`dom/views.ts:33-66`; `buildDomTree.js:1291-1310`).

The raw extractor captures all attributes only for likely interactive candidates, iframes, and `body` (`buildDomTree.js:1362-1380`). The TypeScript renderer then allowlists model-visible attributes. The default list includes `role`, `aria-label`, `aria-checked`, `aria-expanded`, `title`, `type`, `name`, `value`, `placeholder`, `alt`, and `href` (`dom/views.ts:5-20`).

### Accessibility semantics

This is DOM-derived semantic output, not a Chrome accessibility-tree snapshot.

The extractor uses HTML tags, `role`, an apparent `aria-role` attribute, `aria-haspopup`, content-editable state, cursor style, disabled state, and event hints to classify interactivity (`buildDomTree.js:541-781`). It recognizes common ARIA roles such as `button`, `menuitem`, `checkbox`, `tab`, `combobox`, `textbox`, and `listbox` (`buildDomTree.js:703-729`). The compact output preserves selected ARIA attributes and visible text.

What is missing matters:

- No CDP `Accessibility.getFullAXTree` or Puppeteer accessibility snapshot is used.
- There is no computed accessible name or description algorithm. The renderer prints raw `aria-label` when present and visible descendant text otherwise.
- Implicit roles are represented only when the HTML tag itself carries enough meaning.
- `aria-labelledby` and `aria-describedby` are not in the default output allowlist (`dom/views.ts:5-20`).
- `isInteractiveCandidate()` checks `hasAttribute('aria-')`, which does not match normal `aria-*` names and therefore contributes no useful signal (`buildDomTree.js:976-985`). Other role and tag checks still catch many controls.

For Astra, call this a compact semantic DOM, not an accessibility tree.

### Pruning and token control

The extractor removes or suppresses several kinds of noise:

- It rejects `svg`, `script`, `style`, `link`, `meta`, `noscript`, and `template` leaf elements (`buildDomTree.js:505-517`).
- It drops blank text and text under `script` (`buildDomTree.js:1291-1302`).
- It applies viewport checks unless `viewportExpansion` is `-1` (`buildDomTree.js:1318-1343`). The default expansion is zero, so output focuses on the visible viewport (`browser/views.ts:81-93`).
- It requires element dimensions and visible CSS (`buildDomTree.js:525-529`).
- It uses hit testing to reject covered elements in the main document (`buildDomTree.js:790-885`).
- It skips tiny or far-offscreen iframes (`buildDomTree.js:1405-1429`).
- It avoids assigning separate refs to most interactive descendants of an already highlighted parent unless the child looks like a distinct control (`buildDomTree.js:1070-1159`, `1183-1225`).
- It drops empty anchors only when they also have no dimensions (`buildDomTree.js:1481-1490`).

The string renderer prunes again. It emits highlighted elements plus visible, top-layer text that is not already owned by a highlighted ancestor (`dom/views.ts:224-337`). It stops descendant-text collection at the next highlighted node (`dom/views.ts:184-207`). It removes duplicate attribute values, removes a `role` identical to the tag name, and removes `aria-label`, `placeholder`, or `title` when the same string already appears as text (`dom/views.ts:232-295`). It caps rendered attribute values to 15 units through `capTextLength` (`dom/views.ts:289-293`).

The final form looks like `[17]<button aria-label=Save>Save />`. `isNew` adds a leading asterisk (`dom/views.ts:297-321`). `BasePrompt` wraps this output as untrusted page content and adds URL, title, tab list, and scroll data (`agent/prompts/base.ts:29-80`). The navigator prompt states that only bracketed numeric entries are actionable (`agent/prompts/templates/navigator.ts:17-30`, `51-54`).

### Observation gaps

- The tree is tied to a viewport snapshot. Offscreen content is absent with the default configuration.
- Hit testing treats elements in iframes as topmost without an occlusion check against the parent document (`buildDomTree.js:827-833`).
- Open shadow roots are traversed. Closed shadow roots are unavailable, despite the anti-detection hook forcing future calls to `attachShadow` into open mode (`page.ts:155-161`). Existing closed roots remain inaccessible.
- The `DOMElementNode` type has coordinate fields, but `_parse_node()` copies only `viewportInfo`, not raw `viewportCoordinates` or `pageCoordinates` (`dom/service.ts:478-503`). History records therefore usually lack bounds even though their type permits them.
- `showHighlightElements` is passed into `buildDomTree`, but the script sets `doHighlightElements = true` unconditionally (`buildDomTree.js:11-16`). Visual highlighting is not actually disabled by that flag.

## 2. Numeric ref map and live element grounding

### How `[17]` is created

`handleHighlighting()` assigns `highlightIndex++` to each accepted interactive element in traversal order (`buildDomTree.js:1183-1217`). A new extraction starts the counter from `startHighlightIndex`, normally zero for the main frame (`dom/service.ts:138-153`). Subframe runs continue after the current maximum so indexes remain unique across the stitched result (`dom/service.ts:195-205`, `240-280`).

`_constructDomTree()` parses every raw node. For each element with a `highlightIndex`, it adds `selectorMap.set(highlightIndex, node)` (`dom/service.ts:408-427`). The map value is metadata, a `DOMElementNode`, not a browser `ElementHandle`.

The same `highlightIndex` appears in the compact prompt string (`dom/views.ts:297-321`). Action schemas ask the model for a plain integer index (`agent/actions/schemas.ts:46-64`). The action builder reads the matching `DOMElementNode` from `state.selectorMap` (`agent/actions/builder.ts:222-300`, `581-680`).

### How metadata becomes a live element

`Page.locateElement()` re-resolves the node at action time. It walks the stored parent chain, enters each iframe through its generated CSS selector, then queries the target by enhanced CSS selector. If CSS lookup fails, it tries the stored relative XPath (`page.ts:1029-1099`). The enhanced CSS selector derives from the stored XPath, classes, and a selected set of attributes (`dom/views.ts:371-446`, `449-548`).

There is no retained DOM handle in the ref map. That is a sound reusable choice because React and navigation can detach handles. The weakness is that the metadata is not verified against the live result. `locateElement()` checks visibility and scrolls the match into view, but it does not compare the live element's role, text, attributes, or identity with the snapshot node (`page.ts:1063-1091`).

The `xpath` properties included in click and input action schemas are unused by the handlers. The handlers trust `index`; they obtain the XPath from the map value (`agent/actions/schemas.ts:46-64`; `agent/actions/builder.ts:222-300`).

### Separate history-replay grounding

Nanobrowser has a second identity mechanism for replayed historical tasks. `DOMHistoryElement` stores tag name, XPath, parent branch, attributes, selector, coordinates, and viewport data (`dom/history/view.ts:35-61`). `HistoryTreeProcessor` hashes parent tags, all captured attributes, and XPath, then searches the current interactive tree for an exact three-part match (`dom/history/service.ts:7-55`, `80-99`). `NavigatorAgent.updateActionIndices()` uses the match's current `highlightIndex` to rewrite a recorded action (`agent/agents/navigator.ts:630-676`).

This mechanism only runs in `executeHistoryActions()` during task replay (`agent/agents/navigator.ts:501-548`). Normal model actions do not carry a `DOMHistoryElement` or use this matcher before execution.

The replay matcher is strict but brittle. A harmless attribute change or XPath shift prevents a match. Text is not part of the hash. There is no ranked fallback by role and accessible name, backend node ID, stable test ID, or geometry.

## 3. Snapshot freshness and stale refs

### State ownership and replacement

Each `Page` owns one mutable `_state`, one `_cachedState` pointer, and one URL-scoped set of clickable-element hashes (`page.ts:61-74`). `build_initial_state()` creates the initial tree and map (`page.ts:27-45`).

Every successful `_updateState()` replaces `_state.elementTree` and `_state.selectorMap`, then updates URL, title, screenshot, and scroll values (`page.ts:424-433`). `getState()` assigns the returned object to `_cachedState` (`page.ts:372-375`). Since `_updateState()` mutates and returns `_state`, `_cachedState` is not an immutable snapshot. It aliases the same object.

`getCachedState()` returns the pointer unchanged (`page.ts:337-339`). `BrowserContext.getCachedState()` uses it when present and rebuilds only when absent (`browser/context.ts:323-337`). `BrowserContext.getState()` always requests a rebuild (`browser/context.ts:339-351`).

There is no `snapshotId`, generation counter, document ID, navigation epoch, DOM revision, or ref version in `DOMState`, `PageState`, `BrowserState`, prompt text, or action schemas (`dom/views.ts:557-560`; `browser/views.ts:95-114`; `agent/actions/schemas.ts:46-64`).

### Can stale refs silently survive a rerender or navigation?

Yes.

The model chooses an index from snapshot A. Normal indexed actions call `page.getState()` again before looking up that index (`agent/actions/builder.ts:228-233`, `284-289`, `588-590`, `654-656`). If the page changed meanwhile, extraction creates snapshot B and assigns indexes again from traversal order. The handler then interprets the model's old number in B without proving it represents the same element. If index 17 now belongs to another control, the action can click or type into that control with no stale-ref error.

Navigation has the same risk. The `Page` instance survives Puppeteer navigation when `BrowserContext.navigateTo()` uses an already attached page (`browser/context.ts:241-260`). Its old state remains until the next successful rebuild. A rebuild gives the new document a fresh index sequence, but no navigation epoch is compared with the action.

There are two further silent-staleness paths:

- If `_updateState()` cannot obtain content or catches an error, it returns the last `_state` instead of invalidating the map (`page.ts:403-407`, `434-438`). An old selector can then be tried against a changed document.
- Several scroll actions intentionally use `page.getCachedState()` for indexed targets (`agent/actions/builder.ts:379-465`, `498-545`). They do not rebuild at action time.

Multi-action execution only partially limits this. Before a sequence, it records branch-path hashes. Before later indexed actions, it rebuilds and stops if the new hash set is not a subset of the old set (`agent/agents/navigator.ts:371-407`). This detects some newly appearing elements. It does not bind refs to a snapshot, and it allows removals because a reduced set remains a subset. Removals can shift traversal indexes. Changes that preserve branch paths can also pass. The fixed one-second delay after each action is time-based rather than tied to a DOM or navigation event (`agent/agents/navigator.ts:409-431`).

The reference therefore reduces stale `ElementHandle` failures through re-querying, but it does not prevent stale semantic refs.

### New-element hashes are not snapshot validation

The clickable service hashes branch tag path, attributes, and XPath (`dom/clickable/service.ts:50-65`). `Page.getState()` compares these hashes only when `cacheClickableElementsHashes` is enabled and only when the URL is unchanged. It marks absent hashes as `isNew` for prompt display (`page.ts:341-370`). This feature does not validate an action's ref. Normal prompt creation calls `BrowserContext.getState()` without enabling the hash cache (`agent/prompts/base.ts:29-31`).

## 4. Per-tab and session state

`BrowserContext` owns the session-level routing state:

- `_currentTabId` selects the active managed tab.
- `_attachedPages` maps each Chrome tab ID to its own `Page` instance.
- `_config` stores shared browser settings.

These fields are defined at `browser/context.ts:15-22`. `getCurrentPage()` attaches the active tab on demand and reuses its `Page` from `_attachedPages` (`browser/context.ts:93-128`). `switchTab()` activates the requested Chrome tab, gets or creates its `Page`, and updates `_currentTabId` (`browser/context.ts:221-230`). `openTab()` creates and attaches a new `Page` (`browser/context.ts:263-284`). `closeTab()` detaches it, removes the Chrome tab, and clears the current ID when needed (`browser/context.ts:286-293`). Cleanup detaches every page and clears both session fields (`browser/context.ts:56-65`).

Because each tab has a distinct `Page`, each tab also has its own URL, title, DOM tree, selector map, screenshot, scroll values, cached pointer, and new-element hash set (`page.ts:61-74`, `341-375`). Switching away and back preserves that tab's cached state until code asks for a fresh state.

`BrowserState` adds a flat list of all Chrome tabs to the current page state (`browser/views.ts:95-114`; `browser/context.ts:307-351`). The prompt prints the current tab and the other tab IDs, URLs, and titles (`agent/prompts/base.ts:66-80`). Only the current tab's DOM snapshot appears in the prompt.

### Tab-state gaps

- There is no stable session identifier above the in-memory `BrowserContext` instance.
- The context does not subscribe here to tab navigation, update, replace, or removal events to invalidate a `Page`. Some outside caller may call `removeAttachedPage()`, but this class itself only exposes the method (`browser/context.ts:295-305`).
- A tab keeps only one mutable state, not a revision history.
- Tab metadata comes from all Chrome tabs through `chrome.tabs.query({})`, while action methods often limit themselves to the current window. The scope is inconsistent (`browser/context.ts:134-137`, `307-320`).
- `Page.detachPuppeteer()` resets `_state` but does not explicitly clear `_cachedState` or `_cachedStateClickableElementsHashes` (`page.ts:165-172`). A detached object is usually discarded by `BrowserContext`, but the invariant is not local to `Page`.

## Recommended Astra design

### Reuse these concepts

1. Build a fresh semantic observation after meaningful page changes. Return a tree for model context and a lookup table for actions from the same traversal.
2. Keep browser handles out of model-visible refs. Store locator metadata and resolve a fresh handle immediately before action execution.
3. Keep state per tab. A tab record should own its URL, document epoch, latest snapshot, ref map, and connection state.
4. Traverse open shadow roots and preserve frame ancestry in locator metadata.
5. Prune by visibility, viewport, top-layer hit testing, and nested-control deduplication. Keep the compact renderer separate from extraction so Astra can tune token cost without changing grounding.
6. Wrap observed page text as untrusted content before sending it to Eve or an LLM.

### Do not copy these Nanobrowser-specific choices directly

- Chrome extension APIs such as `chrome.scripting`, `chrome.tabs`, and `chrome.webNavigation`
- a global `window.buildDomTree` script and visual highlight overlays
- `ExtensionTransport.connectTab()` and one Puppeteer browser connection per Chrome tab
- Nanobrowser's navigator prompt, LangChain action registry, history persistence, and i18n events
- traversal-order indexes without a snapshot version
- strict replay hashes as the only re-resolution strategy

### Proposed Astra state model

```ts
type TabId = string;
type SnapshotId = string;
type DocumentEpoch = number;

interface BrowserSessionState {
  sessionId: string;
  activeTabId: TabId;
  tabs: Map<TabId, TabState>;
}

interface TabState {
  tabId: TabId;
  url: string;
  title: string;
  documentEpoch: DocumentEpoch;
  latestSnapshot: PageSnapshot | null;
}

interface PageSnapshot {
  snapshotId: SnapshotId;
  documentEpoch: DocumentEpoch;
  observedAt: number;
  semanticTree: SemanticNode;
  refs: Map<string, ElementLocator>;
}

interface ElementRefInput {
  tabId: TabId;
  snapshotId: SnapshotId;
  ref: string;
}
```

The read tool should return `tabId`, `snapshotId`, URL, title, compact semantic tree, and refs embedded in the tree. Every ref action should require all three values from `ElementRefInput`.

### Required invalidation rules

1. Increment `documentEpoch` on top-level navigation, reload, or target replacement. Drop the latest snapshot and ref map immediately.
2. Create a new `snapshotId` for every observation, including observations on the same URL.
3. Reject an action when its `tabId` is not active or explicitly targeted, its `snapshotId` is not the tab's latest accepted snapshot, or its document epoch differs.
4. Never return the previous selector map when observation fails. Return an unavailable-state error and require another read.
5. After an action, wait for a bounded state-change condition, then mark the prior snapshot consumed or stale before asking the model for another action.
6. For action batches, either pin the batch to one unchanged snapshot or force a read after the first action that mutates the DOM. Do not remap the old integer into a new traversal.

### Re-resolution order

Store enough evidence to relocate the intended element without silently accepting a different one:

1. frame path and CDP backend node ID within the same document epoch
2. stable attributes such as `id`, `data-testid`, form name, and stable `href`
3. role plus computed accessible name
4. CSS selector and XPath
5. nearby text, ancestor signature, and bounds as supporting evidence

A fallback match should exceed a confidence threshold and pass a semantic check against the original tag, role, name, and key attributes. If it does not, return `stale_ref` and ask the agent to read again. Clicking a plausible substitute is worse than failing loudly.

### Suggested build slices

1. Implement a CDP-backed tab registry with `documentEpoch` and explicit invalidation.
2. Implement `browser_read` to return a versioned `PageSnapshot` and compact semantic DOM. Add computed accessibility data rather than relying only on raw ARIA attributes.
3. Implement ref-based `click` and `type` using exact snapshot validation and a fresh handle lookup.
4. Add rerender, navigation, iframe, shadow-root, and removed-element tests. Each test should prove that an old ref either resolves to the same semantic element or fails with `stale_ref`.
5. Add event-driven post-action stabilization, then allow bounded multi-action execution only while the snapshot remains valid.

## Bottom line

Nanobrowser's strongest reusable idea is the paired semantic tree and `selectorMap`, rebuilt from one page traversal and owned by a per-tab `Page`. Its main weakness is the missing version boundary. Astra should preserve the pairing, add `snapshotId` and `documentEpoch`, and make stale refs fail instead of treating the same number in a new traversal as the same element.
