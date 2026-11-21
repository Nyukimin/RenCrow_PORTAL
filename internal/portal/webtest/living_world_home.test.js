const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const threeContext = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../web/living/vendor/three-kit.js"), "utf8"), threeContext);
const THREE = threeContext.window.THREE;
const houseContext = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../web/living/assets/house-data.js"), "utf8"), houseContext);
const sceneContext = { module: { exports: {} } };
const sceneSource = fs.readFileSync(path.join(__dirname, "../web/living/scene.js"), "utf8");
vm.runInNewContext(sceneSource, sceneContext);
const scene = sceneContext.module.exports;
const worldHome = require("../web/living/world-home.js");
const house = houseContext.window.housePreviewData;
const houseGLB = fs.readFileSync(path.join(__dirname, "../web/living/assets/house-105.glb"));
const houseGLBModel = JSON.parse(houseGLB.subarray(20, 20 + houseGLB.readUInt32LE(12)).toString("utf8"));

const observedAt = "2026-11-14T00:00:05.000Z";
const snapshot = (actor) => ({
  scene_sha256: worldHome.houseSHA256,
  state_seq: 17,
  observed_at: observedAt,
  actors: Array.isArray(actor) ? actor : [actor]
});

function sourceBetween(startMarker, endMarker) {
  const start = sceneSource.indexOf(startMarker);
  const end = sceneSource.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `scene source must contain ${startMarker} before ${endMarker}`);
  return sceneSource.slice(start, end);
}

function pinnedSeatBounds(seatNames) {
  const parents = new Map();
  houseGLBModel.nodes.forEach((node, index) => (node.children || []).forEach((child) => parents.set(child, index)));
  return Object.fromEntries(seatNames.map((seatName) => {
    const index = houseGLBModel.nodes.findIndex((node) => node.name === seatName);
    const node = houseGLBModel.nodes[index];
    assert.ok(node, `${seatName} must be present in the pinned HOUSE model`);
    const parent = houseGLBModel.nodes[parents.get(index)];
    assert.equal(parent?.name, "RC_GROUND", `${seatName} remains a direct ground-level object`);
    assert.equal(parent.translation, undefined);
    assert.equal(parent.rotation, undefined);
    assert.equal(parent.scale, undefined);
    assert.equal(parent.matrix, undefined);
    assert.equal(node.matrix, undefined);
    assert.equal(node.scale, undefined);
    assert.equal(node.rotation?.[0], 0, `${seatName} keeps its horizontal rotation`);
    assert.equal(node.rotation?.[2], 0, `${seatName} keeps its horizontal rotation`);

    const mesh = houseGLBModel.meshes[node.mesh];
    assert.equal(mesh.primitives.length, 1, `${seatName} has one measured seat surface`);
    const accessor = houseGLBModel.accessors[mesh.primitives[0].attributes.POSITION];
    const localCenterX = (accessor.min[0] + accessor.max[0]) / 2;
    const localCenterZ = (accessor.min[2] + accessor.max[2]) / 2;
    assert.ok(Math.abs(localCenterX) < 1e-9 && Math.abs(localCenterZ) < 1e-9, `${seatName} geometry stays centered on its node`);
    const layout = house.groundLayout.find((group) => group.objects.includes(seatName));
    assert.ok(layout, `${seatName} remains in its existing ground layout`);
    return [seatName, [
      node.translation[0] + layout.offset[0],
      node.translation[1] + accessor.max[1] + layout.offset[1],
      node.translation[2] + layout.offset[2],
    ]];
  }));
}

