# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Astra Space is for people who want one agent to handle recurring digital work instead of starting a new chat for every task. They work across websites, documents, messages, calendars, internal tools, and private account data. They need the agent to remember context, take action, and return useful work without exposing raw sensitive information.

Teams and organizations can use the same agent through the browser and messaging channels while keeping control over integrations, permissions, and credentials.

The SIH 2026 judges are an important evaluation audience. They need to see a capable working agent and clear evidence that its browser context is sanitized on the device before an external model receives it.

## Product purpose

Astra Space is a personal work agent that can be reached where the user already works, act through the browser and connected tools, run tasks on a schedule, call reusable skills, delegate complex work to subagents, and deliver finished artifacts or messages.

The product is meant for work that continues beyond a single conversation. A user can ask Astra to complete a browser task now, schedule a routine for later, continue through Telegram or WhatsApp, or have several specialist agents prepare a larger result. Session, episodic, and semantic memory give that work continuity.

Privacy is the trust layer beneath those capabilities. When Astra needs a live webpage, it detects and sanitizes sensitive page context locally before a cloud or on-premises model reasons about the next action.

Success means Astra completes useful work across time, tools, and channels while the user can inspect what it did, what it sent to a model, and which actions required approval.

## Positioning

Most AI assistants stop at conversation. Most browser agents focus on one active tab. Astra Space is a persistent agent for real work:

- it can respond now or start work from a schedule;
- it can continue through the browser, Telegram, and WhatsApp;
- it can use skills and connected tools instead of relying on one general prompt;
- it can split a complex request among specialist subagents;
- it can create documents, presentations, spreadsheets, reports, and code;
- it can control the browser while filtering sensitive page context on the device.

The central promise is not redaction by itself. It is an agent useful enough to trust with ongoing work, with a visible privacy boundary where browser data enters model context.

## Operating context

Astra Space runs primarily as a Chrome Manifest V3 extension backed by an Eve agent. The extension is the main place for browser control, live page inspection, task status, approvals, and agent conversation.

The same agent can also receive and deliver work through messaging channels. Scheduled jobs can start recurring tasks without waiting for a new message. Skills encode repeatable procedures, subagents handle bounded parts of larger jobs, and connected tools let Astra work with external services.

For organizations that need to own the integration boundary, Watchtower is the planned self-hosted MCP and authentication gateway. It manages MCP servers, OAuth, tokens, tool permissions, and audit logs between Astra and enterprise systems.

The controlled SIH demonstration page contains names, email addresses, phone numbers, a password, an address, a face, normal text, forms, and buttons. It proves that Astra can act on a real page after local sanitization, then show the exact context sent to the reasoning model.

The current workspace is a Bun monorepo with a TypeScript, React, and Vite Chrome extension plus an Eve-based agent package.

## Capabilities and constraints

### Agent runtime

- Stream a durable conversation with the Eve agent and expose the real configured model, context usage when measured, provider reasoning when supplied, steering, cancellation, and recoverable errors.
- Keep session context for the active task, then add episodic memory for past workflows and semantic memory for durable preferences and facts.
- Load reusable skills for research, report generation, data analysis, email drafting, meeting preparation, and other defined procedures.
- Delegate bounded work to specialist subagents and combine their results in the main task.
- Generate useful artifacts such as documents, presentations, spreadsheets, reports, and code files. Chat text is not the only output.
- Run scheduled jobs for recurring work, monitoring, digests, preparation, and follow-up.
- Receive and deliver work through the browser extension, Telegram, and WhatsApp. The browser remains the primary channel for browser-control tasks.

### Browser action and local privacy

- Capture the visible page and extract useful screen state locally.
- Inspect DOM roles, labels, inputs, accessibility attributes, visible text, and element coordinates.
- Detect sensitive data using DOM rules, text rules or local NLP, OCR, face detection, and lightweight local vision where needed.
- Support complete masking, partial masking, and semantic placeholders.
- Produce a sanitized screenshot, a structured page representation, and redaction metadata before model reasoning.
- Show detected categories, confidence, transformed context, the outbound payload, and action history in a privacy inspector.
- Receive structured actions such as click, type, scroll, select, navigate, and open tab, then execute them locally.
- Keep original sensitive page values on the device.

