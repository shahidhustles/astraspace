# Reference browser action tools

This report traces the model-facing browser actions in `packages/reference`, a vendored Nanobrowser implementation. It covers the action schema, dispatch path, `BrowserContext`, the per-tab `Page` wrapper, and the Puppeteer or Chrome API call that does the work.

The useful split is clear. Nanobrowser's Zod action definitions and thin action handlers are easy to adapt. Its Chrome extension lifecycle, LangChain output parsing, localization, analytics, and DOM index map are application-specific. Astra should keep the former ideas, then connect them to its own Eve tool contract and grounding layer.

## End-to-end call path

```text
LLM structured response
  -> NavigatorActionRegistry dynamic Zod schema
  -> NavigatorAgent.doMultiAction
  -> Action.call, which validates one action's arguments
  -> ActionBuilder handler
  -> BrowserContext, for current-page and tab operations
  -> Page, for element and page operations
  -> Puppeteer Page, ElementHandle, Frame, keyboard, screenshot
     or chrome.tabs, for extension tab lifecycle
  -> Chrome DevTools Protocol through ExtensionTransport
```

The concrete assembly path is:

1. `Executor` creates `ActionBuilder`, calls `buildDefaultActions()`, and registers every returned `Action` in `NavigatorActionRegistry` (`packages/reference/chrome-extension/src/background/agent/executor.ts:71-79`).
2. `NavigatorActionRegistry.setupModelOutputSchema()` turns the registered actions into one Zod object per possible action and requires an array of those objects (`packages/reference/chrome-extension/src/background/agent/agents/navigator.ts:41-68`).
3. `NavigatorAgent` converts that Zod type to JSON Schema and gives it to the LLM as structured output (`packages/reference/chrome-extension/src/background/agent/agents/navigator.ts:75-100`).
4. `NavigatorAgent.execute()` normalizes the model's `action` array and calls `doMultiAction()` (`packages/reference/chrome-extension/src/background/agent/agents/navigator.ts:183-205`).
5. `doMultiAction()` looks up the first key in each action object, calls the matching `Action`, records the interacted element for indexed actions, and waits one second before the next action (`packages/reference/chrome-extension/src/background/agent/agents/navigator.ts:366-458`).
6. `Action.call()` runs Zod `safeParse` and throws `InvalidInputError` for invalid arguments before it invokes the handler (`packages/reference/chrome-extension/src/background/agent/actions/builder.ts:34-72`).

`ActionResult` is the common result shape. It contains `isDone`, `success`, `extractedContent`, `error`, `includeInMemory`, and an optional historical element record (`packages/reference/chrome-extension/src/background/agent/types.ts:112-127`). Most successful browser handlers set `extractedContent` and `includeInMemory`, but leave `success` at its default `false`. Astra should not copy that contradictory default.

## Source map

| File | Exports and symbols used by browser actions |
| --- | --- |
| `agent/actions/schemas.ts` | Exported `ActionSchema` plus one exported schema object per model action. The action fields are Zod types (`lines 3-7, 19-93, 115-215`). |
| `agent/actions/builder.ts` | Exported `InvalidInputError`, `Action`, `buildDynamicActionSchema()`, and `ActionBuilder`. `ActionBuilder.buildDefaultActions()` closes over `AgentContext` and creates the executable handlers (`lines 34-152`). |
| `agent/agents/navigator.ts` | Exported `NavigatorActionRegistry`, `NavigatorResult`, and `NavigatorAgent`. Private `doMultiAction()` is the runtime dispatcher (`lines 41-85, 366-459`). |
| `agent/types.ts` | Exported `AgentOptions`, `AgentContext`, `ActionResult`, and related agent types. `AgentContext.browserContext` is how every action reaches the browser (`lines 10-76, 112-132`). |
| `browser/context.ts` | Default-exported `BrowserContext`. It owns `Page` instances and exposes current-page, navigation, tab, state, and cleanup methods (`lines 15-359`). |
| `browser/page.ts` | Default-exported `Page`, plus exported `build_initial_state()` and `CachedStateClickableElementsHashes`. Public `Page` methods execute all page and element actions (`lines 27-69`). |
| `browser/views.ts` | Exported `BrowserContextConfig`, defaults, `PageState`, `TabInfo`, `BrowserState`, `BrowserError`, and `URLNotAllowedError` (`lines 4-151`). |
| `browser/util.ts` | Exported `isUrlAllowed()` enforces navigation policy (`lines 1-93`). |

