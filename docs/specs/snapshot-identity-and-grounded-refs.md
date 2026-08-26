# Snapshot identity and grounded refs

## Goal

Astra can bind every browser ref to the exact observation that created it. A delayed or recycled ref may still reach its original element, but it can never silently target a newly numbered element.

## User flow

1. Astra observes the selected tab and receives one browser state with a unique snapshot identity.
2. The state presents compact numeric refs such as `[3]`. The same number may appear in later snapshots.
3. An element action carries the selected tab, snapshot, and ref together.
4. Astra looks up the ref only in that snapshot's immutable ref map and verifies that the live element still matches the recorded element.
5. Astra proceeds when the original target is still identifiable. Otherwise it returns a specific stale, missing, or ambiguous target error and does nothing.

## Requirements

### Snapshot identity

- Every successfully committed observation includes `snapshotId`, `snapshotVersion`, `documentEpoch`, and `navigationEpoch` alongside the existing browser state.
- `snapshotId` is an opaque UUID that stays unique across tabs, disconnects, and extension runtime sessions.
- `snapshotVersion` starts at 1 for each attached tab and increases once per committed observation. Failed observations do not consume a version.
- `documentEpoch` increases when the main frame receives a new CDP loader identity, including a full navigation or reload.
- `navigationEpoch` increases for a full document navigation and for same-document navigation such as History API or hash changes.
- The observer reads the main-frame identity before capture and checks it again before commit. A change during capture fails the observation.

### Ref ownership and metadata

- Ref numbers are positive integers scoped to one snapshot. They may repeat in another snapshot.
- Each committed snapshot owns an immutable map from ref number to the element metadata captured in that observation.
- Private ref metadata retains the DOM path, tag, role, accessible name, safe attributes, disabled state, and bounds. Public `ObservedRef` values remain serializable and compact.
- Ref maps store metadata, not live `ElementHandle` objects. The executor re-resolves an element when an action runs.
- A snapshot cannot commit if its ref numbers are duplicated or its public refs and private ref map disagree.

The grounded action target is:

```ts
interface GroundedTarget {
  tabId: number;
  snapshotId: SnapshotId;
  ref: number;
}
```

### Target resolution

- Resolution starts from the exact `tabId`, `snapshotId`, and `ref`. It never looks up the number in the latest snapshot as a fallback.
- A target from an older snapshot may resolve while that snapshot remains in the executable cache and its document and navigation epochs still match the live page.
- The first implementation re-resolves the recorded DOM path and verifies the result against the recorded tag, role, accessible name, and stable attributes. Bounds may support verification but cannot identify an element by themselves.
- No verified live match returns `target_not_found`.
- More than one verified candidate returns `ambiguous_ref`.
- An unknown, evicted, invalidated, detached, or epoch-mismatched snapshot returns `stale_ref`.
- Every failure is a typed result. Resolution does not throw for an expected stale, missing, or ambiguous target.

### Invalidation and cache rules

- Each tab retains its current snapshot and seven previous successful snapshots. The ninth older snapshot is evicted and becomes stale.
- Full navigation, reload, same-document navigation, unsupported-page transition, debugger detach, and tab close immediately disable execution from prior snapshots.
- Astra invalidates snapshots before dispatching its own navigate, back, and refresh operations. Browser events confirm the new epochs afterward.
- Switching tabs does not invalidate snapshots. Each attached tab keeps independent identity and cache state.
- A DOM rerender without navigation does not invalidate an entire snapshot. Target resolution must still prove that the recorded element survived.
- Cache retention is in memory only. A background or extension restart makes every prior snapshot stale.

### Atomic state publication and failure

- DOM extraction, accessibility enrichment, ref rendering, screenshot capture, URL and frame identity checks, and tab-list assembly form one staged observation.
- Astra publishes the browser state and installs its executable ref map in one commit after every stage succeeds.
- A failed stage returns no partial browser state, does not increment `snapshotVersion`, and does not publish a new ref map.
- After any observation failure, Astra disables all previously executable snapshots for that tab until a fresh observation commits. It may retain the last successful snapshot for diagnostics, but action resolution cannot use it.
- Concurrent observations for one tab remain serialized. A later request cannot partially overwrite an earlier commit.

## Implementation decisions

- Add branded snapshot identity types, `GroundedTarget`, and a discriminated target-resolution result to the browser types. Extend `PageObservation` and `BrowserState` with the four snapshot identity fields.
- Add a snapshot module under `chrome-extension/src/browser/` that owns immutable snapshot records, the eight-entry per-tab cache, validation, invalidation, and exact target lookup.
- Let `BrowserPage` own a main-frame identity tracker backed by a CDP session. Track full-document and same-document navigation separately, and dispose the session with the page connection.
- Preserve `domPath` and verification fields when `renderPageContent` builds public refs. Keep the internal ref map out of the serializable `BrowserState`.
- Split observation into staging and commit so `BrowserContext.observe()` can include tab-list success in the atomic boundary. The context must invalidate the staged result if final assembly fails.
- Keep the existing observation queue. Commit IDs and versions in queue order.
- Model expected lookup failures as a discriminated union with `stale_ref`, `target_not_found`, and `ambiguous_ref` variants. Each error includes the grounded target and a safe reason suitable for action results.
- Do not copy the reference package's latest-map lookup, mutable cached-state alias, or fallback to old state after capture failure. Keep its useful metadata-based re-resolution approach.

## Demo / acceptance

- [ ] Two observations of the same tab receive different snapshot IDs and increasing versions, even when both assign `[1]`.
- [ ] A target from the older retained snapshot uses that snapshot's original metadata and never the newer `[1]` record.
- [ ] The ninth older snapshot is evicted and returns `stale_ref`.
- [ ] Full navigation, reload, and same-document navigation make earlier targets stale before an action can run.
- [ ] Replacing the recorded element between observation and resolution returns `target_not_found` instead of using a different element at the same DOM path.
- [ ] Multiple verified candidates return `ambiguous_ref` and no target.
- [ ] A failed extraction, screenshot, identity check, or tab-list assembly publishes no state and disables prior snapshots for execution.
- [ ] Parallel observation requests commit complete states in request order without mixing DOM, refs, screenshot, tabs, or identity.
- [ ] Browser unit tests and the real Chrome observation integration test pass, and `bun run build:extension` succeeds.

## Out of scope

- Same-origin and cross-origin iframe identity, shadow roots, backend node IDs, selector fallbacks, and detached-handle recovery. Spec 4 owns these.
- Click, type, scroll, dropdown, keyboard, and navigation action implementations. Spec 5 consumes the grounded target contract.
- Action wait barriers, retries, and post-action evidence. Spec 6 owns these.
- Eve tool schemas, model prompting, and the observe-reason-act loop. Spec 7 owns these.
- Snapshot persistence across extension restarts, UI history, and long-term browser-state storage.
