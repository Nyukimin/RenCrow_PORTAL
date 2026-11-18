"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "web", "games.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");

function extract(start, end) {
  const startAt = source.indexOf(start);
  assert.notEqual(startAt, -1, `source must contain ${start}`);
  const endAt = source.indexOf(end, startAt + start.length);
  assert.notEqual(endAt, -1, `source must contain ${end} after ${start}`);
  return source.slice(startAt, endAt);
}

const catalogDeclaration = extract("  const gameCatalog = [", "  const actorNames =");
const rosterDeclaration = extract("  const actorNames =", "  const state = {");
const supportedGameIDs = extract("  function supportedGameIDs(", "  function updateCatalog(");
const updateGameGuidance = extract("  function updateGameGuidance(", "\n  function sessionPersonas");
const launchGame = extract("  async function launchGame(", "\n  async function runSessionAction");

function catalog() {
  const context = {};
  vm.runInNewContext(`${catalogDeclaration}\nresult = gameCatalog;`, context);
  return JSON.parse(JSON.stringify(context.result));
}

function resolveSupportedGameIDs(payload) {
  const context = { payload };
  vm.runInNewContext(`${catalogDeclaration}\n${supportedGameIDs}\nresult = [...supportedGameIDs(payload)];`, context);
  return JSON.parse(JSON.stringify(context.result));
}

test("public Games catalog contains the four registered titles with readable, title-specific guidance", () => {
  const games = catalog();
  assert.deepEqual(games.map(game => game.id), [
    "nethack",
    "survival_garden",
    "territory_commander",
    "herzog_zwei",
  ]);
  for (const game of games) {
    assert.ok(game.title.trim(), `${game.id} needs a readable title`);
    assert.ok(game.reasonPlaceholder.trim(), `${game.id} needs reason guidance`);
  }
  assert.equal(new Set(games.map(game => game.title)).size, 4);
  assert.equal(new Set(games.map(game => game.reasonPlaceholder)).size, 4);
  assert.deepEqual(
    [...html.matchAll(/data-game-id="([^"]+)"/g)].map(match => match[1]),
    games.map(game => game.id),
    "public cards must match the canonical four-title catalog exactly and in order",
  );
  for (const game of games) {
    assert.match(html, new RegExp(`data-game-id="${game.id}"`), `${game.id} must have a public catalog card`);
    assert.match(html, new RegExp(`<strong>${game.title}</strong>`), `${game.id} card must show its readable title`);
    assert.match(html, new RegExp(`data-game-capability="${game.id}"`), `${game.id} must show CORE capability`);
  }
  assert.doesNotMatch(html, /data-game-id="falling_blocks"/);
});

test("catalog launch capability requires Agent mode and an exact registered ID from CORE", () => {
  assert.deepEqual(resolveSupportedGameIDs({
    decision_mode: "agent",
    supported_games: ["nethack", "survival_garden", "territory_commander", "herzog_zwei", "unregistered_game"],
  }), ["nethack", "survival_garden", "territory_commander", "herzog_zwei"]);
  assert.deepEqual(resolveSupportedGameIDs({
    decision_mode: "rule_based",
    supported_games: ["nethack", "survival_garden", "territory_commander", "herzog_zwei"],
  }), []);
  assert.deepEqual(resolveSupportedGameIDs({
    decision_mode: "agent",
    supported_games: ["nethack", "survival_garden", "territory_commander", "herzog_zwei"],
  }), ["nethack", "survival_garden", "territory_commander", "herzog_zwei"]);
  assert.deepEqual(resolveSupportedGameIDs({
    decision_mode: "agent",
    supported_games: ["nethack", "Unknown_Game"],
  }), ["nethack"]);
  assert.deepEqual(resolveSupportedGameIDs({ decision_mode: "agent", supported_games: "nethack" }), []);
});

