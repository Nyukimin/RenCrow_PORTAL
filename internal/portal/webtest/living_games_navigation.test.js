"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const webRoot = path.join(__dirname, "..", "web");
const livingSource = fs.readFileSync(path.join(webRoot, "living", "living.js"), "utf8");
const gamesSource = fs.readFileSync(path.join(webRoot, "games.js"), "utf8");
const portalCSS = fs.readFileSync(path.join(webRoot, "portal.css"), "utf8");

function extract(source, start, end) {
  const startAt = source.indexOf(start);
  assert.notEqual(startAt, -1, `source must contain ${start}`);
  const endAt = source.indexOf(end, startAt + start.length);
  assert.notEqual(endAt, -1, `source must contain ${end} after ${start}`);
  return source.slice(startAt, endAt);
}

const activeGamesForResident = extract(livingSource, "  function activeGamesForResident(", "\n  function showGameStatus");
const requestedGameSession = extract(gamesSource, "  function requestedGameSession(", "\n  async function refreshSessions");
const selectGameSession = extract(gamesSource, "  function selectSession(", "\n  function requestedGameSession");
const isKnownActor = extract(gamesSource, "  function isKnownActor(", "\n  function setOperation");
const sessionPersonas = extract(gamesSource, "  function sessionPersonas(", "\n  function sessionActorLabel");
const sessionActorLabel = extract(gamesSource, "  function sessionActorLabel(", "\n  function updateLivingReturnLink");
const updateLivingReturnLink = extract(gamesSource, "  function updateLivingReturnLink(", "\n  async function requestJSON");
const refreshGameSessions = extract(gamesSource, "  async function refreshSessions(", "\n  function validAgentSpeech");
const activateResident = extract(livingSource, "  async function activateResident(", "\n  function setPaused");
const restoreLivingSelection = extract(livingSource, "  function restoreSelection(", "\n  houseTab?.addEventListener");
const gamesURL = extract(livingSource, "  function gamesURL(", "\n  function navigateToActiveGame");

function activePayload(entries, sessions = []) {
  return { ok: true, source: "local_observer", sessions, active_agent_sessions: entries };
}

const actorNames = {mio: "Mio", shiro: "Shiro", kuro: "Kuro", midori: "Midori", aka: "Aka", ao: "Ao", kin: "Kin", gin: "Gin"};
const knownActorIDs = new Set(Object.keys(actorNames));

function makeActiveGamesForResident(actors) {
  const context = { heartbeatActors: new Set(actors) };
  vm.createContext(context);
  vm.runInContext(activeGamesForResident, context);
  return context.activeGamesForResident;
}

test("resident resolves every active session containing that persona, including launching and multiplayer", () => {
  const context = { heartbeatActors: new Set(["mio", "shiro"]), payload: activePayload([
    { game_id: "nethack", session_id: "turn-gap-session", personas: ["mio", "shiro"], status: "running" },
    { game_id: "survival_garden", session_id: "launching-session", personas: ["mio"], status: "launching" },
    { game_id: "nethack", session_id: "other", personas: ["shiro"], status: "running" },
  ]) };
  vm.runInNewContext(`${activeGamesForResident}\nresult = activeGamesForResident(payload, "mio");`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.result)).map(session => session.session_id), ["turn-gap-session", "launching-session"]);
  assert.throws(() => vm.runInNewContext(`${activeGamesForResident}\nactiveGamesForResident({}, "mio");`, {}), /active game registry unavailable/);
  assert.throws(() => vm.runInNewContext(`${activeGamesForResident}\nactiveGamesForResident(payload, "mio");`, {
    heartbeatActors: new Set(["mio", "shiro"]),
    payload: activePayload([{ game_id: "nethack", session_id: "malformed", personas: ["unknown-actor"], status: "running" }]),
  }), /active game registry is malformed/);
});

test("no active match does not infer a game from heartbeat fields", () => {
  const context = { payload: activePayload([]) };
  vm.runInNewContext(`${activeGamesForResident}\nresult = activeGamesForResident(payload, "mio");`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.result)), []);
});

