# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Astra Space is for people who use browser agents on pages that may contain passwords, personal details, private documents, account data, faces, or confidential work. The primary user wants the agent to complete real browser tasks without sending raw page context to an external model.

The SIH 2026 judges are an important evaluation audience. They need visible proof that sensitive information stays on the device while the agent continues to work.

## Product purpose

Astra Space is a privacy-first browser agent. It inspects the active page locally, detects sensitive DOM, text, and visual content, sanitizes that context, and only then asks a cloud or on-premises model to reason about the next browser action.

The core product loop is:

1. Observe the current page on the device.
2. Detect sensitive regions and values locally.
3. Redact or replace them while preserving task meaning.
4. Preview the exact sanitized context that may leave the device.
5. Send the sanitized context to the reasoning model.
6. Execute the returned browser action locally.
7. Repeat until the task ends or needs user approval.

Success means the agent can finish a useful browser task while the privacy inspector proves that no original private values were sent to the model.

## Positioning

Most browser agents treat privacy as a policy around cloud processing. Astra Space places an inspectable privacy boundary on the user's device. The model receives a task-preserving representation such as `[EMAIL_1]` or `[PRIVATE_PASSWORD]`, while the original value remains local.

The product must prove this mechanism in the interface. A privacy claim without an outbound payload preview is not enough.

## Operating context

Astra Space runs as a Chrome Manifest V3 extension. Users invoke it while working on a live webpage, give it a task, and watch the browser agent move through an observe, sanitize, reason, and act cycle.

The controlled SIH demonstration page contains names, email addresses, phone numbers, a password, an address, a face, normal text, forms, and buttons. The privacy inspector compares detected content with the sanitized screenshot and structured page representation sent to the model.

The current workspace is a Bun monorepo with a TypeScript and Vite Chrome extension plus an Eve-based agent package. The browser remains the primary place for browser-control tasks.

## Capabilities and constraints

### Core demonstration

- Capture the visible page and extract useful screen state locally.
- Inspect DOM roles, labels, inputs, accessibility attributes, visible text, and element coordinates.
- Detect sensitive data with DOM rules, text rules or local NLP, OCR, face detection, and lightweight local vision where needed.
- Support complete masking, partial masking, and semantic placeholders.
- Produce a sanitized screenshot, a concise structured page representation, and redaction metadata.
- Show detected categories, confidence, sanitized output, outbound payload, and action history in a privacy inspector.
- Receive structured actions such as click, type, scroll, select, navigate, and open tab, then execute them locally.
- Keep original sensitive values on the device.

### Performance constraints

- Prefer DOM-first detection before expensive vision inference.
- Keep local models small enough for a browser runtime.
- Use WebGPU when available and retain a WebAssembly fallback.
- Track visual understanding accuracy, PII precision and recall, redaction precision, client resource use, and end-to-end latency.

### Additions after the core loop

Session, episodic, and semantic memory may improve continuity across tasks. Reusable skills, artifact generation, subagent delegation, Telegram and WhatsApp access, and the self-hosted Watchtower MCP gateway extend Astra Space into real work. These additions must not weaken the local privacy boundary.

MCP tool-output redaction is a separate future problem. Until that layer exists, the product must not imply that connected-tool output receives the same protection as browser page context.

## Brand commitments

The product name is **Astra Space**.

The voice is calm, exact, and accountable. Labels should name what happened using plain language: "3 private values removed" and "No original values sent" are stronger than broad claims such as "Your data is completely safe."

`DESIGN.reference.md` is the design reference for token structure, dark surfaces, typography hierarchy, spacing, buttons, panels, focus treatments, and restrained glow. It is inspiration rather than a visual identity to copy. Astra Space must adapt that system to a privacy inspector and browser-agent workflow.

## Evidence on hand

- [`SIH 2026 PS 26171.md`](SIH%202026%20PS%2026171.md) defines the problem, evaluation criteria, core capabilities, and demonstration flow.
- [`DESIGN.reference.md`](DESIGN.reference.md) provides the approved design reference.
- `chrome-extension/` contains the current Manifest V3 TypeScript and Vite scaffold.
- `packages/agent-core/` contains the current Eve agent scaffold.

There are no verified production benchmarks, customer testimonials, deployment claims, or measured privacy results in the repository. Product copy and demonstration screens must not invent them. Synthetic demo data must be labeled as demo data where a user could mistake it for a real result.

## Product principles

1. **Sanitize before reasoning.** Raw browser context does not cross the local privacy boundary.
2. **Make the boundary visible.** Users can inspect what Astra detected, changed, and sent.
3. **Preserve task meaning.** Redaction hides private values without making the page unusable to the reasoning model.
4. **Use the lightest reliable detector.** DOM and text evidence run before local vision work.
5. **Earn broader capability.** Memory, integrations, and delegation come after the protected browser loop works end to end.

## Accessibility and inclusion

Accessibility is part of real-world usefulness, not a later polish pass. Astra Space must preserve page accessibility metadata during inspection, expose agent and privacy state without relying on color alone, support keyboard operation and visible focus, respect reduced-motion preferences, and keep critical privacy evidence readable at extension dimensions and browser zoom levels.

The exact conformance target remains an open product decision.
