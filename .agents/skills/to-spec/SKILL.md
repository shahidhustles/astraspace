---
name: to-spec
description: Short spec from confirmed decisions, ready to build.
disable-model-invocation: true
---

# To spec

Build a short spec from conversation, decisions, and codebase. Keep it build ready, not exhaustive.

Work from confirmed decisions only. If big product questions remain, use /grill-fast.

## 1. Gather context

Pull from conversation, grill-fast decisions, project docs, research or prototypes, and codebase.

Keep settled questions settled and scope as agreed. For a small missing detail that is cheap to change later, choose a reasonable value and note it.

Done when you can list scope, decisions, and open assumptions without re-asking.

## 2. Map the shape

Explore code before you decide how to build.

Find reusable modules and patterns, key data and state, external integrations, where the feature connects, and constraints that affect the build.

Stay on existing patterns unless a change clearly helps. Leave detailed internals to the builder.

Done when you can name what to reuse, what to change, and the key constraint.

## 3. Write the spec

Use this structure. Keep each section short.

# <Feature Name>

## Goal

What the user can do and why it matters.

## User flow

End to end behavior in the order seen. Observable behavior, not screens or endpoints.

## Requirements

Only what the feature needs. Behavior, key states, real edge cases, and constraints already set.

## Implementation decisions

Only choices that constrain the build. Modules to add or change, architecture choices, data or state changes, integrations, contracts, and decisions made in planning.

Add paths only when location matters. Leave local internals to the builder.

## Demo / acceptance

Smallest set of checks that prove it works, human verifiable.

- [ ] User can submit a report with an image
- [ ] Report appears in the officer dashboard
- [ ] Officer can change its status
- [ ] User sees the updated status

## Out of scope

Nearby work to skip. Use this to hold the line on scope.

Done when every requirement maps to a demo check or is marked out of scope.

## 4. Keep it tight

Prefer typecheck, build, lint and obvious runtime errors, plus human testing of the flow. Leave automated tests optional.

Trim repeated discussion, rejected ideas unless they set scope, exhaustive edge cases, enterprise concerns, and details the builder can choose. If the draft covers the whole app, narrow to the feature.

Done when a fresh builder can list what to build, constraints to respect, and acceptance checks without reading the planning thread.

## 5. Save

Use the project's spec location if it has one. Otherwise `docs/specs/<feature-slug>.md`. Leave slicing to /to-tickets.

Done when the file is saved at the expected path and a fresh agent can build from it alone.
