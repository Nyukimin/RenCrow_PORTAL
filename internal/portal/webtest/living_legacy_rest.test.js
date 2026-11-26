const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const root = path.join(__dirname, "../web/living");
const context = { window: {}, names: new Map() };
for (const file of ["current-activity.js", "world-home.js"]) {
  vm.runInNewContext(fs.readFileSync(path.join(root, file), "utf8"), context);
}
const source = fs.readFileSync(path.join(root, "living.js"), "utf8");
function between(start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a);
  return source.slice(a, b);
}
vm.runInNewContext(between("  const heartbeatActors = new Set(", "  let activeView =") +
  between("  function presentHeartbeatResponse(payload) {", "\n  async function pollLivingHeartbeat"), context);
const rest = { kind: "rest", label: "休憩中", phase: "resting", revision: 1 };
const ids = ["mio", "shiro", "kuro", "midori", "aka", "ao", "kin", "gin"];
function heartbeat(actor) {
  return { observed_at: "2026-11-26T08:00:00Z", agents: ids.map(actor_id =>
    actor_id === "ao" ? { actor_id, ...actor } : { actor_id, state: "waiting" }) };
}
const routine = { state: "running", activity_kind: "routine", routine_availability: "available", ongoing_activity: "rest", current_activity: rest };
test("legacy CORE rest keeps all eight WORLD residents and heartbeat labels visible", () => {
  const snapshot = { scene_sha256: context.window.houseWorldHome.houseSHA256, state_seq: 9331,
    observed_at: "2026-11-26T08:00:00Z", actors: ids.map(id => ({ id, room_id: "living", position: [1.2, 0.21, 3.65],
      ...(id === "ao" || id === "kuro" ? { current_activity: rest } : {}) })) };
  const accepted = context.window.houseWorldHome.validateSnapshot(snapshot);
  assert.equal(accepted.actors.length, 8);
  const timeline = context.window.houseWorldHome.createTimeline();
  timeline.accept(snapshot, 1000);
  for (const id of ids) assert.ok(timeline.sample(id, 1000), id);
  for (const state of ["waiting", "running"]) {
    const projected = context.presentHeartbeatResponse(heartbeat({ ...routine, state }));
    assert.equal(projected.length, 8);
    assert.equal(projected.find(actor => actor.actor_id === "ao").label, "休憩中");
  }
  for (const invalid of [{ ...rest, kind: "unknown" }, { ...rest, label: "private" },
    { ...rest, phase: "sleeping" }, { ...rest, task_id: "private" }, { ...rest, revision: 0 }]) {
    const bad = structuredClone(snapshot);
    bad.actors[0].current_activity = invalid;
    assert.throws(() => context.window.houseWorldHome.validateSnapshot(bad), /current_activity is invalid/);
  }
  assert.equal(context.window.houseWorldHome.validateSnapshot(snapshot).actors.length, 8, "valid recovery remains accepted");
});
test("legacy rest annotation requires its exact routine and canonical descriptor", () => {
  for (const invalid of [{ ...routine, current_activity: undefined }, { ...routine, activity_kind: "private" },
    { ...routine, routine_availability: "disabled" }, { ...routine, state: "checking" },
    { ...routine, current_activity: { ...rest, phase: "sleeping" } },
    { ...routine, ongoing_activity: "sleep_window" }]) {
    assert.throws(() => context.presentHeartbeatResponse(heartbeat(invalid)), /invalid living heartbeat/);
  }
  assert.equal(context.presentHeartbeatResponse(heartbeat(routine)).length, 8);
});
