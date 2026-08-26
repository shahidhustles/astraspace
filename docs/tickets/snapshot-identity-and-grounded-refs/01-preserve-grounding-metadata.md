# 01 - Preserve grounding metadata

## Goal

Each rendered numeric ref has a private element record from the same extraction, while the public observation stays compact and serializable.

## Files

Create:
- None.

Modify:
- `chrome-extension/src/browser/observation/types.ts`
- `chrome-extension/src/browser/observation/render.ts`
- `chrome-extension/src/browser/observation/index.ts`
- `chrome-extension/tests/browser-observation-render.test.ts`

## Implementation notes

- Add a private grounding record with the ref, DOM path, tag, role, accessible name, safe attributes, disabled state, and bounds.
- Return public refs and private grounding records from the same render traversal so their numbering cannot drift.
- Do not expose DOM paths or mutable page objects through `ObservedRef`.

## Blocked by

None.

## Done when

- Rendering a fixture produces one private grounding record for every public ref, with the matching number and DOM path.
- Public ref records still survive a JSON round trip and contain no private locator data.