function registerMeasuredSeatFixture(positions) {
  class Vector3 {
    constructor() { this.x = 0; this.y = 0; this.z = 0; }
  }
  class Box3 {
    setFromObject(object) { this.min = object.min; this.max = object.max; return this; }
    getCenter(target) {
      target.x = (this.min.x + this.max.x) / 2;
      target.y = (this.min.y + this.max.y) / 2;
      target.z = (this.min.z + this.max.z) / 2;
      return target;
    }
  }
  const boundsFor = (position) => ({
    min: { x: position[0] - 0.05, y: position[1] - 0.02, z: position[2] - 0.05 },
    max: { x: position[0] + 0.05, y: position[1], z: position[2] + 0.05 },
  });
  const nodes = new Map(Object.entries(positions).map(([name, position]) => [name, boundsFor(position)]));
  const officeSeats = [
    "Seat_v4", "Seat_v4__PORTAL_EXTRA_SEAT", "Seat.002_v4", "Seat.002_v4__PORTAL_EXTRA_SEAT",
    "Seat.003_v4", "Seat.003_v4__PORTAL_EXTRA_SEAT", "Seat.005_v4", "Seat.005_v4__PORTAL_EXTRA_SEAT",
  ];
  officeSeats.forEach((name, index) => {
    if (!nodes.has(name)) nodes.set(name, boundsFor([index, 0.65, index]));
  });
  ["Wood tabletop_v4", "Wood tabletop.002_v4", "Wood tabletop.003_v4", "Wood tabletop.005_v4"].forEach((name, index) => {
    if (!nodes.has(name)) nodes.set(name, boundsFor([index, 0.72, index]));
  });
  const seats = new Map();
  const worktops = new Map();
  vm.runInNewContext(`${sourceBetween("    function registerSeats(nodes) {", "    function demoPath(kind, seat) {")}\nregisterSeats(nodes);`, {
    nodes,
    seats,
    worktops,
    desks: ["mio", "shiro", "kuro", "midori", "aka", "ao", "kin", "gin"].map((residentId) => ({ residentId })),
    THREE: { Box3, Vector3 },
  });
  return seats;
}

function renderSeatFixture(seats, seatID, position, activity, options = {}) {
  let renderedState = null;
  let renderedAction = null;
  const residentID = options.residentID || "mio";
  const roomID = options.roomID || (seatID.startsWith("dining") ? "dining" : "living");
  const resident = { id: residentID, mesh: {}, livingArtPending: true, livingArt: {}, livingProps: null };
  const actor = { id: options.actorID || residentID, room_id: roomID, active_kind: options.activeKind, seat_id: seatID, position: position, seat_action: options.seatAction || "sit" };
  const heartbeatSeatActivities = new Map(activity ? [[residentID, activity]] : []);
  const worldHomeSnapshotCurrent = options.worldHomeSnapshotCurrent !== false;
  const worldHomeTimeline = { isFresh: () => options.worldHomeSnapshotFresh !== false };
  vm.runInNewContext(`${sourceBetween("    function renderLivingSeat(resident, actor) {", "    async function startMotionPreview(id, kind, action) {")};\nrenderLivingSeat(resident, actor);`, {
    resident,
    actor,
    heartbeatSeatActivities,
    worldHomeSnapshotCurrent,
    worldHomeTimeline,
    heartbeatSeatAction: scene.heartbeatSeatAction,
    motionEnabled: true,
    seats,
    currentTime: () => 1000,
    seatedActor(_resident, _art, state, action) {
      renderedState = state;
      renderedAction = action;
    },
    clearLivingProps() {},
  });
  return { state: renderedState, action: renderedAction, worldSeatAction: actor.seat_action };
}

test("defines the fourth attic facade with Gin's WORLD room id", () => {
  const attic = house.upperHallways.find((layout) => layout.floor === 2);
  assert.equal(attic.rooms.length, 4);
  assert.equal(attic.rooms[3].x[0], 6);
  assert.equal(attic.rooms[3].x[1], 12);
  assert.equal(attic.rooms[3].roomId, "attic-window");
  assert.equal(scene.upperRoomIdFor(attic, 3, attic.rooms[3]), "attic-window");
  assert.equal(scene.upperRoomIdFor(attic, 2, attic.rooms[2]), "upper-room-3-3");
});

