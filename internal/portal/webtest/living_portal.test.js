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
  assert.match(header[1], /id="jst-clock"[^>]*aria-label="日本標準時"/);
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
  assert.match(css, /\.site-header\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto\s+minmax\(0,\s*1fr\);/s);
}

function testJstClockFormatting() {
  const formatter = extract(livingSource, "  function formatJST(date) {", "\n  function updateJSTClock");
  const sandbox = { Intl, Date };
  vm.runInNewContext(`${formatter}\nresult = formatJST(new Date("2026-11-15T00:24:00Z"));`, sandbox);
  assert.equal(sandbox.result, "2026/11/15 09:24");
  assert.match(formatter, /timeZone:\s*["']Asia\/Tokyo["']/);
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
    ["scene", canvas], ["jst-clock", clock], ["scene-frame", frame],
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
  assert.match(clock.textContent, /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/);
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
  ];
  const arrangeAt = sceneSource.indexOf("var atticNodes = arrangeFloor(atticRoot, metadata.atticLayout);");
  assert.notEqual(arrangeAt, -1, "attic floor nodes must be retained for the roof cleanup");
  const removeAt = sceneSource.indexOf("removeFromParent()", arrangeAt);
  const optimizeAt = sceneSource.indexOf("optimizeRoomGeometry();", arrangeAt);
  assert.ok(removeAt > arrangeAt && optimizeAt > removeAt, "roof beams must be removed after floor arrangement and before batching");
  for (const name of names) assert.ok(sceneSource.includes(name), `must remove ${name}`);
  assert.ok(!sceneSource.includes("Attic_Roof_Beam.004_v4"), "the .004 roof beam must remain outside the removal list");
  assert.doesNotMatch(sceneSource.slice(arrangeAt, optimizeAt), /Attic_Roof_Beam[^\n]*\.visible\s*=\s*false/);
}

testPortalShellMatchesHouseReference();
testHouseSceneUsesViewportAndResponsiveFullFrame();
testMobileHeaderKeepsBrandTabsAndClockInOneRow();
testJstClockFormatting();
testHeaderTabsSwitchTheRealHouseCameras();
testBoardTabUsesConfiguredUrlAndFailsClosedWithoutIt();
testPageBootsAndSwitchesViewsWithoutRemovedAuxiliaryDom();
testAtticMarkingBeamsAreRemovedBeforeMeshBatching();

console.log("PORTAL HOUSE shell, camera navigation, JST clock, BOARD link and roof cleanup passed");
