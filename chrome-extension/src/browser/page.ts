import {
  connect,
  ExtensionTransport,
  type Browser,
  type CDPSession,
  type Frame,
  type Page,
} from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import { FrameGraphTracker, lineageStepMatchesLive, type FrameRecord } from "./document-identity";
import { bindFrameGraph } from "./frame-binding";
import {
  buildHighlightOverlayExpression,
  clipToRect,
  enrichPageContentWithAccessibility,
  observePageExpression,
  readJpegDimensions,
  removeHighlightOverlayExpression,
  renderPageContent,
  toObservedRef,
  type ExtractedFrame,
  type ExtractedFrameContent,
  type ExtractedNode,
  type ExtractedPageContent,
  type FrameLineageStep,
  type GroundingRecord,
  type ObservedRef,
  type PathStep,
  type RectBounds,
  type ScrollState,
  type ViewportCapture,
  type ViewportMeasurements,
} from "./observation";
import type { OwnerMap } from "./observation/extract";
import { SnapshotStore } from "./snapshot";
import { resolveTarget } from "./target-resolution";
import { enforceUrlPolicy } from "./url-policy";
import { clickGroundedTarget } from "./actions/element";
import { clearGroundedTarget, typeGroundedTarget } from "./actions/input";
import { keypressGroundedTarget } from "./actions/keyboard";
import type {
  ClearInputResult,
  ClickResult,
  KeypressInput,
  KeypressResult,
  TypeResult,
} from "./actions/types";
import type { BrowserError, GroundedTarget, ObserveResult, TargetResolutionResult, UrlPolicyResult } from "./types";

const DEFAULT_NAVIGATION_TIMEOUT_MS = 10_000;
const SCREENSHOT_QUALITY = 85;

export interface PageDeps {
  connect: (options: Parameters<typeof connect>[0]) => Promise<Browser>;
  connectTab: (tabId: number) => Promise<ExtensionTransport>;
  timeoutMs: number;
  snapshotStore?: SnapshotStore;
  onCreated?: (listener: (tab: chrome.tabs.Tab) => void) => () => void;
}

export type AttachResult = { ok: true; tabId: number } | { ok: false; error: BrowserError };

export type NavResult = { ok: true; url: string } | { ok: false; error: BrowserError };

export type DisconnectResult = { ok: true } | { ok: false; error: BrowserError };

export interface StagedObservation {
  tabId: number;
  url: string;
  title: string;
  scroll: ScrollState;
  dom: string;
  refs: ObservedRef[];
  groundings: GroundingRecord[];
  screenshot: ViewportCapture;
  documentEpoch: number;
  navigationEpoch: number;
  graphVersion: number;
  connectionGeneration: number;
}

export type StageResult = { ok: true; staged: StagedObservation } | { ok: false; error: BrowserError };

interface FrameOverlay {
  frame: Frame;
  refs: ObservedRef[];
  viewport: ViewportMeasurements;
}

interface ExtractedFrameTreeResult {
  content: ExtractedPageContent;
  nextRef: number;
  overlays: FrameOverlay[];
}

interface FrameOwnerGeometry {
  contentRect: RectBounds;
  scaleX: number;
  scaleY: number;
}

export class BrowserPage {
  readonly tabId: number;
  readonly url: string;

  private readonly deps: PageDeps;
  private readonly policy: UrlPolicyResult;
  private readonly snapshots: SnapshotStore;
  private browser: Browser | null = null;
  private puppeteerPage: Page | null = null;
  private session: CDPSession | null = null;
  private identityTracker: FrameGraphTracker | null = null;
  private observationQueue: Promise<void> = Promise.resolve();
  private connectionGeneration = 0;

  constructor(tabId: number, url: string, deps: PageDeps = defaultDeps) {
    this.tabId = tabId;
    this.url = url;
    this.deps = deps;
    this.policy = enforceUrlPolicy(url);
    this.snapshots = deps.snapshotStore ?? new SnapshotStore();
  }

  get attached(): boolean {
    return this.browser !== null && this.puppeteerPage !== null;
  }

  get page(): Page | null {
    return this.puppeteerPage;
  }

