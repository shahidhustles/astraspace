import { defineTool } from "eve/tools";
import { z } from "zod";
import { actionModelOutput, actionWaitSchema, executeAction, groundedTargetSchema } from "../lib/browser-action-tool";

export default defineTool({
  description: "Choose one exact option identity from a grounded native select.",
  inputSchema: groundedTargetSchema.extend({ index: z.number().int().nonnegative(), label: z.string(), value: z.string(), wait: actionWaitSchema }),
  execute: ({ index, label, value, wait, ...target }, ctx) => executeAction("browser_select_option", { target, index, label, value }, normalized(wait), ctx),
  toModelOutput: actionModelOutput,
});

function normalized(wait: z.infer<typeof actionWaitSchema>) {
  return wait ? { timeoutMs: wait.timeoutMs ?? null, expectation: wait.expectation ?? null } : undefined;
}
