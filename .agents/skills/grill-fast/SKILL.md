---
name: grill-fast
description: Rapidly clarify a hackathon idea, feature, or technical direction by batching the important decisions instead of interviewing one-by-one.
disable-model-invocation: true
---

# Grill Fast

Stress-test the user's idea quickly enough that planning does not become the bottleneck.

The goal is **shared understanding, not exhaustive certainty**.

## Process

### 1. Gather context

Read the current conversation, supplied docs, project context, and relevant codebase context.

Do not ask for facts that can be discovered from the environment, repository, documentation, or existing conversation.

Do not re-ask decisions the user has already made.

### 2. Find build-changing questions

Identify unresolved decisions that would materially change:

- what gets built;
- the user flow;
- data or state;
- architecture or external integrations;
- important edge cases;
- the hackathon demo.

Ignore minor implementation details, polish, speculative scale concerns, and decisions that can safely be made while coding.

Prefer making a reasonable assumption over asking a question when the choice is cheap to reverse.

### 3. Ask in one batch

Ask all important questions together.

Normally ask **3–8 questions**. Ask fewer when the idea is already clear.

Group them when useful under:

- Product / Behaviour
- UX
- Technical
- Demo

For every question:

- keep it short;
- make the actual decision clear;
- provide a **Recommended** answer based on the current context.

Example:

1. Should uploaded videos remain available after processing?  
   **Recommended:** Yes. Keep them attached to the report so officers can revisit the evidence.

2. Should users need an account before submitting a report?  
   **Recommended:** No. Avoid authentication friction in the hackathon demo.

The user should be able to answer the entire batch in one message using the question numbers.

### 4. Resolve the answers

After the user responds:

- incorporate every answer;
- infer decisions that are now implied;
- identify contradictions or genuinely blocking uncertainty.

Ask **at most one additional batch** when important uncertainty still remains.

Do not continue questioning merely because more detail could theoretically be specified.

If the remaining choices are reversible during implementation, state the assumptions you will use instead of asking more questions.

### 5. Finish

Summarize:

- confirmed decisions;
- important assumptions;
- explicitly deferred decisions.

Keep the summary concise and suitable as input to `/to-spec`.

Do not start implementation unless the user asks.

Completion criterion: there is enough shared understanding to write a useful spec and begin building without likely rework to the core feature.