  async attach(): Promise<AttachResult> {
    if (this.attached) {
      return { ok: true, tabId: this.tabId };
    }
    if (!this.policy.ok) {
      return { ok: false, error: this.policy.error };
    }

    let browser: Browser | null = null;
    try {
      browser = await this.deps.connect({
        transport: await this.deps.connectTab(this.tabId),
        protocol: "cdp",
        defaultViewport: null,
      });
      const [page] = await browser.pages();
      if (!page) {
        await browser.disconnect();
        return { ok: false, error: { code: "attach_failed", message: "Connection exposed no page" } };
      }
      const session = await page.createCDPSession();
      const identityTracker = await FrameGraphTracker.create(session, () =>
        this.snapshots.invalidate(this.tabId),
      );
      this.browser = browser;
      this.puppeteerPage = page;
      this.session = session;
      this.identityTracker = identityTracker;
      this.connectionGeneration += 1;
      return { ok: true, tabId: this.tabId };
    } catch (error) {
      if (browser) {
        await browser.disconnect();
      }
      if (error instanceof Error && /already attached/i.test(error.message)) {
        return { ok: false, error: { code: "attach_conflict", message: "Another debugger is attached to the tab" } };
      }
      return { ok: false, error: { code: "attach_failed", message: "Failed to attach to tab" } };
    }
  }

  async disconnect(): Promise<DisconnectResult> {
    const browser = this.browser;
    this.connectionGeneration += 1;
    this.browser = null;
    this.puppeteerPage = null;
    this.session = null;
    this.identityTracker?.dispose();
    this.identityTracker = null;
    this.snapshots.invalidate(this.tabId);
    if (!browser) {
      return { ok: true };
    }
    try {
      await browser.disconnect();
      return { ok: true };
    } catch {
      return { ok: false, error: { code: "disconnect_failed", message: "Failed to disconnect from tab" } };
    }
  }

  async navigate(url: string): Promise<NavResult> {
    const policy = enforceUrlPolicy(url);
    if (!policy.ok) {
      return { ok: false, error: policy.error };
    }
    return this.runNavigation((page) => page.goto(url, this.navOptions()));
  }

  async goBack(): Promise<NavResult> {
    return this.runNavigation((page) => page.goBack(this.navOptions()));
  }

  async reload(): Promise<NavResult> {
    return this.runNavigation((page) => page.reload(this.navOptions()));
  }

  async click(target: GroundedTarget): Promise<ClickResult> {
    return clickGroundedTarget(target, {
      resolveTarget: (resolved) => this.resolveTarget(resolved),
      onCreated: (listener) => this.deps.onCreated?.(listener) ?? (() => {}),
      invalidate: () => this.snapshots.invalidate(this.tabId),
      currentUrl: () => this.puppeteerPage?.url() ?? "",
    });
  }

  async type(target: GroundedTarget, text: string): Promise<TypeResult> {
    return typeGroundedTarget(target, text, {
      resolveTarget: (resolved) => this.resolveTarget(resolved),
      invalidate: () => this.snapshots.invalidate(this.tabId),
      currentUrl: () => this.puppeteerPage?.url() ?? "",
    });
  }

  async clearInput(target: GroundedTarget): Promise<ClearInputResult> {
    return clearGroundedTarget(target, {
      resolveTarget: (resolved) => this.resolveTarget(resolved),
      invalidate: () => this.snapshots.invalidate(this.tabId),
      currentUrl: () => this.puppeteerPage?.url() ?? "",
    });
  }

  async keypress(input: KeypressInput): Promise<KeypressResult> {
    return keypressGroundedTarget(input, {
      resolveTarget: (resolved) => this.resolveTarget(resolved),
      invalidate: () => this.snapshots.invalidate(this.tabId),
      keyboard: () => (this.attached ? (this.puppeteerPage?.keyboard ?? null) : null),
      currentUrl: () => this.puppeteerPage?.url() ?? "",
    });
  }