test("deep link keeps active-session identity exact and resolves matching completed history", () => {
  const payload = activePayload([
    { game_id: "nethack", session_id: "exact-1", personas: ["mio", "shiro"], status: "running" },
    { game_id: "survival_garden", session_id: "launch-2", personas: ["mio"], status: "launching" },
  ]);
  function resolve(params, payloadForRoute = payload) {
    const context = { actorNames, knownActorIDs, hasRequestedSession: true, requestedSession: params.session, requestedGame: params.game, requestedPersona: params.persona, payload: payloadForRoute };
    vm.runInNewContext(`${isKnownActor}\n${sessionPersonas}\n${requestedGameSession}\nresult = requestedGameSession(payload);`, context);
    return JSON.parse(JSON.stringify(context.result));
  }
  assert.deepEqual(resolve({ session: "exact-1", game: "nethack", persona: "shiro" }), {
    state: "active",
    session: { game_id: "nethack", session_id: "exact-1", personas: ["mio", "shiro"], persona: "shiro", status: "running", turn: 0 },
  });
  assert.equal(resolve({ session: "launch-2", game: "survival_garden", persona: "mio" }).session.status, "launching");
  assert.equal(resolve({ session: "exact-1", game: "nethack", persona: "kuro" }).state, "invalid");
  assert.equal(resolve({ session: "exact-1", game: "wrong-game", persona: "mio" }).state, "invalid");
  assert.equal(resolve({ session: "exact-1", game: "nethack", persona: "constructor" }).state, "invalid");
  assert.equal(resolve({ session: "exact-1", game: "nethack", persona: "__proto__" }).state, "invalid");
  const completedSummary = JSON.parse(fs.readFileSync(
    path.join(__dirname, "survival_garden_completed_session.json"), "utf8")).sessions[0];
  const completedPayload = activePayload([], [completedSummary]);
  const exactCompleted = resolve({ session: completedSummary.session_id, game: "survival_garden", persona: "mio" }, completedPayload);
  assert.deepEqual(exactCompleted, { state: "completed", session: completedSummary });
  assert.equal(resolve({ session: completedSummary.session_id, game: "survival_garden", persona: "mio" },
    activePayload([], [{ ...completedSummary, status: "failed" }])).state, "invalid",
  "failed history remains an explicit nonmatch for the completed deeplink path");
  assert.equal(resolve({ session: completedSummary.session_id, game: "wrong-game", persona: "mio" }, completedPayload).state, "invalid");
  assert.equal(resolve({ session: completedSummary.session_id, game: "survival_garden", persona: "shiro" }, completedPayload).state, "invalid");
  assert.equal(resolve({ session: "unknown", game: "survival_garden", persona: "mio" }, completedPayload).state, "invalid");
  assert.equal(resolve({ session: completedSummary.session_id, game: "survival_garden", persona: "mio" },
    activePayload([{ game_id: "nethack", session_id: completedSummary.session_id, personas: ["mio"], status: "running" }],
      [completedSummary])).state, "invalid", "conflicting active identity must not fall through to history");
  assert.equal(resolve({ session: completedSummary.session_id, game: "survival_garden", persona: "mio" },
    activePayload([], [completedSummary, completedSummary])).state, "invalid", "duplicate exact summaries stay ambiguous");
  assert.equal(resolve({ session: "missing", game: "nethack", persona: "mio" }).state, "invalid");
});

