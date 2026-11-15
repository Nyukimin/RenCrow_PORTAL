const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const houseContext = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../web/living/assets/house-data.js"), "utf8"), houseContext);
const sceneContext = { module: { exports: {} } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../web/living/scene.js"), "utf8"), sceneContext);
const scene = sceneContext.module.exports;
const worldHome = require("../web/living/world-home.js");
const house = houseContext.window.housePreviewData;

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

test("classifies current WORLD positions by measured floor and hides upper residents only in LIVING", () => {
  assert.equal(sceneContext.houseWorldHome, undefined, "scene floor policy must load without the WORLD helper");
  const positions = [
    { position: [-9.16, 3.72, 1.58], floor: 1, label: "2F private room" },
    { position: [-0.51, 3.72, 4.92], floor: 1, label: "2F hallway" },
    { position: [-8.07, 7.25, 0.73], floor: 2, label: "3F private room" },
    { position: [-1.8, 0.21, 4.83], floor: 0, label: "1F" },
    { position: [-1.8, 3.546, -2.135], floor: 0, label: "last lower stair tread" },
    { position: [-1.8, 3.72, -2.135], floor: 1, label: "first 2F stair landing point" },
    { position: [9.28, 5.1, -3.38], floor: 1, label: "2F to 3F stairs" },
    { position: [9.28, 7.25, -3.38], floor: 2, label: "3F stair landing" },
    { position: [9.28, 3.719999, -3.38], floor: 0, label: "just below the 2F boundary" },
  ];

  for (const entry of positions) {
    const state = scene.floorStateFor("living", entry.position, house, 0.75);
    assert.equal(state.floor, entry.floor, entry.label);
    assert.equal(state.visible, entry.floor === 0, entry.label);
    assert.equal(state.opacity, entry.floor === 0 ? 0.75 : 0, entry.label);
  }

  const houseState = scene.floorStateFor("house", positions[0].position, house, 0.42);
  assert.equal(houseState.floor, 1);
  assert.equal(houseState.opacity, 0.42);
  assert.equal(houseState.visible, true);
});

test("WORLD residents in HOUSE use the same measured-floor camera fade as the upper floors", () => {
  const progress = 0.5;
  const secondOpacity = scene.floorOpacityFor(1, progress);
  const atticOpacity = scene.floorOpacityFor(2, progress);
  const secondRoom = { x: -9.16, y: 3.72, z: 1.58 };
  const secondHallway = { x: -0.51, y: 3.72, z: 4.92 };
  const atticRoom = { x: -8.07, y: 7.25, z: 0.73 };

  assert.equal(scene.worldResidentOpacityFor(secondRoom, 1, house, progress), secondOpacity);
  assert.equal(scene.worldResidentOpacityFor(secondHallway, 1, house, progress), secondOpacity);
  assert.equal(scene.worldResidentOpacityFor(atticRoom, 2, house, progress), atticOpacity);
  assert.equal(scene.worldResidentOpacityFor(secondRoom, 1, house, 0), 1);
  assert.equal(scene.worldResidentOpacityFor(secondRoom, 1, house, 1), 0);
  assert.equal(scene.worldResidentOpacityFor(atticRoom, 2, house, 1), 0);

  const entryX = house.stairTrip.entry[0];
  const secondHeight = house.stairTrip.landing[0][1];
  const upperEdge = -2.725;
  const lowerEdge = -2.455;
  const stairUpper = { x: entryX, y: secondHeight, z: upperEdge };
  const stairMiddle = { x: entryX, y: secondHeight, z: (upperEdge + lowerEdge) / 2 };
  const stairLower = { x: entryX, y: secondHeight, z: lowerEdge };
  assert.equal(scene.worldResidentOpacityFor(stairUpper, 1, house, progress), secondOpacity);
  assert.ok(scene.worldResidentOpacityFor(stairMiddle, 1, house, progress) > secondOpacity);
  assert.ok(scene.worldResidentOpacityFor(stairMiddle, 1, house, progress) < 1);
  assert.equal(scene.worldResidentOpacityFor(stairLower, 1, house, progress), 1);
});

test("uses interpolated position through both stair directions and endpoint waiting, independent of room labels", () => {
  const stairs = house.stairTrip.landing[0][1];
  const timeline = worldHome.createTimeline();
  const start = [0, 0.21, 0];
  const end = [0, stairs, 0];
  const movingActor = {
    id: "mio",
    room_id: "living",
    target_room_id: "upper-room-2-1",
    position: end,
    active_kind: "move",
    activity_started_at: "2026-11-14T00:00:00.000Z",
    activity_due_at: "2026-11-14T00:00:10.000Z",
    move_points: [start, end],
  };

  timeline.accept(snapshot(movingActor), 1000);
  const ascending = timeline.sample("mio", 3000);
  assert.equal(ascending.actor.room_id, "living", "the receipt still names the departure room");
  assert.ok(ascending.position[1] > start[1] && ascending.position[1] < stairs);
  assert.equal(scene.floorStateFor("living", ascending.position, house, 1).floor, 0);
  const arrived = timeline.sample("mio", 6000);
  assert.equal(arrived.moving, false);
  assert.deepEqual(arrived.position, end);
  assert.equal(scene.floorStateFor("living", arrived.position, house, 1).floor, 1);

  timeline.accept(snapshot({
    ...movingActor,
    room_id: "upper-room-2-1",
    target_room_id: "living",
    position: start,
    move_points: [end, start],
  }), 12000);
  const descending = timeline.sample("mio", 14000);
  assert.equal(descending.actor.room_id, "upper-room-2-1", "the receipt still names the departure room");
  assert.ok(descending.position[1] > start[1] && descending.position[1] < stairs);
  assert.equal(scene.floorStateFor("living", descending.position, house, 1).floor, 0);

  const atticStart = [4.88, house.stairTrip.landing[0][1], -3.38];
  const atticEnd = [9.28, house.atticTrip.landing[0][1], -3.38];
  timeline.accept(snapshot({
    ...movingActor,
    room_id: "hall-second",
    target_room_id: "landing-attic",
    position: atticEnd,
    move_points: [atticStart, atticEnd],
  }), 18000);
  const ascendingAttic = timeline.sample("mio", 20000);
  assert.equal(ascendingAttic.actor.room_id, "hall-second");
  assert.ok(ascendingAttic.position[1] > atticStart[1] && ascendingAttic.position[1] < atticEnd[1]);
  assert.equal(scene.floorStateFor("living", ascendingAttic.position, house, 1).floor, 1);
  const arrivedAttic = timeline.sample("mio", 23000);
  assert.equal(arrivedAttic.moving, false);
  assert.deepEqual(arrivedAttic.position, atticEnd);
  assert.equal(scene.floorStateFor("living", arrivedAttic.position, house, 1).floor, 2);

  timeline.accept(snapshot({
    ...movingActor,
    room_id: "attic-window",
    target_room_id: "hall-second",
    position: atticStart,
    move_points: [atticEnd, atticStart],
  }), 24000);
  const descendingAttic = timeline.sample("mio", 26000);
  assert.equal(descendingAttic.actor.room_id, "attic-window");
  assert.ok(descendingAttic.position[1] > atticStart[1] && descendingAttic.position[1] < atticEnd[1]);
  assert.equal(scene.floorStateFor("living", descendingAttic.position, house, 1).floor, 1);
});

test("uses the same floor rule for Lumina and preserves visitor expiry", () => {
  const timeline = worldHome.createTimeline();
  timeline.accept(snapshot({
    id: "lumina",
    room_id: "upper-room-3-1",
    position: [-8.07, 7.25, 0.73],
    visit_until: "2026-11-14T00:00:05.500Z",
  }), 1000);

  const visitor = timeline.sample("lumina", 1000);
  assert.ok(visitor);
  const visitorState = scene.floorStateFor("living", visitor.position, house, 1);
  assert.equal(visitorState.floor, 2);
  assert.equal(visitorState.opacity, 0);
  assert.equal(visitorState.visible, false);
  assert.equal(timeline.sample("lumina", 1500), null);
});

test("rejecting an invalid snapshot retains the last accepted WORLD state", () => {
  const timeline = worldHome.createTimeline();
  const accepted = snapshot({ id: "mio", room_id: "living", position: [1.2, 0.21, 3.65] });
  timeline.accept(accepted, 1000);
  assert.throws(() => timeline.accept({ ...accepted, scene_sha256: "0".repeat(64) }, 2000), /HOUSE hash/);
  assert.equal(timeline.snapshot().state_seq, accepted.state_seq);
  assert.deepEqual(timeline.sample("mio", 2000).position, accepted.actors[0].position);
});
