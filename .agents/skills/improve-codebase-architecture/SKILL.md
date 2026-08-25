---
name: improve-codebase-architecture
description: Improve coding-agent feedback loops by finding places where complexity can be concentrated behind smaller, clearer interfaces.
disable-model-invocation: true
---

# Improve Codebase Architecture

Improve the codebase so future coding-agent changes are easier to understand, implement, and verify.

The main idea is simple:

**put related complexity inside deep modules with small interfaces.**

Do not perform architecture work for elegance alone.

The goal is a shorter feedback loop for future development:

**less code to understand → fewer places to change → smaller blast radius → easier verification**

## 1. Choose a useful scope

If the user names a feature, module, route, or area, inspect that area.

Otherwise identify recently active parts of the codebase using:

- recent commits;
- files changed frequently;
- modules touched by recent tickets;
- areas where implementing changes requires jumping through many files.

Prefer architecture improvements in code that is likely to change again.

Do not audit the entire repository unless explicitly requested.

## 2. Find feedback-loop friction

Explore the relevant code and look for places where a coding agent has to understand too much before making a small change.

Useful signals include:

- one behaviour spread across many files;
- several callers repeating the same knowledge;
- shallow wrapper modules that add names but hide no complexity;
- interfaces exposing implementation details callers should not need;
- changes that regularly require editing multiple unrelated-looking places;
- state or business rules owned by several modules;
- external integrations leaking their details throughout feature code;
- modules with many public functions that callers must coordinate correctly.

Do not treat file count, function length, or class size as problems by themselves.

Focus on **knowledge distribution and change locality**.

## 3. Look for deep-module opportunities

A good candidate moves complexity from callers into one module with a smaller interface.

Prefer:

```text
small interface
      ↓
deep module
      ↓
complex implementation hidden inside
```

over:

```text
caller
 ↓
wrapper
 ↓
helper
 ↓
manager
 ↓
adapter
 ↓
implementation
```

A module earns its existence when removing it would force important complexity back into multiple callers.

When evaluating a candidate, ask:

- Can callers know less?
- Can fewer files change when this behaviour changes?
- Can several steps become one meaningful operation?
- Can implementation-specific knowledge stay inside one place?
- Can the resulting behaviour be verified through the smaller interface?

Do not introduce a new interface merely because mocking or abstraction is possible.

One concrete implementation with no real variation usually does not need an abstraction around it.

## 4. Prefer consolidation over layering

When improving architecture, first consider whether related code should simply be moved together.

Do not solve shallow architecture by adding another wrapper.

Prefer:

- combining tightly related logic;
- deleting pass-through modules;
- reducing public functions;
- moving orchestration behind an existing useful interface;
- hiding vendor-specific details inside the feature that owns them;
- making one module responsible for one meaningful capability.

The desired result is usually **fewer concepts**, not more.

## 5. Present only high-value candidates

Do not immediately refactor.

Present at most **3 architecture opportunities**, ordered by expected improvement to the coding feedback loop.

For each include:

### <Candidate name>

**Current friction:**  
Why future changes currently require too much context or too many edits.

**Proposed shape:**  
What complexity should move together and what smaller interface should remain visible.

**Why it helps:**  
How this improves locality, understanding, implementation speed, or verification.

**Likely files:**  
The main files expected to move, merge, disappear, or change.

**Recommendation:**  
`Strong`, `Useful`, or `Skip for now`.

Do not recommend speculative cleanup simply because it looks architecturally nicer.

## 6. Discuss before changing code

After presenting the candidates, ask the user which ones to pursue.

For the selected candidate, ask only architecture questions that materially affect the shape of the module.

Ask **1–4 questions in one batch**, each with a recommended answer.

Useful questions include:

- what behaviour should belong behind the interface;
- which callers should use it;
- what state or dependency the module should own;
- what should deliberately remain outside;
- whether an existing interface should be replaced rather than wrapped.

Do not ask code-level questions that the implementation agent can decide safely.

## 7. Refactor toward a smaller interface

Once the direction is confirmed:

- make the smallest refactor that achieves the architectural improvement;
- preserve behaviour;
- remove obsolete wrappers or duplicate paths;
- avoid unrelated cleanup;
- keep naming direct and domain-oriented;
- reduce the amount of knowledge callers need.

Prefer replacing the old shape rather than permanently layering a new architecture on top of it.

## 8. Verify the improvement

Run relevant mechanical checks and existing tests.

Then verify the architecture itself.

Confirm that:

- callers now use a smaller interface;
- complexity is more local;
- the same behaviour is not duplicated elsewhere;
- the number of concepts needed to understand the feature decreased or stayed justified;
- a future change in this area should require touching fewer places.

If the refactor produces more indirection without reducing caller knowledge, reconsider it.

## 9. Show the feedback-loop improvement

At completion, briefly report:

- what was difficult before;
- the new module/interface shape;
- what callers no longer need to know;
- which future changes should now be easier;
- files substantially moved, removed, or simplified.

The success metric is not architectural purity.

Completion criterion: a future coding agent can understand and change the affected behaviour with less context, through a smaller useful interface, while the underlying complexity remains concentrated in one place.