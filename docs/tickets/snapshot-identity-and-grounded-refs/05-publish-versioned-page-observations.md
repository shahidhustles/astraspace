# 05 - Publish versioned page observations

## Goal

Every successful page observation publishes its snapshot identity with the synchronized DOM, refs, and screenshot.

## Files

Create:
- None.

Modify:
- `chrome-extension/src/browser/page.ts`
- `chrome-extension/src/browser/types.ts`
- `chrome-extension/tests/browser-page-observation.test.ts`
- `chrome-extension/tests/browser-page.test.ts`

## Implementation notes

- Attach and dispose the main-frame identity tracker with the Puppeteer connection.
- Stage the observation before committing it to the snapshot store. Keep a page-level `observe()` wrapper for focused tests and callers.
- Compare URL and frame identity before and after extraction, accessibility enrichment, highlighting, and screenshot capture.
- Add the four identity fields to `PageObservation` and `BrowserState`.
- A failed capture must not consume a version or leave its ref map executable.

## Blocked by

- 04 - Reject unusable snapshots

## Done when

- Two successful observations return unique snapshot IDs and increasing versions with the current document and navigation epochs.
- Navigation during capture or any capture failure returns no state, consumes no version, and disables earlier snapshots until a later observation succeeds.
