import { defineTool } from "eve/tools";
import { z } from "zod";
import { actionModelOutput, actionWaitSchema, executeAction, groundedTargetSchema } from "../lib/browser-action-tool";

export default defineTool({
  description: "Type text into one editable element from the latest browser observation.",
  inputSchema: groundedTargetSchema.extend({ text: z.string().min(1), wait: actionWaitSchema }),
  execute: ({ text, wait, ...target }, ctx) => executeAction("browser_type", { target, text }, normalized(wait), ctx),
  toModelOutput: actionModelOutput,
});

function normalized(wait: z.infer<typeof actionWaitSchema>) {
  return wait ? { timeoutMs: wait.timeoutMs ?? null, expectation: wait.expectation ?? null } : undefined;
}
