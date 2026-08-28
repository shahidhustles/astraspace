import { defineTool } from "eve/tools";
import { z } from "zod";
import { actionModelOutput, actionWaitSchema, executeAction } from "../lib/browser-action-tool";

export default defineTool({
  description: "Open and select a new allowed HTTP or HTTPS tab, then return a fresh observation.",
  inputSchema: z.object({ url: z.string().url(), wait: actionWaitSchema }),
  execute: ({ url, wait }, ctx) => executeAction("browser_open_tab", { url }, normalized(wait), ctx),
  toModelOutput: actionModelOutput,
});

function normalized(wait: z.infer<typeof actionWaitSchema>) {
  return wait ? { timeoutMs: wait.timeoutMs ?? null, expectation: wait.expectation ?? null } : undefined;
}
