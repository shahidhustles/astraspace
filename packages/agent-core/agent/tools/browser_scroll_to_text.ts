import { defineTool } from "eve/tools";
import { z } from "zod";
import { actionModelOutput, actionWaitSchema, executeAction } from "../lib/browser-action-tool";

export default defineTool({
  description: "Scroll the selected page to one exact visible-text occurrence.",
  inputSchema: z.object({ text: z.string().min(1), occurrence: z.number().int().min(1), wait: actionWaitSchema }),
  execute: ({ text, occurrence, wait }, ctx) => executeAction("browser_scroll_to_text", { text, occurrence }, normalized(wait), ctx),
  toModelOutput: actionModelOutput,
});

function normalized(wait: z.infer<typeof actionWaitSchema>) {
  return wait ? { timeoutMs: wait.timeoutMs ?? null, expectation: wait.expectation ?? null } : undefined;
}