Paths in this table are relative to `packages/reference/chrome-extension/src/background/`.

## Puppeteer and CDP setup

`Page` imports the browser build of Puppeteer Core, including `connect`, `ExtensionTransport`, `ProtocolType`, and `KeyInput`. It separately imports the `Browser`, `Page`, `ElementHandle`, and `Frame` types (`packages/reference/chrome-extension/src/background/browser/page.ts:1-13`). The extension depends on `puppeteer-core` version `^24.31.0` (`packages/reference/chrome-extension/package.json:18-36`).

`Page.attachPuppeteer()` is the connection point. It rejects non-HTTP pages and the Chrome Web Store, calls `ExtensionTransport.connectTab(tabId)`, then passes that transport to `connect()` with `protocol: 'cdp'` and no default viewport. It takes the first Puppeteer page returned by `browser.pages()` (`packages/reference/chrome-extension/src/background/browser/page.ts:71-120`). This requires the extension's `debugger` permission. The manifest also grants `tabs`, `activeTab`, `scripting`, `webNavigation`, and `<all_urls>` host access (`packages/reference/chrome-extension/manifest.js:52-80`).

`BrowserContext` owns a `Map<number, Page>` and one current tab ID (`packages/reference/chrome-extension/src/background/browser/context.ts:15-21`). `getCurrentPage()` finds the active Chrome tab when no current ID exists, creates the wrapper, and attaches Puppeteer. Later calls reuse the map entry (`packages/reference/chrome-extension/src/background/browser/context.ts:93-128`). Cleanup disconnects every Puppeteer browser and clears the map (`packages/reference/chrome-extension/src/background/browser/context.ts:56-65`). The background worker also drops a map entry when Chrome closes a tab and cancels execution when the user detaches the debugger (`packages/reference/chrome-extension/src/background/index.ts:32-53`).

This setup is tied to a Manifest V3 Chrome extension. Astra can adapt the per-tab wrapper and the `connectTab` technique if it will also run in an extension background worker. It should not copy the global singleton, side-panel connection, analytics hooks, anti-detection script, or Nanobrowser's event names. The anti-detection script modifies `navigator.webdriver`, `window.chrome`, the Permissions API, and every new shadow root (`packages/reference/chrome-extension/src/background/browser/page.ts:123-163`). Those changes are unrelated to core browser control and carry compatibility risk.

## Action inventory

| Capability | Model action | Schema evidence | Handler evidence | Browser API endpoint |
| --- | --- | --- | --- | --- |
| Click | `click_element` | `schemas.ts:46-54` | `builder.ts:223-277` | `ElementHandle.click()`, then DOM `HTMLElement.click()` fallback in `page.ts:1285-1335` |
| Type or input | `input_text` | `schemas.ts:56-65` | `builder.ts:279-300` | `ElementHandle.type()` or DOM value assignment in `page.ts:1101-1190` |
| Navigate | `go_to_url`, `search_google`, `go_back` | `schemas.ts:19-44` | `builder.ts:165-209` | Puppeteer `goto()` and `goBack()` in `page.ts:500-568` |
| Tabs | `switch_tab`, `open_tab`, `close_tab` | `schemas.ts:67-93` | `builder.ts:302-331` | `chrome.tabs.update/create/remove` in `context.ts:221-293` |
| Scroll | six actions | `schemas.ts:115-177` | `builder.ts:379-566` | DOM `scrollTo`, `scrollBy`, and Puppeteer locators in `page.ts:592-721,840-911` |
| Keypress | `send_keys` | `schemas.ts:179-187` | `builder.ts:568-579` | Puppeteer keyboard in `page.ts:723-838` |
| Native select | `get_dropdown_options`, `select_dropdown_option` | `schemas.ts:189-206` | `builder.ts:581-703` | DOM `<select>` evaluation in `page.ts:913-1024` |
| Screenshot | No model action | Repository-wide action search finds no schema or builder action | Vision state and side-panel command only | Puppeteer `Page.screenshot()` in `page.ts:441-484` |

