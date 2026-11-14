const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const livingRoot = path.join(__dirname, "..", "web", "living");

function loadHouseData() {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(livingRoot, "assets", "house-data.js"), "utf8"), context);
  return JSON.parse(JSON.stringify(context.window.housePreviewData));
}

function loadHouseModel() {
  const bytes = fs.readFileSync(path.join(livingRoot, "assets", "house-105.glb"));
  assert.equal(bytes.toString("ascii", 0, 4), "glTF");
  assert.equal(bytes.readUInt32LE(8), bytes.length);

  let json;
  for (let offset = 12; offset < bytes.length;) {
    const length = bytes.readUInt32LE(offset);
    const type = bytes.readUInt32LE(offset + 4);
    if (type === 0x4e4f534a) json = JSON.parse(bytes.toString("utf8", offset + 8, offset + 8 + length));
    offset += 8 + length;
  }
  assert.ok(json, "HOUSE GLB must contain a JSON chunk");
  return json;
}

function measureAtticRearPiers(json) {
  const nodes = json.nodes;
  const byIndex = new Map(nodes.map((node, index) => [index, node]));
  const parentOf = new Map();
  nodes.forEach((node, index) => (node.children || []).forEach((child) => parentOf.set(child, index)));
  const attic = nodes.find((node) => node.name === "RC_ATTIC");
  assert.ok(attic, "HOUSE GLB must expose its attic root");
  assert.deepEqual(attic.translation || [0, 0, 0], [0, 0, 0]);

  return nodes.flatMap((node, index) => {
    if (!/^Attic_Rear_Wall_Pier(?:\.\d+)?_v4$/.test(node.name || "")) return [];
    assert.equal(byIndex.get(parentOf.get(index))?.name, "RC_ATTIC", `${node.name} must be attached to the attic root`);
    assert.ok(node.mesh !== undefined, `${node.name} must reference measured mesh geometry`);
    const mesh = json.meshes[node.mesh];
    const ranges = mesh.primitives.map((primitive) => json.accessors[primitive.attributes.POSITION]);
    assert.ok(ranges.length > 0 && ranges.every((range) => range.min && range.max), `${node.name} must expose POSITION bounds`);
    const xMin = Math.min(...ranges.map((range) => range.min[0]));
    const xMax = Math.max(...ranges.map((range) => range.max[0]));
    const scaleX = node.scale?.[0] ?? 1;
    return [{
      center: (xMin + xMax) * scaleX / 2 + (node.translation?.[0] ?? 0),
      width: (xMax - xMin) * Math.abs(scaleX),
    }];
  });
}

function crossingX(start, end, z) {
  const fraction = (z - start[2]) / (end[2] - start[2]);
  return start[0] + (end[0] - start[0]) * fraction;
}

function assertNoRoomPartitionCrossings(points, partitions, roomBack, frontZ) {
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    for (const partition of partitions) {
      if (start[0] === end[0] && start[0] === partition) {
        assert.ok(start[2] > frontZ && end[2] > frontZ, `route follows partition x=${partition} inside a room`);
        continue;
      }
      if ((start[0] - partition) * (end[0] - partition) > 0 || start[0] === end[0]) continue;
      const fraction = (partition - start[0]) / (end[0] - start[0]);
      if (fraction < 0 || fraction > 1) continue;
      const z = start[2] + (end[2] - start[2]) * fraction;
      assert.ok(z < roomBack || z >= frontZ, `route crosses room partition x=${partition} at z=${z}`);
    }
  }
}

test("attic preview rooms and all doorway crossings follow the measured HOUSE rear piers", () => {
  const house = loadHouseData();
  const model = loadHouseModel();
  const piers = measureAtticRearPiers(model);
  const rearLimits = piers.filter((pier) => pier.width < 1).map((pier) => pier.center).sort((a, b) => a - b);
  const roomDividers = piers.filter((pier) => pier.width > 1).map((pier) => pier.center).sort((a, b) => a - b);

  const attic = house.upperHallways.find((layout) => layout.floor === 2);
  assert.ok(attic, "attic hallway layout must exist");
  assert.equal(attic.rooms.length, 3, "the east stair access remains outside the three rooms");
  assert.deepEqual(attic.rooms.map((room) => room.x[1]), roomDividers);
  assert.equal(attic.rooms[0].x[0], rearLimits[0]);
  assert.ok(attic.x[1] > attic.rooms.at(-1).x[1], "hallway remains open beyond the last room for stair access");
  assert.ok(!attic.rooms.some((room) => Math.abs(room.x[1] - 8.48) < 0.01), "the former 8.48 facade edge is removed");

  const frontZ = attic.z[0];
  const doorHalfWidth = 0.77;
  const doors = attic.rooms.map((room) => ({ center: (room.x[0] + room.x[1]) / 2, halfWidth: doorHalfWidth }));
  const points = house.atticTrip.aisle;
  assert.ok(points.every((point) => point[1] === attic.height), "the attic route stays on the attic floor");
  assert.ok(points.some((point) => point[0] === -8.07 && point[2] === 0.73), "west room interior stop is preserved");
  assert.ok(points.some((point) => point[0] === -0.74 && point[2] === 0.2), "middle room interior stop is preserved");
  assert.ok(points.some((point) => point[0] === 5.24 && point[2] === 0.24), "east room interior stop is preserved");

  const crossings = new Map(doors.map((door) => [door.center, []]));
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    if ((start[2] - frontZ) * (end[2] - frontZ) >= 0) continue;
    const x = crossingX(start, end, frontZ);
    const door = doors.find((candidate) => Math.abs(x - candidate.center) <= candidate.halfWidth);
    assert.ok(door, `route crosses the attic facade outside a doorway at x=${x}`);
    crossings.get(door.center).push(x);
  }
  assert.equal([...crossings.values()].reduce((count, values) => count + values.length, 0), 6, "each room is entered and exited once");
  for (const [center, xs] of crossings) {
    assert.equal(xs.length, 2, `door centered at x=${center} must have an entry and exit crossing`);
    assert.ok(xs.every((x) => Math.abs(x - center) < 0.02), `door crossings at x=${center} must clear its frame`);
  }

  assertNoRoomPartitionCrossings(points, attic.rooms.slice(0, -1).map((room) => room.x[1]), attic.roomBack, frontZ);
  assert.deepEqual(house.upperHallways[0], {
    floor: 1,
    height: 3.72,
    x: [-11.85, 11.85],
    z: [4.12, 5.62],
    roomBack: -2.6,
    doorHeight: 2.22,
    rooms: [
      { x: [-12, -6], color: 8745302 },
      { x: [-6, 0], color: 5722728 },
      { x: [0, 6], color: 7765862 },
      { x: [6, 12], color: 6584917 },
    ],
  }, "2F layout remains unchanged");
  assert.deepEqual(house.atticTrip.arrival.at(-1), [8.6, 7.25, 3.38]);
  assert.deepEqual(house.atticTrip.departure, [
    [7.38, 7.25, 1.9], [8.55, 7.25, 1.9], [9.42, 7.25, 0.63], [9.64, 7.25, -0.42],
  ], "attic departure and stair landing path remain unchanged");
  assert.equal(house.atticTrip.steps, 17, "attic stair geometry remains unchanged");
});
