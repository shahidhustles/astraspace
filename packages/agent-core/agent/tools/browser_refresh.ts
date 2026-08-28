import { defineTool } from "eve/tools";
import { z } from "zod";
import { actionModelOutput, actionWaitSchema, executeAction } from "../lib/browser-action-tool";

export default defineTool({
  description: "Refresh the selected tab, then return completion evidence and a fresh observation.",
  inputSchema: z.object({ wait: actionWaitSchema }),
  execute: ({ wait }, ctx) => executeAction("browser_refresh", {}, normalized(wait), ctx),
  toModelOutput: actionModelOutput,
});

function normalized(wait: z.infer<typeof actionWaitSchema>) {
  return wait ? { timeoutMs: wait.timeoutMs ?? null, expectation: wait.expectation ?? null } : undefined;
}