test("four-player SG/HZ sprite identity survives active and completed deep links", async () => {
  const personas = ["aka", "ao", "kin", "gin"];
  for (const gameID of ["survival_garden", "herzog_zwei"]) {
    const sessionID = `${gameID}-four-player`;
    const active = activePayload([{ game_id: gameID, session_id: sessionID, personas, status: "running" }]);
    const labelContext = { actorNames, knownActorIDs };
    vm.runInNewContext(`${isKnownActor}\n${sessionPersonas}\n${sessionActorLabel}\nresult = sessionActorLabel({ personas: ${JSON.stringify(personas)} });`, labelContext);
    assert.equal(labelContext.result, "Aka・Ao・Kin・Gin", "Games must display the full ordered participant roster");
    for (const actor of personas) {
      const context = { actorNames, knownActorIDs, hasRequestedSession: true, requestedSession: sessionID, requestedGame: gameID, requestedPersona: actor, payload: active };
      vm.runInNewContext(`${isKnownActor}\n${sessionPersonas}\n${requestedGameSession}\nresult = requestedGameSession(payload);`, context);
      assert.equal(context.result.state, "active", `${actor} must open its exact four-player session`);
      assert.equal(context.result.session.persona, actor);
      assert.deepEqual(JSON.parse(JSON.stringify(context.result.session.personas)), personas);
      const living = { heartbeatActors: new Set(personas), payload: active };
      vm.runInNewContext(`${activeGamesForResident}\nresult = activeGamesForResident(payload, "${actor}");`, living);
      assert.deepEqual(JSON.parse(JSON.stringify(living.result)).map(session => session.session_id), [sessionID]);

      const navigations = [];
      const livingPage = {
        heartbeatActors: new Set(personas),
        selectResident() {},
        showGameStatus() {},
        activeGameDialog: null,
        activeView: "workplace",
        gameActivationSequence: 0,
        window: {
          location: { origin: "https://portal.example" },
          fetch: async () => ({ ok: true, json: async () => active }),
        },
        URL,
        activeGamesForResident: makeActiveGamesForResident(personas),
        navigateToActiveGame: (session, clickedActor) => {
          const route = { session, actorID: clickedActor, URL, window: { location: { origin: "https://portal.example" } } };
          vm.runInNewContext(`${gamesURL}\nresult = gamesURL(session, actorID);`, route);
          navigations.push(route.result);
        },
        showActiveGameChoices() { throw new Error("one exact session must open directly"); },
      };
      vm.createContext(livingPage);
      vm.runInContext(activateResident, livingPage);
      await vm.runInContext(`activateResident("${actor}")`, livingPage);
      assert.deepEqual(navigations, [
        `https://portal.example/games?session=${encodeURIComponent(sessionID)}&game=${encodeURIComponent(gameID)}&persona=${actor}`,
      ], `${actor} sprite must link to its exact game and session`);
    }
    const completedSummary = { game_id: gameID, session_id: sessionID, personas, status: "completed", turn: 40 };
    const completed = activePayload([], [completedSummary]);
    const completedContext = { actorNames, knownActorIDs, hasRequestedSession: true, requestedSession: sessionID, requestedGame: gameID, requestedPersona: "gin", payload: completed };
    vm.runInNewContext(`${isKnownActor}\n${sessionPersonas}\n${requestedGameSession}\nresult = requestedGameSession(payload);`, completedContext);
    assert.equal(completedContext.result.state, "completed");
    assert.equal(completedContext.result.session.session_id, sessionID);
    assert.equal(completedContext.result.session.personas.length, 4);
    const mismatch = { ...completedContext, requestedPersona: "mio" };
    vm.runInNewContext(`${isKnownActor}\n${sessionPersonas}\n${requestedGameSession}\nresult = requestedGameSession(payload);`, mismatch);
    assert.equal(mismatch.result.state, "invalid", "a nonparticipant cannot claim a completed session link");
  }
});

test("actor allowlist rejects inherited object keys in roster, route and Living return identity", () => {
  const returnLivingLink = {href: ""};
  const context = {
    actorNames,
    knownActorIDs,
    returnLivingLink,
    window: { location: { origin: "https://portal.example" } },
    URL,
  };
  vm.runInNewContext(`${isKnownActor}\n${sessionPersonas}\n${updateLivingReturnLink}\n` +
    `roster = sessionPersonas({ personas: ["aka", "constructor"] }); updateLivingReturnLink("__proto__");`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.roster)), []);
  assert.equal(returnLivingLink.href, "/living?view=workplace");
  assert.match(gamesSource, /!isKnownActor\(requestedPersona\)/);
});

test("LIVING return restores the exact selected resident from its person query", () => {
  const selected = [];
  const views = [];
  const context = {
    window: { location: { search: "?view=workplace&person=kin" } },
    URLSearchParams,
    validViews: new Set(["lcp", "workplace"]),
    heartbeatActors: new Set(["mio", "shiro", "kuro", "midori", "aka", "ao", "kin", "gin"]),
    setView: (...args) => views.push(args),
    selectResident: actor => selected.push(actor),
  };
  vm.runInNewContext(`${restoreLivingSelection}\nrestoreSelection();`, context);
  assert.deepEqual(views, [["workplace", false]]);
  assert.deepEqual(selected, ["kin"]);
});

