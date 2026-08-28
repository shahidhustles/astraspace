import { defineTool } from "eve/tools";
import { z } from "zod";
import { actionModelOutput, actionWaitSchema, executeAction, groundedTargetSchema } from "../lib/browser-action-tool";

const modifiersSchema = z.object({ alt: z.boolean(), control: z.boolean(), meta: z.boolean(), shift: z.boolean() });

export default defineTool({
  description: "Press one keyboard key, optionally focused on an element from the latest observation.",
  inputSchema: z.object({ key: z.string().min(1), modifiers: modifiersSchema, target: groundedTargetSchema.nullable(), wait: actionWaitSchema }),
  execute: ({ key, modifiers, target, wait }, ctx) => executeAction("browser_keypress", { key, modifiers, target }, normalized(wait), ctx),
  toModelOutput: actionModelOutput,
});

function normalized(wait: z.infer<typeof actionWaitSchema>) {
  return wait ? { timeoutMs: wait.timeoutMs ?? null, expectation: wait.expectation ?? null } : undefined;
}
