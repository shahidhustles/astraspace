import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import type { CDPSession } from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import { FrameGraphTracker } from "../src/browser/document-identity";

const MAIN_FRAME_ID = "main-1";
const SUB_FRAME_ID = "sub-1";

function frame(id: string, loaderId: string, parentId?: string): Record<string, unknown> {
  return { id, loaderId, url: "https://fixture.test/", ...(parentId ? { parentId } : {}) };
}

class FakeSession extends EventEmitter {
  detached = false;
  frameTree: { frame: Record<string, unknown>; childFrames?: unknown[] } | null = null;
  sent: string[] = [];

  async send(method: string): Promise<unknown> {
    this.sent.push(method);
    if (method === "Page.enable") {
      return {};
    }
    if (method === "Page.getFrameTree") {
      if (!this.frameTree) {
        throw new Error("no frame tree configured");
      }
      return { frameTree: this.frameTree };
    }
    throw new Error(`unexpected send: ${method}`);
  }

  async detach(): Promise<void> {
    this.detached = true;
  }
}

function emitFrameNavigated(session: FakeSession, target: Record<string, unknown>): void {
  session.emit("Page.frameNavigated", { frame: target, type: "Navigation" });
}

function emitNavigatedWithinDocument(session: FakeSession, frameId: string): void {
  session.emit("Page.navigatedWithinDocument", {
    frameId,
    url: "https://fixture.test/#fragment",
    navigationType: "fragment",
  });
}

function emitFrameAttached(session: FakeSession, frameId: string, parentFrameId: string): void {
  session.emit("Page.frameAttached", { frameId, parentFrameId });
}

function emitFrameDetached(session: FakeSession, frameId: string, reason: "remove" | "swap" = "remove"): void {
  session.emit("Page.frameDetached", { frameId, reason });
}

async function createTracker(session: FakeSession, main: Record<string, unknown>): Promise<FrameGraphTracker> {
  session.frameTree = { frame: main, childFrames: [{ frame: frame(SUB_FRAME_ID, "L-sub", MAIN_FRAME_ID) }] };
  return FrameGraphTracker.create(session as unknown as CDPSession);
}

