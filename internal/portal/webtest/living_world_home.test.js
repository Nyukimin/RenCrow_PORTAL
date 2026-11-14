const assert = require("node:assert/strict");
const test = require("node:test");
const worldHome = require("../web/living/world-home.js");

const observedAt = "2026-11-14T00:00:05.000Z";
const snapshot = (actor) => ({
  scene_sha256: worldHome.houseSHA256,
  state_seq: 17,
  observed_at: observedAt,
  actors: [actor]
});

test("accepts only snapshots pinned to the shipped HOUSE and valid actor state", () => {
  const valid = {
    id: "mio",
    room_id: "hall-second",
    position: [0, 3.72, 5],
    active_kind: "move",
    activity_started_at: "2026-11-14T00:00:00.000Z",
    activity_due_at: "2026-11-14T00:00:10.000Z",
    move_points: [[0, 3.72, 0], [0, 3.72, 5], [4, 3.72, 5]],
    target_room_id: "upper-room-2-2"
  };
  const sanitized = worldHome.validateSnapshot({ ...snapshot({ ...valid, world_token: "must-not-be-retained" }), extra_token: "must-not-be-retained" });
  assert.equal(sanitized.actors[0].id, "mio");
  assert.equal("world_token" in sanitized.actors[0], false);
  assert.equal("extra_token" in sanitized, false);
  assert.throws(() => worldHome.validateSnapshot({ ...snapshot(valid), scene_sha256: "0".repeat(64) }), /HOUSE hash/);
  assert.throws(() => worldHome.validateSnapshot(snapshot({ ...valid, position: [0, NaN, 2] })), /location/);
  assert.throws(() => worldHome.validateSnapshot(snapshot({ ...valid, active_pose: "mirror-made-up" })), /active_pose/);
  assert.throws(() => worldHome.validateSnapshot({ ...snapshot(valid), observed_at: "November 14, 2026" }), /observed_at/);
});

test("interpolates a moving actor by arc length on the measured path and holds its endpoint", () => {
  const timeline = worldHome.createTimeline();
  timeline.accept(snapshot({
    id: "mio",
    room_id: "hall-second",
    position: [4, 3.72, 5],
    active_kind: "move",
    activity_started_at: "2026-11-14T00:00:00.000Z",
    activity_due_at: "2026-11-14T00:00:10.000Z",
    move_points: [[0, 3.72, 0], [0, 3.72, 5], [4, 3.72, 5]]
  }), 1000);

  const interpolated = timeline.sample("mio", 2000);
  assert.ok(Math.abs(interpolated.position[0] - 0.4) < 1e-10);
  assert.deepEqual(interpolated.position.slice(1), [3.72, 5]);
  assert.deepEqual(interpolated.tangent, [1, 0, 0]);
  assert.equal(timeline.sample("mio", 6000).moving, false);
  assert.deepEqual(timeline.sample("mio", 6000).position, [4, 3.72, 5]);
});

test("keeps room and activity labels tied to the owner receipt, including mirror completion count", () => {
  assert.equal(worldHome.describeActor({ id: "mio", room_id: "upper-room-2-2", active_kind: "move", target_room_id: "upper-room-2-3" }), "移動中 → 2F 個室 3");
  assert.equal(worldHome.describeActor({ id: "shiro", room_id: "living", active_kind: "mirror_pose", active_pose: "mirror-greeting", mirror_pose_completions: 4 }), "挨拶 · 4回 · 1F リビング");
  assert.equal(worldHome.describeActor({ id: "gin", room_id: "attic-window", active_kind: "sleep" }), "睡眠中 · 屋根裏 窓辺");
});