The rest of this report expands each row.

## Click

### Contract and dispatch

`click_element` accepts:

```ts
{
  intent?: string;
  index: number;
  xpath?: string | null;
}
```

The Zod schema requires an integer `index`; `intent` defaults to an empty string, and `xpath` is nullable and optional (`packages/reference/chrome-extension/src/background/agent/actions/schemas.ts:46-54`). The handler never reads `xpath`. It resolves only `state.selectorMap.get(index)` (`packages/reference/chrome-extension/src/background/agent/actions/builder.ts:223-234`).

The handler gets a fresh state, blocks file-upload inputs, snapshots all tab IDs, and calls `Page.clickElementNode(useVision, elementNode)`. After the click, it compares tab ID sets. If one new tab exists, it switches to that tab (`packages/reference/chrome-extension/src/background/agent/actions/builder.ts:228-265`). It catches all click errors and returns an `ActionResult.error` rather than throwing (`packages/reference/chrome-extension/src/background/agent/actions/builder.ts:266-272`).

### Execution

`Page.clickElementNode()`:

1. Fails if Puppeteer is not connected.
2. Re-resolves the stored `DOMElementNode` through `locateElement()`.
3. Scrolls the handle into view.
4. Races `ElementHandle.click()` against a two-second timer.
5. Calls `_checkAndHandleNavigation()` after a successful Puppeteer click.
6. If the first attempt fails, calls `HTMLElement.click()` inside the page (`packages/reference/chrome-extension/src/background/browser/page.ts:1285-1335`).

`locateElement()` is shared by click, input, scroll, and select. It walks iframe ancestors, locates each frame by a generated CSS selector, then tries the target's generated CSS selector. XPath is the second choice. It rejects hidden or missing frame handles by returning `null` (`packages/reference/chrome-extension/src/background/browser/page.ts:1027-1099`).

### Error behavior and adaptation notes

- A missing index throws before the click try/catch in the handler. `doMultiAction()` converts that exception to an error result (`builder.ts:231-234`; `navigator.ts:432-455`).
- A file input is treated as a successful informational result. The tool does not upload a file (`builder.ts:236-244`).
- Any failure inside `clickElementNode()` becomes `Failed to click element: ...` and the action handler returns it as data (`page.ts:1330-1334`; `builder.ts:266-272`).
- The DOM click fallback does not run `_checkAndHandleNavigation()`. A fallback click can therefore navigate to a blocked URL without this method checking it at that point (`page.ts:1316-1329`). The next state read may catch it, but Astra should check after both click paths.
- The schema's `xpath` field is dead input. Astra should remove it unless its action executor will use the supplied value as grounded metadata.

Worth adapting: a grounded reference resolves to a fresh handle immediately before click, the two click methods, and new-tab detection. Replace the index with Astra's versioned ref, preserve typed error codes, and check the resulting URL after either click path.

## Type and input

### Contract and dispatch

`input_text` accepts `intent?`, integer `index`, string `text`, and unused optional `xpath` (`packages/reference/chrome-extension/src/background/agent/actions/schemas.ts:56-65`). Its handler reads fresh page state, resolves the index, then calls `Page.inputTextElementNode(useVision, elementNode, text)` (`packages/reference/chrome-extension/src/background/agent/actions/builder.ts:279-300`). Unlike click, the handler does not catch executor errors. `doMultiAction()` catches them.

