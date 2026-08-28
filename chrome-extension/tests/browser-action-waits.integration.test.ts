import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DRIVER_JS } from "./helpers/mv3-driver";
import { createMv3Harness, findChrome, type Mv3Harness } from "./helpers/mv3-worker-harness";

// Every scenario runs inside the built service worker: the driver page is an
// extension page whose only control surface is chrome.runtime.sendMessage plus
// Chrome tab/debugger APIs for staging (opening fixture tabs, cancelling,
// removing tabs mid-action, detaching the debugger). No helper or context call
// shortcuts the worker.

interface SignalView {
  status?: string;
  idleMs?: number;
  ignoredRequests?: number;
  watchedFrames?: number;
}

interface CommitView {
  kind?: string;
  oldUrl?: string;
  newUrl?: string;
}

interface ResultView {
  ok?: boolean;
  url?: string;
  snapshotInvalidated?: boolean;
  error?: { code?: string; dispatchStarted?: boolean; url?: string };
  completion?: { status?: string; elapsedMs?: number; dispatchStarted?: boolean };
  signals?: { network?: SignalView; dom?: SignalView };
  data?: {
    newTabId?: number | null;
    options?: unknown[];
    selectedIndex?: number;
    y?: number;
    measured?: {
      outcome?: string;
      commits?: CommitView[];
      expectation?: { status?: string; intent?: string; scope?: string };
      lifecycle?: { completedBy?: string };
      stability?: { status?: string };
      signals?: { network?: SignalView; dom?: SignalView };
    };
  };
}

function actionError(result: ResultView | null | undefined): string | null {
  if (!result || result.ok !== false) {
    return null;
  }
  return result.error?.code ?? "unknown-error";
}

type OptionalResult = ResultView | undefined;

