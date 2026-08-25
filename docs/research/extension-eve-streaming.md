# Extension to Eve streaming research

## Scope

This note covers one vertical slice: a React and TypeScript Chrome MV3 interface sends a text prompt to the Eve 0.44.4 runtime in `packages/agent-core`, then renders assistant text and reasoning while they stream. Browser observation, redaction, and browser actions are outside this slice.

The repository currently has a plain Vite TypeScript extension, not React. Its manifest defines only an action popup. The agent uses Eve 0.44.4 with the static model `zai/glm-5.2`, and its generated Eve channel accepts `localDev()` but deliberately rejects ordinary production browser traffic through `placeholderAuth()` ([extension package](../../chrome-extension/package.json), [manifest](../../chrome-extension/public/manifest.json), [agent package](../../packages/agent-core/package.json), [agent config](../../packages/agent-core/agent/agent.ts), [channel config](../../packages/agent-core/agent/channels/eve.ts)).

## Finding

Use `useEveAgent()` from `eve/react` in the visible extension page. Render its `agent.data.messages` with AI Elements. Do not use AI SDK `useChat()` for this slice, and do not relay the live response through the MV3 service worker.

Eve already owns the required transport work. Its React hook creates or attaches to a durable session, posts messages, parses Eve's NDJSON event stream, projects events into render-ready messages, reconnects by stream index, and exposes `ready`, `submitted`, `streaming`, and `error` states ([Eve frontend guide](../../packages/agent-core/node_modules/eve/docs/guides/frontend/overview.mdx)). Eve's own installed web scaffold combines `useEveAgent()` with AI Elements `Conversation`, `Message`, `PromptInput`, and `Reasoning`, which confirms this composition for the installed release ([Eve 0.44.4 scaffold source](../../packages/agent-core/node_modules/eve/dist/src/setup/scaffold/create/web-template.js)).