test("turns the middle bookcase toward the room without blocking Kuro or the stair route", () => {
  const bookcase = house.secondLayout.find((layout) => layout.name === "middle-bookcase");
  assert.ok(bookcase, "the measured middle bookcase layout exists");
  assert.deepEqual(Array.from(bookcase.offset), [2, 0, 3.84]);
  assert.equal(bookcase.rotation_y, -Math.PI / 2, "the bookcase faces into the room from the right wall");
  assert.deepEqual(Array.from(bookcase.rotation_center), [3.5, -3.64]);

  const node = new THREE.Object3D();
  node.position.set(3.5, 4.2, -3.64);
  node.rotation.set(0.2, 0.3, -0.4);
  const startingRotation = node.quaternion.clone();
  const expectedRotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), bookcase.rotation_y).multiply(startingRotation);
  scene.transformHouseLayoutNode(node, bookcase, THREE);
  assert.ok(Math.abs(node.position.x - 5.5) < 1e-9);
  assert.ok(Math.abs(node.position.y - 4.2) < 1e-9);
  assert.ok(Math.abs(node.position.z - 0.2) < 1e-9);
  assert.ok(Math.abs(Math.abs(node.quaternion.dot(expectedRotation)) - 1) < 1e-9);

  // These bounds were measured from all 152 named GLB meshes, then transformed around their measured center.
  const sourceBounds = { minX: 2.83, maxX: 4.17, minZ: -3.87, maxZ: -3.41 };
  const rotatedCorners = [
    [sourceBounds.minX, sourceBounds.minZ], [sourceBounds.minX, sourceBounds.maxZ],
    [sourceBounds.maxX, sourceBounds.minZ], [sourceBounds.maxX, sourceBounds.maxZ],
  ].map(([x, z]) => {
    const corner = new THREE.Object3D();
    corner.position.set(x, 4, z);
    scene.transformHouseLayoutNode(corner, bookcase, THREE);
    return [corner.position.x, corner.position.z];
  });
  const bounds = {
    minX: Math.min(...rotatedCorners.map(([x]) => x)),
    maxX: Math.max(...rotatedCorners.map(([x]) => x)),
    minZ: Math.min(...rotatedCorners.map(([, z]) => z)),
    maxZ: Math.max(...rotatedCorners.map(([, z]) => z)),
  };
  assert.ok(Math.abs(bounds.minX - 5.27) < 0.01 && Math.abs(bounds.maxX - 5.73) < 0.01);
  assert.ok(Math.abs(bounds.minZ + 0.47) < 0.01 && Math.abs(bounds.maxZ - 0.87) < 0.01);
  const roomBack = house.upperHallways.find((layout) => layout.floor === 1).roomBack;

  assert.ok(bounds.minX > 5.05, "the shelf clears the mirror frame's measured x extent");
  assert.ok(bounds.maxX < 6, "the shelf stays in the right-side room");
  assert.ok(bounds.minZ > roomBack, "the shelf stays inside the second-floor room");
  assert.ok(bounds.minZ > -2.225, "the shelf clears the measured bed bounds");
  assert.ok(bounds.minZ > -1.37, "the shelf clears Kuro's mirror station depth");

  const stairPoints = [...house.stairTrip.landing, ...house.stairTrip.roomVisit].map(([x, , z]) => [x, z]);
  const distanceFromPathPoint = ([x, z]) => Math.hypot(
    Math.max(0, bounds.minX - x, x - bounds.maxX),
    Math.max(0, bounds.minZ - z, z - bounds.maxZ)
  );
  assert.ok(Math.min(...stairPoints.map(distanceFromPathPoint)) > 0.6, "the shelf clears the measured stair and room-visit paths");
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