test("exact completed deeplink selects its canonical summary and opens the matching Observer session", async () => {
  const payload = JSON.parse(fs.readFileSync(path.join(__dirname, "survival_garden_completed_session.json"), "utf8"));
  const summary = payload.sessions[0];
  const state = { sessions: [], selectedSessionID: "", selectedSession: null, frameCount: 0 };
  const observerFrame = { src: "" };
  const stageTitle = { textContent: "" };
  const stageSession = { textContent: "" };
  const operationMessages = [];
  const returnLivingLink = { href: "" };
  const context = {
    hasRequestedSession: true,
    requestedSession: summary.session_id,
    requestedGame: summary.game_id,
    requestedPersona: summary.persona,
    actorNames,
    knownActorIDs,
    window: { location: { origin: "https://portal.example" } },
    URL,
    returnLivingLink,
    requestedSessionHandled: false,
    state,
    requestJSON: async () => payload,
    stagePanel: { scrollIntoView() {} },
    stageTitle,
    stageSession,
    screenShell: { classList: { add() {} } },
    observerFrame,
    titleNames: { survival_garden: "Survival Garden" },
    actorNames: { mio: "Mio" },
    updateSessionActions() {},
    setOverlayAgent() {},
    renderSessions() {},
    refreshSelectedFrames() {},
    setOperation: (...args) => operationMessages.push(args),
  };
  vm.createContext(context);
  vm.runInContext(`${isKnownActor}\n${sessionPersonas}\n${sessionActorLabel}\n${updateLivingReturnLink}\n${requestedGameSession}\n${selectGameSession}\n${refreshGameSessions}`, context);
  await vm.runInContext("refreshSessions()", context);

  assert.equal(state.selectedSessionID, summary.session_id);
  assert.equal(state.selectedSession.status, "completed");
  assert.equal(stageTitle.textContent, "Survival Garden");
  assert.equal(stageSession.textContent, `${summary.session_id} · Mio · turn 17`);
  assert.equal(returnLivingLink.href, "/living?view=workplace&person=mio");
  assert.equal(observerFrame.src,
    `/viewer/games/observer?session=${encodeURIComponent(summary.session_id)}&game=survival_garden`);
  assert.deepEqual(operationMessages, []);
});

test("all four registered games keep exact sprite-to-game links for launching and running sessions", async () => {
  const gameIDs = ["nethack", "survival_garden", "territory_commander", "herzog_zwei"];
  for (const gameID of gameIDs) {
    for (const status of ["launching", "running"]) {
      const sessionID = `${gameID}-${status}`;
      const payload = activePayload([{ game_id: gameID, session_id: sessionID, personas: ["mio"], status }]);
      const context = {
        actorNames,
        knownActorIDs,
        hasRequestedSession: true,
        requestedSession: sessionID,
        requestedGame: gameID,
        requestedPersona: "mio",
        payload,
      };
      vm.runInNewContext(`${isKnownActor}\n${sessionPersonas}\n${requestedGameSession}\nresult = requestedGameSession(payload);`, context);
      assert.equal(context.result.state, "active", `${gameID} ${status} exact link should resolve`);
      assert.equal(context.result.session.game_id, gameID);
      assert.equal(context.result.session.session_id, sessionID);
      assert.equal(context.result.session.persona, "mio");

      for (const mismatch of [
        { requestedSession: "other-session" },
        { requestedGame: "other-game" },
        { requestedPersona: "shiro" },
      ]) {
        const invalid = { ...context, ...mismatch };
        vm.runInNewContext(`${isKnownActor}\n${sessionPersonas}\n${requestedGameSession}\nresult = requestedGameSession(payload);`, invalid);
        assert.equal(invalid.result.state, "invalid", `${gameID} ${status} rejects mismatched deep-link identity`);
      }

      const livingContext = {
        heartbeatActors: new Set(["mio"]),
        payload,
      };
      vm.runInNewContext(`${activeGamesForResident}\nresult = activeGamesForResident(payload, "mio");`, livingContext);
      assert.deepEqual(JSON.parse(JSON.stringify(livingContext.result)).map(session => session.session_id), [sessionID]);

      const navigations = [];
      const livingSandbox = {
        heartbeatActors: new Set(["mio"]),
        selectResident() {},
        showGameStatus() {},
        activeGameDialog: null,
        activeView: "workplace",
        gameActivationSequence: 0,
        window: {
          location: { origin: "https://portal.example" },
          fetch: async () => ({ ok: true, json: async () => payload }),
        },
        URL,
        activeGamesForResident: makeActiveGamesForResident(["mio"]),
        navigateToActiveGame: (session, persona) => {
          const context = {
            session,
            actorID: persona,
            window: { location: { origin: "https://portal.example" } },
            URL,
          };
          vm.runInNewContext(`${gamesURL}\nresult = gamesURL(session, actorID);`, context);
          navigations.push(context.result);
        },
        showActiveGameChoices() { throw new Error("one active session must navigate directly"); },
      };
      vm.createContext(livingSandbox);
      vm.runInContext(activateResident, livingSandbox);
      await vm.runInContext("activateResident('mio')", livingSandbox);
      assert.deepEqual(navigations, [
        `https://portal.example/games?session=${encodeURIComponent(sessionID)}&game=${encodeURIComponent(gameID)}&persona=mio`,
      ]);
    }
  }
});

