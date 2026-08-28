import { defineTool } from "eve/tools";
import { actionModelOutput, executeAction, groundedTargetSchema } from "../lib/browser-action-tool";

export default defineTool({
  description: "Read the bounded options of one native select from the latest browser observation without invalidating its snapshot.",
  inputSchema: groundedTargetSchema,
  execute: (target, ctx) => executeAction("browser_get_select_options", target, undefined, ctx),
  toModelOutput: actionModelOutput,
});
