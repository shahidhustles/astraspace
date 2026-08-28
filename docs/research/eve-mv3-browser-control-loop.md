# Eve to MV3 browser-control loop

Research date: 2026-08-28

Installed Eve package: `eve@0.44.4`, resolved through `chrome-extension/node_modules/eve`. The installed documentation is the version-matched source of truth. Context7's `/vercel/eve` index agrees with the installed API, but the claims below cite the installed package directly.

## Current boundary

Astra already has two working halves:

- The side panel talks directly to the local Eve HTTP server with `useEveAgent({ host: "http://127.0.0.1:2000" })`. It sends `astraModelId` as one-turn `clientContext` and uses `agent.cancel()` for the Stop button. ([`chrome-extension/src/components/chat-panel.tsx`](../../chrome-extension/src/components/chat-panel.tsx#L39-L94))
- The MV3 service worker owns the live `BrowserContext`. It accepts attach, observe, action, and action-cancel requests over `chrome.runtime.onMessage`, then replies asynchronously. ([`chrome-extension/src/background.ts`](../../chrome-extension/src/background.ts#L1-L25), [`chrome-extension/src/browser/runtime.ts`](../../chrome-extension/src/browser/runtime.ts#L16-L114))

The missing piece is not another chat client. It is a request/result bridge between an Eve tool executor running in the Node app runtime and the browser executor running in Chrome.

## Eve 0.44.4 contracts

### Sessions, streaming, and display

One Eve `sessionId` addresses messages, controls, and the NDJSON event stream. A client can persist `{ sessionId, streamIndex }`, reconnect from that cursor, and resume an in-flight turn. `useEveAgent` already wraps this contract and exposes raw events plus projected `EveMessage[]`. ([installed sessions guide](../../chrome-extension/node_modules/eve/docs/concepts/sessions-runs-and-streaming.md), [installed client continuation guide](../../chrome-extension/node_modules/eve/docs/guides/client/continuations.mdx), [installed frontend guide](../../chrome-extension/node_modules/eve/docs/guides/frontend/overview.mdx))

The stream publishes `actions.requested` before tool execution and `action.result` after it. Eve's default message reducer turns these into `dynamic-tool` parts, so Astra can render real tool input and output from the existing `agent.data.messages`; it does not need a parallel fake tool log. ([installed streaming guide](../../chrome-extension/node_modules/eve/docs/guides/client/streaming.mdx), [installed frontend guide](../../chrome-extension/node_modules/eve/docs/guides/frontend/overview.mdx))

`useEveAgent` has lifecycle callbacks and a reducer, but no client-side tool executor or tool-result submission API. Its public commands are `send`, `respond`, `resume`, `cancel`, and `reset`. `respond` answers human-input requests, not arbitrary model tool calls. ([installed React types](../../chrome-extension/node_modules/eve/dist/src/react/use-eve-agent.d.ts), [installed store types](../../chrome-extension/node_modules/eve/dist/src/client/eve-agent-store.d.ts))

### Tool execution and cancellation

An authored tool lives at `agent/tools/<name>.ts`. Eve derives the model-facing name from the filename, validates input with the required schema, and runs `execute(input, ctx)` in the Eve app runtime with Node.js and `process.env` access. It does not run the executor in the extension, browser page, or Eve sandbox. ([installed tools guide](../../chrome-extension/node_modules/eve/docs/tools/overview.mdx), [installed execution guide](../../chrome-extension/node_modules/eve/docs/concepts/execution-model-and-durability.mdx))

`ctx.session.id`, `ctx.session.turn.id`, `ctx.callId`, and `ctx.abortSignal` are public tool inputs. The signal aborts when Eve cancels the active turn. A browser tool must pass that cancellation into the bridge and then into Astra's existing action cancellation path. ([installed tool definition](../../chrome-extension/node_modules/eve/dist/src/public/definitions/tool.d.ts), [installed session-context guide](../../chrome-extension/node_modules/eve/docs/guides/session-context.md), [`chrome-extension/src/browser/waits/coordinator.ts`](../../chrome-extension/src/browser/waits/coordinator.ts#L19-L46))

`agent.cancel()` requests durable cooperative cancellation and keeps the stream attached until `turn.cancelled` followed by `session.waiting`. Aborting or closing the HTTP stream only detaches the client; the server-side turn keeps running. Closing the side panel therefore must not be treated as an Eve cancellation. ([installed streaming guide](../../chrome-extension/node_modules/eve/docs/guides/client/streaming.mdx), [installed frontend guide](../../chrome-extension/node_modules/eve/docs/guides/frontend/overview.mdx))

Eve checkpoints at model/tool step boundaries. A completed step is replayed from its recorded result, but an interrupted step runs again. Browser mutations are therefore unsafe unless the bridge can recognize a repeated operation and return its recorded result without dispatching it twice. In Eve 0.44.4, the harness stores the pending runtime-action batch, including every tool `callId`, in durable session state before the separate dispatch step reads it. A retry of that dispatch step therefore reuses the stored call ID instead of asking the model to create another one. This is installed-version behavior rather than a public compatibility promise, so the implementation still needs a regression test around it. ([installed execution guide](../../chrome-extension/node_modules/eve/docs/concepts/execution-model-and-durability.mdx), [installed tools guide](../../chrome-extension/node_modules/eve/docs/tools/overview.mdx), [installed pending-action implementation](../../chrome-extension/node_modules/eve/dist/src/harness/runtime-actions.js), [installed dispatch implementation](../../chrome-extension/node_modules/eve/dist/src/execution/dispatch-runtime-actions-shared.js))

### DOM and screenshots in model context

Eve tool results must cross a durable JSON boundary. `toModelOutput` can project the full executor result into text, JSON, or ordered content parts. `toolOutputPart.file(base64, { mediaType })` is the supported way to send a screenshot to a vision-capable model. Raw bytes are rejected. ([installed tools guide](../../chrome-extension/node_modules/eve/docs/tools/overview.mdx), [installed output-builder types](../../chrome-extension/node_modules/eve/dist/src/public/tools/output-builders.d.ts))

Astra already returns the highlighted viewport as base64 JPEG with an explicit MIME type and dimensions. An observe tool can project the compact DOM and public browser state as text, then the JPEG as a file content part. It must not send private grounding records. ([`chrome-extension/src/browser/observation/types.ts`](../../chrome-extension/src/browser/observation/types.ts#L126-L138), [`chrome-extension/src/browser/types.ts`](../../chrome-extension/src/browser/types.ts))

There is a cost to this route. Eve persists content-part images in session history, re-sends them on later model calls, and warns above 3 MiB. Compaction replaces old files with text stubs. Also, `toModelOutput` only changes what the model sees; `action.result` and the client stream still receive the full executor output. Browser tool outputs must be bounded and redacted before they return. ([installed tools guide](../../chrome-extension/node_modules/eve/docs/tools/overview.mdx))

## MV3 contracts

Chrome can stop an extension service worker after 30 seconds of inactivity, when one request or API call exceeds five minutes, or when a `fetch()` response takes more than 30 seconds. Global variables disappear on shutdown, so Chrome tells extensions to persist recoverable state and tolerate unexpected termination. ([Chrome service-worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle))

Chrome 118 and later keep an extension service worker alive while a `chrome.debugger` session is active. Astra has the `debugger` permission and its browser runtime is built on the attached CDP session, but the manifest does not set `minimum_chrome_version`. The implementation must either require Chrome 118 or prove recovery on older Chrome. ([Chrome service-worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle), [`chrome-extension/public/manifest.json`](../../chrome-extension/public/manifest.json#L1-L17))

`chrome.runtime.sendMessage()` is a one-request JSON channel. Astra's listener correctly returns literal `true` to keep the response channel open during async work. Long-lived `runtime.Port` connections support multiple messages and expose `Port.onDisconnect`; opening a port alone does not keep an MV3 worker alive on Chrome 114 and later, although sending long-lived messages resets the worker timer. ([Chrome messaging](https://developer.chrome.com/docs/extensions/develop/concepts/messaging), [Chrome service-worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle))

Chrome serializes extension messages as JSON and caps each message at 64 MiB. Screenshot payloads can cross `runtime.sendMessage`, but the bridge still needs a much lower product limit because the same image also enters Eve's durable history and model context. ([Chrome messaging](https://developer.chrome.com/docs/extensions/develop/concepts/messaging), [installed tools guide](../../chrome-extension/node_modules/eve/docs/tools/overview.mdx))

An extension page such as the side panel may make cross-origin requests only to hosts granted in `host_permissions`. Astra currently grants only `http://127.0.0.1:2000/*`, which is enough for the local Eve server and nothing remote. Chrome recommends narrow host permissions, sender validation, schema validation, and treating messages from content scripts as untrusted. ([Chrome cross-origin requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests), [Chrome extension security](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure), [`chrome-extension/public/manifest.json`](../../chrome-extension/public/manifest.json#L1-L17))

## Hard constraints for Spec 7

1. **Add an explicit local bridge.** Eve tools cannot call `chrome.runtime.sendMessage()` from the Node app runtime, and `useEveAgent` cannot execute client tools. Each tool must send a correlated request to an app-owned bridge, and the extension must forward it to the existing MV3 runtime and return the exact typed result. The bridge contract needs a version, Eve session ID, turn ID, tool call or operation ID, request ID, deadline, request kind, payload, and terminal result.

2. **Bind one Eve session to one live extension connection.** Do not route through "the most recent browser." The side panel learns the fixed Eve session cursor from `useEveAgent`; the bridge must bind that `sessionId` to the live extension connection before a browser tool can dispatch. Reconnect may rebind the same live Eve session, but a stale connection must lose ownership.

3. **Keep execution local.** The extension owns Chrome permissions, CDP, tabs, refs, snapshots, and action scheduling. Eve owns reasoning, schemas, durable turns, and model context. The bridge passes serializable commands and results only. It must not move Puppeteer or `BrowserContext` into the Eve process.

4. **Reuse the exact browser contracts.** Model tools must reuse the existing `BrowserActionRequest`, `{ tabId, snapshotId, ref }` grounded target, typed action result, observation result, deadlines, and action IDs. Do not introduce selectors, coordinates, backend node IDs, or a second ref system at the Eve boundary. ([`chrome-extension/src/browser/runtime.ts`](../../chrome-extension/src/browser/runtime.ts), [`chrome-extension/src/browser/types.ts`](../../chrome-extension/src/browser/types.ts))

5. **Return a fresh observation after page-changing work.** The extension should execute one action through the existing coordinator, then observe the selected page after the action settles. The Eve tool result should contain completion evidence plus the new public browser state. The next model step receives compact DOM text and the highlighted JPEG through `toModelOutput`.

6. **Propagate cancellation both ways.** When `ctx.abortSignal` fires, the Eve tool must stop waiting and ask the bridge to cancel the exact live Astra action ID. A bridge disconnect or extension unload must fail pending tools with a stable `browser_unavailable` or `browser_disconnected` result within a bound; it must not leave an Eve step waiting indefinitely. Closing the side panel is only a chat-stream disconnect when the worker owns the bridge. Client transport loss alone must not be mislabeled as `turn.cancelled`.

7. **Prevent duplicate mutations.** Record dispatch and terminal result before acknowledging the Eve tool. A retry after ambiguous transport loss must query that record. It must never click, type, submit, navigate, close, or open twice merely because the Eve step or bridge request retried.

8. **Fail closed on availability and identity.** Reject a browser request when no connection owns the Eve session, the connection generation changed, the deadline expired, the selected tab is unavailable, or the grounded snapshot is stale. Never fall back to another tab or connection.

9. **Minimize what leaves Chrome.** Send only the redacted public observation, bounded screenshot, tool input, completion evidence, and typed error. The Eve runtime, configured model provider, durable session store, stream clients, and any configured telemetry can receive or retain this data. That boundary must be stated in the product copy and tests. ([installed Eve security model](../../chrome-extension/node_modules/eve/docs/concepts/security-model.md), [installed tools guide](../../chrome-extension/node_modules/eve/docs/tools/overview.mdx))

10. **Prove the real path.** Acceptance needs one built unpacked-MV3 test that starts the installed Eve 0.44.4 runtime, sends a user request through the real side panel client, observes an `actions.requested` event, crosses the production bridge, executes inside the built worker, returns `action.result`, re-observes, and reaches a final assistant response. Direct tool tests or a constructed `BrowserContext` do not prove this boundary.

## Decisions carried into Spec 7

- Eve 0.44.4 documents custom HTTP and WebSocket channel routes, but it does not expose a public client-tool transport or a documented way for an authored tool executor to address and await a particular WebSocket peer. A module-global socket map would conflict with Eve's restart and multi-process durability model. Spec 7 therefore uses an application-owned local broker with explicit ownership and result storage behind custom HTTP routes. ([installed custom-channel guide](../../chrome-extension/node_modules/eve/docs/channels/custom.mdx), [installed execution guide](../../chrome-extension/node_modules/eve/docs/concepts/execution-model-and-durability.mdx))
- `ctx.callId` is stable across interrupted dispatch-step retries in the installed Eve 0.44.4 implementation because Eve dispatches the persisted pending action batch. Spec 7 uses it as the mutation idempotency key and requires a focused regression test. Recheck this before upgrading Eve because the public docs do not promise the internal storage shape.
- Spec 7 stays local-only at `127.0.0.1:2000`. A hosted Eve runtime requires HTTPS or WSS, real route authentication, a remote-safe broker, and new host permissions. Those are separate security and deployment work, not a manifest string change. ([Chrome extension security](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure), [installed Eve security model](../../chrome-extension/node_modules/eve/docs/concepts/security-model.md))
