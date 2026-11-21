"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const webRoot = path.join(__dirname, "..", "web", "living");
const html = fs.readFileSync(path.join(webRoot, "index.html"), "utf8");
const css = fs.readFileSync(path.join(webRoot, "living.css"), "utf8");
const livingSource = fs.readFileSync(path.join(webRoot, "living.js"), "utf8");
const sceneSource = fs.readFileSync(path.join(webRoot, "scene.js"), "utf8");
const currentActivitySource = fs.readFileSync(path.join(webRoot, "current-activity.js"), "utf8");

function extract(source, start, end) {
  const startAt = source.indexOf(start);
  assert.notEqual(startAt, -1, `source must contain ${start}`);
  const endAt = source.indexOf(end, startAt + start.length);
  assert.notEqual(endAt, -1, `source must contain ${end} after ${start}`);
  return source.slice(startAt, endAt);
}

function worldHomePollHarness(fetcher) {
  const timers = [];
  const freshness = [];
  const statuses = [];
  const retained = { state_seq: 17 };
  const sandbox = {
    worldHomeLive: true,
    worldHomeRequestVersion: 3,
    worldHomePollTimer: null,
    worldHomeFetchTimeoutMs: 5000,
    worldHomeLatest: retained,
    houseAssetVerified: true,
    scene: {
      worldHomeReady() { return true; },
      setWorldHomeSnapshotFresh(value) { freshness.push(value); },
    },
    callScene(method, ...args) { return sandbox.scene[method]?.(...args); },
    fetch: fetcher,
    showWorldHomeSnapshot(snapshot) {
      sandbox.worldHomeLatest = snapshot;
      sandbox.scene.setWorldHomeSnapshotFresh(true);
    },
    setWorldHomeStatus(message, unavailable) { statuses.push({ message, unavailable }); },
    cards: [],
    console: { warn() {} },
    AbortController,
    window: {
      setTimeout(callback, delay) {
        const timer = { callback, delay, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimeout(timer) { if (timer) timer.cleared = true; },
    },
  };
  const poll = extract(livingSource, "  function scheduleWorldHomePoll(version) {", "\n  function setWorldHomeLive(enabled)");
  vm.runInNewContext(poll, sandbox);
  return { sandbox, timers, freshness, statuses, retained };
}

function testPortalShellMatchesHouseReference() {
  const header = html.match(/<header class="site-header">([\s\S]*?)<\/header>/);
  assert.ok(header, "portal header must exist");
  assert.match(header[1], /RenCrow PORTAL/);
  assert.match(header[1], /<nav[^>]*class="view-switch"/);
  assert.match(header[1], /HOUSE[\s\S]*LIVING[\s\S]*BOARD[\s\S]*Tasks/);
  assert.match(header[1], /<time class="portal-clock" id="jst-clock"[^>]*aria-label="日本標準時"/);
  assert.match(header[1], /<svg class="portal-clock-icon"[^>]*aria-hidden="true"/);
  assert.match(header[1], /<span class="portal-clock-date" id="jst-clock-date">/);
  assert.match(header[1], /<strong class="portal-clock-time" id="jst-clock-time">/);
  assert.match(header[1], /id="board-tab"[^>]*href="\{\{\.BoardURL\}\}"/);
  assert.match(header[1], /id="board-tasks-tab"[^>]*href="\{\{\.BoardURL\}\}\?view=tasks"/);
  assert.match(header[1], /aria-disabled="true"[^>]*>BOARD<\/span>/);
  assert.doesNotMatch(html, /scene-topline|scene-bottomline|living-section|board-link-panel|site-footer|resident-card|data-person=|data-filter=|motion-preview|world-home-toggle|marker-toggle/);
  assert.match(html, /<canvas id="scene"/);
  assert.match(html, /id="scene-load-status"[^>]*role="status"/);
}

function testCanonicalActivityLabelAndWORLDProjectionAreCurated() {
  const policy = extract(livingSource, "  const heartbeatActors = new Set(", "  let activeView =");
  const mapper = extract(livingSource, "  function presentHeartbeatResponse(payload) {", "\n  async function pollLivingHeartbeat");
  const currentActivity = { kind: "chat", label: "シロと会話中", phase: "talking", revision: 12 };
  const actors = ["mio", "shiro", "kuro", "midori", "aka", "ao", "kin", "gin"].map(actor_id => ({actor_id,state:"running"}));
  actors[0].current_activity = currentActivity;
  const activitySandbox = { window: {} };
  vm.runInNewContext(currentActivitySource, activitySandbox);
  const result = vm.runInNewContext(
    `${policy}\n${mapper}\npresentHeartbeatResponse({observed_at:"2026-11-21T00:00:00Z",agents});`,
    { agents: actors, names: new Map(), window: activitySandbox.window },
  );
  assert.equal(result[0].label, currentActivity.label, "canonical activity label takes precedence over the scheduler label");
  assert.deepEqual(JSON.parse(JSON.stringify(result[0].current_activity)), currentActivity);
  assert.match(sceneSource, /item\.current_activity\.label\.slice\(0, 48\)/, "scene bubbles use the canonical label when available");
  assert.match(fs.readFileSync(path.join(webRoot, "world-home.js"), "utf8"), /accepted\.current_activity = \{/,
    "WORLD validation retains the same canonical descriptor");
  for (const invalid of [
    { ...currentActivity, label: "秘密のタスク" },
    { ...currentActivity, phase: "working" },
    { ...currentActivity, label: "ミオと会話中" },
    { ...currentActivity, task_id: "private-task" },
  ]) {
    const changed = actors.slice();
    changed[0] = { ...actors[0], current_activity: invalid };
    assert.throws(() => vm.runInNewContext(
      `${policy}\n${mapper}\npresentHeartbeatResponse({observed_at:"2026-11-21T00:00:00Z",agents});`,
      { agents: changed, names: new Map(), window: activitySandbox.window },
    ), /invalid living heartbeat current activity/);
  }
}

function testHouseSceneUsesViewportAndResponsiveFullFrame() {
  assert.match(css, /\.page-shell\.living\s*\{[^}]*height:\s*100dvh;[^}]*overflow:\s*hidden;/s);
  const viewportRule = css.match(/\.scene-viewport\s*\{([^}]*)\}/)?.[1] || "";
  assert.match(viewportRule, /flex:\s*1 1 auto;/);
  assert.match(viewportRule, /min-height:\s*0;/);
  assert.match(css, /@media\s*\(max-width:\s*\d+px\)[\s\S]*?\.view-tab[\s\S]*?\.portal-clock/);
  assert.match(sceneSource, /function fitFraming\(bounds, aspect\)[\s\S]*?Math\.max\(\(bounds\.max\.y - bounds\.min\.y\) \/ 0\.93, \(bounds\.max\.x - bounds\.min\.x\) \/ \(aspect \* 0\.95\)\)/);
}

function testMobileHeaderKeepsBrandTabsAndClockInOneRow() {
  const mobileHeader = extract(css, "@media (max-width: 640px) {", "\n@media (max-width: 380px)");
  assert.match(mobileHeader, /\.site-header\s*\{[^}]*height:\s*42px;[^}]*\}/s);
  assert.match(mobileHeader, /\.brand\s*\{[^}]*width:\s*100%;/);
  assert.match(mobileHeader, /\.brand-mark\s*\{[^}]*display:\s*none;/);
  assert.match(mobileHeader, /\.brand-name\s*\{[^}]*font-size:\s*clamp\(10px,\s*2\.8vw,\s*12px\);/);
  assert.match(mobileHeader, /\.portal-clock\s*\{[^}]*font-size:\s*clamp\(10px,\s*2\.55vw,\s*12px\);/);
  assert.match(mobileHeader, /\.portal-clock\s*\{[^}]*padding:\s*3px 2px;/);
  assert.match(mobileHeader, /\.portal-clock-date\s*\{[^}]*font-size:\s*clamp\(9px,\s*2\.55vw,\s*12px\);/);
  assert.match(mobileHeader, /\.portal-clock-time\s*\{[^}]*font-size:\s*clamp\(12px,\s*3\.2vw,\s*15px\);/);
  assert.match(css, /\.site-header\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto\s+minmax\(0,\s*1fr\);/s);
  const compactHeader = extract(css, "@media (max-width: 380px) {", "\n}");
  assert.match(compactHeader, /\.portal-clock\s*\{[^}]*gap:\s*1px;/);
  assert.match(compactHeader, /\.portal-clock-date\s*\{[^}]*font-size:\s*8px;/);
  assert.match(compactHeader, /\.portal-clock-icon\s*\{[^}]*width:\s*10px;/);
  assert.match(compactHeader, /\.portal-clock-time\s*\{[^}]*font-size:\s*12px;/);
}

