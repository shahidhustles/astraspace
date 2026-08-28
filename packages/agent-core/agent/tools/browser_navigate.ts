import { defineTool } from "eve/tools";
import { z } from "zod";
import { actionModelOutput, actionWaitSchema, executeAction } from "../lib/browser-action-tool";

export default defineTool({
  description: "Navigate the selected browser tab to an allowed HTTP or HTTPS URL, then return completion evidence and a fresh observation.",
  inputSchema: z.object({ url: z.string().url(), wait: actionWaitSchema }),
  execute: ({ url, wait }, ctx) => executeAction("browser_navigate", { url }, normalizeWait(wait), ctx),
  toModelOutput: actionModelOutput,
});

function normalizeWait(wait: z.infer<typeof actionWaitSchema>) {
  return wait ? { timeoutMs: wait.timeoutMs ?? null, expectation: wait.expectation ?? null } : undefined;
}
