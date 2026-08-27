# 03 - Measure navigation and frame commits

## Goal

Navigate, back, and refresh actions prove the committed document or same-document route and the quiet page state that followed it.

## Files

Create:
- `chrome-extension/src/browser/waits/navigation.ts`
- `chrome-extension/tests/browser-navigation-waits.test.ts`

Modify:
- `chrome-extension/src/browser/waits/coordinator.ts`
- `chrome-extension/src/browser/waits/types.ts`
- `chrome-extension/src/browser/document-identity.ts`
- `chrome-extension/src/browser/page.ts`
- `chrome-extension/src/browser/url-policy.ts`
- `chrome-extension/tests/fixtures/browser-action-waits.html`

## Implementation notes

- Register CDP, `FrameGraphTracker`, request, and DOM watchers before calling Puppeteer navigation methods. A `load` event alone cannot complete the policy.
- Record main-frame commits, same-document navigation, child-frame navigation, old and final URLs, document identity, and frame identity without guessing from URL changes alone.
- Completion requires the expected main-frame or same-document signal, an allowed final URL, and the quiet conditions from ticket 02.
- Reinstall a DOM observer when frame navigation destroys its execution context. Stop tracking a detached frame and remove its pending work.
- Check the URL policy after direct and action-induced navigation. An unsupported redirect invalidates the tab and returns its typed error with failure evidence.

## Blocked by

- 02 - Wait for edit-driven page work

## Done when

- A navigation that commits immediately after dispatch is captured and reports its final URL, frame identity, DOM quiet, and network quiet.
- Back, refresh, and a same-document route change complete without treating URL equality or a load event as sufficient evidence.
- A nested same-origin or cross-origin frame navigation contributes frame-specific evidence and leaves no dead observer behind.
- A redirect to an unsupported URL fails closed and leaves every prior snapshot for that tab stale.
- `bun test chrome-extension/tests/browser-navigation-waits.test.ts chrome-extension/tests/browser-page.test.ts chrome-extension/tests/browser-document-identity.test.ts` passes.
