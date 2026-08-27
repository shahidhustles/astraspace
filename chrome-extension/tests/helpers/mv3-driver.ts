// Driver page source shared by the MV3 worker integration suites. It runs
// inside the temporary extension copy and talks to the worker only through
// chrome.runtime.sendMessage plus Chrome tab/debugger APIs for staging.

const MESSAGES = JSON.stringify({
  attach: "browser.attach-active-tab",
  observe: "browser.observe-selected-tab",
  action: "browser.action",
  cancel: "browser.action.cancel",
});

const DRIVER_JS = (origin: string): string => `(async () => {
  const S = ${JSON.stringify(origin)};
  const M = ${MESSAGES};
  const send = (message) => chrome.runtime.sendMessage(message);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const post = (label, record) =>
    fetch(S + "/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label, record }),
    }).catch(() => {});
  chrome.runtime.connect();
  // Any extension API round-trip resets the worker's idle timer; long quiet
  // stretches in the worker need this heartbeat to stay measurable.
  setInterval(() => {
    void chrome.runtime.getPlatformInfo();
  }, 15000);
  const observed = { current: null };
  let cursor = "starting";
  void post("__booted", { href: location.href });

  async function openFixtureTab(query) {
    const tab = await chrome.tabs.create({ url: S + "/fixture?" + query, active: true });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const current = await chrome.tabs.get(tab.id);
      if (current.status === "complete") break;
      await sleep(50);
    }
    // Focus the exact tab and its window so attach-active-tab cannot bind a
    // page from another window while windows settle in headless Chrome.
    if (tab.windowId !== undefined) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }
    await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    return tab.id;
  }

  async function selectActiveTab() {
    cursor = cursor + " > selectActiveTab";
    const attach = await send({ type: M.attach });
    if (!attach.ok) {
      throw new Error(
        "attach failed [" + cursor + "]: " + JSON.stringify(attach.error ?? attach),
      );
    }
    const observe = await send({ type: M.observe });
    if (!observe.ok) {
      throw new Error(
        "observe failed [" + cursor + "]: " + JSON.stringify(observe.error ?? observe),
      );
    }
    observed.current = observe.state;
    return observe.state;
  }

  function ref(name) {
    const record = observed.current.refs.find((entry) => entry.name === name);
    if (!record) {
      throw new Error(
        "Missing ref for name [" + name + "] cursor [" + cursor + "] refs [" +
          JSON.stringify(observed.current.refs.slice(0, 40)) + "]",
      );
    }
    return record;
  }
  function target(record) {
    return {
      tabId: observed.current.tabId,
      snapshotId: observed.current.snapshotId,
      ref: record.ref,
    };
  }
  const act = (action, payload, envelope) =>
    send({ type: M.action, action, input: payload.input, ...(envelope ?? {}) });

  async function resetSuggestInput() {
    await selectActiveTab();
    await act("browser_clear_input", { input: target(ref("Suggest input")) });
    await selectActiveTab();
  }

  try {
    // ---- primary-flows: navigation commit, SPA route, DOM click, frame work
    cursor = "primary start";
    await openFixtureTab("phase=primary");
    await selectActiveTab();
    const routeClick = await act("browser_click", { input: target(ref("Route click")) });
    cursor = "primary idle";
    await selectActiveTab();
    const idleClick = await act("browser_click", { input: target(ref("Idle click")) });
    cursor = "primary dom";
    await selectActiveTab();
    const domClick = await act("browser_click", { input: target(ref("Dom click")) });
    cursor = "primary frame";
    await selectActiveTab();
    const spawnFrame = await act("browser_click", { input: target(ref("Spawn frame")) });
    cursor = "primary child-next";
    await selectActiveTab();
    const childNext = await act("browser_click", { input: target(ref("Next child version")) });
    cursor = "primary nav";
    await selectActiveTab();
    const navClick = await act("browser_click", { input: target(ref("Nav click")) });
    cursor = "primary post";
    await post("primary-flows", {
      routeClick,
      idleClick,
      domClick,
      spawnFrame,
      childNext,
      navClick,
    });

    // ---- edit-flows: tracked fetches, aborted fetch, ignored websocket/media
    cursor = "edits start";
    await openFixtureTab("phase=edits");
    await selectActiveTab();
    const suggestType = await act("browser_type", {
      input: { target: target(ref("Suggest input")), text: "pineapple" },
    });
    cursor = "edits fail";
    await selectActiveTab();
    const failType = await act("browser_type", {
      input: { target: target(ref("Fail input")), text: "doomed" },
    });
    cursor = "edits ws";
    await selectActiveTab();
    const wsType = await act("browser_type", {
      input: { target: target(ref("Ws input")), text: "socket" },
    });
    cursor = "edits chip";
    await selectActiveTab();
    const chipOptions = await act("browser_get_select_options", { input: target(ref("Chip select")) });
    await selectActiveTab();
    const chipSet = await act("browser_select_option", {
      input: { target: target(ref("Chip select")), index: 1, label: "Green chip", value: "green" },
    });
    cursor = "edits post";
    await post("edit-flows", { suggestType, failType, wsType, chipOptions, chipSet });

    // ---- expectation-popup: appear/disappear semantics plus opener popup
    cursor = "popup start";
    await openFixtureTab("phase=popup");
    await selectActiveTab();
    const appearClick = await act(
      "browser_click",
      { input: target(ref("Toast click")) },
      { wait: { expectation: { intent: "appear", role: "dialog", name: "Import ready" } } },
    );
    await selectActiveTab();
    const disappearClick = await act(
      "browser_click",
      { input: target(ref("End import")) },
      { wait: { expectation: { intent: "disappear", role: "status", name: "Import running" } } },
    );
    cursor = "popup open";
    await selectActiveTab();
    const popupClick = await act("browser_click", { input: target(ref("Open popup")) });
    const newTabId = popupClick && popupClick.ok ? popupClick.data.newTabId : null;
    let popupUrl = null;
    let switchToPopup = null;
    let closePopup = null;
    if (newTabId !== null && typeof newTabId === "number") {
      popupUrl = await chrome.tabs.get(newTabId).then((tab) => tab.url, (error) => String(error));
      switchToPopup = await act("browser_switch_tab", { input: { tabId: newTabId } });
      closePopup = await act("browser_close_tab", { input: { tabId: newTabId } });
    }
    await post("expectation-popup", {
      appearClick,
      disappearClick,
      popupClick,
      popupUrl,
      switchToPopup,
      closePopup,
    });

    // ---- scroll-flows: document text scroll and container bottom settle
    cursor = "scroll start";
    await openFixtureTab("phase=scroll");
    await selectActiveTab();
    cursor = "scroll box";
    await selectActiveTab();
    const boxScroll = await act("browser_scroll", {
      input: { mode: { mode: "bottom" }, target: target(ref("Box anchor")) },
    });
    const scrollToText = await act("browser_scroll_to_text", {
      input: { text: "Deep scroll marker two", occurrence: 1 },
    });
    cursor = "scroll post";
    await post("scroll-flows", { scrollToText, boxScroll });

    // ---- url-policy: pre-dispatch denial and post-landing redirect failure
    cursor = "policy start";
    await openFixtureTab("phase=policy");
    await selectActiveTab();
    const blockedScheme = await act("browser_navigate", { input: { url: "chrome://settings/" } });
    const redirectTrap = await act("browser_navigate", {
      input: { url: S + "/redirect-trap" },
    });
    await post("url-policy", { blockedScheme, redirectTrap });

    // ---- hardening: timeout, live cancel, queued cancel, unknown id,
    // duplicate id, tab removal mid-action
    cursor = "hardening timeout";
    await openFixtureTab("phase=hardening");
    await selectActiveTab();
    const timeoutRun = await act(
      "browser_type",
      { input: { target: target(ref("Suggest input")), text: "delay-6000-crow" } },
      { wait: { timeoutMs: 1500 } },
    );

    cursor = "hardening cancel-live";
    await resetSuggestInput();
    const cancelLivePromise = act(
      "browser_type",
      { input: { target: target(ref("Suggest input")), text: "delay-6000-dove" } },
      { actionId: "cancel-live-astra" },
    );
    await sleep(400);
    const cancelLiveReply = await send({ type: M.cancel, actionId: "cancel-live-astra" });
    const cancelLiveResult = await cancelLivePromise;

    cursor = "hardening cancel-queued";
    await resetSuggestInput();
    const pairedTarget = target(ref("Suggest input"));
    const queuedA = act(
      "browser_type",
      { input: { target: pairedTarget, text: "delay-6000-hawk" } },
      { actionId: "queued-astra" },
    );
    const queuedB = act(
      "browser_type",
      { input: { target: pairedTarget, text: "delay-6000-wren" } },
      { actionId: "queued-b-astra" },
    );
    await sleep(300);
    const cancelQueuedB = await send({ type: M.cancel, actionId: "queued-b-astra" });
    const cancelDispatchingA = await send({ type: M.cancel, actionId: "queued-astra" });
    const queuedAResult = await queuedA;
    const queuedBResult = await queuedB;

    const unknownCancel = await send({ type: M.cancel, actionId: "ghost-id-xyz" });

    cursor = "hardening duplicate";
    await resetSuggestInput();
    const duplicateFirst = act(
      "browser_type",
      { input: { target: target(ref("Suggest input")), text: "delay-1500-kite" } },
      { actionId: "duplicate-astra" },
    );
    await sleep(300);
    const duplicateSecond = await send({
      type: M.action,
      action: "browser_type",
      input: { target: pairedTarget, text: "again" },
      actionId: "duplicate-astra",
    }).catch((error) => ({ ok: false, error: { code: "invalid_action", message: String(error) } }));
    const duplicateFirstResult = await duplicateFirst;

    cursor = "hardening removal";
    await resetSuggestInput();
    const removalTarget = target(ref("Suggest input"));
    const removalPromise = act(
      "browser_type",
      { input: { target: removalTarget, text: "delay-6000-robin" } },
      { actionId: "remove-me-astra" },
    );
    await sleep(600);
    const removedTabId = observed.current.tabId;
    await chrome.tabs.remove(removedTabId);
    const removalResult = await removalPromise;

    await post("hardening", {
      timeoutRun,
      cancelLiveReply,
      cancelLiveResult,
      cancelQueuedB,
      cancelDispatchingA,
      queuedAResult,
      queuedBResult,
      unknownCancel,
      duplicateSecond,
      duplicateFirstResult,
      removalResult,
    });

    // ---- detach-staleness: Chrome kills the real debugger session mid-barrier
    cursor = "detach start";
    await openFixtureTab("phase=detach");
    const detachedState = await selectActiveTab();
    const detachedTabId = detachedState.tabId;
    const staleTarget = {
      tabId: detachedTabId,
      snapshotId: detachedState.snapshotId,
      ref: ref("Suggest input").ref,
    };
    const detachPromise = act(
      "browser_type",
      { input: { target: staleTarget, text: "delay-7000-raven" } },
      { actionId: "detach-me-astra" },
    );
    await sleep(900);
    const detachError = await chrome.debugger
      .detach({ tabId: detachedTabId })
      .then(() => null, (error) => String(error));
    const detachResult = await detachPromise;
    const afterDetachRetry = await act("browser_type", { input: { target: staleTarget, text: "zombie" } });
    await post("detach-staleness", { detachError, detachResult, afterDetachRetry });

    await post("__done", { ok: true });
  } catch (error) {
    await post("__fatal", {
      error: String(error && error.stack ? error.stack : error),
      cursor,
    });
  }
})();`;

export { DRIVER_JS };
