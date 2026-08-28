import { defineTool } from "eve/tools";
import { z } from "zod";
import { actionModelOutput, actionWaitSchema, executeAction, groundedTargetSchema } from "../lib/browser-action-tool";

export default defineTool({
  description: "Clear one editable element from the latest browser observation.",
  inputSchema: groundedTargetSchema.extend({ wait: actionWaitSchema }),
  execute: ({ wait, ...target }, ctx) => executeAction("browser_clear_input", target, normalized(wait), ctx),
  toModelOutput: actionModelOutput,
});

function normalized(wait: z.infer<typeof actionWaitSchema>) {
  return wait ? { timeoutMs: wait.timeoutMs ?? null, expectation: wait.expectation ?? null } : undefined;
}
