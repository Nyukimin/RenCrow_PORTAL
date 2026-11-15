"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const webRoot = path.join(__dirname, "..", "web", "living");
const html = fs.readFileSync(path.join(webRoot, "index.html"), "utf8");
const css = fs.readFileSync(path.join(webRoot, "living.css"), "utf8");
const livingSource = fs.readFileSync(path.join(webRoot, "living.js"), "utf8");
const sceneSource = fs.readFileSync(path.join(webRoot, "scene.js"), "utf8");

function extract(source, start, end) {
  const startAt = source.indexOf(start);
  assert.notEqual(startAt, -1, `source must contain ${start}`);
  const endAt = source.indexOf(end, startAt + start.length);
  assert.notEqual(endAt, -1, `source must contain ${end} after ${start}`);
  return source.slice(startAt, endAt);
}

function testPortalShellMatchesHouseReference() {
  const header = html.match(/<header class="site-header">([\s\S]*?)<\/header>/);
  assert.ok(header, "portal header must exist");
  assert.match(header[1], /RenCrow PORTAL/);
  assert.match(header[1], /<nav[^>]*class="view-switch"/);
  assert.match(header[1], /HOUSE[\s\S]*LIVING[\s\S]*BOARD/);
  assert.match(header[1], /<time class="portal-clock" id="jst-clock"[^>]*aria-label="日本標準時"/);
  assert.match(header[1], /<svg class="portal-clock-icon"[^>]*aria-hidden="true"/);
  assert.match(header[1], /<span class="portal-clock-date" id="jst-clock-date">/);
  assert.match(header[1], /<strong class="portal-clock-time" id="jst-clock-time">/);
  assert.match(header[1], /id="board-tab"[^>]*href="\{\{\.BoardURL\}\}"/);
  assert.match(header[1], /aria-disabled="true"[^>]*>BOARD<\/span>/);
  assert.doesNotMatch(html, /scene-topline|scene-bottomline|living-section|board-link-panel|site-footer|resident-card|data-person=|data-filter=|motion-preview|world-home-toggle|marker-toggle|scene-heartbeat-bubbles/);
  assert.match(html, /<canvas id="scene"/);
  assert.match(html, /id="scene-load-status"[^>]*role="status"/);
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
  assert.equal(sandbox.houseTab.attributes["aria-pressed"], "false");
  assert.equal(sandbox.livingTab.attributes["aria-pressed"], "true");
  assert.equal(sandbox.frame.dataset.view, "living");
  assert.deepEqual(sceneCalls[0], ["setView", "living"]);
  assert.ok(events.includes("heartbeat"), "LIVING camera selection must keep heartbeat polling in sync");

  sceneCalls.length = 0;
  vm.runInNewContext(`${setView}\nsetView("lcp", false);`, sandbox);
  assert.equal(sandbox.frame.dataset.view, "house");
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
  const mapper = extract(livingSource, "  function presentHeartbeatResponse(payload) {", "\n  async function pollLivingHeartbeat");
  const sandbox = {
    heartbeatActors: new Set(["mio", "shiro", "kuro", "midori", "aka", "ao", "kin", "gin"]),
    heartbeatStates: new Set(["waiting", "checking", "running", "stopping"]),
    heartbeatActivities: new Set(["board", "private", "game", "foreground", "routine"]),
    heartbeatRoutineAvailability: new Set(["available", "disabled", "unavailable"]),
    heartbeatOngoingActivities: new Set(["rest", "sleep_window", "waiting"]),
    heartbeatActivityLabels: { board: "BOARD対応中", private: "個別タスク中", game: "ゲーム中", foreground: "会話対応中", routine: "日課中" },
    heartbeatStateLabels: { waiting: "待機中", checking: "確認中", running: "実行中", stopping: "停止中" },
    heartbeatOngoingActivityLabels: { rest: "休憩中", sleep_window: "就寝時間", waiting: "次の活動を確認中" },
    names: new Map(),
  };
  const agents = [
    { actor_id: "mio", state: "waiting", routine_availability: "available", ongoing_activity: "rest" },
    { actor_id: "shiro", state: "waiting", routine_availability: "available", ongoing_activity: "sleep_window" },
    { actor_id: "kuro", state: "waiting", routine_availability: "available", ongoing_activity: "waiting" },
    { actor_id: "midori", state: "waiting", routine_availability: "disabled" },
    { actor_id: "aka", state: "waiting", routine_availability: "unavailable" },
    { actor_id: "ao", state: "checking" },
    { actor_id: "kin", state: "stopping" },
    { actor_id: "gin", state: "running", activity_kind: "game" },
  ];
  const mapped = vm.runInNewContext(`${mapper}\npresentHeartbeatResponse({ observed_at:"2026-11-15T00:00:00Z", agents });`, { ...sandbox, agents });
  assert.deepEqual(Array.from(mapped, item => item.label), ["休憩中", "就寝時間", "次の活動を確認中", "日課停止中", "日課状態を取得できません", "確認中", "停止中", "ゲーム中"]);

  for (const invalid of [
    { ...agents[0], routine_availability: "maybe" },
    { ...agents[0], ongoing_activity: "unknown" },
    { ...agents[0], ongoing_activity: "rest", routine_availability: "disabled" },
    { ...agents[0], state: "running", routine_availability: "available" },
  ]) {
    const changed = agents.slice();
    changed[0] = invalid;
    assert.throws(() => vm.runInNewContext(`${mapper}\npresentHeartbeatResponse({ observed_at:"2026-11-15T00:00:00Z", agents });`, { ...sandbox, agents: changed }), /invalid living heartbeat/);
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
testPageBootsAndSwitchesViewsWithoutRemovedAuxiliaryDom();
testAtticMarkingBeamsAreRemovedBeforeMeshBatching();

console.log("PORTAL HOUSE shell, camera navigation, JST clock, BOARD link and roof cleanup passed");