### Execution

`inputTextElementNode()` re-resolves the element, waits up to 1.5 seconds for a stable bounding box, and scrolls it into view. Preparation errors only produce a debug log (`packages/reference/chrome-extension/src/background/browser/page.ts:1101-1130`). It then reads `tagName`, `isContentEditable`, `readOnly`, and `disabled` in the page (`page.ts:1132-1151`).

For editable content or an input, it clears `textContent` and `value`, dispatches `input` and `change`, then calls `ElementHandle.type(text, { delay: 50 })`. Otherwise it assigns `value` or `textContent` and dispatches the same events. It waits for page and frame load after input (`packages/reference/chrome-extension/src/background/browser/page.ts:1153-1189`).

### Error behavior and adaptation notes

- Read-only and disabled controls fall into the direct assignment branch. That can mutate a disabled field in the DOM even though a user could not type into it. Astra should return a non-interactable error instead.
- `textarea` is not included in the `ElementHandle.type()` branch because the condition checks only contenteditable and `input`. It still receives a direct value assignment. If keystroke behavior matters, include textareas in the typing branch.
- Clearing and typing dispatches `input` and `change` before typing. Puppeteer's typing dispatches keyboard and input events afterward. Framework-controlled fields may see an unusual event order.
- The method wraps every failure with the target node's string form (`page.ts:1184-1190`). A stable error code plus the ref and current snapshot version would be easier for Eve to act on.

Worth adapting: fresh resolution, stability check, scroll into view, and choosing the input mechanism from element properties. Rewrite the clear sequence and explicitly reject disabled or read-only targets.

## Navigation

### Model actions

- `go_to_url` accepts `intent?` and `url: string` (`packages/reference/chrome-extension/src/background/agent/actions/schemas.ts:29-36`). Its handler calls `BrowserContext.navigateTo(url)` (`builder.ts:181-193`).
- `search_google` accepts `intent?` and `query: string`, constructs a Google search URL, and calls the same context method (`schemas.ts:19-27`; `builder.ts:165-179`). The query is interpolated without `encodeURIComponent`. Astra should use `URLSearchParams`.
- `go_back` accepts only `intent?`, gets the current page, and calls `Page.goBack()` (`schemas.ts:38-44`; `builder.ts:195-209`).

There is no model-facing refresh or forward action. `Page.refreshPage()` and `Page.goForward()` exist as unused page methods (`packages/reference/chrome-extension/src/background/browser/page.ts:529-590`).

### Execution

`BrowserContext.navigateTo()` validates the URL against the allow and deny lists. It tracks the domain, obtains the current page, and uses `Page.navigateTo()` when Puppeteer is attached. Its fallback calls `chrome.tabs.update({ url, active: true })`, waits for Chrome tab events, recreates the `Page`, and attaches Puppeteer (`packages/reference/chrome-extension/src/background/browser/context.ts:233-261`).

`Page.navigateTo()` repeats URL validation and runs `PuppeteerPage.goto(url)` alongside `waitForPageAndFramesLoad()`. A timeout is logged and treated as usable success. Other failures propagate (`packages/reference/chrome-extension/src/background/browser/page.ts:500-527`). `goBack()` follows the same pattern with Puppeteer's `goBack()` (`page.ts:550-568`).

`isUrlAllowed()` always rejects Chrome internal pages, extension URLs, the Chrome Web Store, `javascript:`, `data:`, `file:`, `vbscript:`, and WebSocket URLs. With no configured lists, other URLs pass. With lists, a deny match wins and unmatched domains pass only when the allow list is empty (`packages/reference/chrome-extension/src/background/browser/util.ts:8-92`).

### Error behavior and adaptation notes