test("a slower earlier activation cannot navigate after a newer resident tap", async () => {
  const deferred = [];
  const navigations = [];
  const messages = [];
  const selected = [];
  const sandbox = {
    heartbeatActors: new Set(["mio", "shiro"]),
    selectResident: id => selected.push(id),
    showGameStatus: message => messages.push(message),
    activeGameDialog: null,
    activeView: "workplace",
    gameActivationSequence: 0,
    window: {
      fetch() { return new Promise(resolve => deferred.push(resolve)); },
    },
    activeGamesForResident: makeActiveGamesForResident(["mio", "shiro"]),
    navigateToActiveGame: (session, actor) => navigations.push([session.session_id, actor]),
    showActiveGameChoices() { throw new Error("unexpected chooser"); },
  };
  vm.createContext(sandbox);
  vm.runInContext(activateResident, sandbox);
  const earlier = vm.runInContext("activateResident('mio')", sandbox);
  const later = vm.runInContext("activateResident('shiro')", sandbox);
  assert.equal(deferred.length, 2);
  deferred[0]({ ok: true, json: async () => activePayload([{ game_id: "nethack", session_id: "mio-game", personas: ["mio"], status: "running" }]) });
  await earlier;
  assert.deepEqual(navigations, []);
  deferred[1]({ ok: true, json: async () => activePayload([{ game_id: "nethack", session_id: "shiro-game", personas: ["shiro"], status: "running" }]) });
  await later;
  assert.deepEqual(navigations, [["shiro-game", "shiro"]]);
  assert.deepEqual(selected, ["mio", "shiro"]);
  assert.deepEqual(messages, ["", ""]);
});

test("multiple active sessions open a chooser and malformed/failed registry never navigates", async () => {
  const choices = [];
  const navigations = [];
  const messages = [];
  const sandbox = {
    heartbeatActors: new Set(["mio"]),
    selectResident() {},
    showGameStatus: (message, error) => messages.push([message, error]),
    activeGameDialog: null,
    activeView: "workplace",
    gameActivationSequence: 0,
    names: new Map([["mio", "Mio"]]),
    window: { fetch: async () => ({ ok: true, json: async () => activePayload([
      { game_id: "nethack", session_id: "one", personas: ["mio"], status: "running" },
      { game_id: "survival_garden", session_id: "two", personas: ["mio"], status: "launching" },
    ]) }) },
    activeGamesForResident: makeActiveGamesForResident(["mio"]),
    navigateToActiveGame: (...args) => navigations.push(args),
    showActiveGameChoices: (...args) => choices.push(args),
  };
  vm.createContext(sandbox);
  vm.runInContext(activateResident, sandbox);
  await vm.runInContext("activateResident('mio')", sandbox);
  assert.equal(choices.length, 1, "ambiguous active sessions must be offered for explicit selection");
  assert.deepEqual(JSON.parse(JSON.stringify(choices[0][1])).map(session => session.session_id), ["one", "two"]);
  assert.deepEqual(navigations, [], "ambiguity must not select the first session");

  sandbox.window.fetch = async () => ({ ok: true, json: async () => ({ ok: true, source: "local_observer" }) });
  await vm.runInContext("activateResident('mio')", sandbox);
  assert.equal(messages.at(-1)[1], true, "missing registry must be shown as a failure");
  sandbox.window.fetch = async () => ({ ok: false, json: async () => ({}) });
  await vm.runInContext("activateResident('mio')", sandbox);
  assert.equal(messages.at(-1)[1], true, "failed GET must be shown as a failure");
  assert.deepEqual(navigations, []);
});

