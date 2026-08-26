import type { CDPSession, Protocol } from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";

export interface FrameIdentity {
  readonly documentEpoch: number;
  readonly navigationEpoch: number;
}

export class MainFrameIdentityTracker {
  private disposed = false;
  private readonly session: CDPSession;
  private readonly mainFrameId: string;
  private readonly onChange: (() => void) | undefined;
  private loaderId: string;
  private documentEpoch: number;
  private navigationEpoch: number;
  private readonly onFrameNavigated: (event: Protocol.Page.FrameNavigatedEvent) => void;
  private readonly onNavigatedWithinDocument: (event: Protocol.Page.NavigatedWithinDocumentEvent) => void;

  private constructor(
    session: CDPSession,
    mainFrameId: string,
    loaderId: string,
    onChange?: () => void,
    documentEpoch = 0,
    navigationEpoch = 0,
  ) {
    this.session = session;
    this.mainFrameId = mainFrameId;
    this.onChange = onChange;
    this.loaderId = loaderId;
    this.documentEpoch = documentEpoch;
    this.navigationEpoch = navigationEpoch;
    this.onFrameNavigated = (event) => {
      if (event.frame.id !== this.mainFrameId || event.frame.loaderId === this.loaderId) {
        return;
      }
      this.loaderId = event.frame.loaderId;
      this.documentEpoch += 1;
      this.navigationEpoch += 1;
      this.onChange?.();
    };
    this.onNavigatedWithinDocument = (event) => {
      if (event.frameId !== this.mainFrameId) {
        return;
      }
      this.navigationEpoch += 1;
      this.onChange?.();
    };
    session.on("Page.frameNavigated", this.onFrameNavigated);
    session.on("Page.navigatedWithinDocument", this.onNavigatedWithinDocument);
  }

  static async create(session: CDPSession, onChange?: () => void): Promise<MainFrameIdentityTracker> {
    await session.send("Page.enable");
    const { frameTree } = await session.send("Page.getFrameTree");
    return new MainFrameIdentityTracker(session, frameTree.frame.id, frameTree.frame.loaderId, onChange);
  }

  get identity(): FrameIdentity {
    return Object.freeze({ documentEpoch: this.documentEpoch, navigationEpoch: this.navigationEpoch });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.session.off("Page.frameNavigated", this.onFrameNavigated);
    this.session.off("Page.navigatedWithinDocument", this.onNavigatedWithinDocument);
    if (!this.session.detached) {
      void this.session.detach().catch(() => {});
    }
  }
}