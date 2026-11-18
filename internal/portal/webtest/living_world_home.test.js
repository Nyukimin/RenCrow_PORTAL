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
  actors: Array.isArray(actor) ? actor : [actor]
});

test("defines the fourth attic facade with Gin's WORLD room id", () => {
  const attic = house.upperHallways.find((layout) => layout.floor === 2);
  assert.equal(attic.rooms.length, 4);
  assert.equal(attic.rooms[3].x[0], 6);
  assert.equal(attic.rooms[3].x[1], 12);
  assert.equal(attic.rooms[3].roomId, "attic-window");
  assert.equal(scene.upperRoomIdFor(attic, 3, attic.rooms[3]), "attic-window");
  assert.equal(scene.upperRoomIdFor(attic, 2, attic.rooms[2]), "upper-room-3-3");
});

test("attic-window opacity follows sampled 3F position and ignores stale room labels", () => {
  const timeline = worldHome.createTimeline();
  timeline.accept(snapshot({
    id: "gin", room_id: "hall-attic", position: [9.64, 7.25, -0.42]
  }), 1000);
  assert.equal(scene.atticWindowOccupied(timeline, 1000, house), true, "landing position counts despite the stale hallway room_id");
  timeline.accept(snapshot([]), 1050);
  assert.equal(scene.atticWindowOccupied(timeline, 1050, house), false, "an actor without a current sample counts as absent");

  timeline.accept(snapshot({
    id: "gin", room_id: "attic-window", position: [9, 7.25, 1.55]
  }), 1100);
  assert.equal(scene.atticWindowOccupied(timeline, 1100, house), false, "hallway position does not count despite the stale room_id");

  timeline.accept(snapshot({
    id: "gin", room_id: "hall-attic", position: [8.95, 7.71, 0.2], active_kind: "sleep"
  }), 1200);
  assert.equal(scene.atticWindowOccupied(timeline, 1200, house), true, "the bed's measured y=7.71 remains on 3F");
});

test("attic-window occupancy observes measured movement, exact bounds, and expired samples", () => {
  const timeline = worldHome.createTimeline();
  const routeActor = {
    id: "gin", room_id: "hall-attic", target_room_id: "attic-window", position: [9.64, 7.25, -0.42],
    active_kind: "move", activity_started_at: observedAt,
    activity_due_at: "2026-11-14T00:00:15.000Z",
    move_points: [[9.64, 7.25, -0.42], [8.55, 7.25, 1.9]]
  };
  timeline.accept(snapshot(routeActor), 1000);
  assert.equal(scene.atticWindowOccupied(timeline, 4500, house), true, "an in-flight interpolated position inside the room counts");

  timeline.accept(snapshot({ id: "gin", room_id: "attic-window", position: [6, 7.25, 0] }), 5000);
  assert.equal(scene.atticWindowOccupied(timeline, 5000, house), false, "the west x boundary is excluded");
  timeline.accept(snapshot({ id: "gin", room_id: "attic-window", position: [9, 7.25, -4.1] }), 5100);
  assert.equal(scene.atticWindowOccupied(timeline, 5100, house), true, "the roomBack z boundary is included");

  timeline.accept(snapshot({
    id: "lumina", room_id: "attic-window", position: [9, 7.25, 0],
    visit_until: "2026-11-14T00:00:05.500Z"
  }), 5200);
  assert.equal(scene.atticWindowOccupied(timeline, 5800, house), false, "expired WORLD samples count as absent");
});

test("attic door opens across the measured room-to-hall route at x=9", () => {
  const timeline = worldHome.createTimeline();
  const doorRoom = {
    layout: house.upperHallways.find((layout) => layout.floor === 2),
    door: {}, doorX: 9, doorHalfWidth: 0.77
  };
  timeline.accept(snapshot({
    id: "gin", room_id: "attic-window", target_room_id: "hall-attic", position: [8.55, 7.25, 1.9],
    active_kind: "move", activity_started_at: observedAt,
    activity_due_at: "2026-11-14T00:00:15.000Z",
    move_points: [[9.64, 7.25, -0.42], [9.42, 7.25, 0.63], [8.55, 7.25, 1.9]]
  }), 1000);
  assert.equal(scene.worldHomeDoorRoutePasses(doorRoom, timeline, 9400), true);
  assert.equal(scene.worldHomeDoorRoutePasses({ ...doorRoom, doorX: 11 }, timeline, 9400), false);
});

test("preview attic arrival and departure cross the facade within the door opening", () => {
  const attic = house.upperHallways.find((layout) => layout.floor === 2);
  const doorX = 9;
  const doorHalfWidth = 0.77;
  const doorZ = attic.z[0];
  const crossing = (route) => {
    for (let index = 0; index < route.length - 1; index += 1) {
      const start = route[index];
      const end = route[index + 1];
      const dz = end[2] - start[2];
      if (Math.abs(dz) < 1e-9) continue;
      const fraction = (doorZ - start[2]) / dz;
      if (fraction < 0 || fraction > 1) continue;
      return {
        x: start[0] + (end[0] - start[0]) * fraction,
        y: start[1] + (end[1] - start[1]) * fraction
      };
    }
    return null;
  };

  for (const [name, route] of Object.entries({ arrival: house.atticTrip.arrival, departure: house.atticTrip.departure })) {
    const point = crossing(route);
    assert.ok(point, `${name} must cross the attic facade`);
    assert.ok(Math.abs(point.x - doorX) <= doorHalfWidth, `${name} crosses within the x=9 door opening`);
    assert.equal(point.y, attic.height, `${name} crosses at the 3F floor height`);
  }
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
  for (const active_pose of ["mirror-crossed-arms", "mirror-hand-near-face"]) {
    assert.equal(worldHome.validateSnapshot(snapshot({ ...valid, active_pose })).actors[0].active_pose, active_pose);
  }
  assert.throws(() => worldHome.validateSnapshot({ ...snapshot(valid), observed_at: "November 14, 2026" }), /observed_at/);
  for (const [id, active_kind] of [["mio", "fashion_show"], ["midori", "reading"]]) {
    assert.equal(worldHome.validateSnapshot(snapshot({ id, room_id: "living", position: [0, 0, 0], active_kind })).actors[0].active_kind, active_kind);
  }
});

test("WORLD sample exposes server time derived from observed_at and monotonic receipt time", () => {
  const timeline = worldHome.createTimeline();
  timeline.accept(snapshot({ id: "mio", room_id: "living", position: [0, 0, 0], active_kind: "fashion_show" }), 1000);
  assert.equal(timeline.sample("mio", 1000).serverNow, Date.parse(observedAt));
  assert.equal(timeline.sample("mio", 2750).serverNow, Date.parse(observedAt) + 1750);
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
  assert.equal(worldHome.describeActor({ id: "mio", room_id: "living", active_kind: "fashion_show" }), "ファッションショー中 · 1F リビング");
  assert.equal(worldHome.describeActor({ id: "midori", room_id: "living", active_kind: "reading" }), "読書中 · 1F リビング");
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