- `URLNotAllowedError` extends `BrowserError` and survives the navigator and executor boundaries as a task-level error (`packages/reference/chrome-extension/src/background/browser/views.ts:133-150`; `navigator.ts:432-435`).
- `Page.navigateTo()` silently returns if Puppeteer is missing (`page.ts:500-503`). The context fallback only runs when `page.attached` is false, so this return is reachable mainly through direct `Page` use. Astra should fail closed.
- `waitForPageAndFramesLoad()` starts before `goto()` because both promises are created together. Its network listeners may miss the first requests. Astra should attach listeners before triggering navigation or use Puppeteer's lifecycle waits.
- Navigation timeouts count as success (`page.ts:519-522`). That is reasonable for automation, but the result should say `timed_out_but_usable` so the model knows state may be incomplete.

Worth adapting: URL policy at both the context boundary and after an action-induced navigation. Keep policy separate from analytics and localization.

## Tabs

### Contracts and dispatch

- `switch_tab` accepts `intent?` and integer `tab_id` (`packages/reference/chrome-extension/src/background/agent/actions/schemas.ts:68-75`).
- `open_tab` accepts `intent?` and `url` (`schemas.ts:77-84`).
- `close_tab` accepts `intent?` and integer `tab_id` (`schemas.ts:86-93`).

Their handlers call `BrowserContext.switchTab`, `openTab`, or `closeTab` and return localized text (`packages/reference/chrome-extension/src/background/agent/actions/builder.ts:302-331`). Browser state also exposes every tab as `{ id, url, title }`, so the model can choose a tab ID (`packages/reference/chrome-extension/src/background/browser/views.ts:95-114`; `prompts/base.ts:66-78`).

### Execution

`switchTab()` calls `chrome.tabs.update(tabId, { active: true })`, waits for activation, creates or reuses a page wrapper, attaches it, and updates `_currentTabId` (`packages/reference/chrome-extension/src/background/browser/context.ts:221-231`).

`openTab()` validates the URL, calls `chrome.tabs.create({ url, active: true })`, waits for URL, title, load completion, and activation, then creates and attaches the page (`context.ts:263-284`). `closeTab()` detaches Puppeteer first, calls `chrome.tabs.remove()`, and clears the current ID when needed (`context.ts:286-293`).

`waitForTabEvents()` listens to `chrome.tabs.onUpdated` and `onActivated`, also checks current state, and races those checks against a five-second rejecting timer (`context.ts:139-219`).

### Error behavior and adaptation notes

- Chrome API rejections and the five-second timeout bubble through the action handler to `doMultiAction()`.
- The timeout promise is not cancelled after success. It will reject later inside an already settled `Promise.race`, which is harmless but wasteful.
- The update listener waits for URL, title, and `status === 'complete'`. Pages with no title can time out despite being ready.
- `getTabInfos()` queries every browser window, while `getAllTabIds()` queries only the current window (`context.ts:130-137,307-320`). This mismatch affects model-visible tabs and new-tab detection.
- The `new_task` message contains `tabId`, but `setupExecutor()` does not call `updateCurrentTabId()` (`packages/reference/chrome-extension/src/background/index.ts:98-107,268-335`). The agent therefore starts from whichever tab Chrome reports active when the first state read occurs.

Worth adapting: one context-owned session map and explicit tab operations. Astra should define whether its session spans one window or all windows, use abortable listeners, and bind a task to its requested starting tab.

## Scroll

### Model actions

Nanobrowser exposes six scroll actions:

- `scroll_to_percent`: integer `yPercent` and optional integer `index` (`packages/reference/chrome-extension/src/background/agent/actions/schemas.ts:115-124`). The description says 0 through 100, but the schema does not apply `.min(0).max(100)`.
- `scroll_to_top` and `scroll_to_bottom`: optional integer `index` (`schemas.ts:126-142`).
- `previous_page` and `next_page`: optional integer `index` (`schemas.ts:144-162`).
- `scroll_to_text`: string `text` and positive, one-based `nth` with default 1 (`schemas.ts:164-177`).