function testClockMatchesBoardVisualHierarchyWithoutFrame() {
  const clockRule = css.match(/\.portal-clock\s*\{([^}]*)\}/)?.[1] || "";
  assert.match(clockRule, /display:\s*flex;/);
  assert.match(clockRule, /align-items:\s*center;/);
  assert.match(clockRule, /gap:\s*6px;/);
  assert.match(clockRule, /font-size:\s*12px;/);
  assert.doesNotMatch(clockRule, /border\s*:/);
  const timeRule = css.match(/\.portal-clock-time\s*\{([^}]*)\}/)?.[1] || "";
  assert.match(timeRule, /font-size:\s*20px;/);
  assert.match(timeRule, /font-weight:\s*700;/);
}

function testJstClockFormatting() {
  const formatter = extract(livingSource, "  function formatJST(date) {", "\n  function updateJSTClock");
  const sandbox = { Intl, Date };
  vm.runInNewContext(`${formatter}\nresult = [formatJST(new Date("2026-11-15T11:29:00Z")), formatJST(new Date("2026-11-14T14:59:00Z")), formatJST(new Date("2026-11-14T15:00:00Z"))];`, sandbox);
  assert.equal(JSON.stringify(sandbox.result), JSON.stringify([
    { date: "11月15日(日)", time: "20:29" },
    { date: "11月14日(土)", time: "23:59" },
    { date: "11月15日(日)", time: "00:00" },
  ]));
  assert.equal((formatter.match(/timeZone:\s*["']Asia\/Tokyo["']/g) || []).length, 2);
}

function testJstClockUpdatesAtMinuteBoundaryAndKeepsDatetime() {
  const formatter = extract(livingSource, "  function formatJST(date) {", "\n  function updateJSTClock");
  const updater = extract(livingSource, "  function updateJSTClock() {", "\n  updateJSTClock();");
  let now = Date.parse("2026-11-14T14:59:37Z");
  const timers = [];
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now + 50; }
  }
  const clock = { dateTime: "" };
  const dateLabel = { textContent: "" };
  const timeLabel = { textContent: "" };
  const sandbox = {
    Date: ClockDate,
    Intl,
    jstClock: clock,
    jstClockDate: dateLabel,
    jstClockTime: timeLabel,
    window: { setTimeout(callback, delay) { timers.push({ callback, delay }); } },
  };
  vm.runInNewContext(`${formatter}\n${updater}\nupdateJSTClock();`, sandbox);
  assert.equal(dateLabel.textContent, "11月14日(土)");
  assert.equal(timeLabel.textContent, "23:59");
  assert.equal(clock.dateTime, "2026-11-14T14:59:37.000Z");
  assert.equal(timers[0].delay, 60_000 - (now % 60_000));

  now = Date.parse("2026-11-14T15:00:05Z");
  timers[0].callback();
  assert.equal(dateLabel.textContent, "11月15日(日)", "the weekday and date must roll over at JST midnight");
  assert.equal(timeLabel.textContent, "00:00");
  assert.equal(clock.dateTime, "2026-11-14T15:00:05.000Z");
  assert.equal(timers[1].delay, 60_000 - (now % 60_000));
}

function testHeaderTabsSwitchTheRealHouseCameras() {
  const setView = extract(livingSource, "  function setView(view, persist = true) {", "\n  function selectResident");
  const sceneCalls = [];
  const events = [];
  function button() {
    return { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
  }
  const sandbox = {
    activeView: "lcp",
    gameActivationSequence: 0,
    houseTab: button(),
    livingTab: button(),
    frame: { dataset: {} },
    livingBoard: null,
    motionPreview: null,
    motionPreviewEnabled: false,
    window: { houseSDMotion: null },
    sceneName: null,
    sceneContext: null,
    livingJump: null,
    portalView: view => view === "workplace" || view === "living" ? "workplace" : "lcp",
    internalView: view => view === "workplace" ? "living" : "house",
    callScene: (...args) => sceneCalls.push(args),
    syncLivingHeartbeat: () => events.push("heartbeat"),
    saveSelection: () => events.push("save"),
    updateBoardLink: () => events.push("board"),
  };
  vm.runInNewContext(`${setView}\nsetView("workplace", false);`, sandbox);
  assert.equal(sandbox.activeView, "workplace");
  assert.equal(sandbox.gameActivationSequence, 1, "changing views must invalidate pending sprite activation");
  assert.equal(sandbox.houseTab.attributes["aria-pressed"], "false");
  assert.equal(sandbox.livingTab.attributes["aria-pressed"], "true");
  assert.equal(sandbox.frame.dataset.view, "living");
  assert.deepEqual(sceneCalls[0], ["setView", "living"]);
  assert.ok(events.includes("heartbeat"), "LIVING camera selection must keep heartbeat polling in sync");

  sceneCalls.length = 0;
  vm.runInNewContext(`${setView}\nsetView("lcp", false);`, sandbox);
  assert.equal(sandbox.frame.dataset.view, "house");
  assert.equal(sandbox.gameActivationSequence, 2);
  assert.deepEqual(sceneCalls[0], ["setView", "house"]);
}

function testBoardTabUsesConfiguredUrlAndFailsClosedWithoutIt() {
  const updateBoardLink = extract(livingSource, "  function updateBoardLink() {", "\n  function setView(");
  const attributes = {};
  const boardTab = {
    href: "",
    setAttribute(name, value) { attributes[name] = value; },
    removeAttribute(name) { delete attributes[name]; if (name === "href") this.href = ""; },
  };
  const sandbox = {
    boardTab,
    living: { dataset: { boardUrl: "https://board.example/" } },
    activeView: "workplace",
    URL,
  };
  vm.runInNewContext(`${updateBoardLink}\nupdateBoardLink();`, sandbox);
  const configured = new URL(boardTab.href);
  assert.equal(configured.origin, "https://board.example");
  assert.equal(configured.searchParams.get("from"), "living");
  assert.equal(configured.searchParams.has("agent"), false, "BOARD navigation must not choose a participant");
  assert.equal(configured.searchParams.has("person"), false, "BOARD navigation must not open a person page");
  assert.equal(configured.searchParams.get("view"), "workplace");

  const missingAttrs = {};
  sandbox.boardTab = {
    href: "https://board.example/",
    setAttribute(name, value) { missingAttrs[name] = value; },
    removeAttribute(name) { delete missingAttrs[name]; if (name === "href") this.href = ""; },
  };
  sandbox.living.dataset.boardUrl = "";
  vm.runInNewContext(`${updateBoardLink}\nupdateBoardLink();`, sandbox);
  assert.equal(sandbox.boardTab.href, "");
  assert.equal(missingAttrs["aria-disabled"], "true");
}

function testHeartbeatWaitingActivityUsesOnlyValidatedRoutineProjection() {
  const policy = extract(livingSource, "  const heartbeatActors = new Set(", "  let activeView =");
  const mapper = extract(livingSource, "  function presentHeartbeatResponse(payload) {", "\n  async function pollLivingHeartbeat");
  const present = (agents) => vm.runInNewContext(
    `${policy}\n${mapper}\npresentHeartbeatResponse({ observed_at:"2026-11-15T00:00:00Z", agents });`,
    { agents, names: new Map() },
  );
  const agents = [
    { actor_id: "mio", state: "waiting", routine_availability: "available", ongoing_activity: "rest" },
    { actor_id: "shiro", state: "waiting", routine_availability: "available", ongoing_activity: "sleep_window" },
    { actor_id: "kuro", state: "waiting", routine_availability: "available", ongoing_activity: "waiting" },
    { actor_id: "midori", state: "waiting", routine_availability: "disabled" },
    { actor_id: "aka", state: "waiting", routine_availability: "unavailable" },
    { actor_id: "ao", state: "checking" },
    { actor_id: "kin", state: "stopping" },
    { actor_id: "gin", state: "running", activity_kind: "routine", routine_availability: "available", ongoing_activity: "moving_home" },
  ];
  const mapped = present(agents);
  assert.deepEqual(Array.from(mapped, item => item.label), ["休憩中", "就寝時間", "次の活動を確認中", "日課停止中", "日課状態を取得できません", "確認中", "停止中", "自室に移動中"]);
  const waitingMoveAgents = agents.slice();
  waitingMoveAgents[0] = { ...agents[0], ongoing_activity: "moving_home" };
  const waitingMove = present(waitingMoveAgents);
  assert.equal(waitingMove[0].label, "自室に移動中", "fresh WORLD movement must remain visible while the scheduler is waiting");

  for (const [activity, label] of Object.entries({
    sofa_reading: "ソファで読書中",
    sofa_chat: "ソファで会話中",
    dining_tea: "ダイニングでお茶中",
    dining_tea_chat: "ダイニングでお茶・会話中",
  })) {
    const waitingRoutine = agents.slice();
    waitingRoutine[0] = { ...agents[0], state: "waiting", routine_availability: "available", ongoing_activity: activity };
    const waitingProjection = present(waitingRoutine)[0];
    assert.equal(waitingProjection.label, label, `${activity} is visible while the scheduler waits`);
    assert.equal(waitingProjection.ongoing_activity, activity, `${activity} remains attached to its actor for the matching WORLD seat`);

    const runningRoutine = agents.slice();
    runningRoutine[0] = { ...agents[0], state: "running", activity_kind: "routine", routine_availability: "available", ongoing_activity: activity };
    const runningProjection = present(runningRoutine)[0];
    assert.equal(runningProjection.label, label, `${activity} is visible during its running routine`);
    assert.equal(runningProjection.ongoing_activity, activity, `${activity} remains attached to its actor for the matching WORLD seat`);
  }
  assert.equal(Object.hasOwn(present(agents)[0], "ongoing_activity"), false, "rest-only status does not select an activity pose");
  assert.equal(Object.hasOwn(present(agents)[7], "ongoing_activity"), false, "movement does not select an activity pose");

  for (const invalid of [
    { ...agents[0], routine_availability: "maybe" },
    { ...agents[0], ongoing_activity: "unknown" },
    { ...agents[0], ongoing_activity: "rest", routine_availability: "disabled" },
    { ...agents[0], state: "running", routine_availability: "available" },
    { ...agents[0], state: "running", activity_kind: "board", ongoing_activity: "moving_home" },
    { ...agents[0], state: "running", activity_kind: "board", routine_availability: "available", ongoing_activity: "sofa_reading" },
    { ...agents[0], state: "running", activity_kind: "board", routine_availability: "available", ongoing_activity: "dining_tea" },
    { ...agents[0], state: "waiting", activity_kind: "private", routine_availability: "available", ongoing_activity: "sofa_chat" },
    { ...agents[0], state: "checking", routine_availability: "available", ongoing_activity: "dining_tea_chat" },
    { ...agents[0], state: "checking", ongoing_activity: "moving_home" },
  ]) {
    const changed = agents.slice();
    changed[0] = invalid;
    assert.throws(() => present(changed), /invalid living heartbeat/);
  }
}

function testHeartbeatGameLabelsRequireRunningNethackIdentity() {
  const policy = extract(livingSource, "  const heartbeatActors = new Set(", "  let activeView =");
  const mapper = extract(livingSource, "  function presentHeartbeatResponse(payload) {", "\n  async function pollLivingHeartbeat");
  const agents = [
    { actor_id: "mio", state: "running", activity_kind: "game", game_id: "nethack" },
    { actor_id: "shiro", state: "running", activity_kind: "game", game_id: "other-game" },
    { actor_id: "kuro", state: "running", activity_kind: "game" },
    { actor_id: "midori", state: "running", activity_kind: "foreground", game_id: "nethack" },
    { actor_id: "aka", state: "stopping", activity_kind: "game", game_id: "nethack" },
    { actor_id: "ao", state: "running", activity_kind: "private", title: "Private title", game_id: "nethack" },
    { actor_id: "kin", state: "running", activity_kind: "board" },
    { actor_id: "gin", state: "waiting" },
  ];
  const present = (input) => vm.runInNewContext(
    `${policy}\n${mapper}\npresentHeartbeatResponse({ observed_at:"2026-11-15T00:00:00Z", agents });`,
    { agents: input, names: new Map() },
  );
  const mapped = present(agents);
  assert.deepEqual(Array.from(mapped, item => item.label), ["Nethackで遊んでる", "ゲームで遊んでる", "ゲームで遊んでる", "会話対応中", "停止中", "個別タスク中", "BOARD対応中", "待機中"]);
  assert.equal(mapped[5].title, "Private title", "private task title remains available under its existing visibility policy");
  assert.equal(mapped[0].title, "", "game title must not become public");

  for (const invalid of [null, 1, true, {}, []]) {
    const changed = agents.slice();
    changed[0] = { ...agents[0], game_id: invalid };
    assert.throws(() => present(changed), /invalid living heartbeat game id/);
  }
}

function testHeartbeatBubblesHaveAReadableOverlayAndKeepTheCurrentFloorGate() {
  assert.match(html, /<div id="scene-heartbeat-bubbles" class="scene-heartbeat-bubbles" aria-live="off"><\/div>/,
    "the real LIVING page must mount the scene heartbeat overlay");
  const overlayRule = css.match(/\.scene-heartbeat-bubbles\s*\{([^}]*)\}/)?.[1] || "";
  assert.match(overlayRule, /position:\s*absolute;/);
  assert.match(overlayRule, /z-index:\s*2;/);
  assert.match(overlayRule, /inset:\s*0;/);
  assert.match(overlayRule, /pointer-events:\s*none;/);

  const bubbleRule = css.match(/\.scene-heartbeat-bubble\s*\{([^}]*)\}/)?.[1] || "";
  assert.match(bubbleRule, /max-width:\s*min\(176px,\s*42vw\);/);
  assert.match(bubbleRule, /border:\s*1px solid rgba\(255,\s*226,\s*170,\s*\.92\);/);
  assert.match(bubbleRule, /background:\s*rgba\(20,\s*31,\s*48,\s*\.94\);/);
  assert.match(bubbleRule, /color:\s*#fff1d9;/);
  assert.match(bubbleRule, /font-size:\s*clamp\(11px,\s*1\.05vw,\s*14px\);/);
  assert.match(bubbleRule, /line-height:\s*1\.25;/);
  assert.match(css, /\.scene-heartbeat-bubble\[hidden\][^{]*\{\s*display:\s*none;/);
  assert.match(css, /@media\s*\(max-width:\s*640px\)[\s\S]*?\.scene-heartbeat-bubble\s*\{[^}]*font-size:\s*9px;/);

  const positionUpdate = extract(sceneSource, "    function updateHeartbeatBubblePositions() {", "\n    function setHeartbeatBubbles(items) {");
  assert.match(positionUpdate, /view !== "living"/);
  assert.match(positionUpdate, /!resident\.group\.visible/);
  assert.match(positionUpdate, /resident\.mesh\.material\.opacity < 0\.5/);
}

function testHeartbeatBubblePlacementStaysInsideViewportAtEdges() {
  const helpers = extract(sceneSource, "  function clamp(value, minimum, maximum) {", "\n  function smooth(value) {");
  const placement = extract(sceneSource, "  function heartbeatBubblePlacement(anchor, size, bounds, lift) {", "\n  function smooth(value) {");
  const sandbox = {};
  vm.runInNewContext(`${helpers}\n${placement}\nresult = [\n  heartbeatBubblePlacement({ x: 2, y: 9 }, { width: 104, height: 32 }, { width: 300, height: 180 }, 20),\n  heartbeatBubblePlacement({ x: 299, y: 100 }, { width: 104, height: 32 }, { width: 300, height: 180 }, 0),\n];`, sandbox);
  const placements = JSON.parse(JSON.stringify(sandbox.result));
  assert.deepEqual(placements[0], {
    left: 58,
    top: 9,
    placement: "below",
    arrowOffset: -44,
    stem: 0,
    rect: { left: 6, top: 17, right: 110, bottom: 49 },
  }, "a lifted bubble near the upper-left edge must flip below and clamp its body and tail");
  assert.deepEqual(placements[1], {
    left: 242,
    top: 100,
    placement: "above",
    arrowOffset: 44,
    stem: 0,
    rect: { left: 190, top: 60, right: 294, bottom: 92 },
  }, "a bubble near the right edge must clamp its body and keep the tail aimed at its actor");
  for (const item of placements) {
    assert.ok(item.rect.left >= 6 && item.rect.top >= 6);
    assert.ok(item.rect.right <= 294 && item.rect.bottom <= 174);
  }
}

function testPageBootsAndSwitchesViewsWithoutRemovedAuxiliaryDom() {
  const sceneCalls = [];
  function element(dataset = {}) {
    return {
      dataset,
      attributes: {},
      listeners: {},
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(type, callback) { this.listeners[type] = callback; },
      setAttribute(name, value) { this.attributes[name] = value; },
      removeAttribute(name) { delete this.attributes[name]; },
    };
  }
  const houseTab = element();
  const livingTab = element();
  const frame = element();
  const boardTab = element();
  const clock = element();
  const clockDate = element();
  const clockTime = element();
  const canvas = element();
  const sceneStatus = element();
  const page = element({
    boardUrl: "https://board.example/",
    assetVersion: "test",
    worldHomeEnabled: "true",
    houseAssetVerified: "false",
    houseSha256: "",
  });
  const dom = new Map([
    ["scene", canvas], ["jst-clock", clock], ["jst-clock-date", clockDate], ["jst-clock-time", clockTime], ["scene-frame", frame],
    ["house-tab", houseTab], ["living-tab", livingTab], ["board-tab", boardTab],
    ["scene-load-status", sceneStatus],
  ]);
  const scene = {
    setView(view) { sceneCalls.push(view); },
    setPaused() {}, selectResident() {}, setMarker() {}, setHeartbeatBubbles() {},
    setCameraMotionEnabled() {}, setWorldHomeMode(enabled) { if (enabled) sceneCalls.push("world-live"); },
  };
  const document = {
    visibilityState: "visible",
    querySelector(selector) { return selector === ".living" ? page : null; },
    querySelectorAll() { return []; },
    getElementById(id) { return dom.get(id) || null; },
    addEventListener() {},
  };
  const window = {
    location: { search: "", href: "https://portal.example/living" },
    localStorage: { getItem() { return null; }, setItem() {} },
    setTimeout() { return 1; }, clearTimeout() {}, addEventListener() {},
    houseWorldHome: { houseSHA256: "", createTimeline() { return {}; } },
    createHouseScene() { return scene; },
  };
  const sandbox = {
    document, window, URL, URLSearchParams, Intl, Date, Map, Set, Object, Array, Boolean,
    TypeError, console,
    history: { state: null, replaceState(_state, _title, url) { window.location.href = String(url); window.location.search = new URL(url).search; } },
  };
  vm.runInNewContext(livingSource, sandbox, { filename: "living.js" });
  assert.match(clockDate.textContent, /^\d{1,2}月\d{1,2}日\([^)]\)$/);
  assert.match(clockTime.textContent, /^\d{2}:\d{2}$/);
  assert.match(clock.dateTime, /^\d{4}-\d\d-\d\dT.*Z$/);
  assert.ok(sceneCalls.includes("house"), "initial camera should be HOUSE");
  assert.ok(sceneCalls.includes("world-live"), "WORLD mode should initialize from configuration without its removed toggle");
  livingTab.listeners.click();
  assert.equal(frame.dataset.view, "living");
  assert.equal(livingTab.attributes["aria-pressed"], "true");
  assert.ok(sceneCalls.includes("living"), "LIVING tab should switch the real camera");
  houseTab.listeners.click();
  assert.equal(frame.dataset.view, "house");
  assert.equal(houseTab.attributes["aria-pressed"], "true");
}

function testAtticMarkingBeamsAreRemovedBeforeMeshBatching() {
  const names = [
    "Attic_Roof_Beam_v4",
    "Attic_Roof_Beam.001_v4",
    "Attic_Roof_Beam.002_v4",
    "Attic_Roof_Beam.003_v4",
    "Attic_Roof_Beam.004_v4",
  ];
  const arrangeAt = sceneSource.indexOf("var atticNodes = arrangeFloor(atticRoot, metadata.atticLayout);");
  assert.notEqual(arrangeAt, -1, "attic floor nodes must be retained for the roof cleanup");
  const removeAt = sceneSource.indexOf("removeFromParent()", arrangeAt);
  const optimizeAt = sceneSource.indexOf("optimizeRoomGeometry();", arrangeAt);
  assert.ok(removeAt > arrangeAt && optimizeAt > removeAt, "roof beams must be removed after floor arrangement and before batching");
  for (const name of names) assert.ok(sceneSource.includes(name), `must remove ${name}`);
  assert.doesNotMatch(sceneSource.slice(arrangeAt, optimizeAt), /Attic_Roof_Beam[^\n]*\.visible\s*=\s*false/);
}

testPortalShellMatchesHouseReference();
testHouseSceneUsesViewportAndResponsiveFullFrame();
testMobileHeaderKeepsBrandTabsAndClockInOneRow();
testClockMatchesBoardVisualHierarchyWithoutFrame();
testJstClockFormatting();
testJstClockUpdatesAtMinuteBoundaryAndKeepsDatetime();
testHeaderTabsSwitchTheRealHouseCameras();
testBoardTabUsesConfiguredUrlAndFailsClosedWithoutIt();
testHeartbeatWaitingActivityUsesOnlyValidatedRoutineProjection();
testCanonicalActivityLabelAndWORLDProjectionAreCurated();
testHeartbeatGameLabelsRequireRunningNethackIdentity();
testHeartbeatBubblesHaveAReadableOverlayAndKeepTheCurrentFloorGate();
testHeartbeatBubblePlacementStaysInsideViewportAtEdges();
testPageBootsAndSwitchesViewsWithoutRemovedAuxiliaryDom();
testAtticMarkingBeamsAreRemovedBeforeMeshBatching();

test("canonical task work has a work label and does not reveal task identity or title", () => {
  const policy = extract(livingSource, "  const heartbeatActors = new Set(", "  let activeView =");
  const mapper = extract(livingSource, "  function presentHeartbeatResponse(payload) {", "\n  async function pollLivingHeartbeat");
  const agents = ["mio", "shiro", "kuro", "midori", "aka", "ao", "kin", "gin"].map(actor_id => ({actor_id,state:"waiting"}));
  agents[0] = {actor_id:"mio",state:"running",activity_kind:"task",title:"private-title-marker",task_id:"private-task-marker"};
  const result = vm.runInNewContext(
    `${policy}\n${mapper}\npresentHeartbeatResponse({observed_at:"2026-11-21T00:00:00Z",agents});`,
    {agents,names:new Map()},
  );
  assert.equal(result[0].label, "作業中");
  assert.equal(result[0].title, "");
  assert.doesNotMatch(JSON.stringify(result), /private-title-marker|private-task-marker/);
});

test("WORLD fetch failure clears only activity freshness and a later successful snapshot restores it", async () => {
  const harness = worldHomePollHarness(async () => ({ ok: false, status: 503 }));
  await harness.sandbox.pollWorldHome(3);
  assert.deepEqual(harness.freshness, [false], "failed WORLD fetch disables the activity overlay");
  assert.equal(harness.sandbox.worldHomeLatest, harness.retained, "the last displayed snapshot remains retained");

  const recovered = { state_seq: 18 };
  harness.sandbox.fetch = async () => ({ ok: true, async json() { return recovered; } });
  await harness.sandbox.pollWorldHome(3);
  assert.deepEqual(harness.freshness, [false, true], "successful snapshot reception restores the activity overlay");
  assert.equal(harness.sandbox.worldHomeLatest, recovered);
});

test("WORLD fetch timeout aborts the GET and clears only activity freshness", async () => {
  let requestSignal = null;
  const harness = worldHomePollHarness((_url, options) => {
    requestSignal = options.signal;
    return new Promise(() => {});
  });
  const pending = harness.sandbox.pollWorldHome(3);
  await Promise.resolve();
  const timeout = harness.timers.find((timer) => timer.delay === 5000);
  assert.ok(timeout, "WORLD snapshot GET has a bounded timeout");
  timeout.callback();
  await pending;
  assert.equal(requestSignal.aborted, true, "timed-out request is aborted");
  assert.deepEqual(harness.freshness, [false]);
  assert.equal(harness.sandbox.worldHomeLatest, harness.retained, "timeout preserves the last displayed snapshot");
});

console.log("PORTAL HOUSE shell, camera navigation, JST clock, BOARD link and roof cleanup passed");
