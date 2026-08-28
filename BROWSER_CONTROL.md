## Spec 1: Browser runtime and tab lifecycle

What belongs inside:

- Puppeteer Core connection through Chrome CDP
- `ExtensionTransport.connectTab(tabId)`
- Browser context ownership
- Per-tab `Page` instances
- Active-tab discovery
- Open, switch, close, navigate, back, and refresh
- Attach, detach, and cleanup
- Unsupported page handling
- URL restrictions
- Chrome permissions required for control

End goal: Astra has a stable local browser runtime that can attach to allowed Chrome tabs and maintain independent state for each tab.

Primary reference:

- [reference-browser-actions.md](/Users/shahidpatel/codes/hackathons/astra-space-v2/docs/research/reference-browser-actions.md)

Relevant reference code:

- `packages/reference/chrome-extension/src/background/browser/context.ts`
- `packages/reference/chrome-extension/src/background/browser/page.ts`
- `packages/reference/chrome-extension/manifest.js`

Do not include DOM observation or agent tools yet.

## Spec 2: Multimodal page observation

What belongs inside:

- DOM traversal
- Visible and interactive element detection
- Accessibility roles and names
- Labels, forms, inputs, buttons, links, and text
- Element bounds and viewport coordinates
- Noise pruning
- Compact semantic-tree rendering
- Numbered model-facing refs
- Visible-viewport screenshot capture
- Ref highlights in the screenshot
- DOM and screenshot collection from the same observation
- Browser-state result containing URL, title, tabs, scroll state, DOM, refs, and screenshot

End goal: one observation produces a synchronized browser-state package:

```text
URL and title
DOM semantic tree
Grounded element refs
Highlighted viewport screenshot
Scroll state
Tab state
```

Primary reference:

- [reference-browser-observation-and-state.md](/Users/shahidpatel/codes/hackathons/astra-space-v2/docs/research/reference-browser-observation-and-state.md)

Supporting reference:

- [reference-browser-actions.md](/Users/shahidpatel/codes/hackathons/astra-space-v2/docs/research/reference-browser-actions.md)

Relevant reference code:

- `browser/dom/service.ts`
- `browser/dom/views.ts`
- `public/buildDomTree.js`
- `browser/page.ts`
- `agent/prompts/base.ts`

The screenshot is captured automatically during every observation. It does not replace the DOM tree.

## Spec 3: Snapshot identity and grounded refs

What belongs inside:

- Snapshot IDs
- Document and navigation epochs
- Versioned ref maps
- Ref format
- Ref-to-element metadata
- Snapshot invalidation
- Cached-state rules
- Stale-ref detection
- Ambiguous-ref detection
- Action target contract
- Atomic replacement of browser state
- Failure behavior when observation cannot complete

End goal: a ref always belongs to one exact observation. An old ref either resolves to its original element or fails. It can never silently target a newly numbered element.

A grounded target should eventually contain something equivalent to:

```ts
{
  tabId,
  snapshotId,
  ref
}
```

Primary reference:

- [reference-browser-observation-and-state.md](/Users/shahidpatel/codes/hackathons/astra-space-v2/docs/research/reference-browser-observation-and-state.md)

Supporting reference:

- [reference-browser-resilience.md](/Users/shahidpatel/codes/hackathons/astra-space-v2/docs/research/reference-browser-resilience.md)

Relevant reference code:

- `browser/page.ts`
- `browser/dom/service.ts`
- `browser/dom/clickable/service.ts`
- `agent/actions/builder.ts`
- `agent/agents/navigator.ts`

This spec fixes the reference package’s largest weakness: unversioned numeric refs.

## Spec 4: Frames, shadow DOM, and element re-resolution

What belongs inside:

- Same-origin iframes
- Cross-origin iframes
- Nested iframe traversal
- Chrome frame graph
- Frame-specific observation
- Frame IDs and parent frame IDs
- Frame navigation invalidation
- Open shadow roots
- Frame-aware locator metadata
- Backend node IDs
- CSS and XPath lookup
- Role/name and text fallback
- Bounds-based fallback
- Semantic verification after fallback
- Detached-handle recovery

End goal: Astra can observe and act on elements inside complex documents while retaining their real frame and document identity.

Primary reference:

- [reference-browser-resilience.md](/Users/shahidpatel/codes/hackathons/astra-space-v2/docs/research/reference-browser-resilience.md)

Supporting reference:

- [reference-browser-observation-and-state.md](/Users/shahidpatel/codes/hackathons/astra-space-v2/docs/research/reference-browser-observation-and-state.md)

Relevant reference code:

- `browser/dom/service.ts`
- `browser/page.ts`
- `browser/dom/views.ts`
- `browser/dom/history/service.ts`
- `public/buildDomTree.js`