An index means "scroll the nearest scrollable ancestor of this grounded element." No index means scroll the document. The handlers resolve indexed targets from cached state and call the matching `Page` method (`packages/reference/chrome-extension/src/background/agent/actions/builder.ts:379-566`). Top and bottom delegate to `scrollToPercent(0|100)`. Previous and next page inspect scroll position first and return informational success when already at the edge (`builder.ts:450-545`).

### Execution

`scrollToPercent()` runs `window.scrollTo()` for document scrolling. For an indexed element, it resolves the handle, finds its nearest scrollable ancestor, and calls that element's `scrollTo()` (`packages/reference/chrome-extension/src/background/browser/page.ts:592-634`). Previous and next page call `window.scrollBy()` by one viewport height or call `scrollBy()` on the ancestor by one `clientHeight` (`page.ts:669-721`).

`scrollToText()` tries Puppeteer's text pseudo-selector and a case-insensitive XPath. It filters matches by computed visibility, picks the requested occurrence, scrolls it into view, waits 500 ms, and disposes all handles (`page.ts:840-911`).

### Error behavior and adaptation notes

- All page scroll methods fail when Puppeteer is unavailable. Indexed methods also fail when resolution or scrollable-ancestor lookup fails.
- The handlers use `if (input.index)`. Index `0` is therefore treated as no index (`builder.ts:385-397,409-420,432-443,456-491,504-540`). Astra should test `input.index != null`, or avoid numeric truthiness by using string refs.
- Percent scrolling accepts out-of-range values. The browser will clamp much of this in practice, but validation belongs in the tool schema.
- Smooth scrolling returns before visual movement ends. The global one-second wait in `doMultiAction()` masks this most of the time (`navigator.ts:430-431`). Astra should wait for scroll position stability instead.
- `scrollToText()` inserts raw model text into both a Puppeteer text selector and an XPath string. Quotes and selector syntax can break either locator. Use a locator API that accepts text as data, or escape it.

Worth adapting: document and nearest-container scrolling, edge checks, and scroll-to-text. Prefer a smaller initial tool set such as `scroll({ direction, amount, ref? })` unless the prompt benefits from separate names.

## Keypress

### Contract and dispatch

`send_keys` accepts `intent?` and a single string `keys`. The description advertises special keys and `+`-joined shortcuts (`packages/reference/chrome-extension/src/background/agent/actions/schemas.ts:179-187`). Its handler gets the current page and calls `Page.sendKeys(keys)` (`packages/reference/chrome-extension/src/background/agent/actions/builder.ts:568-579`).

### Execution

`sendKeys()` splits the string on `+`, presses all modifiers with `keyboard.down()`, and executes the main key with `keyboard.press()` while waiting for page stability. Its `finally` block releases modifiers in reverse order (`packages/reference/chrome-extension/src/background/browser/page.ts:723-759`). `_convertKey()` maps letters, digits, and common special keys. On macOS it maps Control and Command to Puppeteer's `Meta`, and Option to `Alt` (`page.ts:761-838`).

### Error behavior and adaptation notes

- Execution failures become `Failed to send keys: ...`. Modifier-release failures are logged but do not replace the main result (`page.ts:746-756`).
- Splitting on every `+` cannot type the literal plus key.
- Mapping `Control` to `Meta` on macOS changes the user's requested key. This is convenient for shortcuts but wrong for sites that specifically listen for Control.
- The advertised `Insert` and `PageDown` are not in the explicit map. They still pass through as raw strings because `_convertKey()` falls back to the input key (`page.ts:818-837`). Puppeteer decides whether they are valid.
- The model cannot target an element. The command goes to the currently focused element.

Worth adapting: guaranteed modifier release and a typed key enum. Astra should accept `keys: string[]` or `{ modifiers, key }`, distinguish platform-neutral shortcuts from literal keys, and optionally take a grounded target ref.