test("four-player titles expose the fixed four-agent roster while single-agent titles retain their selector", () => {
  for (const gameID of ["nethack", "survival_garden", "territory_commander", "herzog_zwei"]) {
    const context = {
      gameCatalog: catalog(),
      state: { gameID },
      reasonInput: { placeholder: "" },
      fourPlayerGameIDs: new Set(["survival_garden", "herzog_zwei"]),
      singleAgentField: { hidden: false },
      fourPlayerRoster: { hidden: true },
      rosterGuidance: { textContent: "" },
    };
    vm.runInNewContext(`${updateGameGuidance}\nupdateGameGuidance();`, context);
    const fourPlayer = gameID === "survival_garden" || gameID === "herzog_zwei";
    assert.equal(context.singleAgentField.hidden, fourPlayer);
    assert.equal(context.fourPlayerRoster.hidden, !fourPlayer);
    assert.equal(context.rosterGuidance.textContent, fourPlayer
      ? "Aka・Ao・Kin・Ginの4 Agentで遊びます" : "1 Agentで遊びます");
  }
});

test("Agent Play launch sends all four titles without overriding GAMES mode defaults", async () => {
  for (const gameID of ["nethack", "survival_garden", "territory_commander", "herzog_zwei"]) {
    const requests = [];
    const selectedSessions = [];
    const context = {
      state: {
        presenceReady: true,
        launchBusy: false,
        supportedGames: new Set([gameID]),
        gameID,
        sessions: [],
      },
      actorNames: { mio: "Mio", aka: "Aka", ao: "Ao", kin: "Kin", gin: "Gin" },
      fourPlayerGameIDs: new Set(["survival_garden", "herzog_zwei"]),
      fourPlayerPersonas: ["aka", "ao", "kin", "gin"],
      titleNames: Object.fromEntries(catalog().map(game => [game.id, game.title])),
      agentSelect: { value: "mio" },
      singleAgentField: { hidden: false },
      fourPlayerRoster: { hidden: true },
      rosterGuidance: { textContent: "" },
      turnsInput: { value: "24" },
      reasonInput: { value: "  Test launch reason  " },
      requestJSON: async (url, options) => {
        requests.push({ url, options });
        return { session_id: `session-${gameID}`, game_id: gameID, status: "launching" };
      },
      updateCatalog() {},
      setOperation() {},
      setOverlayAgent() {},
      refreshSessions: async () => {},
      selectSession(session) { selectedSessions.push(session); },
    };
    vm.createContext(context);
    vm.runInContext(`${launchGame}\nthis.launchGame = launchGame;`, context);
    await context.launchGame({ preventDefault() {} });

    assert.equal(requests.length, 1, `${gameID} should make one launch request`);
    assert.equal(requests[0].url, "/api/games/viewer/games/launch");
    assert.equal(requests[0].options.method, "POST");
    const body = JSON.parse(requests[0].options.body);
    assert.equal(body.game_id, gameID);
    assert.deepEqual(body.personas, gameID === "survival_garden" || gameID === "herzog_zwei"
      ? ["aka", "ao", "kin", "gin"] : ["mio"]);
    assert.equal(body.turns, 24);
    assert.equal(body.reason, "Test launch reason");
    assert.equal(Object.hasOwn(body, "mode"), false, `${gameID} must leave mode selection to GAMES`);
    assert.equal(selectedSessions.length, 1);
    assert.equal(selectedSessions[0].game_id, gameID);
    assert.equal(context.state.launchBusy, false);
  }
});

test("Games actor labels include all existing LIVING residents without inventing portrait assets", () => {
  const context = {};
  vm.runInNewContext(`${rosterDeclaration}\nresult = actorNames;`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.result)), {
    mio: "Mio", shiro: "Shiro", kuro: "Kuro", midori: "Midori",
    aka: "Aka", ao: "Ao", kin: "Kin", gin: "Gin",
  });
  for (const actor of ["aka", "ao", "kin", "gin"]) {
    assert.match(html, new RegExp(`data-persona="${actor}"`));
  }
});