Do not copy the reference’s iframe matching by dimensions. Preserve Chrome frame identity directly.

## Spec 5: Browser action catalog

What belongs inside:

- Click
- Type
- Clear input
- Scroll by page
- Scroll to top or bottom
- Scroll to percentage
- Scroll to text
- Native dropdown inspection
- Native dropdown selection
- Keypress and keyboard shortcuts
- Navigate
- Back and refresh
- Open tab
- Switch tab
- Close tab
- New-tab detection
- File-upload element detection
- Structured action results
- Structured action errors

End goal: Astra supports the complete browser action set through one consistent, typed action interface.

Primary reference:

- [reference-browser-actions.md](/Users/shahidpatel/codes/hackathons/astra-space-v2/docs/research/reference-browser-actions.md)

Relevant reference code:

- `agent/actions/schemas.ts`
- `agent/actions/builder.ts`
- `browser/context.ts`
- `browser/page.ts`
- `agent/agents/navigator.ts`

Every element action must use the grounded target contract from Spec 3.

## Spec 6: Action waits and browser reliability

What belongs inside:

- Navigation watchers installed before actions
- DOM mutation quiet
- Network request tracking
- `xhr` and `fetch` tracking
- Request-finished and request-failed handling
- Layout stability
- Frame navigation
- New-tab creation
- Expected element appearance or disappearance
- Scroll completion
- Action cancellation
- Bounded timeouts
- Retry rules
- Post-action snapshot invalidation
- Completion evidence
- Failure evidence
- Removal of fixed sleeps where a real signal exists

End goal: every browser action ends with evidence explaining what changed, what timed out, or why the action failed.

Example result:

```text
Click completed
Completion signal: navigation committed
New URL: /checkout
DOM quiet: 420 ms
Snapshot invalidated: yes
```

Primary reference:

- [reference-browser-resilience.md](/Users/shahidpatel/codes/hackathons/astra-space-v2/docs/research/reference-browser-resilience.md)

Supporting reference:

- [reference-browser-actions.md](/Users/shahidpatel/codes/hackathons/astra-space-v2/docs/research/reference-browser-actions.md)

Relevant reference code:

- `browser/page.ts`
- `browser/context.ts`
- `agent/agents/navigator.ts`

This spec replaces the reference’s fixed one-second sleeps and incomplete network-idle logic.

## Spec 7: Eve browser-control loop

What belongs inside:

- Extension-to-Eve browser session binding
- Browser observation request
- Multimodal DOM and screenshot model input
- Eve browser tool schemas
- Structured model actions
- Action delivery to the extension
- Action result delivery to Eve
- Observe → Reason → Act loop
- Fresh observation after page-changing actions
- Turn cancellation
- Extension disconnect behavior
- Timeouts and unavailable-browser errors
- Browser-specific agent instructions
- Tool-call display in the existing side panel
- End-to-end browser task testing

End goal: a user can ask Astra to complete a browser task, and Astra repeatedly observes the active page with DOM + screenshot, chooses grounded actions, executes them locally, and continues until the task completes or fails clearly.


Primary references:

- [reference-browser-actions.md](/Users/shahidpatel/codes/hackathons/astra-space-v2/docs/research/reference-browser-actions.md)
- [reference-browser-observation-and-state.md](/Users/shahidpatel/codes/hackathons/astra-space-v2/docs/research/reference-browser-observation-and-state.md)
- [reference-browser-resilience.md](/Users/shahidpatel/codes/hackathons/astra-space-v2/docs/research/reference-browser-resilience.md)

Relevant reference code:

- `agent/prompts/base.ts`
- `agent/agents/navigator.ts`
- `agent/actions/builder.ts`
- `agent/executor.ts`
- `background/index.ts`

This spec integrates the browser runtime with the Eve application you already have. It does not add privacy processing or the privacy inspector.

## Final sequence

```text
1. Browser runtime and tabs
2. DOM + screenshot observation
3. Snapshot identity and refs
4. Frames and re-resolution
5. Browser actions
6. Action waits and reliability
7. Eve browser-control loop
```

## Phase end goal

At the end of these seven specs:

```text
User gives Astra a browser task
  -> Astra observes DOM + screenshot
  -> model receives synchronized page state
  -> model selects grounded action
  -> extension verifies and executes action
  -> runtime waits for measured state change
  -> previous snapshot becomes stale
  -> Astra observes again
  -> loop continues until completion
```

Explicitly outside this phase:

- PII detection
- Screenshot redaction
- Privacy inspector
- Local vision models
- Memory systems
- Skills
- Subagents
- Telegram or WhatsApp
- MCP and Watchtower
- Artifact generation