test("WORLD snapshot freshness expires without removing the retained snapshot or resident sample", () => {
  const timeline = worldHome.createTimeline();
  const received = snapshot({ id: "mio", room_id: "dining", seat_id: "dining-aisle-north", position: [7.98, 0.21, 2.15] });
  const accepted = timeline.accept(received, 1000);

  assert.equal(timeline.isFresh(1000), true);
  assert.equal(timeline.isFresh(1000 + worldHome.snapshotFreshnessMs - 1), true);
  assert.equal(timeline.isFresh(1000 + worldHome.snapshotFreshnessMs), false, "snapshot expires at the configured freshness boundary");
  assert.equal(timeline.snapshot(), accepted, "expiry does not discard the last accepted snapshot");
  assert.equal(timeline.sample("mio", 1001 + worldHome.snapshotFreshnessMs).actor.seat_id, "dining-aisle-north", "resident display data remains available");

  const recovered = snapshot({ id: "mio", room_id: "dining", seat_id: "dining-aisle-north", position: [7.98, 0.21, 2.15] });
  timeline.accept(recovered, 9000);
  assert.equal(timeline.isFresh(9000), true, "a new accepted snapshot restores freshness");
});

test("scene freshness changes disable only the pose gate and a new accepted snapshot restores it", () => {
  const timeline = worldHome.createTimeline();
  let now = 1000;
  let updates = 0;
  let catalogLoads = 0;
  const first = timeline.accept(snapshot({ id: "mio", room_id: "living", seat_id: "sofa", position: [0, 0.21, 0] }), now);
  const sandbox = {
    worldHomeMode: true,
    houseAssetVerified: true,
    modelLoaded: true,
    worldHomeTimeline: timeline,
    worldHomeSnapshotCurrent: true,
    hobbyCatalog: null,
    loadHobbyCatalog() { catalogLoads += 1; },
    currentTime: () => now,
    updateResidentWorldPositions() { updates += 1; },
  };
  vm.runInNewContext(`${sourceBetween("    function setWorldHomeSnapshot(snapshot) {", "    function worldHomeReady() {")}`, sandbox);

  assert.equal(sandbox.setWorldHomeSnapshotFresh(false), true);
  assert.equal(sandbox.worldHomeSnapshotCurrent, false);
  assert.equal(timeline.snapshot(), first, "freshness failure preserves the last snapshot");
  assert.equal(updates, 1, "the rendered activity posture updates immediately");

  now += worldHome.snapshotFreshnessMs;
  assert.equal(sandbox.setWorldHomeSnapshotFresh(true), true);
  assert.equal(sandbox.worldHomeSnapshotCurrent, false, "a stale snapshot cannot re-enable the pose gate");

  now += 1;
  const recovered = { ...snapshot({ id: "mio", room_id: "living", seat_id: "sofa", position: [0, 0.21, 0] }), state_seq: 18 };
  assert.equal(sandbox.setWorldHomeSnapshot(recovered), true);
  assert.equal(sandbox.worldHomeSnapshotCurrent, true, "new snapshot acceptance restores freshness");
  assert.equal(timeline.snapshot().state_seq, 18);
  assert.equal(catalogLoads, 1, "accepted snapshots preserve lazy hobby-catalog loading");
});

test("accepts all four measured dining rest seats while preserving existing sofa and dining slots", () => {
  const seats = [
    { id: "mio", room_id: "living", seat_id: "sofa", position: [0, 0.21, 0], seat_action: "talk" },
    { id: "shiro", room_id: "living", seat_id: "sofa-guest", position: [1, 0.21, 0], seat_action: "talk" },
    { id: "kuro", room_id: "dining", seat_id: "dining", position: [2, 0.21, 0], seat_action: "talk" },
    { id: "midori", room_id: "dining", seat_id: "dining-guest", position: [3, 0.21, 0], seat_action: "talk" },
    { id: "aka", room_id: "dining", seat_id: "dining-aisle-north", position: [7.98, 0.21, 2.15] },
    { id: "ao", room_id: "dining", seat_id: "dining-aisle-south", position: [7.98, 0.21, -0.48] },
    { id: "kin", room_id: "dining", seat_id: "dining-window-north", position: [10.1, 0.21, 2.15] },
    { id: "gin", room_id: "dining", seat_id: "dining-window-south", position: [10.1, 0.21, -0.48] },
  ];
  const accepted = worldHome.validateSnapshot(snapshot(seats)).actors;

  assert.deepEqual(accepted.map((actor) => actor.seat_id), seats.map((actor) => actor.seat_id));
  assert.equal(new Set(accepted.map((actor) => actor.seat_id)).size, 8, "all eight residents retain distinct seat ids");
  assert.deepEqual(accepted.slice(4).map((actor) => actor.position), seats.slice(4).map((actor) => actor.position));
});

