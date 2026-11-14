(() => {
  "use strict";

  const living = document.querySelector(".living");
  const worldHome = window.houseWorldHome;
  const canvas = document.getElementById("scene");
  const frame = document.getElementById("scene-frame");
  const houseTab = document.getElementById("house-tab");
  const livingTab = document.getElementById("living-tab");
  const viewMotionToggle = document.getElementById("view-motion-toggle");
  const viewMotionState = document.getElementById("view-motion-state");
  const livingBoard = document.getElementById("living-board");
  const sceneName = document.getElementById("scene-view-name");
  const sceneContext = document.getElementById("scene-context-label");
  const selectedLabel = document.getElementById("selected-resident");
  const sceneStatus = document.getElementById("scene-load-status");
  const motionToggle = document.getElementById("motion-toggle");
  const motionLabel = document.getElementById("motion-label");
  const markerToggle = document.getElementById("marker-toggle");
  const markerNote = document.getElementById("marker-note");
  const worldHomeToggle = document.getElementById("world-home-toggle");
  const worldHomeIndicator = document.getElementById("world-home-indicator");
  const worldHomeStatus = document.getElementById("world-home-status");
  const worldHomeObservedAt = document.getElementById("world-home-observed-at");
  const worldHomeBoardNote = document.getElementById("world-home-board-note");
  const livingJump = document.getElementById("living-jump");
  const boardPeople = Array.from(document.querySelectorAll("[data-person]"));
  const cards = Array.from(document.querySelectorAll("[data-card]"));
  const groups = Array.from(document.querySelectorAll(".resident-group"));
  const filters = Array.from(document.querySelectorAll("[data-filter]"));
  const openBoard = document.getElementById("open-board");
  const motionPreview = document.getElementById("motion-preview");
  const motionPreviewForm = document.getElementById("motion-preview-form");
  const motionPreviewStatus = document.getElementById("motion-preview-status");
  const names = new Map(cards.map((card) => [
    card.dataset.card,
    card.querySelector(".resident-name")?.textContent.trim() || card.dataset.card,
  ]));
  const systemMotionPreference = window.matchMedia?.("(prefers-reduced-motion: reduce)") || null;
  const viewMotionPreferenceKey = "rencrow-living-view-motion-v1";
  const scrollKey = "rencrow-living-scroll";
  const validViews = new Set(["lcp", "workplace"]);
  const motionPreviewEnabled = new URLSearchParams(window.location.search).get("motion") === "preview";
  const worldHomeEnabled = living?.dataset.worldHomeEnabled === "true";
  const houseAssetVerified = living?.dataset.houseAssetVerified === "true" &&
    living?.dataset.houseSha256?.toLowerCase() === worldHome?.houseSHA256;

  let activeView = "lcp";
  let selectedResidentId = null;
  let boardPerson = boardPeople[0] || null;
  let isPaused = false;
  let markerVisible = false;
  let scene = null;
  let worldHomeLive = false;
  let worldHomeLatest = null;
  let worldHomePollTimer = null;
  let worldHomeRequestVersion = 0;
  let explicitViewMotion = null;
  let viewMotionEnabled = true;

  try {
    const saved = window.localStorage.getItem(viewMotionPreferenceKey);
    if (saved === "on" || saved === "off") explicitViewMotion = saved === "on";
  } catch {}
  viewMotionEnabled = explicitViewMotion ?? !(systemMotionPreference?.matches ?? false);

  function internalView(view) {
    return view === "workplace" ? "living" : "house";
  }

  function portalView(view) {
    return view === "workplace" || view === "living" ? "workplace" : "lcp";
  }

  function callScene(method, ...args) {
    if (scene && typeof scene[method] === "function") {
      try {
        scene[method](...args);
      } catch (error) {
        console.error(`House scene ${method} failed`, error);
        if (sceneStatus) sceneStatus.textContent = "シーン操作を反映できませんでした。";
      }
    }
  }

  function updateBoardLink() {
    boardPeople.forEach((button) => {
      button.setAttribute("aria-pressed", String(button === boardPerson));
    });
    if (!openBoard || !boardPerson || !living?.dataset.boardUrl) return;

    try {
      const target = new URL(living.dataset.boardUrl);
      target.searchParams.set("agent", boardPerson.dataset.participant);
      target.searchParams.set("from", "living");
      target.searchParams.set("person", boardPerson.dataset.person);
      target.searchParams.set("view", activeView);
      openBoard.href = target.href;
      openBoard.textContent = `${boardPerson.querySelector(".person-name")?.textContent.trim() || "選択中の参加者"} の会話をBOARDで開く`;
    } catch (error) {
      console.error("BOARD URL could not be prepared", error);
      openBoard.removeAttribute("href");
      openBoard.setAttribute("aria-disabled", "true");
    }
  }

  function setView(view, persist = true) {
    activeView = portalView(view);
    const isWorkplace = activeView === "workplace";
    houseTab?.setAttribute("aria-pressed", String(!isWorkplace));
    livingTab?.setAttribute("aria-pressed", String(isWorkplace));
    if (livingBoard) livingBoard.hidden = !isWorkplace;
    if (frame) frame.dataset.view = isWorkplace ? "living" : "house";
    if (sceneName) sceneName.textContent = isWorkplace ? "LIVING / 1階" : "HOUSE / 全景";
    if (sceneContext) sceneContext.textContent = isWorkplace ? "1階を眺める" : "家の全景を眺める";
    if (livingJump) {
      livingJump.innerHTML = isWorkplace
        ? '<span>全景を見る</span><span aria-hidden="true">↗</span>'
        : '<span>1階を見る</span><span aria-hidden="true">↗</span>';
      livingJump.setAttribute("aria-label", isWorkplace ? "HOUSE 全景へ切り替える" : "LIVING 1階へ切り替える");
    }
    callScene("setView", internalView(activeView));
    if (persist) saveSelection();
    else updateBoardLink();
  }

  function selectResident(id) {
    const candidate = id ? cards.find((card) => card.dataset.card === id && card.dataset.selectable === "true") : null;
    selectedResidentId = candidate ? id : null;
    cards.forEach((card) => {
      if (card.dataset.selectable !== "true") return;
      card.setAttribute("aria-pressed", String(card.dataset.card === selectedResidentId));
    });
    if (selectedLabel) {
      selectedLabel.hidden = !selectedResidentId;
      selectedLabel.textContent = selectedResidentId ? names.get(selectedResidentId) : "";
    }
    callScene("selectResident", selectedResidentId);
  }

  function setPaused(paused) {
    isPaused = Boolean(paused);
    motionToggle?.setAttribute("aria-pressed", String(isPaused));
    motionToggle?.setAttribute("aria-label", isPaused ? "住人の動きを再開" : "住人の動きを一時停止");
    if (motionLabel) motionLabel.textContent = isPaused ? "動きを再開" : "動きを止める";
    callScene("setPaused", isPaused);
  }

  function setViewMotion(enabled, remember = false) {
    viewMotionEnabled = Boolean(enabled);
    if (remember) {
      explicitViewMotion = viewMotionEnabled;
      try {
        window.localStorage.setItem(viewMotionPreferenceKey, viewMotionEnabled ? "on" : "off");
      } catch {}
    }
    viewMotionToggle?.setAttribute("aria-pressed", String(viewMotionEnabled));
    if (viewMotionState) viewMotionState.textContent = viewMotionEnabled ? "ON" : "OFF";
    callScene("setCameraMotionEnabled", viewMotionEnabled);
  }

  function setMarker(visible) {
    markerVisible = Boolean(visible);
    markerToggle?.setAttribute("aria-pressed", String(markerVisible));
    markerToggle?.setAttribute("aria-label", markerVisible ? "8人の作業位置を非表示" : "8人の作業位置を表示");
    if (markerNote) markerNote.hidden = !markerVisible;
    callScene("setMarker", markerVisible);
  }

  function setWorldHomeStatus(message, unavailable = false) {
    if (worldHomeIndicator) worldHomeIndicator.textContent = worldHomeLive ? "WORLD 実データ" : "外観プレビュー";
    if (worldHomeStatus) worldHomeStatus.textContent = message;
    if (worldHomeStatus) worldHomeStatus.dataset.state = unavailable ? "unavailable" : worldHomeLive ? "live" : "preview";
    if (worldHomeBoardNote) {
      const lines = worldHomeLive
        ? ["所在地と活動はCOREの受信snapshotに基づきます。", "受信できない間は最終表示を保持します。"]
        : ["活動・作業・所在地・来訪情報は未取得です。", "外観プレビューは実際の状態を示しません。"];
      worldHomeBoardNote.replaceChildren(document.createTextNode(lines[0]), document.createElement("br"), document.createTextNode(lines[1]));
    }
  }

  function showWorldHomeSnapshot(snapshot) {
    const accepted = worldHome.validateSnapshot(snapshot);
    if (!scene?.worldHomeReady?.() || !scene.setWorldHomeSnapshot(accepted)) {
      throw new Error("HOUSE model is not ready for WORLD data");
    }
    worldHomeLatest = accepted;
    const actors = new Map(accepted.actors.map((actor) => [actor.id, actor]));
    cards.forEach((card) => {
      const status = card.querySelector(".resident-status");
      const actor = actors.get(card.dataset.card);
      if (status) status.textContent = actor ? worldHome.describeActor(actor) : "WORLD 状態未取得";
    });
    if (worldHomeObservedAt) {
      worldHomeObservedAt.textContent = `観測 ${new Date(accepted.observed_at).toLocaleString()}`;
      worldHomeObservedAt.hidden = false;
    }
    setWorldHomeStatus(`受信済み · seq ${accepted.state_seq}`);
  }

  function scheduleWorldHomePoll(version) {
    if (!worldHomeLive || version !== worldHomeRequestVersion) return;
    worldHomePollTimer = window.setTimeout(() => pollWorldHome(version), 1500);
  }

  async function pollWorldHome(version) {
    if (!worldHomeLive || version !== worldHomeRequestVersion) return;
    if (!houseAssetVerified) {
      setWorldHomeStatus("HOUSE asset hash未確認 · WORLD表示不可", true);
      return;
    }
    if (!scene?.worldHomeReady?.()) {
      setWorldHomeStatus("HOUSE読み込み待ち");
      scheduleWorldHomePoll(version);
      return;
    }
    try {
      const response = await fetch("/api/living/world", {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (!worldHomeLive || version !== worldHomeRequestVersion) return;
      if (!response.ok) throw new Error(`WORLD snapshot unavailable (${response.status})`);
      const snapshot = await response.json();
      if (!worldHomeLive || version !== worldHomeRequestVersion) return;
      showWorldHomeSnapshot(snapshot);
    } catch (error) {
      if (!worldHomeLive || version !== worldHomeRequestVersion) return;
      console.warn("WORLD HOUSE snapshot unavailable", error);
      setWorldHomeStatus(worldHomeLatest ? "接続不可 · 最終受信状態を保持" : "接続不可 · 住人を非表示", true);
      if (!worldHomeLatest) {
        cards.forEach((card) => {
          const status = card.querySelector(".resident-status");
          if (status) status.textContent = "WORLD 状態未取得";
        });
      }
    } finally {
      scheduleWorldHomePoll(version);
    }
  }

  function setWorldHomeLive(enabled) {
    if (enabled && !worldHomeEnabled) return false;
    worldHomeLive = Boolean(enabled);
    worldHomeRequestVersion += 1;
    if (worldHomePollTimer !== null) window.clearTimeout(worldHomePollTimer);
    worldHomePollTimer = null;
    worldHomeToggle?.setAttribute("aria-pressed", String(worldHomeLive));
    if (worldHomeToggle) worldHomeToggle.textContent = worldHomeLive ? "プレビューへ戻る" : "WORLD 実データを見る";
    callScene("setWorldHomeMode", worldHomeLive);
    if (worldHomeLive) {
      setView("lcp", false);
      setWorldHomeStatus("接続中…");
      void pollWorldHome(worldHomeRequestVersion);
    } else {
      worldHomeLatest = null;
      if (worldHomeObservedAt) worldHomeObservedAt.hidden = true;
      cards.forEach((card) => {
        const status = card.querySelector(".resident-status");
        if (status) status.textContent = "未取得";
      });
      setWorldHomeStatus("状況データ未接続");
    }
  }

  function setFilter(filter) {
    filters.forEach((button) => {
      const isActive = button.dataset.filter === filter;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", String(isActive));
    });
    groups.forEach((group) => {
      group.hidden = filter !== "all" && group.dataset.group !== filter;
    });
  }

  function saveSelection() {
    const url = new URL(window.location.href);
    if (boardPerson) url.searchParams.set("person", boardPerson.dataset.person);
    url.searchParams.set("view", activeView);
    history.replaceState(history.state, "", url);
    updateBoardLink();
  }

  function restoreSelection() {
    const params = new URLSearchParams(window.location.search);
    const person = params.get("person");
    boardPerson = boardPeople.find((button) => button.dataset.person === person) || boardPeople[0] || null;
    setView(validViews.has(params.get("view")) ? params.get("view") : "lcp", false);

    if (!person || !boardPerson) return;
    boardPerson.focus({ preventScroll: true });
    try {
      const saved = JSON.parse(sessionStorage.getItem(scrollKey));
      if (saved?.person === boardPerson.dataset.person && saved.view === activeView && Number.isFinite(saved.y)) {
        requestAnimationFrame(() => window.scrollTo(0, saved.y));
      }
    } catch {}
  }

  houseTab?.addEventListener("click", () => setView("lcp"));
  livingTab?.addEventListener("click", () => setView("workplace"));
  viewMotionToggle?.addEventListener("click", () => setViewMotion(!viewMotionEnabled, true));
  livingJump?.addEventListener("click", () => setView(activeView === "lcp" ? "workplace" : "lcp"));
  motionToggle?.addEventListener("click", () => setPaused(!isPaused));
  markerToggle?.addEventListener("click", () => setMarker(!markerVisible));
  worldHomeToggle?.addEventListener("click", () => setWorldHomeLive(!worldHomeLive));
  filters.forEach((button) => button.addEventListener("click", () => setFilter(button.dataset.filter)));
  boardPeople.forEach((button) => {
    button.addEventListener("click", () => {
      boardPerson = button;
      saveSelection();
    });
  });
  cards.forEach((card) => {
    if (card.dataset.selectable !== "true") return;
    card.addEventListener("click", () => {
      selectResident(selectedResidentId === card.dataset.card ? null : card.dataset.card);
    });
  });
  cards.forEach((card) => {
    const image = card.querySelector(".portrait img");
    if (!image) return;
    image.addEventListener("error", () => {
      image.hidden = true;
      image.closest(".portrait")?.classList.add("portrait--fallback");
    }, { once: true });
    image.addEventListener("load", () => {
      image.closest(".portrait")?.classList.add("portrait--loaded");
    }, { once: true });
  });
  openBoard?.addEventListener("click", () => {
    try {
      sessionStorage.setItem(scrollKey, JSON.stringify({ person: boardPerson?.dataset.person, view: activeView, y: window.scrollY }));
    } catch {}
  });

  restoreSelection();
  if (worldHomeToggle) worldHomeToggle.hidden = !worldHomeEnabled;
  setViewMotion(viewMotionEnabled);
  if (systemMotionPreference) {
    const followSystemMotion = (event) => {
      if (explicitViewMotion === null) setViewMotion(!event.matches);
    };
    if (typeof systemMotionPreference.addEventListener === "function") {
      systemMotionPreference.addEventListener("change", followSystemMotion);
    } else if (typeof systemMotionPreference.addListener === "function") {
      systemMotionPreference.addListener(followSystemMotion);
    }
  }

  if (canvas && typeof window.createHouseScene === "function") {
    try {
      scene = window.createHouseScene(canvas, { cameraMotionEnabled: viewMotionEnabled, initialView: internalView(activeView), assetVersion: living.dataset.assetVersion, motionPreview: motionPreviewEnabled, houseAssetVerified, houseSha256: living.dataset.houseSha256 });
      window.housePreview = scene;
      callScene("setView", internalView(activeView));
      callScene("setPaused", isPaused);
      callScene("selectResident", selectedResidentId);
      callScene("setMarker", markerVisible);
    } catch (error) {
      console.error("House scene initialization failed", error);
      if (sceneStatus) sceneStatus.textContent = error?.message || "シーンを読み込めませんでした。";
      window.housePreview = null;
    }
  } else {
    if (sceneStatus) sceneStatus.textContent = "WebGLシーンを読み込めません。BOARDの参加者選択は利用できます。";
    window.housePreview = null;
  }

  if (scene && motionPreviewForm && window.houseSDMotion && motionPreviewEnabled) {
    const character = motionPreviewForm.elements.namedItem("character");
    const seat = motionPreviewForm.elements.namedItem("seat");
    const activity = motionPreviewForm.elements.namedItem("activity");
    const close = motionPreviewForm.elements.namedItem("close");
    const seek = document.getElementById("motion-preview-seek");
    const button = motionPreviewForm.querySelector('button[type="submit"]');
    function refreshActivities() {
      activity.replaceChildren(...Object.entries(window.houseSDMotion.actions[seat.value]).map(([value, label]) => new Option(label, value)));
      seek.disabled = seat.value === "walk";
    }
    close.addEventListener("change", () => scene.setMotionCloseView(close.checked));
    seat.addEventListener("change", refreshActivities);
    motionPreviewForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      button.disabled = true;
      motionPreviewStatus.textContent = "動作サンプルの素材を読み込み中";
      try {
        setView("workplace");
        if (await scene.startMotionPreview(character.value, seat.value, activity.value)) {
          scene.setMotionCloseView(close.checked);
          setPaused(false);
          motionPreviewStatus.textContent = "動作サンプルを表示中";
        } else {
          motionPreviewStatus.textContent = "部屋の準備後に再生できます";
        }
      } catch (error) {
        console.error("House motion preview could not start", error);
        motionPreviewStatus.textContent = "動作素材を読み込めませんでした";
      } finally {
        button.disabled = false;
      }
    });
    document.getElementById("motion-preview-stop").addEventListener("click", () => {
      scene.stopMotionPreview();
      motionPreviewStatus.textContent = "動作サンプルを終了しました";
    });
    seek.addEventListener("click", () => {
      if (!scene.seekMotionPreview()) motionPreviewStatus.textContent = "再生後に着席中の動作へ進めます";
    });
    refreshActivities();
    motionPreview.hidden = false;
    motionPreview.open = true;
  }

  window.housePreviewUI = Object.freeze({ setView, selectResident, setPaused, setMarker, setWorldHomeLive });
  if (worldHomeEnabled && scene) setWorldHomeLive(true);
  window.addEventListener("pageshow", restoreSelection);
})();
