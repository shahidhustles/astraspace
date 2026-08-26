# 02 - Track main-frame epochs

## Goal

An attached page can distinguish a new main document from a same-document navigation and expose a stable identity token for observation checks.

## Files

Create:
- `chrome-extension/src/browser/document-identity.ts`
- `chrome-extension/tests/browser-document-identity.test.ts`

Modify:
- None.

## Implementation notes

- Initialize the tracker from the main frame returned by CDP `Page.getFrameTree`.
- A changed main-frame loader ID increases both document and navigation epochs. `Page.navigatedWithinDocument` increases only the navigation epoch.
- Ignore subframe events. Make listener cleanup explicit so reconnects cannot retain an old session.
- Return immutable identity values that can be compared before and after a capture.

## Blocked by

None.

## Done when

- A main-frame loader change increases both epochs, a History API or hash navigation increases only the navigation epoch, and subframe events change neither.
- The tracker reports the same identity before and after a quiet interval and stops reacting after disposal.