test("does not retain unknown or room-mismatched seat ids", () => {
  const invalidSeats = [
    { id: "mio", room_id: "dining", seat_id: "dining-unknown", position: [1, 0.21, 1], seat_action: "talk" },
    { id: "shiro", room_id: "living", seat_id: "dining-aisle-north", position: [2, 0.21, 2], seat_action: "talk" },
    { id: "kuro", room_id: "dining", seat_id: "sofa-guest", position: [3, 0.21, 3], seat_action: "talk" },
  ];
  const accepted = worldHome.validateSnapshot(snapshot(invalidSeats)).actors;

  for (const actor of accepted) {
    assert.equal("seat_id" in actor, false, `${actor.id} must not retain an invalid seat id`);
    assert.equal("seat_action" in actor, false, `${actor.id} must not retain an action for an invalid seat`);
  }
});

test("keeps existing work seats and Lumina visitor rest seating compatible", () => {
  const worker = worldHome.validateSnapshot(snapshot({
    id: "mio", room_id: "living", seat_id: "desk-mio", position: [-11.07, 0.21, 1.52], seat_action: "type",
  })).actors[0];
  const visitor = worldHome.validateSnapshot(snapshot({
    id: "lumina", room_id: "living", seat_id: "sofa-guest", position: [0.5, 0.21, 2],
    seat_action: "relax", visit_until: "2026-11-14T00:01:00.000Z",
  })).actors[0];

  assert.equal(worker.seat_id, "desk-mio");
  assert.equal(worker.seat_action, "type");
  assert.equal(visitor.seat_id, "sofa-guest");
  assert.equal(visitor.seat_action, "relax");
  assert.equal(visitor.visit_until, "2026-11-14T00:01:00.000Z");
});

test("measured chair node names remain in the exact HOUSE GLB and existing floor layout", () => {
  const expectedHash = "602a80fee5ce300ecfd3bee8cb4b316f4b3c95a6fda207a14cc95e06aaac840e";
  const seatNames = ["Seat.006_v4", "Seat.008_v4", "Seat.009_v4", "Seat.011_v4"];
  const measured = pinnedSeatBounds(seatNames);
  const aisle = house.groundLayout.find((group) => group.name === "dining-aisle-chairs");
  const window = house.groundLayout.find((group) => group.name === "dining-window-chairs");

  assert.equal(crypto.createHash("sha256").update(houseGLB).digest("hex"), expectedHash);
  assert.equal(worldHome.houseSHA256, expectedHash);
  for (const [seatName, position] of Object.entries({
    "Seat.006_v4": [7.98, 0.745, 2.15],
    "Seat.008_v4": [7.98, 0.745, -0.48],
    "Seat.009_v4": [10.1, 0.745, 2.15],
    "Seat.011_v4": [10.1, 0.745, -0.48],
  })) {
    assert.ok(position.every((value, index) => Math.abs(measured[seatName][index] - value) < 1e-5), `${seatName} retains its measured GLB transform`);
  }
  assert.deepEqual(Array.from(aisle.offset), [-0.12, 0, 0]);
  assert.deepEqual(Array.from(window.offset), [-0.9, 0, 0]);
  assert.ok(aisle.objects.includes("Seat.006_v4") && aisle.objects.includes("Seat.008_v4"));
  assert.ok(window.objects.includes("Seat.009_v4") && window.objects.includes("Seat.011_v4"));
});