  observe(): Promise<ObserveResult> {
    const result = this.observationQueue.then(() => this.performObservation());
    this.observationQueue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private async performObservation(): Promise<ObserveResult> {
    const staged = await this.stageObservation();
    if (!staged.ok) {
      return staged;
    }
    return this.commitObservation(staged.staged);
  }

  async stageObservation(): Promise<StageResult> {
    if (!this.attached || !this.puppeteerPage) {
      return { ok: false, error: { code: "selected_tab_unavailable", message: "No selected live connection" } };
    }
    if (!this.policy.ok) {
      return { ok: false, error: this.policy.error };
    }
    const tracker = this.identityTracker;
    if (!tracker) {
      return this.failCapture();
    }
    const page = this.puppeteerPage;
    const url = page.url();
    const currentPolicy = enforceUrlPolicy(url);
    if (!currentPolicy.ok) {
      this.snapshots.invalidate(this.tabId);
      return { ok: false, error: currentPolicy.error };
    }
    const identityBefore = tracker.identity;
    const graphVersionBefore = tracker.version;

    try {
      const title = await page.title();
      const extracted = await this.extractFrameTree();
      if (!extracted) {
        return this.failCapture();
      }
      const { content, overlays } = extracted;
      if (tracker.version !== graphVersionBefore) {
        return this.failCapture();
      }
      const rendered = renderPageContent(content);
      const refs = rendered.refs;
      const viewport = content.viewport;
      const captureId = crypto.randomUUID();

      let data: string;
      try {
        for (const overlay of overlays) {
          await overlay.frame.evaluate(
            buildHighlightOverlayExpression(overlay.refs, overlay.viewport, captureId),
          );
        }
        data = (await page.screenshot({
          type: "jpeg",
          quality: SCREENSHOT_QUALITY,
          encoding: "base64",
        })) as string;
      } finally {
        const removals = await Promise.allSettled(
          overlays.map((overlay) =>
            overlay.frame.evaluate(removeHighlightOverlayExpression(captureId)),
          ),
        );
        if (removals.some((result) => result.status === "rejected")) {
          throw new Error("Failed to remove observation overlays");
        }
      }

      const finalUrl = page.url();
      if (finalUrl !== url || !enforceUrlPolicy(finalUrl).ok) {
        return this.failCapture();
      }
      if (tracker.version !== graphVersionBefore) {
        return this.failCapture();
      }
      const screenshotDimensions = readJpegDimensions(data);
      if (!screenshotDimensions) {
        return this.failCapture();
      }

      return {
        ok: true,
        staged: {
          tabId: this.tabId,
          url,
          title,
          scroll: viewport.scroll,
          dom: rendered.dom,
          refs,
          groundings: rendered.groundings,
          screenshot: { mimeType: "image/jpeg", data, ...screenshotDimensions },
          documentEpoch: identityBefore.documentEpoch,
          navigationEpoch: identityBefore.navigationEpoch,
          graphVersion: graphVersionBefore,
          connectionGeneration: this.connectionGeneration,
        },
      };
    } catch {
      return this.failCapture();
    }
  }

  commitObservation(staged: StagedObservation): ObserveResult {
    const tracker = this.identityTracker;
    if (
      !this.attached ||
      !this.puppeteerPage ||
      !tracker ||
      staged.tabId !== this.tabId ||
      staged.connectionGeneration !== this.connectionGeneration
    ) {
      return this.failCapture();
    }
    if (tracker.version !== staged.graphVersion || !lineagesMatchLive(staged.groundings, tracker)) {
      return this.failCapture();
    }
    const live = tracker.identity;
    if (live.documentEpoch !== staged.documentEpoch || live.navigationEpoch !== staged.navigationEpoch) {
      return this.failCapture();
    }
    const committed = this.snapshots.commit({
      tabId: this.tabId,
      documentEpoch: staged.documentEpoch,
      navigationEpoch: staged.navigationEpoch,
      dom: staged.dom,
      refs: staged.refs,
      groundings: staged.groundings,
    });
    if (!committed.ok) {
      return this.failCapture();
    }
    const identity = committed.snapshot.identity;
    return {
      ok: true,
      state: {
        tabId: this.tabId,
        url: staged.url,
        title: staged.title,
        scroll: staged.scroll,
        dom: staged.dom,
        refs: staged.refs,
        screenshot: staged.screenshot,
        snapshotId: identity.snapshotId,
        snapshotVersion: identity.snapshotVersion,
        documentEpoch: identity.documentEpoch,
        navigationEpoch: identity.navigationEpoch,
      },
    };
  }

  async resolveTarget(target: GroundedTarget): Promise<TargetResolutionResult> {
    if (
      target.tabId !== this.tabId ||
      !this.attached ||
      !this.puppeteerPage ||
      !this.identityTracker ||
      !this.session
    ) {
      return { ok: false, code: "stale_ref", target, reason: "No selected live connection" };
    }
    return resolveTarget(
      { page: this.puppeteerPage, session: this.session, tracker: this.identityTracker },
      this.snapshots,
      target,
    );
  }

  invalidateTargets(): void {
    this.snapshots.invalidate(this.tabId);
  }

  private async extractFrameTree(): Promise<{ content: ExtractedPageContent; overlays: FrameOverlay[] } | null> {
    const page = this.puppeteerPage;
    const tracker = this.identityTracker;
    const session = this.session;
    if (!page || !tracker || !session) {
      return null;
    }
    const binding = await bindFrameGraph(page, tracker, session);
    if (!binding.ok) {
      return null;
    }
    const frameById = new Map<string, Frame>();
    for (const [frame, frameId] of binding.frameIds) {
      frameById.set(frameId, frame);
    }
    const result = await extractFrameRecursive(
      page.mainFrame(),
      binding.frameIds,
      frameById,
      1,
    );
    if (!result) {
      return null;
    }
    const mainRecord = tracker.record(tracker.mainFrameId);
    if (!mainRecord) {
      return null;
    }
    annotateLineages(result.content.root, [toLineageStep(mainRecord)], (frameId) => {
      const record = tracker.record(frameId);
      return record ? toLineageStep(record) : null;
    });
    assignMainViewportBounds(result.content.root, result.content.viewport);
    return { content: result.content, overlays: result.overlays };
  }

  private failCapture(): { ok: false; error: BrowserError } {
    this.snapshots.invalidate(this.tabId);
    return { ok: false, error: { code: "observation_failed", message: "Page observation failed" } };
  }

  private navOptions() {
    return { timeout: this.deps.timeoutMs, waitUntil: "load" as const };
  }

  private async runNavigation(run: (page: Page) => Promise<unknown>): Promise<NavResult> {
    if (!this.attached || !this.puppeteerPage) {
      return { ok: false, error: { code: "selected_tab_unavailable", message: "No selected live connection" } };
    }
    this.snapshots.invalidate(this.tabId);

    const page = this.puppeteerPage;
    try {
      await run(page);
    } catch (error) {
      this.detachIfDisconnected();
      if (error instanceof Error && error.name === "TimeoutError") {
        return { ok: false, error: { code: "navigation_timeout", message: "Navigation timed out" } };
      }
      return { ok: false, error: { code: "navigation_failed", message: "Navigation failed" } };
    }

    const finalUrl = page.url();
    const policy = enforceUrlPolicy(finalUrl);
    if (!policy.ok) {
      return {
        ok: false,
        error: { code: "unsupported_redirect", message: "Navigation ended on an unsupported page", url: finalUrl },
      };
    }
    return { ok: true, url: finalUrl };
  }

  private detachIfDisconnected(): void {
    if (this.browser && !this.browser.connected) {
      this.connectionGeneration += 1;
      this.browser = null;
      this.puppeteerPage = null;
      this.session = null;
      this.identityTracker?.dispose();
      this.identityTracker = null;
      this.snapshots.invalidate(this.tabId);
    }
  }
}

async function extractFrameRecursive(
  frame: Frame,
  frameIds: Map<Frame, string>,
  frameById: Map<string, Frame>,
  startRef: number,
): Promise<ExtractedFrameTreeResult | null> {
  const owners: OwnerMap = {};
  for (const child of frame.childFrames()) {
    const childId = frameIds.get(child);
    if (!childId) {
      return null;
    }
    const owner = await child.frameElement();
    if (!owner) {
      return null;
    }
    try {
      const path = await owner.evaluate(pathOfElement);
      if (path === null) {
        return null;
      }
      owners[JSON.stringify(path)] = childId;
    } catch {
      return null;
    } finally {
      await owner.dispose();
    }
  }

  let raw: ExtractedFrameContent;
  try {
    raw = (await frame.evaluate(observePageExpression(startRef, owners))) as ExtractedFrameContent;
  } catch {
    return null;
  }

  const content = await enrichPageContentWithAccessibility(raw.content, async (control) => {
    const handle = await frame.evaluateHandle(resolveElementAtPath, control.domPath);
    const element = handle.asElement();
    if (!element) {
      await handle.dispose();
      return null;
    }
    try {
      const tag = await element.evaluate((node) =>
        node instanceof Element ? node.tagName.toLowerCase() : null,
      );
      if (tag !== control.tag) {
        return null;
      }
      control.backendNodeId = await element.backendNodeId();
      return await frame.accessibility.snapshot({ root: element, interestingOnly: false });
    } finally {
      await handle.dispose();
    }
  });

  const overlays: FrameOverlay[] = [
    {
      frame,
      refs: content.controls.filter((control) => control.ref !== null).map(toObservedRef),
      viewport: content.viewport,
    },
  ];

  let nextRef = raw.nextRef;
  for (const placeholder of collectFrameNodes(content.root)) {
    if (!placeholder.frameId) {
      return null;
    }
    const childFrame = frameById.get(placeholder.frameId);
    if (!childFrame) {
      return null;
    }
    const childResult = await extractFrameRecursive(
      childFrame,
      frameIds,
      frameById,
      nextRef,
    );
    if (!childResult) {
      return null;
    }

    const owner = await childFrame.frameElement();
    if (!owner) {
      return null;
    }
    let ownerGeometry: FrameOwnerGeometry | null;
    try {
      ownerGeometry = await owner.evaluate(measureFrameOwner);
    } catch {
      return null;
    } finally {
      await owner.dispose();
    }
    if (!ownerGeometry) {
      return null;
    }
    translateToParentViewport(childResult.content.root, ownerGeometry, content.viewport);

    placeholder.children = childResult.content.root.children;
    nextRef = childResult.nextRef;
    overlays.push(...childResult.overlays);
  }

  return { content, nextRef, overlays };
}

function translateToParentViewport(
  root: ExtractedNode,
  ownerGeometry: FrameOwnerGeometry,
  parentViewport: ViewportMeasurements,
): void {
  const visibleOwner = clipToRect(
    ownerGeometry.contentRect,
    { x: 0, y: 0, width: parentViewport.width, height: parentViewport.height },
  );
  const walk = (node: ExtractedNode): void => {
    if (node.kind === "element") {
      if (node.ref !== null) {
        node.viewportBounds = translateBounds(
          node.viewportBounds === undefined ? node.bounds : node.viewportBounds,
          ownerGeometry,
          visibleOwner,
        );
      }
      for (const child of node.children) {
        walk(child);
      }
      return;
    }
    if (node.kind === "frame" || node.kind === "shadow") {
      for (const child of node.children) {
        walk(child);
      }
    }
  };
  walk(root);
}

function translateBounds(
  bounds: RectBounds | null,
  ownerGeometry: FrameOwnerGeometry,
  visibleOwner: RectBounds | null,
): RectBounds | null {
  if (bounds === null || visibleOwner === null) {
    return null;
  }
  return clipToRect(
    {
      x: Math.round(ownerGeometry.contentRect.x + bounds.x * ownerGeometry.scaleX),
      y: Math.round(ownerGeometry.contentRect.y + bounds.y * ownerGeometry.scaleY),
      width: Math.round(bounds.width * ownerGeometry.scaleX),
      height: Math.round(bounds.height * ownerGeometry.scaleY),
    },
    visibleOwner,
  );
}

function measureFrameOwner(element: HTMLIFrameElement): FrameOwnerGeometry | null {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  const layoutWidth = element.offsetWidth > 0 ? element.offsetWidth : rect.width;
  const layoutHeight = element.offsetHeight > 0 ? element.offsetHeight : rect.height;
  const scaleX = rect.width / layoutWidth;
  const scaleY = rect.height / layoutHeight;
  const clientWidth = element.clientWidth > 0 ? element.clientWidth : layoutWidth;
  const clientHeight = element.clientHeight > 0 ? element.clientHeight : layoutHeight;
  const contentX = rect.x + element.clientLeft * scaleX;
  const contentY = rect.y + element.clientTop * scaleY;
  return {
    contentRect: {
      x: Math.round(contentX),
      y: Math.round(contentY),
      width: Math.round(clientWidth * scaleX),
      height: Math.round(clientHeight * scaleY),
    },
    scaleX,
    scaleY,
  };
}

function assignMainViewportBounds(root: ExtractedNode, viewport: ViewportMeasurements): void {
  const mainRect = { x: 0, y: 0, width: viewport.width, height: viewport.height };
  const walk = (node: ExtractedNode): void => {
    if (node.kind === "element") {
      if (node.ref !== null && node.viewportBounds === undefined && node.bounds !== null) {
        node.viewportBounds = clipToRect(node.bounds, mainRect);
      }
      for (const child of node.children) {
        walk(child);
      }
      return;
    }
    if (node.kind === "frame" || node.kind === "shadow") {
      for (const child of node.children) {
        walk(child);
      }
    }
  };
  walk(root);
}

function lineagesMatchLive(groundings: GroundingRecord[], tracker: FrameGraphTracker): boolean {
  for (const grounding of groundings) {
    for (const step of grounding.frameLineage) {
      if (!lineageStepMatchesLive(step, tracker.record(step.frameId))) {
        return false;
      }
    }
  }
  return true;
}

function collectFrameNodes(root: ExtractedNode, out: ExtractedFrame[] = []): ExtractedFrame[] {
  if (root.kind === "frame") {
    out.push(root);
    return out;
  }
  if (root.kind === "element" || root.kind === "shadow") {
    for (const child of root.children) {
      collectFrameNodes(child, out);
    }
  }
  return out;
}

function annotateLineages(
  node: ExtractedNode,
  lineage: FrameLineageStep[],
  stepFor: (frameId: string) => FrameLineageStep | null,
): void {
  if (node.kind === "element") {
    node.frameLineage = lineage;
    for (const child of node.children) {
      annotateLineages(child, lineage, stepFor);
    }
    return;
  }
  if (node.kind === "frame") {
    if (!node.frameId) {
      return;
    }
    const step = stepFor(node.frameId);
    if (!step) {
      return;
    }
    const childLineage = [...lineage, step];
    for (const child of node.children) {
      annotateLineages(child, childLineage, stepFor);
    }
    return;
  }
  if (node.kind === "shadow") {
    for (const child of node.children) {
      annotateLineages(child, lineage, stepFor);
    }
  }
}

function toLineageStep(record: FrameRecord): FrameLineageStep {
  return {
    frameId: record.frameId,
    parentFrameId: record.parentFrameId,
    documentEpoch: record.documentEpoch,
    navigationEpoch: record.navigationEpoch,
  };
}

function resolveElementAtPath(path: PathStep[]): Element | null {
  let node: Node | null = document.body;
  for (const step of path) {
    if (step.kind === "shadow") {
      node = node instanceof Element ? node.shadowRoot : null;
    } else {
      node = node?.childNodes.item(step.index) ?? null;
    }
  }
  return node instanceof Element ? node : null;
}

function pathOfElement(el: Element): PathStep[] | null {
  const reversed: PathStep[] = [];
  let node: Node | null = el;
  const root = document.body;
  while (node && node !== root) {
    const parent: Node | null = node.parentNode;
    if (!parent) {
      return null;
    }
    const index = Array.from(parent.childNodes).indexOf(node as ChildNode);
    if (index < 0) {
      return null;
    }
    reversed.push({ kind: "child", index });
    if (parent.nodeType === 11) {
      reversed.push({ kind: "shadow" });
      node = (parent as ShadowRoot).host;
    } else {
      node = parent;
    }
  }
  return node ? reversed.reverse() : null;
}

const defaultDeps: PageDeps = {
  connect,
  connectTab: (tabId) => ExtensionTransport.connectTab(tabId),
  timeoutMs: DEFAULT_NAVIGATION_TIMEOUT_MS,
  onCreated: (listener) => {
    chrome.tabs.onCreated.addListener(listener);
    return () => chrome.tabs.onCreated.removeListener(listener);
  },
};