### Integrations and control

- Connect to external services through MCP, OpenAPI, and authored tools with narrow permissions.
- Require human approval for sensitive or consequential actions rather than relying on model instructions alone.
- Use Watchtower as the planned self-hosted gateway for organization-owned credentials, permissions, and audit records.

### Technical constraints

- Prefer DOM and text detection before expensive vision inference.
- Keep local models small enough for a browser runtime.
- Use WebGPU when available and retain a WebAssembly fallback.
- Track visual understanding accuracy, PII precision and recall, redaction precision, client resource use, and end-to-end latency.
- Never invent counts, confidence, model usage, successful protection, or completed actions when runtime evidence is unavailable.
- Treat MCP tool-output redaction as a separate unsolved boundary. Until it exists, Astra must not imply that connected-tool results receive the same protection as browser page context.

## Delivery status

The product direction includes the full agent system described above. The current implementation is earlier and narrower.

The repository currently proves a Chrome side-panel conversation connected to a local Eve agent, including streaming replies, steering, cancellation, real model and context telemetry when available, and provider reasoning when supplied. Browser observation, sanitization, browser actions, schedules, memory, skills, subagents, messaging channels, artifact generation, and Watchtower remain product capabilities to build and verify.

Future product copy must distinguish implemented behavior from planned capability.

## Brand commitments

The product name is **Astra Space**.

The official mascot is the Astra Blob, a violet Feral Blob used as a small, expressive companion at moments of invitation or waiting. It appears when a conversation has no messages and can react as a person starts typing. Use it sparingly when it helps make an empty, loading, or low-stakes guidance state feel more human. It must never stand in for an actual task, privacy, approval, or error state.

The voice is capable, direct, and accountable. Lead with work completed, time saved, or a result delivered. Explain privacy with evidence when it matters. Do not make sanitization the headline of every screen or describe a general-purpose agent as a privacy utility.

Use concrete language such as "Prepare the briefing every weekday at 8:00," "Research delegated to two subagents," or "3 private values removed." Avoid claims such as "Works everywhere," "Fully autonomous," or "Your data is completely safe."

`DESIGN.reference.md` is the design reference for token structure, dark surfaces, typography hierarchy, spacing, buttons, panels, focus treatments, and restrained glow. It is inspiration rather than a visual identity to copy.

## Evidence on hand

- [`SIH 2026 PS 26171.md`](SIH%202026%20PS%2026171.md) defines the browser-agent problem, evaluation criteria, local privacy flow, memory model, skills, artifact generation, subagents, messaging channels, Watchtower concept, and demonstration flow.
- [`docs/specs/extension-eve-streaming-chat.md`](docs/specs/extension-eve-streaming-chat.md) defines the first implemented user-interface slice and its limits.
- `chrome-extension/` contains the current Manifest V3 React and TypeScript side-panel implementation.
- `packages/agent-core/` contains the current Eve agent and installed framework documentation for schedules, skills, subagents, channels, connections, tools, and approvals.
- [`DESIGN.reference.md`](DESIGN.reference.md) provides the approved design reference.

There are no verified production benchmarks, customer testimonials, deployment claims, or measured privacy results in the repository. Product copy and demonstration screens must not invent them. Synthetic demo data must be labeled where a user could mistake it for a real result.

## Product principles

1. **Finish work, not conversations.** Astra should return an action, artifact, update, or completed routine when the task calls for one.
2. **Meet the user where the work happens.** The browser, messaging channels, schedules, and connected tools are entry points to the same agent.
3. **Use specialists for specialist work.** Skills provide repeatable procedures, and subagents divide complex tasks into clear responsibilities.
4. **Keep consequential actions inspectable.** Show progress, tool use, delegation, approvals, failures, and results in plain language.
5. **Protect browser context before reasoning.** Raw sensitive page data does not cross the local privacy boundary, and the user can inspect the transformation.

## Accessibility and inclusion

Accessibility is part of real-world usefulness. Astra must preserve page accessibility metadata during inspection, expose agent state and privacy state without relying on color alone, support keyboard operation and visible focus, respect reduced-motion preferences, and remain readable at extension dimensions and browser zoom levels.

The exact conformance target remains an open product decision.