describe("FrameGraphTracker", () => {
  test("initializes epochs from the main frame of the frame tree", async () => {
    const session = new FakeSession();
    const tracker = await createTracker(session, frame(MAIN_FRAME_ID, "L1"));

    expect(session.sent).toEqual(["Page.enable", "Page.getFrameTree"]);
    expect(tracker.identity).toEqual({ documentEpoch: 0, navigationEpoch: 0 });
  });

  test("builds a nested frame graph from the frame tree", async () => {
    const session = new FakeSession();
    const tracker = await createTracker(session, frame(MAIN_FRAME_ID, "L1"));

    expect(tracker.mainFrameId).toBe(MAIN_FRAME_ID);
    expect(tracker.version).toBe(0);
    expect(tracker.record(SUB_FRAME_ID)).toEqual({
      frameId: SUB_FRAME_ID,
      parentFrameId: MAIN_FRAME_ID,
      loaderId: "L-sub",
      url: "https://fixture.test/",
      documentEpoch: 0,
      navigationEpoch: 0,
      ownerBackendNodeId: null,
      retired: false,
    });
  });

  test("a changed main-frame loader increases both epochs", async () => {
    const session = new FakeSession();
    const tracker = await createTracker(session, frame(MAIN_FRAME_ID, "L1"));

    emitFrameNavigated(session, frame(MAIN_FRAME_ID, "L2"));
    expect(tracker.identity).toEqual({ documentEpoch: 1, navigationEpoch: 1 });

    emitFrameNavigated(session, frame(MAIN_FRAME_ID, "L3"));
    expect(tracker.identity).toEqual({ documentEpoch: 2, navigationEpoch: 2 });
  });

  test("a reused main-frame loader changes neither epoch", async () => {
    const session = new FakeSession();
    const tracker = await createTracker(session, frame(MAIN_FRAME_ID, "L1"));

    emitFrameNavigated(session, frame(MAIN_FRAME_ID, "L1"));
    expect(tracker.identity).toEqual({ documentEpoch: 0, navigationEpoch: 0 });
  });

  test("a same-document navigation increases only the navigation epoch", async () => {
    const session = new FakeSession();
    const tracker = await createTracker(session, frame(MAIN_FRAME_ID, "L1"));

    emitNavigatedWithinDocument(session, MAIN_FRAME_ID);
    expect(tracker.identity).toEqual({ documentEpoch: 0, navigationEpoch: 1 });
    expect(tracker.record(MAIN_FRAME_ID)?.url).toBe("https://fixture.test/#fragment");

    emitFrameNavigated(session, frame(MAIN_FRAME_ID, "L2"));
    expect(tracker.identity).toEqual({ documentEpoch: 1, navigationEpoch: 2 });

    emitNavigatedWithinDocument(session, MAIN_FRAME_ID);
    expect(tracker.identity).toEqual({ documentEpoch: 1, navigationEpoch: 3 });
  });

  test("subframe events change neither epoch of the main-frame projection", async () => {
    const session = new FakeSession();
    const tracker = await createTracker(session, frame(MAIN_FRAME_ID, "L1"));

    emitFrameNavigated(session, frame(SUB_FRAME_ID, "L-sub-2", MAIN_FRAME_ID));
    emitNavigatedWithinDocument(session, SUB_FRAME_ID);
    expect(tracker.identity).toEqual({ documentEpoch: 0, navigationEpoch: 0 });
  });

  test("a subframe navigation changes its epochs and the graph version", async () => {
    const session = new FakeSession();
    const tracker = await createTracker(session, frame(MAIN_FRAME_ID, "L1"));

    emitFrameNavigated(session, frame(SUB_FRAME_ID, "L-sub-2", MAIN_FRAME_ID));
    expect(tracker.record(SUB_FRAME_ID)?.documentEpoch).toBe(1);
    expect(tracker.record(SUB_FRAME_ID)?.navigationEpoch).toBe(1);
    expect(tracker.identity).toEqual({ documentEpoch: 0, navigationEpoch: 0 });
    expect(tracker.version).toBe(1);

    emitNavigatedWithinDocument(session, SUB_FRAME_ID);
    expect(tracker.record(SUB_FRAME_ID)?.navigationEpoch).toBe(2);
    expect(tracker.record(SUB_FRAME_ID)?.documentEpoch).toBe(1);
    expect(tracker.version).toBe(2);
  });

  test("a main-frame navigation retires every descendant", async () => {
    const session = new FakeSession();
    const tracker = await createTracker(session, frame(MAIN_FRAME_ID, "L1"));

    emitFrameNavigated(session, frame(MAIN_FRAME_ID, "L2"));
    expect(tracker.record(SUB_FRAME_ID)?.retired).toBe(true);
    expect(tracker.identity).toEqual({ documentEpoch: 1, navigationEpoch: 1 });
    expect(tracker.version).toBe(1);
  });

  test("a new parentless frame replaces the main frame and preserves monotonic epochs", async () => {
    const session = new FakeSession();
    const tracker = await createTracker(session, frame(MAIN_FRAME_ID, "L1"));

    emitFrameNavigated(session, frame("main-2", "L2"));

    expect(tracker.mainFrameId).toBe("main-2");
    expect(tracker.identity).toEqual({ documentEpoch: 1, navigationEpoch: 1 });
    expect(tracker.record(MAIN_FRAME_ID)?.retired).toBe(true);
    expect(tracker.record(SUB_FRAME_ID)?.retired).toBe(true);
    expect(tracker.liveFrameIds()).toEqual(["main-2"]);
  });

  test("navigating a retired frame restores it", async () => {
    const session = new FakeSession();
    const tracker = await createTracker(session, frame(MAIN_FRAME_ID, "L1"));

    emitFrameNavigated(session, frame(MAIN_FRAME_ID, "L2"));
    expect(tracker.record(SUB_FRAME_ID)?.retired).toBe(true);

    emitFrameNavigated(session, frame(SUB_FRAME_ID, "L-sub-2", MAIN_FRAME_ID));
    expect(tracker.record(SUB_FRAME_ID)?.retired).toBe(false);
    expect(tracker.record(SUB_FRAME_ID)?.documentEpoch).toBe(1);
  });

  test("attaching a new frame adds a record and bumps the version", async () => {
    const session = new FakeSession();
    const tracker = await createTracker(session, frame(MAIN_FRAME_ID, "L1"));

    emitFrameAttached(session, "sub-new", MAIN_FRAME_ID);
    expect(tracker.record("sub-new")).toMatchObject({
      parentFrameId: MAIN_FRAME_ID,
      retired: false,
      documentEpoch: 0,
    });
    expect(tracker.version).toBe(1);
  });

  test("reparenting a frame retires its subtree and clears its owner", async () => {
    const session = new FakeSession();
    const tracker = await createTracker(session, frame(MAIN_FRAME_ID, "L1"));
    tracker.setOwnerBackendNodeId(SUB_FRAME_ID, 42);

    emitFrameAttached(session, SUB_FRAME_ID, "other-parent");
    expect(tracker.record(SUB_FRAME_ID)?.parentFrameId).toBe("other-parent");
    expect(tracker.record(SUB_FRAME_ID)?.retired).toBe(true);
    expect(tracker.record(SUB_FRAME_ID)?.ownerBackendNodeId).toBeNull();
    expect(tracker.version).toBe(1);
  });

  test("a detached frame is removed and its descendants are retired", async () => {
    const session = new FakeSession();
    session.frameTree = {
      frame: frame(MAIN_FRAME_ID, "L1"),
      childFrames: [
        {
          frame: frame(SUB_FRAME_ID, "L-sub", MAIN_FRAME_ID),
          childFrames: [{ frame: frame("sub-2", "L-sub-2", SUB_FRAME_ID) }],
        },
      ],
    };
    const tracker = await FrameGraphTracker.create(session as unknown as CDPSession);

    emitFrameDetached(session, SUB_FRAME_ID);
    expect(tracker.record(SUB_FRAME_ID)).toBeNull();
    expect(tracker.record("sub-2")?.retired).toBe(true);
    expect(tracker.version).toBe(1);
  });

  test("a frame swap keeps the live frame record", async () => {
    const session = new FakeSession();
    const tracker = await createTracker(session, frame(MAIN_FRAME_ID, "L1"));

    emitFrameDetached(session, SUB_FRAME_ID, "swap");

    expect(tracker.record(SUB_FRAME_ID)?.retired).toBe(false);
    expect(tracker.version).toBe(0);
  });

  test("retiring a frame retires every nested descendant", async () => {
    const session = new FakeSession();
    session.frameTree = {
      frame: frame(MAIN_FRAME_ID, "L1"),
      childFrames: [{
        frame: frame(SUB_FRAME_ID, "L-sub", MAIN_FRAME_ID),
        childFrames: [{
          frame: frame("sub-2", "L-sub-2", SUB_FRAME_ID),
          childFrames: [{ frame: frame("sub-3", "L-sub-3", "sub-2") }],
        }],
      }],
    };
    const tracker = await FrameGraphTracker.create(session as unknown as CDPSession);

    emitFrameNavigated(session, frame(MAIN_FRAME_ID, "L2"));

    expect(tracker.record(SUB_FRAME_ID)?.retired).toBe(true);
    expect(tracker.record("sub-2")?.retired).toBe(true);
    expect(tracker.record("sub-3")?.retired).toBe(true);
  });

  test("owner node IDs are binding metadata and do not bump the version", async () => {
    const session = new FakeSession();
    const tracker = await createTracker(session, frame(MAIN_FRAME_ID, "L1"));

    tracker.setOwnerBackendNodeId(SUB_FRAME_ID, 42);
    expect(tracker.record(SUB_FRAME_ID)?.ownerBackendNodeId).toBe(42);
    expect(tracker.version).toBe(0);
  });

  test("a navigation clears the frame's owner backend node", async () => {
    const session = new FakeSession();
    const tracker = await createTracker(session, frame(MAIN_FRAME_ID, "L1"));
    tracker.setOwnerBackendNodeId(SUB_FRAME_ID, 42);

    emitFrameNavigated(session, frame(SUB_FRAME_ID, "L-sub-2", MAIN_FRAME_ID));
    expect(tracker.record(SUB_FRAME_ID)?.ownerBackendNodeId).toBeNull();
    expect(tracker.record(SUB_FRAME_ID)?.documentEpoch).toBe(1);
  });

  test("identity is immutable and stable over a quiet interval", async () => {
    const session = new FakeSession();
    const tracker = await createTracker(session, frame(MAIN_FRAME_ID, "L1"));

    const first = tracker.identity;
    expect(Object.isFrozen(first)).toBe(true);
    expect(() => Object.assign(first, { documentEpoch: 99 })).toThrow();

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(tracker.identity).toEqual(first);
  });

  test("stops reacting after disposal", async () => {
    const session = new FakeSession();
    const tracker = await createTracker(session, frame(MAIN_FRAME_ID, "L1"));

    tracker.dispose();
    expect(session.listenerCount("Page.frameAttached")).toBe(0);
    expect(session.listenerCount("Page.frameDetached")).toBe(0);
    expect(session.listenerCount("Page.frameNavigated")).toBe(0);
    expect(session.listenerCount("Page.navigatedWithinDocument")).toBe(0);
    expect(session.detached).toBe(true);

    emitFrameAttached(session, "late", MAIN_FRAME_ID);
    emitFrameNavigated(session, frame(MAIN_FRAME_ID, "L2"));
    emitNavigatedWithinDocument(session, MAIN_FRAME_ID);
    expect(tracker.record("late")).toBeNull();
    expect(tracker.identity).toEqual({ documentEpoch: 0, navigationEpoch: 0 });

    tracker.dispose();
    expect(session.detached).toBe(true);
  });
});
