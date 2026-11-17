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
const supportedGameIDs = extract("  function supportedGameIDs(", "  function updateCatalog(");

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
