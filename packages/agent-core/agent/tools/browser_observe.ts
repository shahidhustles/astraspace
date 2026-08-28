import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";
import { BrowserBroker } from "../lib/browser-broker";
import { browserObserveModelParts, observeSelectedPage } from "../lib/browser-control";

export default defineTool({
  description:
    "Observe the currently selected browser page. Returns the tab list, URL, title, scroll state, a snapshot identity, numbered element refs, the pruned semantic DOM, and a JPEG screenshot of the viewport. Use a ref from the observation to target an element in a follow-up action.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    return observeSelectedPage({
      broker: BrowserBroker.shared(),
      sessionId: ctx.session.id,
      turnId: ctx.session.turn.id,
      callId: ctx.callId,
      abortSignal: ctx.abortSignal,
    });
  },
  toModelOutput(output) {
    return toolOutput.content(browserObserveModelParts(output));
  },
});
