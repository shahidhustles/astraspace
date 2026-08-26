import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import type { CDPSession, Frame, Page } from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import { FrameGraphTracker } from "../src/browser/document-identity";
import { bindFrameGraph } from "../src/browser/frame-binding";

const MAIN_FRAME_ID = "main-1";
const CHILD_A_ID = "child-a";
const CHILD_B_ID = "child-b";
const NESTED_ID = "nested-1";

class FakeHandle {
  disposed = false;

  constructor(readonly backendNodeIdValue: number) {}

  async backendNodeId(): Promise<number> {
    return this.backendNodeIdValue;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

class FakeFrame {
  lastOwnerHandle: FakeHandle | null = null;

  constructor(
    readonly name: string,
    readonly children: FakeFrame[] = [],
    readonly parent: FakeFrame | null = null,
    readonly ownerBackendNodeIdValue: number | null = null,
    readonly detachedFlag = false,
  ) {
    for (const child of children) {
      child.parent = this;
    }
  }

  get detached(): boolean {
    return this.detachedFlag;
  }

  parentFrame(): FakeFrame | null {
    return this.parent;
  }

  childFrames(): FakeFrame[] {
    return this.children;
  }

  async frameElement(): Promise<FakeHandle | null> {
    if (this.ownerBackendNodeIdValue === null) {
      return null;
    }
    this.lastOwnerHandle = new FakeHandle(this.ownerBackendNodeIdValue);
    return this.lastOwnerHandle;
  }
}

class FakePage {
  constructor(readonly main: FakeFrame) {}

  mainFrame(): FakeFrame {
    return this.main;
  }
}

class FakeSession extends EventEmitter {
  detached = false;
  sent: string[] = [];
  frameTree: { frame: Record<string, unknown>; childFrames?: unknown[] } | null = null;
  ownerNodes = new Map<string, number>();
  onGetFrameOwner: ((frameId: string) => void) | undefined;

  async send(method: string, params?: { frameId?: string }): Promise<unknown> {
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
    if (method === "DOM.getFrameOwner") {
      const frameId = params?.frameId;
      if (!frameId) {
        throw new Error("missing frameId");
      }
      this.onGetFrameOwner?.(frameId);
      const backendNodeId = this.ownerNodes.get(frameId);
      if (backendNodeId === undefined) {
        throw new Error(`no owner node for ${frameId}`);
      }
      return { backendNodeId, nodeId: backendNodeId };
    }
    throw new Error(`unexpected send: ${method}`);
  }

  async detach(): Promise<void> {
    this.detached = true;
  }
}

function frame(id: string, parentId?: string): Record<string, unknown> {
  return { id, loaderId: `L-${id}`, url: "https://fixture.test/", ...(parentId ? { parentId } : {}) };
}

function buildFrameTree(): { frame: Record<string, unknown>; childFrames: unknown[] } {
  return {
    frame: frame(MAIN_FRAME_ID),
    childFrames: [
      { frame: frame(CHILD_A_ID, MAIN_FRAME_ID), childFrames: [{ frame: frame(NESTED_ID, CHILD_A_ID) }] },
      { frame: frame(CHILD_B_ID, MAIN_FRAME_ID) },
    ],
  };
}

function buildPuppeteerTree(): FakePage {
  const nested = new FakeFrame("nested", [], null, 201);
  const a = new FakeFrame("a", [nested], null, 101);
  const b = new FakeFrame("b", [], null, 102);
  return new FakePage(new FakeFrame("main", [a, b], null, null));
}

async function setup(): Promise<{ session: FakeSession; tracker: FrameGraphTracker; page: FakePage }> {
  const session = new FakeSession();
  session.frameTree = buildFrameTree();
  session.ownerNodes.set(CHILD_A_ID, 101);
  session.ownerNodes.set(CHILD_B_ID, 102);
  session.ownerNodes.set(NESTED_ID, 201);
  const tracker = await FrameGraphTracker.create(session as unknown as CDPSession);
  return { session, tracker, page: buildPuppeteerTree() };
}

describe("bindFrameGraph", () => {
  test("binds every live Puppeteer frame to its CDP frame record", async () => {
    const { session, tracker, page } = await setup();

    const result = await bindFrameGraph(page as unknown as Page, tracker, session as unknown as CDPSession);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const [a, b] = page.main.children;
    const nested = a.children[0];
    expect(result.frameIds.get(page.main as unknown as Frame)).toBe(MAIN_FRAME_ID);
    expect(result.frameIds.get(a as unknown as Frame)).toBe(CHILD_A_ID);
    expect(result.frameIds.get(b as unknown as Frame)).toBe(CHILD_B_ID);
    expect(result.frameIds.get(nested as unknown as Frame)).toBe(NESTED_ID);
  });

  test("two sibling frames bind to different Chrome frame IDs through their owner nodes", async () => {
    const { session, tracker, page } = await setup();

    const result = await bindFrameGraph(page as unknown as Page, tracker, session as unknown as CDPSession);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const [a, b] = page.main.children;
    expect(result.frameIds.get(a as unknown as Frame)).toBe(CHILD_A_ID);
    expect(result.frameIds.get(b as unknown as Frame)).toBe(CHILD_B_ID);
    expect(result.frameIds.get(a as unknown as Frame)).not.toBe(result.frameIds.get(b as unknown as Frame));
  });

  test("disposes every owner handle it creates", async () => {
    const { session, tracker, page } = await setup();

    const result = await bindFrameGraph(page as unknown as Page, tracker, session as unknown as CDPSession);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const [a, b] = page.main.children;
    expect(a.lastOwnerHandle?.disposed).toBe(true);
    expect(b.lastOwnerHandle?.disposed).toBe(true);
    expect(a.children[0].lastOwnerHandle?.disposed).toBe(true);
  });

  test("a second bind reuses stored owner node IDs", async () => {
    const { session, tracker, page } = await setup();

    await bindFrameGraph(page as unknown as Page, tracker, session as unknown as CDPSession);
    const fetches = session.sent.filter((method) => method === "DOM.getFrameOwner").length;

    const result = await bindFrameGraph(page as unknown as Page, tracker, session as unknown as CDPSession);
    expect(result.ok).toBe(true);
    expect(session.sent.filter((method) => method === "DOM.getFrameOwner").length).toBe(fetches);
  });

  test("an unresolvable owner returns missing_owner without a guessed match", async () => {
    const { session, tracker, page } = await setup();
    session.ownerNodes.delete(CHILD_B_ID);

    const result = await bindFrameGraph(page as unknown as Page, tracker, session as unknown as CDPSession);
    expect(result).toEqual({ ok: false, code: "missing_owner", reason: expect.any(String) });
  });

  test("an unknown owner element returns missing_owner without a guessed match", async () => {
    const { session, tracker } = await setup();
    const ghost = new FakeFrame("ghost", [], null, 999);
    const page = new FakePage(new FakeFrame("main", [ghost], null, null));

    const result = await bindFrameGraph(page as unknown as Page, tracker, session as unknown as CDPSession);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe("missing_owner");
  });

  test("fails when Chrome has a live frame Puppeteer omitted", async () => {
    const { session, tracker } = await setup();
    const page = new FakePage(new FakeFrame("main", [], null, null));

    const result = await bindFrameGraph(page as unknown as Page, tracker, session as unknown as CDPSession);

    expect(result).toEqual({
      ok: false,
      code: "missing_owner",
      reason: expect.stringContaining(CHILD_A_ID),
    });
  });

  test("duplicate owner nodes across records return ambiguous_owner", async () => {
    const { session, tracker, page } = await setup();
    session.ownerNodes.set(CHILD_B_ID, 101);

    const result = await bindFrameGraph(page as unknown as Page, tracker, session as unknown as CDPSession);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe("ambiguous_owner");
  });

  test("a detached Puppeteer frame returns detached_frame", async () => {
    const { session, tracker } = await setup();
    const detached = new FakeFrame("detached", [], null, 101, true);
    const page = new FakePage(new FakeFrame("main", [detached], null, null));

    const result = await bindFrameGraph(page as unknown as Page, tracker, session as unknown as CDPSession);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe("detached_frame");
  });

  test("a frame reparented during binding returns reparented_frame", async () => {
    const { session, tracker, page } = await setup();
    session.onGetFrameOwner = (frameId) => {
      if (frameId === CHILD_A_ID) {
        session.emit("Page.frameAttached", { frameId: CHILD_A_ID, parentFrameId: "new-parent" });
      }
    };

    const result = await bindFrameGraph(page as unknown as Page, tracker, session as unknown as CDPSession);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe("reparented_frame");
  });
});
