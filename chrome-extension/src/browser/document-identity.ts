import type { CDPSession, Protocol } from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import type { FrameLineageStep } from "./observation/types";

export interface FrameIdentity {
  readonly documentEpoch: number;
  readonly navigationEpoch: number;
}

export function lineageStepMatchesLive(step: FrameLineageStep, live: FrameRecord | null): boolean {
  return (
    live !== null &&
    live.parentFrameId === step.parentFrameId &&
    live.documentEpoch === step.documentEpoch &&
    live.navigationEpoch === step.navigationEpoch
  );
}

export interface FrameRecord {
  readonly frameId: string;
  readonly parentFrameId: string | null;
  readonly loaderId: string;
  readonly url: string;
  readonly documentEpoch: number;
  readonly navigationEpoch: number;
  readonly ownerBackendNodeId: number | null;
  readonly retired: boolean;
}

interface InternalFrameRecord {
  frameId: string;
  parentFrameId: string | null;
  loaderId: string;
  url: string;
  documentEpoch: number;
  navigationEpoch: number;
  ownerBackendNodeId: number | null;
  retired: boolean;
}

function snapshot(record: InternalFrameRecord): FrameRecord {
  return Object.freeze({
    frameId: record.frameId,
    parentFrameId: record.parentFrameId,
    loaderId: record.loaderId,
    url: record.url,
    documentEpoch: record.documentEpoch,
    navigationEpoch: record.navigationEpoch,
    ownerBackendNodeId: record.ownerBackendNodeId,
    retired: record.retired,
  });
}

export class FrameGraphTracker {
  private disposed = false;
  private readonly session: CDPSession;
  private readonly onChange: (() => void) | undefined;
  private readonly records = new Map<string, InternalFrameRecord>();
  private rootFrameId: string;
  private graphVersion = 0;
  private readonly onFrameAttached: (event: Protocol.Page.FrameAttachedEvent) => void;
  private readonly onFrameDetached: (event: Protocol.Page.FrameDetachedEvent) => void;
  private readonly onFrameNavigated: (event: Protocol.Page.FrameNavigatedEvent) => void;
  private readonly onNavigatedWithinDocument: (event: Protocol.Page.NavigatedWithinDocumentEvent) => void;

  private constructor(session: CDPSession, mainFrameId: string, onChange?: () => void) {
    this.session = session;
    this.rootFrameId = mainFrameId;
    this.onChange = onChange;
    this.onFrameAttached = (event) => {
      if (this.disposed) {
        return;
      }
      const record = this.records.get(event.frameId);
      if (!record) {
        this.records.set(event.frameId, {
          frameId: event.frameId,
          parentFrameId: event.parentFrameId,
          loaderId: "",
          url: "",
          documentEpoch: 0,
          navigationEpoch: 0,
          ownerBackendNodeId: null,
          retired: false,
        });
        this.graphVersion += 1;
        return;
      }
      if (record.parentFrameId !== event.parentFrameId) {
        this.retireSubtree(event.frameId);
        record.parentFrameId = event.parentFrameId;
        record.ownerBackendNodeId = null;
        this.graphVersion += 1;
      }
    };
    this.onFrameDetached = (event) => {
      if (this.disposed) {
        return;
      }
      if (event.reason === "swap") {
        return;
      }
      const record = this.records.get(event.frameId);
      if (!record) {
        return;
      }
      this.records.delete(event.frameId);
      for (const child of this.childrenOf(event.frameId)) {
        this.retireSubtree(child.frameId);
      }
      this.graphVersion += 1;
    };
    this.onFrameNavigated = (event) => {
      if (this.disposed) {
        return;
      }
      const frame = event.frame;
      const record = this.records.get(frame.id);
      if (!record) {
        if (!frame.parentId) {
          const previousRoot = this.records.get(this.rootFrameId);
          const documentEpoch = (previousRoot?.documentEpoch ?? 0) + 1;
          const navigationEpoch = (previousRoot?.navigationEpoch ?? 0) + 1;
          if (previousRoot) {
            this.retireSubtree(previousRoot.frameId);
          }
          this.rootFrameId = frame.id;
          this.records.set(frame.id, {
            frameId: frame.id,
            parentFrameId: null,
            loaderId: frame.loaderId,
            url: frame.url,
            documentEpoch,
            navigationEpoch,
            ownerBackendNodeId: null,
            retired: false,
          });
          this.graphVersion += 1;
          this.onChange?.();
          return;
        }
        this.records.set(frame.id, {
          frameId: frame.id,
          parentFrameId: frame.parentId ?? null,
          loaderId: frame.loaderId,
          url: frame.url,
          documentEpoch: 0,
          navigationEpoch: 0,
          ownerBackendNodeId: null,
          retired: false,
        });
        this.graphVersion += 1;
        return;
      }
      if (frame.loaderId === record.loaderId) {
        return;
      }
      record.loaderId = frame.loaderId;
      record.url = frame.url;
      record.documentEpoch += 1;
      record.navigationEpoch += 1;
      record.ownerBackendNodeId = null;
      record.retired = false;
      for (const child of this.childrenOf(frame.id)) {
        this.retireSubtree(child.frameId);
      }
      this.graphVersion += 1;
      if (frame.id === this.rootFrameId) {
        this.onChange?.();
      }
    };
    this.onNavigatedWithinDocument = (event) => {
      if (this.disposed) {
        return;
      }
      const record = this.records.get(event.frameId);
      if (!record) {
        return;
      }
      record.navigationEpoch += 1;
      record.url = event.url;
      this.graphVersion += 1;
      if (event.frameId === this.rootFrameId) {
        this.onChange?.();
      }
    };
    session.on("Page.frameAttached", this.onFrameAttached);
    session.on("Page.frameDetached", this.onFrameDetached);
    session.on("Page.frameNavigated", this.onFrameNavigated);
    session.on("Page.navigatedWithinDocument", this.onNavigatedWithinDocument);
  }