## Native select

### Contracts and dispatch

`get_dropdown_options` accepts `intent?` and integer `index`. `select_dropdown_option` adds exact option `text` (`packages/reference/chrome-extension/src/background/agent/actions/schemas.ts:189-206`). Both handlers get fresh state and check that the index exists. Selection also checks that the grounded node's tag is `select` before calling the page (`packages/reference/chrome-extension/src/background/agent/actions/builder.ts:581-703`).

`get_dropdown_options` returns one line per option as `<index>: text=<JSON-encoded text>`, then instructs the model to reuse exact text (`builder.ts:600-623`). The option index is informational. Selection uses text, not that index.

### Execution

`Page.getDropdownOptions()` uses the cached selector map, re-resolves the element, verifies `HTMLSelectElement`, and maps every option to `{ index, text, value }`. It throws if the select has no options (`packages/reference/chrome-extension/src/background/browser/page.ts:913-949`).

`Page.selectDropdownOption()` also resolves the element and verifies its tag. In page JavaScript it finds an option whose trimmed text equals the supplied text, assigns `select.value`, and dispatches bubbling `change` and `input` events when the value changed (`page.ts:951-1024`).

### Error behavior and adaptation notes

- `getDropdownOptions()` wraps all execution failures with `Failed to get dropdown options` and the action handler returns an error result (`page.ts:921-948`; `builder.ts:633-640`).
- Selection has a correctness bug. When text does not match an option, the page method returns `{ found: false, message }`; the wrapper returns only `message` and does not throw (`page.ts:987-1019`). The action handler then emits `ACT_OK` and returns `extractedContent` (`builder.ts:681-688`). Astra must preserve `found` and return a failed tool result.
- Exact trimmed visible text is brittle when labels repeat or localize. A read action can return stable option values alongside labels, then select by value after the model chooses a listed option.
- Native select handling does not cover ARIA comboboxes or custom listboxes. Those should use click, observe, and click unless Astra adds a semantic combobox action.

Worth adapting: a separate read-options operation and correct DOM `input` and `change` events. Fix the false-success bug and keep `{ label, value, disabled }` as structured output.

## Screenshot

There is no model-facing screenshot action in `actions/schemas.ts` or `ActionBuilder.buildDefaultActions()`. A repository-wide search for `screenshot` finds two execution paths instead:

1. `Page._updateState()` calls `takeScreenshot()` only when `useVision` is true and stores the base64 string in `PageState.screenshot` (`packages/reference/chrome-extension/src/background/browser/page.ts:378-433`). `BasePrompt` then adds it to the model message as a JPEG data URL (`packages/reference/chrome-extension/src/background/agent/prompts/base.ts:83-95`).
2. The background port accepts a side-panel message with `type: 'screenshot'`, switches to the requested tab, calls `Page.takeScreenshot()`, and posts the result back (`packages/reference/chrome-extension/src/background/index.ts:150-156`). No checked-in side-panel sender for this message was found.

`Page.takeScreenshot(fullPage = false)` disables CSS animation and transition rules, calls Puppeteer's screenshot method with base64-encoded JPEG output at quality 80, removes the injected style, and returns the string (`packages/reference/chrome-extension/src/background/browser/page.ts:441-484`). The output type is `Promise<string | null>`, though the live path returns a string or throws.

Adapt the screenshot executor, not the implicit behavior. Astra should expose an explicit screenshot tool if Eve needs to request one, with `tabId`, optional full-page mode, MIME type, dimensions, and a bounded payload or attachment reference. Put animation cleanup in `finally`; Nanobrowser leaves the injected style behind when screenshot capture throws.

## Shared waiting and state-change behavior

Actions rely on three waiting layers:

