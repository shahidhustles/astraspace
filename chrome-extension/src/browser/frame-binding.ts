import type {
  CDPSession,
  Frame,
  Page,
} from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import type { FrameGraphTracker } from "./document-identity";

export type FrameBindingFailureCode =
  | "missing_owner"
  | "ambiguous_owner"
  | "detached_frame"
  | "reparented_frame"
  | "missing_parent";

export type FrameBindingResult =
  | { ok: true; frameIds: Map<Frame, string> }
  | { ok: false; code: FrameBindingFailureCode; reason: string };

export async function bindFrameGraph(
  page: Page,
  tracker: FrameGraphTracker,
  session: CDPSession,
): Promise<FrameBindingResult> {
  const main = page.mainFrame();
  const root = tracker.record(tracker.mainFrameId);
  if (!root) {
    return { ok: false, code: "missing_parent", reason: "The frame graph has no main frame record" };
  }
  const frameIds = new Map<Frame, string>();
  frameIds.set(main, root.frameId);
  const failure = await bindChildren(main, root.frameId, tracker, session, frameIds);
  if (failure) {
    return failure;
  }
  const mappedIds = new Set(frameIds.values());
  const missingFrameId = tracker.liveFrameIds().find((frameId) => !mappedIds.has(frameId));
  if (missingFrameId) {
    return {
      ok: false,
      code: "missing_owner",
      reason: `Chrome frame ${missingFrameId} has no live Puppeteer frame`,
    };
  }
  return { ok: true, frameIds };
}

async function bindChildren(
  parent: Frame,
  parentFrameId: string,
  tracker: FrameGraphTracker,
  session: CDPSession,
  frameIds: Map<Frame, string>,
): Promise<FrameBindingResult | null> {
  for (const child of parent.childFrames()) {
    const match = await bindChild(child, parentFrameId, tracker, session);
    if (!match.ok) {
      return match;
    }
    frameIds.set(child, match.frameId);
    const failure = await bindChildren(child, match.frameId, tracker, session, frameIds);
    if (failure) {
      return failure;
    }
  }
  return null;
}

type ChildBindingResult =
  | { ok: true; frameId: string }
  | { ok: false; code: FrameBindingFailureCode; reason: string };

async function bindChild(
  child: Frame,
  parentFrameId: string,
  tracker: FrameGraphTracker,
  session: CDPSession,
): Promise<ChildBindingResult> {
  if (child.detached) {
    return { ok: false, code: "detached_frame", reason: `A Puppeteer frame under ${parentFrameId} is detached` };
  }
  let ownerNodeId: number;
  try {
    const owner = await child.frameElement();
    if (!owner) {
      return { ok: false, code: "missing_owner", reason: `No owner element for a frame under ${parentFrameId}` };
    }
    try {
      ownerNodeId = await owner.backendNodeId();
    } finally {
      await owner.dispose();
    }
  } catch {
    return {
      ok: false,
      code: "detached_frame",
      reason: `Could not resolve the owner element of a frame under ${parentFrameId}`,
    };
  }

  const children = tracker.childrenOf(parentFrameId);
  const ownerByFrameId = new Map<number, string>();
  for (const record of children) {
    let backendNodeId = record.ownerBackendNodeId;
    if (backendNodeId === null) {
      let resolved: number;
      try {
        const response = await session.send("DOM.getFrameOwner", { frameId: record.frameId });
        resolved = response.backendNodeId;
      } catch {
        return { ok: false, code: "missing_owner", reason: `Could not resolve the owner of frame ${record.frameId}` };
      }
      backendNodeId = resolved;
      tracker.setOwnerBackendNodeId(record.frameId, resolved);
    }
    const existing = ownerByFrameId.get(backendNodeId);
    if (existing !== undefined) {
      return {
        ok: false,
        code: "ambiguous_owner",
        reason: `Frames ${existing} and ${record.frameId} share owner backend node ${backendNodeId}`,
      };
    }
    ownerByFrameId.set(backendNodeId, record.frameId);
  }

  const frameId = ownerByFrameId.get(ownerNodeId);
  if (frameId === undefined) {
    return {
      ok: false,
      code: "missing_owner",
      reason: `No frame under ${parentFrameId} is owned by backend node ${ownerNodeId}`,
    };
  }
  const matched = tracker.record(frameId);
  if (!matched || matched.parentFrameId !== parentFrameId) {
    return { ok: false, code: "reparented_frame", reason: `Frame ${frameId} no longer sits under ${parentFrameId}` };
  }
  return { ok: true, frameId };
}