AI SDK `useChat()` is a different state and transport layer. Its default transport expects the AI SDK UI message stream protocol returned by APIs such as `toUIMessageStreamResponse()`, while Eve exposes newline-delimited Eve events such as `message.appended`, `reasoning.appended`, and `session.waiting` ([AI SDK chat transport](https://github.com/vercel/ai/blob/ai%406.0.0/content/docs/04-ai-sdk-ui/02-chatbot.mdx), [Eve session protocol](../../packages/agent-core/node_modules/eve/docs/concepts/sessions-runs-and-streaming.md)). A custom `ChatTransport` could translate Eve events into AI SDK UI chunks, but that would duplicate Eve's session creation, cursor, reconnect, cancellation, and event projection. It buys nothing for this v1.

Eve messages follow the AI SDK `UIMessage` rendering convention, but Eve explicitly says the types are not interchangeable because it adds authorization and human-input parts and permits file parts without URLs ([Eve frontend guide](../../packages/agent-core/node_modules/eve/docs/guides/frontend/overview.mdx), [Eve message types](../../packages/agent-core/node_modules/eve/dist/src/client/message-reducer-types.d.ts)). The requested AI Elements accept the primitive values this slice needs, so no whole-message cast is necessary. Pass `message.role` to `Message`, text to `MessageResponse`, and reasoning text to `ReasoningContent` after narrowing `part.type`.

## Narrow v1 architecture

```text
Chrome side panel or popup
  React + AI Elements
  useEveAgent({ host, auth, initialSession, initialEvents, resume })
          |
          | HTTPS POST + GET NDJSON stream
          v
Eve channel in packages/agent-core
  /eve/v1/session
  /eve/v1/session/:sessionId
  /eve/v1/session/:sessionId/stream
          |
          v
Eve durable runtime and configured model

MV3 service worker
  opens the extension surface and later owns Chrome browser APIs
  does not proxy or hold the Eve stream
```

Chrome allows an extension page or service worker to fetch a remote origin when that exact origin is declared in `host_permissions`; content scripts do not inherit that cross-origin ability ([Chrome cross-origin requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)). This makes a direct visible-page-to-Eve connection possible.

The service worker is the wrong stream owner. Chrome normally terminates it after 30 seconds of inactivity, caps a single event or API call at five minutes, and can terminate it when a `fetch()` response takes more than 30 seconds to arrive. Chrome tells extension authors to persist state and design for unexpected termination ([Chrome service-worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)). Long-lived extension ports do not remove the design problem: since Chrome 114, opening a port alone does not reset the worker timer; messages sent through it do ([same lifecycle guide](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)).

The foreground extension page can own the fetch while it exists. If it closes, Eve keeps the durable turn running. Eve states that unmounting or closing the page disconnects the local stream but does not cancel server execution; reopening can reattach with the saved `sessionId` and `streamIndex` ([Eve frontend guide](../../packages/agent-core/node_modules/eve/docs/guides/frontend/overview.mdx), [Eve streaming guide](../../packages/agent-core/node_modules/eve/docs/guides/client/streaming.mdx)).

### Recommended extension surface

Use a Chrome side panel for the chat. Chrome describes side panels as persistent extension pages that stay beside the webpage, can remain open across tab navigation, and have access to Chrome APIs ([Chrome Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)). This matches a conversation that must remain visible while the user works on a page. It also matches `DESIGN.md`, which reserves the popup for a compact launcher and the side panel or a dedicated extension page for sustained work.

Keeping the current action popup is possible for the first visual demo. Chrome caps popups at 800 by 600 pixels ([Chrome Action API](https://developer.chrome.com/docs/extensions/reference/api/action)). A popup disconnect must therefore be treated as normal, not as cancellation. The app must persist the Eve cursor as soon as it becomes available and resume when reopened.

## AI Elements API check

AI Elements is copied component source, not a sealed widget library. Its setup command writes components into the application's component directory, after which the project owns and can restyle them ([AI Elements setup](https://github.com/vercel/ai-elements/blob/main/apps/docs/content/docs/setup.mdx), [AI Elements usage](https://github.com/vercel/ai-elements/blob/main/apps/docs/content/docs/usage.mdx)). This is useful here because the copied Tailwind classes can be mapped to the tokens in `DESIGN.md`.

There is one support caveat. The current AI Elements setup page lists React 19, Next.js 14 or later, shadcn/ui, and Tailwind CSS 4 as prerequisites ([AI Elements setup](https://github.com/vercel/ai-elements/blob/main/apps/docs/content/docs/setup.mdx)). shadcn/ui separately documents a React and TypeScript Vite setup ([shadcn Vite guide](https://ui.shadcn.com/docs/installation/vite)), and Vite officially provides a `react-ts` template ([Vite guide](https://vite.dev/guide/)). Therefore, using the copied AI Elements source in this Vite extension is a reasonable adaptation, but it is not a combination AI Elements currently documents as a supported target.

The requested names are compound component families:

| Requested name | Exact role and useful exports |
|---|---|
| `Conversation` | Scroll container family: `Conversation`, `ConversationContent`, `ConversationEmptyState`, and `ConversationScrollButton`. `ConversationDownload` exists but expects AI SDK `UIMessage[]`, so omit it from v1 rather than casting Eve messages. [Source](https://github.com/vercel/ai-elements/blob/main/apps/docs/content/components/%28chatbot%29/conversation.mdx) |
| `Message` | Message family: `Message`, `MessageContent`, and `MessageResponse`. `MessageResponse` renders streaming Markdown with Streamdown. Its stylesheet needs the documented Tailwind `@source` entry for Streamdown. [Source](https://github.com/vercel/ai-elements/blob/main/apps/docs/content/components/%28chatbot%29/message.mdx) |
| `PromptInput` | Composer family: `PromptInput`, `PromptInputTextarea`, `PromptInputSubmit`, and optional layout/tool subcomponents. `onSubmit` receives a `PromptInputMessage`. [Source](https://github.com/vercel/ai-elements/blob/main/apps/docs/content/components/%28chatbot%29/prompt-input.mdx) |
| `Context` | Token-usage hover-card family: `Context`, `ContextTrigger`, `ContextContent`, header/body/footer pieces, and input/output/reasoning/cache usage rows. It is not a page-context editor. The root needs `maxTokens`, `usedTokens`, optional AI SDK usage, and optional `modelId`. [Source](https://github.com/vercel/ai-elements/blob/main/apps/docs/content/components/%28chatbot%29/context.mdx) |
| `ModelSelector` | Searchable dialog family built on `cmdk`: root, trigger, content, input, list, group, item, logo, and name components. It manages selection UI only. It does not change an Eve model. [Source](https://github.com/vercel/ai-elements/blob/main/apps/docs/content/components/%28chatbot%29/model-selector.mdx) |
| `Reasoning` | Collapsible family: `Reasoning`, `ReasoningTrigger`, and `ReasoningContent`. `isStreaming` controls its automatic open and close behavior. [Source](https://github.com/vercel/ai-elements/blob/main/apps/docs/content/components/%28chatbot%29/reasoning.mdx) |

The direct composition is:

1. `useEveAgent()` supplies `data.messages`, `status`, `send`, `cancel`, `events`, and the durable session cursor.
2. `Conversation` lays out the list.
3. Each Eve message renders through `Message` and `MessageContent`.
4. A narrowed `text` part renders through `MessageResponse`.
5. A narrowed `reasoning` part renders through `Reasoning`, using the part's `state === "streaming"` flag.
6. `PromptInput` calls `agent.send(message.text)` and maps Eve's busy state to the submit control.

Eve's default reducer already merges `message.appended` and `reasoning.appended` deltas into the current parts, so the component layer should render state rather than concatenate raw deltas itself ([Eve frontend guide](../../packages/agent-core/node_modules/eve/docs/guides/frontend/overview.mdx), [Eve streaming guide](../../packages/agent-core/node_modules/eve/docs/guides/client/streaming.mdx)).

### Context and model data

Eve emits the concrete model ID in `step.started`. `step.completed` can include input, output, cache-read, cache-write, and cost usage ([Eve stream types](../../packages/agent-core/node_modules/eve/dist/src/protocol/message.d.ts)). The extension can derive the currently reported model and token counts from `agent.events`. Static agent information can expose `agent.model.contextWindowTokens` through `GET /eve/v1/info` ([Eve client guide](../../packages/agent-core/node_modules/eve/docs/guides/client/overview.mdx)).

Do not show `0` when the provider omits usage or the context-window size is unavailable. `DESIGN.md` requires `Not measured` for unavailable runtime evidence. Render `Context` only once both the usage and a defensible maximum exist; otherwise render a small unavailable label.

The current model selector cannot be functional without backend work. `packages/agent-core/agent/agent.ts` chooses one static model. Eve supports dynamic models at session, turn, or step boundaries, but changing model mid-session has cache and cost consequences ([Eve agent configuration](../../packages/agent-core/node_modules/eve/docs/agent-config.md)). For the narrowest v1, display the configured model as a disabled or single-option selector. If multiple models are required, define an allowlist and a verified way for the Eve resolver to select from it. Never send an arbitrary provider model ID from the extension and trust it at the runtime boundary.

Reasoning should be rendered only when Eve supplies a `reasoning` part. The current repository does not prove that `zai/glm-5.2` will produce reasoning events under its present configuration. Eve also warns that reasoning can have privacy and confidentiality implications, so keep the block collapsed after streaming and do not claim it is always available ([Eve session protocol](../../packages/agent-core/node_modules/eve/docs/concepts/sessions-runs-and-streaming.md)).

## Request and streaming sequence

The hook handles this sequence; it is included to make the wire contract explicit.

1. On extension-page boot, load the saved Eve event prefix and `{ sessionId, streamIndex }` from extension storage.
2. Mount `useEveAgent({ host, auth, initialEvents, initialSession, resume: true })` when a saved session exists.
3. For a first prompt, `agent.send(text)` posts `{ message: text }` to `POST /eve/v1/session`. Eve immediately returns the durable `sessionId` in JSON and the `x-eve-session-id` header ([Eve session protocol](../../packages/agent-core/node_modules/eve/docs/concepts/sessions-runs-and-streaming.md)).
4. The client attaches to `GET /eve/v1/session/:sessionId/stream`, an NDJSON stream. `message.appended` and `reasoning.appended` update the visible answer as deltas arrive. `session.waiting` marks the session ready for another user message ([Eve session protocol](../../packages/agent-core/node_modules/eve/docs/concepts/sessions-runs-and-streaming.md)).
5. Persist the session cursor through `onSessionChange` and the event prefix through `onEvent` or a throttled snapshot. Do not wait only for `onFinish`, because the extension page may close during the turn. Eve event IDs remain stable across reconnects, and the hook drops duplicate events in overlapping replay ([Eve frontend guide](../../packages/agent-core/node_modules/eve/docs/guides/frontend/overview.mdx)).
6. A follow-up goes to `POST /eve/v1/session/:sessionId` and keeps the same durable history. Eve's default follow-up policy is `steer`, which replaces an active turn; the v1 UI should either disable submit while busy or deliberately pass `turnPolicy: "steer"` ([Eve channel guide](../../packages/agent-core/node_modules/eve/docs/channels/eve.mdx)).
7. If the panel or popup closes, aborting the local reader does not stop the Eve turn. On reopen, restore the cursor and call the hook with `resume: true`; it reconnects from the saved stream index. The Stop control must call `agent.cancel()` because disconnect and cancellation are different operations ([Eve streaming guide](../../packages/agent-core/node_modules/eve/docs/guides/client/streaming.mdx)).

Chrome recommends `chrome.storage` instead of `window.localStorage` for extension state shared with a service worker. `storage.session` is memory-backed, clears on browser restart or extension reload, and is not exposed to content scripts by default; `storage.local` persists until extension removal and is exposed to content scripts by default unless its access level is reduced ([Chrome Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)). For the least sensitive v1, store the active cursor and projected chat in `chrome.storage.session`. Store long-lived history only after deciding its retention and access policy.

## Local development

Use two processes:

```text
bun run dev:agent       # Eve on http://127.0.0.1:2000
bun run dev:extension   # Vite UI development
```

For ordinary Vite browser development, proxy `/eve/v1/**` to `http://127.0.0.1:2000` so the page stays same-origin. For real extension testing, build or watch the extension, load its output unpacked, set the Eve host to `http://127.0.0.1:2000`, and declare `http://127.0.0.1:2000/*` in the development manifest's `host_permissions`. Eve's `localDev()` authenticator accepts requests only while `eve dev` or `vercel dev` is running and does not open a production deployment ([Eve authentication guide](../../packages/agent-core/node_modules/eve/docs/guides/auth-and-route-protection.md)).

Eve leaves CORS untouched by default and can enable either permissive or origin-restricted CORS on `eveChannel()` ([Eve channel guide](../../packages/agent-core/node_modules/eve/docs/channels/eve.mdx)). A normal Vite browser page needs either the same-origin proxy or Eve CORS. A packaged extension page can use its declared host permission, but a narrow server CORS allowlist for the stable production extension origin remains useful defense in depth. If `connect-src` is added to the extension CSP, it must include the Eve origin; Chrome's default extension CSP does not restrict connections, while its script policy permits only packaged code and cannot be relaxed to allow remote script sources or `unsafe-eval` ([Chrome extension CSP](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy), [Chrome cross-origin requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)).

## Minimum production-safe connection

The production endpoint must be HTTPS and should be the only remote host in `host_permissions`. Do not grant `https://*/` for this feature ([Chrome cross-origin requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)). Bundle all React, AI Elements, font, icon, and Markdown code with the extension because MV3 extension pages cannot load remote executable code under Chrome's minimum CSP ([Chrome extension CSP](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)).

Do not ship a shared API key, HMAC signing secret, Vercel service token, or provider key in the extension. Use an interactive user sign-in to obtain a short-lived bearer token, then supply it through `useEveAgent({ auth: { bearer: async () => getAccessToken() } })`. Eve resolves dynamic auth before every request and reconnect ([Eve frontend guide](../../packages/agent-core/node_modules/eve/docs/guides/frontend/overview.mdx)). Chrome's `identity.launchWebAuthFlow()` is the browser-native option for non-Google OAuth providers, and `chrome.identity` requires the `identity` permission ([Chrome Identity API](https://developer.chrome.com/docs/extensions/reference/api/identity)). Keep access tokens in memory or `chrome.storage.session`, not durable synced storage.

Replace `placeholderAuth()` in `packages/agent-core/agent/channels/eve.ts` with `oidc()`, `jwtEcdsa()`, or a custom `AuthFn` that validates the bearer and returns a stable user principal. The default Eve production policy fails closed, and `vercelOidc()` by itself is for trusted Vercel callers rather than ordinary extension users ([Eve authentication guide](../../packages/agent-core/node_modules/eve/docs/guides/auth-and-route-protection.md)).

Route authentication alone does not prove that the current user owns a supplied Eve `sessionId`. Eve explicitly leaves per-user and per-tenant session ownership to the application boundary ([Eve authentication guide](../../packages/agent-core/node_modules/eve/docs/guides/auth-and-route-protection.md)). Before calling this production-safe, place a thin authenticated gateway in front of the canonical Eve routes or add an equivalent application policy that records session ownership at creation and rejects later message, stream, cancel, and reset requests from another principal. The gateway can proxy Eve's NDJSON unchanged; it does not need an AI SDK adapter.

## Files and package boundaries likely to change

No code is changed by this research. The eventual build should stay inside these boundaries:

- `chrome-extension/package.json`: React 19, React DOM, Eve 0.44.4 client usage, Tailwind 4, shadcn and copied AI Elements dependencies, Vite React tooling, and Chrome types.
- `chrome-extension/vite.config.ts`: React plugin, development Eve proxy, and extension build entries.
- `chrome-extension/src/main.tsx` and chat components: `useEveAgent`, AI Elements composition, session restoration, actual usage projection, and `DESIGN.md` tokens.
- `chrome-extension/src/components/ai-elements/*`, `src/components/ui/*`, and `src/lib/utils.ts`: copied component source and shadcn primitives. These belong to the extension, not `packages/shared`, until another app consumes them.
- `chrome-extension/src/background.ts`: side-panel opening and later browser-control message routing. It must not own the Eve stream.
- `chrome-extension/public/manifest.json`: MV3 module worker, side panel or popup entry, narrow `host_permissions`, `storage`, and optional `sidePanel` and `identity` permissions.
- `packages/agent-core/agent/channels/eve.ts`: development CORS if the Vite proxy is not used, plus real production bearer validation.
- `packages/agent-core/agent/agent.ts`: only if model choice or reasoning configuration becomes functional.
- Root `package.json`: one combined development command is optional, not required for the vertical slice.

## Confirmed facts, recommendations, and unknowns

Confirmed:

- Eve 0.44.4 has the browser hook and durable streaming contract this UI needs.
- Eve's stream is not the AI SDK UI message stream.
- The requested AI Elements are compound families. `Context` means token usage, and `ModelSelector` is presentation only.
- A foreground extension page can call a permitted remote host directly.
- MV3 worker lifetime makes it a poor relay for a reconnectable chat stream.
- The current Eve channel works locally and rejects normal production browser requests.

Recommended:

- Side panel as the v1 conversation surface.
- `useEveAgent`, not `useChat`.
- Static, single-option model display for the first streaming slice.
- Render Context only from actual Eve usage and model metadata.
- Persist cursor and event state in `chrome.storage.session`, then resume after the UI reopens.
- Direct extension-to-Eve locally; HTTPS bearer-authenticated gateway-to-Eve in production with session ownership checks.

Unknown until implementation or product decisions:

- Whether v1 is a side panel or the existing popup.
- Which production identity provider and Eve host will be used.
- Whether `zai/glm-5.2` emits reasoning content in the configured environment.
- Whether the ModelSelector must change the backend model or only show the configured model.
- Whether context means latest-call usage, cumulative session usage, or only remaining context-window capacity.

## Build-changing decisions

1. **Surface:** side panel or popup? Recommended: side panel, because the conversation stays visible while the user interacts with the page.
2. **Client state layer:** Eve `useEveAgent` or an AI SDK `useChat` adapter? Recommended: `useEveAgent`; the adapter would duplicate Eve's durable protocol.
3. **Model selector:** functional multi-model routing or a single configured model in v1? Recommended: single configured model. Add dynamic routing only when there is a real model allowlist.
4. **Context meaning:** latest model-call usage or cumulative session usage? Recommended: latest call plus the configured context maximum, labeled precisely and hidden when not measured.
5. **Reasoning:** show provider reasoning when available? Recommended: yes, collapsed after streaming. Never fabricate it when the model sends none.
6. **Demo auth:** local-only demo now or sign-in in this first slice? Recommended: use Eve `localDev()` for the local vertical slice, but lock the production contract to short-lived user bearer tokens and session ownership checks.