- `waitForPageAndFramesLoad()` tracks selected network requests until 0.5 seconds of idle time, stops after 5 seconds, checks URL policy, and enforces a minimum 0.25-second total wait by default (`packages/reference/chrome-extension/src/background/browser/views.ts:9-33,81-93`; `page.ts:1393-1593`).
- Click calls `_checkAndHandleNavigation()` after the primary click only. Input and keypress call the page-load wait. Scroll relies mainly on the outer action delay.
- `doMultiAction()` waits a fixed one second after every action and breaks a multi-action batch if a later indexed action sees new branch hashes in the DOM (`packages/reference/chrome-extension/src/background/agent/agents/navigator.ts:371-431`).

The network-idle filter ignores WebSockets, media, analytics patterns, large responses, and several CDNs (`packages/reference/chrome-extension/src/background/browser/page.ts:1398-1558`). This is useful reference code, but it is not enough by itself. Request listeners are attached only when waiting starts, completed requests without a matching response event can linger until timeout, and DOM-only React updates may produce no network activity. Astra should combine navigation, DOM mutation, URL change, and bounded network quiet into one action-settling policy.

## What to adapt and what to leave behind

### Adapt

- Zod schemas as the source of runtime validation, translated into Eve's tool definitions.
- A browser context that owns current-tab state and a per-tab page wrapper.
- `ExtensionTransport.connectTab(tabId)` plus Puppeteer Core if Astra remains a Chrome MV3 extension.
- Fresh element resolution before every element action.
- CSS-first and XPath-fallback resolution, including iframe ancestry.
- Element stability and scroll-into-view preparation.
- Guaranteed keyboard modifier release.
- URL checks before direct navigation and after action-induced navigation.
- Tab event waits with a hard timeout.
- Structured action results with user-readable context and machine-readable failure codes.

### Leave behind or rewrite

- LangChain-specific `withStructuredOutput`, JSON repair, navigator memory, and planner integration.
- Localized action strings as the only tool result. Eve tools should return structured data.
- Numeric indices without a snapshot version.
- `xpath` fields that the handlers ignore.
- The global one-second delay after every action.
- Analytics calls in browser control code.
- The global background `BrowserContext` singleton unless Astra intentionally supports one concurrent browser session.
- The anti-detection script.
- False-success behavior in dropdown selection and the default `ActionResult.success = false` on successful actions.
- Chrome permissions unrelated to the implementation Astra ships. Request only the exact extension permissions it uses.

## Minimal Astra implementation checklist

- [ ] Define Eve tools for `navigate`, `back`, `click`, `type`, `scroll`, `keypress`, `open_tab`, `switch_tab`, `close_tab`, `get_select_options`, `select_option`, and `screenshot`.
- [ ] Give every element action a versioned grounded ref. Do not expose a bare numeric index.
- [ ] Validate URLs, percent bounds, tab IDs, key names, and select choices in the tool schema.
- [ ] Create one browser session manager with a `Map<tabId, PageSession>` and an explicit starting tab.
- [ ] Connect each HTTP tab through Puppeteer Core's `ExtensionTransport.connectTab` and cleanly disconnect it on tab close, task cancellation, and debugger detach.
- [ ] Return typed results such as `{ ok, code, message, tabId, url, snapshotVersion }`.
- [ ] Re-resolve a ref immediately before each action and include frame ancestry in resolution.
- [ ] Reject stale refs before acting. If safe fallback metadata finds exactly one live match, return that re-resolution in the result.
- [ ] Settle each action on bounded navigation, DOM mutation, scroll, and network conditions. Remove the blanket one-second sleep.
- [ ] Check URL policy after both primary and fallback clicks.
- [ ] Treat disabled and read-only controls as errors.
- [ ] Preserve dropdown lookup failure as failure, not success.
- [ ] Put screenshot style cleanup and temporary event listeners in `finally` blocks.
- [ ] Add focused tests for new-tab clicks, React rerenders, iframe targets, stale refs, denied redirects, custom inputs, literal plus keypresses, missing select options, and screenshot failure cleanup.
