import { defineTool } from "eve/tools";
import { z } from "zod";
import { actionModelOutput, actionWaitSchema, executeAction } from "../lib/browser-action-tool";

export default defineTool({
  description: "Switch browser control to one tab ID returned by the latest observation.",
  inputSchema: z.object({ tabId: z.number().int(), wait: actionWaitSchema }),
  execute: ({ tabId, wait }, ctx) => executeAction("browser_switch_tab", { tabId }, normalized(wait), ctx),
  toModelOutput: actionModelOutput,
});

function normalized(wait: z.infer<typeof actionWaitSchema>) {
  return wait ? { timeoutMs: wait.timeoutMs ?? null, expectation: wait.expectation ?? null } : undefined;
}
