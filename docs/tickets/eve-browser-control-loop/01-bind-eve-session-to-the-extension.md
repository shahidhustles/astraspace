# 01 - Bind an Eve session to the extension

## Goal

The built MV3 service worker can bind one restored or newly created Eve session to a private local broker and keep that binding alive when the side panel closes and reopens.

## Files

Create:
- `packages/browser-control-contract/package.json`
- `packages/browser-control-contract/tsconfig.json`
- `packages/browser-control-contract/src/index.ts`
- `packages/agent-core/agent/channels/browser-control.ts`
- `packages/agent-core/agent/lib/browser-broker.ts`
- `packages/agent-core/tests/browser-broker.test.ts`
- `chrome-extension/src/browser/bridge.ts`
- `chrome-extension/src/lib/eve-browser-session.ts`
- `chrome-extension/tests/browser-bridge.test.ts`

Modify:
- `package.json`
- `bun.lock`
- `packages/agent-core/package.json`
- `chrome-extension/package.json`
- `chrome-extension/public/manifest.json`
- `chrome-extension/src/background.ts`
- `chrome-extension/src/components/chat-panel.tsx`

## Implementation notes

- Put only versioned, JSON-safe bind, lease, request, result, cancellation, and error envelopes in `@astra-space/browser-control-contract`. Keep Puppeteer, CDP, frame, and grounding objects inside the extension.
- Add `POST /astra/v1/browser-control/bind`, `GET /astra/v1/browser-control/requests`, and `POST /astra/v1/browser-control/results` with Eve's custom `GET()` and `POST()` channel routes. These routes transport browser work; they do not replace the Eve conversation channel.
- Store atomic broker records under a namespaced OS temporary directory. Bound record sizes, lease time, terminal-result retention, and stale-file cleanup. Never write broker payloads into the repository.
- Accept only the configured `chrome-extension://` origin and exact `http://127.0.0.1:2000` local topology. Return an opaque connection-generation token from bind, require it in a header on later calls, and invalidate it on rebind.
- In the side panel, initialize `useEveAgent` with `{ initialSession: { sessionId, streamIndex: 0 }, resume: true }` when `chrome.storage.session` contains a session. Use `onSessionChange` to persist the current session ID and notify the worker. Remount the hook when restoring a different session because its session options are construction-time inputs.
- Let the service worker long-poll below Chrome's 30-second fetch limit with bounded backoff. Polling must continue independently of the side panel and must stop cleanly on rebind or extension shutdown.
- Add the manifest `storage` permission and set `minimum_chrome_version` to `118`. Store only session identity, the connection token, and bounded transport metadata in `chrome.storage.session`, never DOM, screenshots, or complete tool payloads.

## Blocked by

None.

## Done when

- Starting the first Eve turn binds its returned session ID to one extension connection, and the broker rejects a wrong origin, session, protocol version, token, or oversized payload with a typed response.
- Closing and reopening the side panel resumes the same session from stream index zero while the service worker keeps leasing commands.
- Rebinding rotates the connection token and makes the previous generation unable to lease or submit results.
- Broker tests prove atomic claim, lease expiry, bounded cleanup, and isolation between app instances and session IDs.
- `bun test packages/agent-core/tests/browser-broker.test.ts chrome-extension/tests/browser-bridge.test.ts`, TypeScript checks for all three packages, `bun run build:extension`, and `git diff --check` pass.
