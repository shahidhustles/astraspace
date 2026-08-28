import { defineTool } from "eve/tools";
import { z } from "zod";
import { actionModelOutput, actionWaitSchema, executeAction, groundedTargetSchema } from "../lib/browser-action-tool";

const modeSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("page_up") }), z.object({ mode: z.literal("page_down") }),
  z.object({ mode: z.literal("top") }), z.object({ mode: z.literal("bottom") }),
  z.object({ mode: z.literal("percent"), percent: z.number().min(0).max(100) }),
]);

export default defineTool({
  description: "Scroll the selected page or a grounded scroll container and return its stable position.",
  inputSchema: z.object({ mode: modeSchema, target: groundedTargetSchema.optional(), wait: actionWaitSchema }),
  execute: ({ mode, target, wait }, ctx) => executeAction("browser_scroll", { mode, ...(target ? { target } : {}) }, normalized(wait), ctx),
  toModelOutput: actionModelOutput,
});

function normalized(wait: z.infer<typeof actionWaitSchema>) {
  return wait ? { timeoutMs: wait.timeoutMs ?? null, expectation: wait.expectation ?? null } : undefined;
}