test("registers the four additional chairs at their measured HOUSE bounds with existing facing directions", () => {
  const expected = {
    "dining-aisle-north": { object: "Seat.006_v4", heading: Math.PI / 2 },
    "dining-aisle-south": { object: "Seat.008_v4", heading: Math.PI / 2 },
    "dining-window-north": { object: "Seat.009_v4", heading: -Math.PI / 2 },
    "dining-window-south": { object: "Seat.011_v4", heading: -Math.PI / 2 },
  };
  const boxes = pinnedSeatBounds(["Seat.006_v4", "Seat.008_v4", "Seat.009_v4", "Seat.011_v4", "Seat.010_v4", "Seat.007_v4"]);
  Object.assign(boxes, {
    "Main seat cushion.001_v4": [0, 0.21, 1],
    "Main seat cushion.002_v4": [0, 0.21, 2],
    "Seat.003_v4": [13, 0.21, 0],
    "Wood tabletop.006_v4": [11, 0.72, 1],
  });
  const seats = registerMeasuredSeatFixture(boxes);

  for (const [seatID, { object, heading }] of Object.entries(expected)) {
    const position = boxes[object];
    const registered = seats.get(seatID);
    assert.ok([registered?.x, registered?.y, registered?.z].every((value, index) => Math.abs(value - position[index]) < 1e-9), seatID);
    assert.equal(registered?.heading, heading, seatID);
  }
  assert.equal(seats.get("dining").heading, -Math.PI / 2, "existing window-side dining seat keeps its heading");
  assert.equal(seats.get("dining-guest").heading, Math.PI / 2, "existing aisle-side dining seat keeps its heading");
});

test("rendering each new dining seat keeps the WORLD position and uses the measured seat heading", () => {
  const measured = {
    ...pinnedSeatBounds(["Seat.006_v4", "Seat.008_v4", "Seat.009_v4", "Seat.011_v4", "Seat.010_v4", "Seat.007_v4"]),
    "Main seat cushion.001_v4": [0, 0.21, 1],
    "Main seat cushion.002_v4": [0, 0.21, 2],
    "Seat.003_v4": [13, 0.21, 0],
    "Wood tabletop.006_v4": [11, 0.72, 1],
  };
  const seats = registerMeasuredSeatFixture(measured);
  const cases = [
    ["dining-aisle-north", [7.98, 0.21, 2.15], Math.PI / 2],
    ["dining-aisle-south", [7.98, 0.21, -0.48], Math.PI / 2],
    ["dining-window-north", [10.1, 0.21, 2.15], -Math.PI / 2],
    ["dining-window-south", [10.1, 0.21, -0.48], -Math.PI / 2],
  ];

  for (const [seatID, position, heading] of cases) {
    const rendered = renderSeatFixture(seats, seatID, position);
    assert.deepEqual(Array.from(rendered.state.position), position, `${seatID} keeps the WORLD anchor`);
    assert.equal(rendered.state.seatKind, "dining", `${seatID} uses the dining seated pose`);
    assert.equal(rendered.state.heading, heading, `${seatID} faces away from its table edge`);
    assert.equal(rendered.state.seatY, seats.get(seatID).y, `${seatID} keeps the measured GLB cushion height`);
    assert.equal(rendered.action, "sit");
  }
});

