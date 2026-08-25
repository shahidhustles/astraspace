---
name: implement
description: Build one ticket. Tight code, verifiable outcome, one commit.
disable-model-invocation: true
---

# Implement

Build one ticket in a tight loop. Understand, build, verify, review, human test, commit.

Aim for readable, working code over abstraction.

## 1. Read the context

Read ticket, parent spec, every file the ticket names, related flow code, and relevant docs.

Capture goal, change surface, dependencies, constraints, and Done when.

Follow spec decisions. Keep changes inside this ticket. Include a small supporting change only if this ticket cannot work without it.

Done when you can state goal, files, and Done when from memory.

## 2. Fetch current docs

Fetch docs for every external library you will touch.

If a skill covers the tech, use it. Otherwise use Context7 for the part you need. Fall back to official docs if Context7 is thin.

Treat the fetched docs as source. Query only what the ticket needs.

Done when every signature, prop, and pattern you will use comes from fetched docs, not memory.

## 3. Build tight

Write the simplest code that works and stays readable. Use clear names, direct flow, and existing patterns. Keep feature logic where it belongs.

Keep code local until sharing is needed. When several complex pieces belong together, hide them behind one small interface.

Build tight. Use a single wrapper only when the ticket demands it. Leave factories, managers, and providers out unless needed. Prefer plain code over clever code. Remove comments that repeat the code and refactors outside the ticket.

Done when the capability works and the diff stays focused on this ticket.

## 4. Respect the ticket boundary

Build the full capability across layers when the feature needs it. Frontend, server actions, APIs, database, storage, integrations, and shared logic can live in one slice.

Build only this ticket. If real files differ from the ticket list, adjust and note the difference.

Done when the ticket capability works end to end, with no extra ticket started.

## 5. Verify while building

Run light checks that fit the project. Typecheck, build, lint when useful, existing tests for changed behavior, and targeted runtime checks. Fix what you broke.

Add a new test only when it has clear leverage. Complex logic, state transitions, parsing, or regression prone code with a cheap seam qualifies.

Done when typecheck and build pass and related tests are green.

## 6. Verify the outcome

Re-read Done when. Exercise the real capability through app, API, database, logs, or integration.

Count the ticket done only when the observable result works.

Done when every Done when item is observable in the running system.

## 7. Review architecture

Inspect the diff.

Check ownership of behavior, seam placement, complexity leaking to callers, duplicated knowledge, state ownership, local versus shared code, hidden dependencies, and shortcuts that burden the next ticket.

Skip generic style review.

When a real choice exists, ask 1 to 4 questions in one batch. State the choice, why it matters, and a recommended answer. If the structure is already clear, ask nothing. Wait for answers, apply what was agreed, then re-verify.

Done when the diff has no open architecture question.

## 8. Give human test steps

Write short steps that prove the ticket. you may as well use `/wizard` skill.

Name where to go, what data to enter, what to do, what to see, what state to check, and one key failure case. Keep it to this ticket.

Example

```md
## Human test

1. Start the app with `<command>`
2. Open `<route>`
3. Perform `<action>`
4. Confirm `<visible result>`
5. Check `<database or API>` for `<expected state>`
6. Try `<failure case>` and confirm `<expected behavior>`
```

Write steps a human can follow without reading code.

Done when someone can follow the steps and see the expected result.

## 9. Commit

Commit only after build, review, and verification are done.

1. Run `git status` and review the diff
2. Remove debug code, temp files, and dead experiments
3. Check no secrets or unrelated changes are included
4. Confirm Done when is met
5. Check `git log --oneline -10` and match the repo commit style

If no style exists, use `feat:`, `fix:`, or `refactor:` with a short message. One ticket is one commit.

Done when git shows one clean commit for this ticket on top of prior history.

## Done

Report what was built, files changed, checks run, human test steps, any architecture choices, and the commit.

Complete when the observable result works, the code stays readable, a human can verify it, and the work is in one clean commit.