  static async create(session: CDPSession, onChange?: () => void): Promise<FrameGraphTracker> {
    await session.send("Page.enable");
    const { frameTree } = await session.send("Page.getFrameTree");
    const tracker = new FrameGraphTracker(session, frameTree.frame.id, onChange);
    tracker.ingestFrameTree(frameTree);
    return tracker;
  }

  get identity(): FrameIdentity {
    const record = this.records.get(this.rootFrameId);
    return Object.freeze({
      documentEpoch: record?.documentEpoch ?? 0,
      navigationEpoch: record?.navigationEpoch ?? 0,
    });
  }

  get version(): number {
    return this.graphVersion;
  }

  get mainFrameId(): string {
    return this.rootFrameId;
  }

  record(frameId: string): FrameRecord | null {
    const record = this.records.get(frameId);
    return record ? snapshot(record) : null;
  }

  childrenOf(frameId: string): FrameRecord[] {
    return [...this.records.values()]
      .filter((record) => record.parentFrameId === frameId && !record.retired)
      .map(snapshot);
  }

  liveFrameIds(): string[] {
    const ids: string[] = [];
    const visit = (frameId: string): void => {
      const record = this.records.get(frameId);
      if (!record || record.retired) {
        return;
      }
      ids.push(frameId);
      for (const child of this.records.values()) {
        if (child.parentFrameId === frameId && !child.retired) {
          visit(child.frameId);
        }
      }
    };
    visit(this.rootFrameId);
    return ids;
  }

  setOwnerBackendNodeId(frameId: string, backendNodeId: number): void {
    const record = this.records.get(frameId);
    if (record && record.ownerBackendNodeId !== backendNodeId) {
      record.ownerBackendNodeId = backendNodeId;
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.session.off("Page.frameAttached", this.onFrameAttached);
    this.session.off("Page.frameDetached", this.onFrameDetached);
    this.session.off("Page.frameNavigated", this.onFrameNavigated);
    this.session.off("Page.navigatedWithinDocument", this.onNavigatedWithinDocument);
    if (!this.session.detached) {
      void this.session.detach().catch(() => {});
    }
  }

  private ingestFrameTree(tree: Protocol.Page.FrameTree): void {
    this.records.set(tree.frame.id, {
      frameId: tree.frame.id,
      parentFrameId: tree.frame.parentId ?? null,
      loaderId: tree.frame.loaderId,
      url: tree.frame.url,
      documentEpoch: 0,
      navigationEpoch: 0,
      ownerBackendNodeId: null,
      retired: false,
    });
    for (const child of tree.childFrames ?? []) {
      this.ingestFrameTree(child);
    }
  }

  private retireSubtree(frameId: string): void {
    const record = this.records.get(frameId);
    if (!record || record.retired) {
      return;
    }
    const childIds = [...this.records.values()]
      .filter((child) => child.parentFrameId === frameId && !child.retired)
      .map((child) => child.frameId);
    record.retired = true;
    for (const childId of childIds) {
      this.retireSubtree(childId);
    }
  }
}