test("heartbeat rest activity uses an existing pose only for its actor's exact idle WORLD seat", () => {
  const cases = [
    ["sofa_reading", "mio", "living", "sofa", "read"],
    ["sofa_chat", "shiro", "living", "sofa-guest", "talk"],
    ["dining_tea", "kuro", "dining", "dining-aisle-north", "tea"],
    ["dining_tea_chat", "midori", "dining", "dining-window-south", "talk"],
  ];
  for (const [activity, actorID, roomID, seatID, expected] of cases) {
    const actor = { id: actorID, room_id: roomID, seat_id: seatID };
    assert.equal(scene.heartbeatSeatAction(actorID, actor, activity), expected, `${activity} selects its existing seated pose`);
    assert.equal(scene.heartbeatSeatAction(actorID, { ...actor, room_id: roomID === "dining" ? "living" : "dining" }, activity), null, `${activity} requires its matching room`);
    assert.equal(scene.heartbeatSeatAction(actorID, { ...actor, seat_id: "sofa" }, activity), roomID === "living" ? expected : null, `${activity} requires an allowed shared seat`);
    assert.equal(scene.heartbeatSeatAction(actorID, { ...actor, seat_id: "unknown-seat" }, activity), null, `${activity} rejects an unknown seat`);
    assert.equal(scene.heartbeatSeatAction("mio", actor, activity), actorID === "mio" ? expected : null, `${activity} cannot be borrowed by a different resident`);
    assert.equal(scene.heartbeatSeatAction(actorID, { ...actor, active_kind: "sleep" }, activity), null, `${activity} yields to active WORLD actions`);
  }
  assert.equal(scene.heartbeatSeatAction("mio", { id: "mio", room_id: "living", seat_id: "sofa" }, "unknown"), null);
  assert.equal(scene.heartbeatSeatAction("mio", { id: "mio", room_id: "living", seat_id: "sofa" }, undefined), null);
});

test("heartbeat seat activity is cleared when the next response ends the activity", () => {
  const setter = sourceBetween("    function setHeartbeatBubbles(items) {", "    function createMarker(desk, index) {");
  const heartbeatSeatActivities = new Map();
  const heartbeatBubbleContent = new Map();
  const heartbeatSeatActivityPoses = {
    sofa_reading: true, sofa_chat: true, dining_tea: true, dining_tea_chat: true,
  };
  const bubble = { label: { textContent: "" }, title: { textContent: "", hidden: false }, root: { hidden: true, setAttribute() {} } };
  vm.runInNewContext(`${setter}\nsetHeartbeatBubbles([{ actor_id: "mio", label: "ソファで読書中", ongoing_activity: "sofa_reading" }]);`, {
    heartbeatSeatActivities,
    heartbeatSeatActivityPoses,
    heartbeatBubbleContent,
    heartbeatBubbleNodes: new Map([["mio", bubble]]),
    RESIDENT_IDS: ["mio"],
    hideHeartbeatBubbles() {},
  });
  assert.equal(heartbeatSeatActivities.get("mio"), "sofa_reading");

  vm.runInNewContext(`${setter}\nsetHeartbeatBubbles([{ actor_id: "mio", label: "日課中" }]);`, {
    heartbeatSeatActivities,
    heartbeatSeatActivityPoses,
    heartbeatBubbleContent,
    heartbeatBubbleNodes: new Map([["mio", bubble]]),
    RESIDENT_IDS: ["mio"],
    hideHeartbeatBubbles() {},
  });
  assert.equal(heartbeatSeatActivities.has("mio"), false, "activity end clears the render-only pose immediately");
});