test("view changes invalidate an in-flight sprite activation", async () => {
  const deferred = [];
  const navigations = [];
  const sandbox = {
    heartbeatActors: new Set(["mio"]),
    selectResident() {},
    showGameStatus() {},
    activeGameDialog: null,
    activeView: "workplace",
    gameActivationSequence: 0,
    window: { fetch: () => new Promise(resolve => deferred.push(resolve)) },
    activeGamesForResident: makeActiveGamesForResident(["mio"]),
    navigateToActiveGame: (...args) => navigations.push(args),
    showActiveGameChoices() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(activateResident, sandbox);
  const activation = vm.runInContext("activateResident('mio')", sandbox);
  sandbox.activeView = "lcp";
  deferred[0]({ ok: true, json: async () => activePayload([{ game_id: "nethack", session_id: "mio-game", personas: ["mio"], status: "running" }]) });
  await activation;
  assert.deepEqual(navigations, [], "an activation started in LIVING must not navigate after switching away");
});

test("navigation and return targets remain exact and the scene uses sprite activation instead of heartbeat identity", () => {
  assert.match(livingSource, /new URL\("\/games", window\.location\.origin\)/);
  assert.match(livingSource, /url\.searchParams\.set\("session", session\.session_id\)/);
  assert.match(livingSource, /url\.searchParams\.set\("game", session\.game_id\)/);
  assert.match(livingSource, /onResidentActivate: id => \{ void activateResident\(id\); \}/);
  const sceneSource = fs.readFileSync(path.join(webRoot, "living", "scene.js"), "utf8");
  assert.match(sceneSource, /function residentAtPointer\(event\)[\s\S]*?isResidentSpriteInteractive\(view, resident\)/);
  assert.doesNotMatch(sceneSource, /if \(view !== "living" \|\| worldHomeMode/);
  assert.match(sceneSource, /pointerup[\s\S]*?Math\.hypot\(event\.clientX - start\.x, event\.clientY - start\.y\) > 9/);
  assert.match(fs.readFileSync(path.join(webRoot, "index.html"), "utf8"), /href="\/living\?view=workplace">LIVINGに戻る/);
  assert.match(livingSource, /if \(worldHomeEnabled && scene\) \{\s*setWorldHomeLive\(true\);\s*restoreSelection\(\);/);
  assert.match(gamesSource, /selectSession\(requested\.session\);\s*stagePanel\?\.scrollIntoView\(\{ behavior: 'auto', block: 'start' \}\);/);
  assert.match(portalCSS, /\.games-four-player-roster\[hidden\]\{display:none\}/,
    "the explicit roster layout must preserve the HTML hidden state");
});

test("canonical WORLD sprites remain clickable while hidden or unreceived sprites do not", () => {
  const scene = require("../web/living/scene.js");
  assert.equal(scene.isResidentSpriteInteractive("living", {
    group: { visible: true }, mesh: { visible: true, material: { visible: true, opacity: 1 } },
  }), true, "the sampled and visible WORLD actor must be interactive");
  assert.equal(scene.isResidentSpriteInteractive("living", {
    group: { visible: false }, mesh: { visible: true, material: { visible: true, opacity: 1 } },
  }), false, "an unreceived WORLD actor is hidden and must not be interactive");
  assert.equal(scene.isResidentSpriteInteractive("house", {
    group: { visible: true }, mesh: { visible: true, material: { visible: true, opacity: 1 } },
  }), false, "HOUSE view must not activate sprites");
});

test("LIVING selects a known resident even when the production shell has no resident cards", () => {
  const selectResident = extract(livingSource, "  function selectResident(id) {", "\n  function activeGamesForResident");
  const sandbox = {
    cards: [],
    heartbeatActors: new Set(["mio", "shiro"]),
    selectedResidentId: null,
    selectedLabel: { hidden: true, textContent: "" },
    names: new Map([["mio", "Mio"]]),
    callScene() {},
    motionPreviewForm: null,
    motionPreview: { hidden: true },
  };
  vm.runInNewContext(`${selectResident}\nselectResident("mio");`, sandbox);
  assert.equal(sandbox.selectedResidentId, "mio");
  assert.equal(sandbox.selectedLabel.hidden, false);
  assert.equal(sandbox.selectedLabel.textContent, "Mio");
});
