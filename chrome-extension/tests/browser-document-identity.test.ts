import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import type { CDPSession } from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import { MainFrameIdentityTracker } from "../src/browser/document-identity";

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

async function createTracker(session: FakeSession, main: Record<string, unknown>): Promise<MainFrameIdentityTracker> {
  session.frameTree = { frame: main, childFrames: [{ frame: frame(SUB_FRAME_ID, "L-sub") }] };
  return MainFrameIdentityTracker.create(session as unknown as CDPSession);
}

describe("MainFrameIdentityTracker", () => {
  test("initializes epochs from the main frame of the frame tree", async () => {
    const session = new FakeSession();
    const tracker = await createTracker(session, frame(MAIN_FRAME_ID, "L1"));

    expect(session.sent).toEqual(["Page.enable", "Page.getFrameTree"]);
    expect(tracker.identity).toEqual({ documentEpoch: 0, navigationEpoch: 0 });
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

    emitFrameNavigated(session, frame(MAIN_FRAME_ID, "L2"));
    expect(tracker.identity).toEqual({ documentEpoch: 1, navigationEpoch: 2 });

    emitNavigatedWithinDocument(session, MAIN_FRAME_ID);
    expect(tracker.identity).toEqual({ documentEpoch: 1, navigationEpoch: 3 });
  });

  test("subframe events change neither epoch", async () => {
    const session = new FakeSession();
    const tracker = await createTracker(session, frame(MAIN_FRAME_ID, "L1"));

    emitFrameNavigated(session, frame(SUB_FRAME_ID, "L-sub-2", MAIN_FRAME_ID));
    emitNavigatedWithinDocument(session, SUB_FRAME_ID);
    expect(tracker.identity).toEqual({ documentEpoch: 0, navigationEpoch: 0 });
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
    expect(session.listenerCount("Page.frameNavigated")).toBe(0);
    expect(session.listenerCount("Page.navigatedWithinDocument")).toBe(0);
    expect(session.detached).toBe(true);

    emitFrameNavigated(session, frame(MAIN_FRAME_ID, "L2"));
    emitNavigatedWithinDocument(session, MAIN_FRAME_ID);
    expect(tracker.identity).toEqual({ documentEpoch: 0, navigationEpoch: 0 });

    tracker.dispose();
    expect(session.detached).toBe(true);
  });
});