test("heartbeat activity chooses read, tea, and talk poses without mutating WORLD seat_action", () => {
  const measured = {
    ...pinnedSeatBounds(["Seat.006_v4", "Seat.008_v4", "Seat.009_v4", "Seat.011_v4", "Seat.010_v4", "Seat.007_v4"]),
    "Main seat cushion.001_v4": [0, 0.21, 1],
    "Main seat cushion.002_v4": [0, 0.21, 2],
    "Seat.003_v4": [13, 0.21, 0],
    "Wood tabletop.006_v4": [11, 0.72, 1],
  };
  const seats = registerMeasuredSeatFixture(measured);
  for (const [seatID, activity, expected, position] of [
    ["sofa", "sofa_reading", "read", [0, 0.21, 1]],
    ["sofa-guest", "sofa_chat", "talk", [0, 0.21, 2]],
  ]) {
    const rendered = renderSeatFixture(seats, seatID, position, activity);
    assert.equal(rendered.action, expected, `${activity} uses its existing ${expected} motion`);
  }

  for (const [seatID, position] of [
    ["dining-aisle-north", [7.98, 0.21, 2.15]],
    ["dining-aisle-south", [7.98, 0.21, -0.48]],
    ["dining-window-north", [10.1, 0.21, 2.15]],
    ["dining-window-south", [10.1, 0.21, -0.48]],
  ]) {
    const tea = renderSeatFixture(seats, seatID, position, "dining_tea", { seatAction: "talk" });
    assert.equal(tea.action, "tea", `${seatID} supports the existing tea motion`);
    assert.equal(tea.worldSeatAction, "talk", `${seatID} keeps WORLD seat_action unchanged`);
    assert.equal(renderSeatFixture(seats, seatID, position, "dining_tea_chat").action, "talk", `${seatID} supports the existing talk motion`);
  }

  const diningPosition = [7.98, 0.21, 2.15];
  assert.equal(renderSeatFixture(seats, "dining-aisle-north", diningPosition, "dining_tea", { activeKind: "sleep" }).action, "sit", "active WORLD sleep keeps priority");
  assert.equal(renderSeatFixture(seats, "dining-aisle-north", diningPosition, "dining_tea", { roomID: "living" }).action, "sit", "room mismatch falls back to WORLD seat action");
  assert.equal(renderSeatFixture(seats, "dining-aisle-north", diningPosition, "dining_tea", { actorID: "shiro" }).action, "sit", "heartbeat from a different actor cannot select the pose");
  assert.equal(renderSeatFixture(seats, "dining-aisle-north", diningPosition, "dining_tea", { worldHomeSnapshotCurrent: false }).action, "sit", "WORLD retrieval failure clears only the activity pose");
  assert.equal(renderSeatFixture(seats, "dining-aisle-north", diningPosition, "dining_tea", { worldHomeSnapshotFresh: false }).action, "sit", "expired WORLD snapshot clears the activity pose");
  assert.equal(renderSeatFixture(seats, "dining-aisle-north", diningPosition, "dining_tea", { worldHomeSnapshotCurrent: true, worldHomeSnapshotFresh: true }).action, "tea", "fresh WORLD recovery restores the activity pose");
});

test("active WORLD activity takes precedence over a simultaneous dining seat", () => {
  const diningSeat = {
    id: "mio", room_id: "dining", seat_id: "dining-aisle-north", seat_action: "talk", position: [7.98, 0.21, 2.15],
  };
  const seated = worldHome.validateSnapshot(snapshot(diningSeat)).actors[0];
  assert.equal(seated.seat_id, diningSeat.seat_id, "the new dining seat is accepted when the actor is idle");

  const simultaneous = worldHome.validateSnapshot(snapshot({
    ...diningSeat, active_kind: "sleep", activity_started_at: observedAt,
  })).actors[0];
  assert.equal(simultaneous.active_kind, "sleep");
  assert.equal("seat_id" in simultaneous, false, "active WORLD activity suppresses the seat projection");
  assert.equal("seat_action" in simultaneous, false, "active WORLD activity suppresses the seat pose");
  assert.equal(worldHome.describeActor(simultaneous), "睡眠中 · 1F ダイニング");

  const timeline = worldHome.createTimeline();
  timeline.accept(snapshot({ ...diningSeat, active_kind: "sleep", activity_started_at: observedAt }), 1000);
  const sampled = timeline.sample("mio", 1000);
  assert.equal(sampled.actor.active_kind, "sleep");
  assert.equal("seat_id" in sampled.actor, false, "the validated WORLD timeline keeps active_kind precedence");
});