describe("action waits prove out through the real MV3 service worker", () => {
  let harness: Mv3Harness | null = null;

  afterAll(async () => {
    await harness?.close();
  });

  async function worker(): Promise<Mv3Harness> {
    if (!harness) {
      if (!findChrome()) {
        throw new Error("Chrome not found. Set PUPPETEER_EXECUTABLE_PATH.");
      }
      harness = await createMv3Harness({ driverJs: DRIVER_JS });
    }
    return harness;
  }

  test(
    "primary flows: navigation commit, same-document route, dom update, frame work",
    async () => {
      const h = await worker();
      const r = await h.report<{
        routeClick?: OptionalResult;
        idleClick?: OptionalResult;
        domClick?: OptionalResult;
        spawnFrame?: OptionalResult;
        childNext?: OptionalResult;
        navClick?: OptionalResult;
      }>("primary-flows");

      expect(r.routeClick?.ok).toBe(true);
      expect(r.routeClick?.data?.measured?.outcome).toBe("same_document");
      expect(
        r.routeClick?.data?.measured?.commits?.some((commit) => commit.kind === "same_document"),
      ).toBe(true);
      expect(r.routeClick?.url).toContain("#clicked");
      expect(r.routeClick?.snapshotInvalidated).toBe(true);
      expect(r.routeClick?.completion?.status).toBe("completed");

      expect(r.idleClick?.ok).toBe(true);
      expect(r.idleClick?.data?.measured?.outcome).toBe("dom_update");
      expect(r.idleClick?.data?.newTabId).toBe(null);
      expect(r.idleClick?.completion?.status).toBe("completed");

      expect(r.domClick?.ok).toBe(true);
      expect(r.domClick?.data?.measured?.outcome).toBe("dom_update");
      expect(r.domClick?.completion?.status).toBe("completed");

      expect(r.spawnFrame?.ok).toBe(true);
      expect(
        r.spawnFrame?.data?.measured?.commits?.some((commit) => commit.kind === "child_commit"),
      ).toBe(true);

      expect(r.childNext?.ok).toBe(true);
      expect(
        r.childNext?.data?.measured?.commits?.some((commit) => commit.kind === "child_commit"),
      ).toBe(true);

      expect(r.navClick?.ok).toBe(true);
      expect(r.navClick?.data?.measured?.outcome).toBe("navigation");
      const navCommit = r.navClick?.data?.measured?.commits?.find(
        (commit) => commit.kind === "main_commit",
      );
      expect(navCommit?.oldUrl).toContain("/fixture?phase=primary");
      expect(navCommit?.newUrl).toContain("?step=clicked");
      expect(r.navClick?.url).toContain("?step=clicked");
      expect(r.navClick?.snapshotInvalidated).toBe(true);
      expect(r.navClick?.completion?.status).toBe("completed");
    },
    90000,
  );

  test(
    "edit flows: quiet-settled typing, failed request, ignored websocket and media",
    async () => {
      const h = await worker();
      const r = await h.report<{
        suggestType?: OptionalResult;
        failType?: OptionalResult;
        wsType?: OptionalResult;
        chipOptions?: OptionalResult;
        chipSet?: OptionalResult;
      }>("edit-flows");

      expect(r.suggestType?.ok).toBe(true);
      expect(r.suggestType?.signals?.network?.status).toBe("quiet");
      expect(r.suggestType?.signals?.network?.idleMs).toBeGreaterThan(0);
      expect(r.suggestType?.signals?.dom?.status).toBe("quiet");
      expect(r.suggestType?.signals?.dom?.watchedFrames).toBeGreaterThan(0);
      expect(r.suggestType?.snapshotInvalidated).toBe(true);
      expect(r.suggestType?.completion?.status).toBe("completed");

      expect(r.failType?.ok).toBe(true);
      expect(r.failType?.completion?.status).toBe("completed");

      expect(r.wsType?.ok).toBe(true);
      expect(r.wsType?.signals?.network?.status).toBe("quiet");
      expect(r.wsType?.signals?.network?.ignoredRequests).toBeGreaterThanOrEqual(1);

      expect(r.chipOptions?.ok).toBe(true);
      expect(Array.isArray(r.chipOptions?.data?.options)).toBe(true);
      expect(r.chipOptions?.data?.options?.length).toBe(3);
      expect(r.chipOptions?.snapshotInvalidated).toBe(false);
      expect(r.chipOptions?.data?.measured?.lifecycle?.completedBy).toBe("read_only_inspection");

      expect(r.chipSet?.ok).toBe(true);
      expect(r.chipSet?.data?.selectedIndex).toBe(1);
      expect(r.chipSet?.completion?.status).toBe("completed");

      expect(h.requestsWithQuery((query) => query.get("q") === "pineapple")).toHaveLength(1);
      expect(h.requestsWithQuery((query) => query.get("q") === "fail").length).toBeGreaterThanOrEqual(1);
    },
    150000,
  );

  test(
    "expectation flows and popup creation through the worker",
    async () => {
      const h = await worker();
      const r = await h.report<{
        appearClick?: OptionalResult;
        disappearClick?: OptionalResult;
        popupClick?: OptionalResult;
        popupUrl?: string | null;
        switchToPopup?: OptionalResult;
        closePopup?: OptionalResult;
      }>("expectation-popup");

      expect(r.appearClick?.ok).toBe(true);
      expect(r.appearClick?.data?.measured?.expectation).toMatchObject({
        status: "satisfied",
        intent: "appear",
        scope: "main_document",
      });
      expect(r.appearClick?.completion?.status).toBe("completed");
      expect(r.appearClick?.data?.measured?.signals?.network?.status).toBe("quiet");
      expect(r.appearClick?.data?.measured?.signals?.dom?.status).toBe("quiet");

      expect(r.disappearClick?.ok).toBe(true);
      expect(r.disappearClick?.data?.measured?.expectation).toMatchObject({
        status: "satisfied",
        intent: "disappear",
      });
      expect(r.disappearClick?.completion?.status).toBe("completed");

      expect(r.popupClick?.ok).toBe(true);
      expect(typeof r.popupClick?.data?.newTabId).toBe("number");
      expect(r.popupUrl).toContain("/child.html?popped=1");

      expect(r.switchToPopup?.ok).toBe(true);
      expect(r.switchToPopup?.data?.measured?.lifecycle?.completedBy).toBe("activation_and_attach");
      expect(r.closePopup?.ok).toBe(true);
      expect(r.closePopup?.data?.measured?.lifecycle?.completedBy).toBe("removal_confirmed");
      expect(r.closePopup?.snapshotInvalidated).toBe(true);
      expect(actionError(r.closePopup)).toBe(null);
    },
    120000,
  );

  test(
    "scroll flows: document text scroll and container bottom with lazy rows",
    async () => {
      const h = await worker();
      const r = await h.report<{ scrollToText?: OptionalResult; boxScroll?: OptionalResult }>("scroll-flows");

      expect(r.scrollToText?.ok).toBe(true);
      expect(r.scrollToText?.data?.y).toBeGreaterThan(0);
      expect(r.scrollToText?.data?.measured?.stability?.status).toBe("stable");
      expect(r.scrollToText?.data?.measured?.signals?.network?.status).toBe("quiet");
      expect(r.scrollToText?.completion?.status).toBe("completed");

      expect(r.boxScroll?.ok).toBe(true);
      expect(r.boxScroll?.data?.y).toBeGreaterThan(200);
      expect(r.boxScroll?.data?.measured?.stability?.status).toBe("stable");
      expect(r.boxScroll?.completion?.status).toBe("completed");
    },
    120000,
  );

  test(
    "url policy: denied scheme before dispatch and unsupported redirect after landing",
    async () => {
      const h = await worker();
      const r = await h.report<{ blockedScheme?: OptionalResult; redirectTrap?: OptionalResult }>("url-policy");

      expect(r.blockedScheme?.ok).toBe(false);
      expect(actionError(r.blockedScheme)).toBe("unsupported_page");

      expect(r.redirectTrap?.ok).toBe(false);
      expect(actionError(r.redirectTrap)).toBe("unsupported_redirect");
      expect(r.redirectTrap?.error?.url).toBe("about:blank");
      expect(r.redirectTrap?.completion?.dispatchStarted).toBe(true);
    },
    60000,
  );

  test(
    "hardening: truthful exits for timeout, cancels, duplicate ids, and tab removal",
    async () => {
      const h = await worker();
      const r = await h.report<{
        timeoutRun?: OptionalResult;
        cancelLiveReply?: Record<string, unknown>;
        cancelLiveResult?: OptionalResult;
        cancelQueuedB?: Record<string, unknown>;
        cancelDispatchingA?: Record<string, unknown>;
        queuedAResult?: OptionalResult;
        queuedBResult?: OptionalResult;
        unknownCancel?: OptionalResult;
        duplicateSecond?: OptionalResult;
        duplicateFirstResult?: OptionalResult;
        removalResult?: OptionalResult;
      }>("hardening");

      expect(r.timeoutRun?.ok).toBe(true);
      expect(r.timeoutRun?.completion?.status).toBe("timed_out");
      expect(r.timeoutRun?.signals?.network?.status).toBe("activity_timeout");
      expect(r.timeoutRun?.completion?.elapsedMs).toBeGreaterThanOrEqual(1400);

      expect(r.cancelLiveReply).toEqual({
        ok: true,
        actionId: "cancel-live-astra",
        cancelled: true,
        dispatchStarted: true,
      });
      expect(r.cancelLiveResult?.ok).toBe(false);
      expect(actionError(r.cancelLiveResult)).toBe("action_cancelled");
      expect(r.cancelLiveResult?.error.dispatchStarted).toBe(true);
      expect(r.cancelLiveResult?.completion?.status).toBe("cancelled");
      expect(h.requestsWithQuery((q) => q.get("q") === "delay-6000-dove").length).toBe(1);

      expect(r.cancelQueuedB).toEqual({
        ok: true,
        actionId: "queued-b-astra",
        cancelled: true,
        dispatchStarted: false,
      });
      expect(r.cancelDispatchingA).toEqual({
        ok: true,
        actionId: "queued-astra",
        cancelled: true,
        dispatchStarted: true,
      });
      expect(actionError(r.queuedBResult)).toBe("action_cancelled");
      expect(r.queuedBResult?.error.dispatchStarted).toBe(false);
      expect(actionError(r.queuedAResult)).toBe("action_cancelled");
      expect(r.queuedAResult?.error.dispatchStarted).toBe(true);

      expect(r.unknownCancel?.ok).toBe(false);
      expect(actionError(r.unknownCancel)).toBe("unknown_action_id");

      expect(r.duplicateSecond?.ok).toBe(false);
      expect(actionError(r.duplicateSecond)).toBe("invalid_action");
      expect(r.duplicateFirstResult?.ok).toBe(true);
      expect(r.duplicateFirstResult?.completion?.status).toBe("completed");

      expect(r.removalResult?.ok).toBe(false);
      expect(actionError(r.removalResult)).toBe("missing_tab");
      expect(r.removalResult?.completion?.status).toBe("failed");
      expect(r.removalResult?.completion?.elapsedMs).toBeGreaterThanOrEqual(500);
      expect(h.requestsWithQuery((q) => q.get("q") === "delay-6000-robin").length).toBe(1);
    },
    200000,
  );

  test(
    "debugger detach mid-barrier ends the wait truthfully and never replays",
    async () => {
      const h = await worker();
      const r = await h.report<{
        detachError?: string | null;
        detachResult?: OptionalResult;
        afterDetachRetry?: OptionalResult;
      }>("detach-staleness");

      expect(r.detachError ?? null).toBe(null);
      expect(r.detachResult?.ok).toBe(false);
      expect(actionError(r.detachResult)).toBe("selected_tab_unavailable");
      expect(r.detachResult?.completion?.status).toBe("failed");
      expect(h.requestsWithQuery((q) => q.get("q") === "delay-7000-raven").length).toBe(1);
      expect(r.afterDetachRetry?.ok).toBe(false);
      expect(["stale_ref", "target_not_found"]).toContain(actionError(r.afterDetachRetry));
    },
    90000,
  );

  test("the whole run completed without a fatal driver error", async () => {
    const h = await worker();
    const fatal = await h.latestReport<{ error?: string }>("__fatal", 200);
    expect(fatal?.error ?? null).toBe(null);
    const done = await h.latestReport<{ ok?: boolean }>("__done", 100);
    expect(done?.ok ?? false).toBe(true);
  }, 15_000);

  test("built background bundle stays browser-safe", () => {
    const bundlePath = join(import.meta.dir, "..", "dist", "background.js");
    const source = readFileSync(bundlePath, "utf8");
    // The worker must never import Node builtins, and no action may hide a
    // fixed one-second completion delay behind a sleep.
    expect(/(["']node:)|(\brequire\(\s*["']fs\b)/.test(source)).toBe(false);
    expect(/sleep\(1[,_]?000\)/.test(source)).toBe(false);
    expect(/setTimeout\([^)]{0,80},\s*1[,_]?000\s*\)/.test(source)).toBe(false);
  });
});
