const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
require("../web/living/sd-motion.js");

const motion = globalThis.houseSDMotion;

test("camera-relative headings select all eight sprites, with stable boundaries", () => {
  const camera = -.43;
  for (const [index, direction] of motion.directions.entries()) {
    const clip = motion.walkClip(direction, .21, camera);
    const state = motion.sampleClip(clip, .35);
    const angle = state.heading - camera;
    assert.equal(motion.facing(Math.sin(angle), Math.cos(angle)), direction);
    assert.ok(Math.abs(Math.atan2(Math.sin(angle - index * Math.PI / 4), Math.cos(angle - index * Math.PI / 4))) < 1e-10);
  }
  const boundary = Math.PI * .13;
  assert.equal(motion.facing(Math.sin(boundary), Math.cos(boundary), "front"), "front");
  assert.equal(motion.facing(0, 0, "left"), "left");
});

test("a seat clip visits each phase and places the actor at the seat", () => {
  const seat = { x:2, y:.65, z:3, heading:Math.PI / 2 };
  const clip = motion.clipFor("dining", "tea", seat, .21, [[0, 0], [0, 3], [1.4, 3]]);
  const t = clip.approachSeconds;
  assert.equal(motion.sampleClip(clip, 0).stage, "approach");
  assert.equal(motion.sampleClip(clip, t + .1).stage, "turn");
  assert.equal(motion.sampleClip(clip, t + .5).stage, "sit");
  const seated = motion.sampleClip(clip, t + 1);
  assert.equal(seated.stage, "activity");
  assert.deepEqual(seated.position, [2, .21, 3]);
  assert.equal(seated.mix, 1);
  assert.equal(motion.sampleClip(clip, t + clip.active + 1.1).stage, "stand");
  assert.equal(motion.sampleClip(clip, t + clip.active + 1.6).stage, "leave");
  assert.equal(motion.sampleClip(clip, t + clip.active + 3).stage, "done");
});

test("all nine characters have directional, seated, sleep and activity art", () => {
  const root = path.join(__dirname, "..", "web", "living", "assets");
  const views = [...motion.directions, "sit-right", "sit-left", "sit-front-right", "sit-front-left", "sleep", "activity-type", "activity-tea", "activity-talk", "activity-read"];
  for (const id of ["mio", "shiro", "kuro", "midori", "lumina", "aka", "gin", "kin", "ao"]) {
    for (const view of views) {
      const contents = fs.readFileSync(path.join(root, `${id}-${view}.webp`));
      assert.equal(contents.subarray(0, 4).toString(), "RIFF");
      assert.equal(contents.subarray(8, 12).toString(), "WEBP");
    }
  }
});
