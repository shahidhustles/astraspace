import type { BrowserActionName, BrowserActionWait } from "@astra-space/browser-control-contract";
import { toolOutput } from "eve/tools";
import { z } from "zod";
import {
  browserActionModelParts,
  runBrowserAction,
  type BrowserActionOutput,
  type BrowserActionToolContext,
} from "./browser-control";

export const groundedTargetSchema = z.object({
  tabId: z.number().int(),
  snapshotId: z.string().min(1),
  ref: z.number().int().nonnegative(),
});

export const actionWaitSchema = z
  .object({
    timeoutMs: z.number().int().min(1_000).max(30_000).nullable().optional(),
    expectation: z
      .object({
        intent: z.enum(["appear", "disappear"]),
        role: z.string().min(1),
        name: z.string().min(1),
      })
      .nullable()
      .optional(),
  })
  .optional();

export async function executeAction(
  action: BrowserActionName,
  input: Record<string, unknown>,
  wait: BrowserActionWait | undefined,
  ctx: BrowserActionToolContext,
): Promise<BrowserActionOutput> {
  return runBrowserAction({ action, input, wait, ctx });
}

export function actionModelOutput(output: BrowserActionOutput) {
  return toolOutput.content(browserActionModelParts(output));
}
