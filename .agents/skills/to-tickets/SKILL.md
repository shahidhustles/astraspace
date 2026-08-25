---
name: to-tickets
description: Slice a spec into small capability tickets, each verifiable.
disable-model-invocation: true
---

# To tickets

Turn a spec into small capability tickets. Keep the loop tight. Build a little, verify it works, continue.

Prefer vertical slices over layers.

## 1. Gather context

Read spec and project docs. Inspect codebase for structure, relevant modules and routes, database and schema, integrations, and likely files.

Hold product decisions from the spec.

Done when you can name structure, key modules, schema location, and expected files without guessing.

## 2. Split by capability

Slice into the smallest capabilities you can build and verify alone.

A capability can cross frontend, backend, database, API, and integrations when that is what it takes to work.

Prefer

```
Upload a document and verify it is stored
```

over

```
Create upload UI
Create upload API
Create documents table
```

Write vertical slices. One ticket holds all layers a capability needs.

Done when every ticket describes one capability that is verifiable alone.

## 3. Keep tickets small

Aim for 15 to 30 minutes per ticket.

When a ticket has two independent verifiable outcomes, split it. Keep each split still useful alone.

Check each ticket by asking. What becomes verifiable after this ticket that was not before. That can be UI, API, database, logs, integration, or other observable output.

Done when each ticket answers that question with one outcome.

## 4. Order by dependencies

Sequence by real build dependencies. Each ticket lists what blocks it.

Keep chains simple. Wait to create an enabling or refactor ticket until the next capability cannot be built cleanly without it. Keep small support work inside the capability ticket.

Done when every ticket lists its blockers and the chain has no invented parallelism.

## 5. Name the change surface

List files to create or modify. Use exact paths after inspecting the repo. Mark as likely when you cannot know for sure.

Treat the list as guide, not fence. Touch another file if the build requires it.

Done when every ticket names its expected files.

## 6. Write each ticket

Use this format.

```md
# <NN> - <Title>

## Goal

Single capability this ticket makes work. Behavior, not layers.

## Files

Create:
- `<path>`

Modify:
- `<path>`

## Implementation notes

Only what the builder must keep. Short. Omit if not needed.

## Blocked by

- <NN> - <title>

or None.

## Done when

- Concrete observable result that can be checked by hand
```

Write Done when as outcomes, not steps. Prefer "A natural language query returns related records" over "Retrieval function implemented."

Done when every ticket follows this format and Done when is checkable by hand.

## 7. Save

Use the project's ticket location if it has one. Otherwise `docs/tickets/<feature-slug>/` with `01-<slug>.md`, `02-<slug>.md` in dependency order.

Keep the work to tickets. Leave out separate test plans. Add automated tests only when the spec asks or the logic has high leverage. Leave building to the builder.

Done when every ticket is small, notes its blockers, names its files, and gives a concrete result you can verify before moving on.
