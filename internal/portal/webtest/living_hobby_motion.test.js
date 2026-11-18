const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const motion = require("../web/living/hobby-motion.js");
const catalog = require("../web/living/assets/hobbies/catalog.json");

const actor = (id, active_kind, start, due, extra = {}) => ({
  id, active_kind, activity_started_at: start, activity_due_at: due, ...extra
});
const start = Date.parse("2026-11-17T00:00:00.000Z");
const due = Date.parse("2026-11-17T00:00:20.000Z");

test("selects start, looped active frames, end and a stable due hold from WORLD time", () => {
  const mio = actor("mio", "fashion_show", new Date(start).toISOString(), new Date(due).toISOString());
  const selected = (time) => motion.selectAsset(catalog, mio, time).id;
  assert.equal(selected(start), "mio-prepare-start-01");
  assert.equal(selected(start + 600), "mio-present-active-01");
  assert.equal(selected(start + 2099), "mio-present-active-01");
  assert.equal(selected(start + 2100), "mio-present-active-02-blink");
  assert.equal(selected(start + 2220), "mio-present-active-01");
  assert.equal(selected(due - 100), "mio-satisfied-end-01");
  assert.equal(selected(due + 5000), "mio-satisfied-end-01");
  assert.equal(selected(start + 2100), "mio-present-active-02-blink", "the selected phase is derived from activity time, not snapshot receipt count");
});

test("uses only declared matching actor activities and the explicitly mapped Kuro pose", () => {
  const mio = actor("mio", "fashion_show", new Date(start).toISOString(), new Date(due).toISOString());
  const shiro = actor("shiro", "exercise", new Date(start).toISOString(), new Date(due).toISOString());
  assert.equal(motion.selectAsset(catalog, shiro, start + 600).id, "shiro-dumbbell-low");
  assert.equal(motion.selectAsset(catalog, shiro, start + 1400).id, "shiro-dumbbell-high");
  const midori = actor("midori", "reading", new Date(start).toISOString(), new Date(due).toISOString());
  assert.equal(motion.selectAsset(catalog, midori, start + 600).id, "midori-read");
  const kuro = actor("kuro", "mirror_pose", new Date(start).toISOString(), new Date(due).toISOString(), { active_pose: "mirror-hands-on-hips" });
  assert.equal(motion.selectAsset(catalog, kuro, start + 100).id, "kuro-check");
  assert.equal(motion.selectAsset(catalog, kuro, start + 700).id, "kuro-hip");
  assert.equal(motion.selectAsset(catalog, kuro, due - 100).id, "kuro-satisfied");
  assert.equal(motion.selectAsset(catalog, { ...kuro, active_pose: "mirror-crossed-arms" }, start + 700).id, "kuro-crossed");
  assert.equal(motion.selectAsset(catalog, { ...kuro, active_pose: "mirror-hand-near-face" }, start + 700).id, "kuro-face");
  for (const active_pose of ["mirror-greeting", "mirror-hero", "mirror-side", "mirror-focus", "mirror-over-shoulder", "mirror-open-arms", "mirror-bow"]) {
    assert.equal(motion.selectAsset(catalog, { ...kuro, active_pose }, start + 5000), null, `${active_pose} has no matching KIT asset`);
  }
  assert.equal(motion.selectAsset(catalog, { ...midori, id: "aka" }, start + 5000), null);
  assert.equal(motion.selectAsset(catalog, { ...shiro, active_kind: "move" }, start + 5000), null);
  assert.equal(motion.selectAsset(catalog, mio, start - 1), null, "future WORLD activity does not render early");
  assert.equal(motion.selectAsset(catalog, { ...mio, activity_due_at: new Date(start).toISOString() }, start), null);
});

test("failed image retries are bounded and a changed activity invalidates stale loads", () => {
  const state = motion.createLoadState(2);
  const first = state.begin("mio-present|start-1");
  const replacement = state.begin("mio-present|start-2");
  assert.equal(state.isCurrent(first), false);
  assert.equal(state.fail(first), false, "a stale image failure cannot mutate the current activity");
  assert.equal(state.isCurrent(replacement), true);
  assert.equal(state.fail(replacement), true, "one retry remains after the first current failure");
  const retry = state.begin("mio-present|start-2");
  assert.equal(state.fail(retry), false, "the second failure exhausts the retry budget");
  assert.equal(state.begin("mio-present|start-2"), null, "repeated render frames do not cause unbounded retries");
  const afterSwitch = state.begin("mio-present|start-3");
  state.clear();
  assert.equal(state.isCurrent(afterSwitch), false, "leaving WORLD rendering invalidates pending image work");
});

test("catalog fetch retries after failure on demand and stops at its configured bound", async () => {
  let calls = 0;
  const expected = { version: 1, characters: [] };
  const loader = motion.createCatalogLoader(() => {
    calls += 1;
    if (calls === 1) throw new Error("temporary fetch failure");
    return expected;
  }, 2);
  assert.equal(await loader.load(), null);
  assert.equal(loader.attempts(), 1);
  assert.equal(await loader.load(), expected, "the next snapshot-triggered load can recover");
  assert.equal(loader.attempts(), 2);
  assert.equal(await loader.load(), expected, "a loaded catalog is reused");
  assert.equal(calls, 2);

  const exhausted = motion.createCatalogLoader(() => { calls += 1; throw new Error("offline"); }, 2);
  assert.equal(await exhausted.load(), null);
  assert.equal(await exhausted.load(), null);
  assert.equal(await exhausted.load(), null);
  assert.equal(exhausted.attempts(), 2);
  assert.equal(calls, 4, "no timer or unbounded retry is scheduled");
});

test("renderer keeps the previous hobby frame during a pending frame and applies ready maps before draw", async () => {
  const normal = { id: "normal" };
  const first = { id: "mio-present" };
  const next = { id: "mio-blink" };
  const material = { map: normal };
  const resident = { mesh: { material } };
  const setTexture = (target, texture) => { target.mesh.material.map = texture; };

  assert.equal(motion.applyFrame(resident, "mio|fashion_show|start", "mio-present", first, normal, setTexture), true);
  assert.equal(material.map, first, "a ready hobby texture is applied to the rendered material synchronously");
  assert.equal(motion.applyFrame(resident, "mio|fashion_show|start", "mio-blink", null, normal, setTexture), true);
  assert.equal(material.map, first, "a pending frame retains the last valid texture for the same WORLD activity");

  let cached = null;
  await Promise.resolve().then(() => { cached = next; });
  assert.equal(motion.applyFrame(resident, "mio|fashion_show|start", "mio-blink", cached, normal, setTexture), true);
  assert.equal(material.map, next, "a cache hit is bound before this render pass, even after a slow frame interval");

  assert.equal(motion.applyFrame(resident, "mio|fashion_show|replacement", "new-start", null, normal, setTexture), true);
  assert.equal(material.map, normal, "a new WORLD activity starts on the normal sprite while its first image loads");
  assert.equal(motion.applyFrame(resident, null, null, null, normal, setTexture), false);
  assert.equal(material.map, normal, "leaving hobby activity clears the retained hobby texture");
});

test("WORLD clear path skips texture lookup for ordinary or uninitialized residents", () => {
  let lookups = 0;
  const normal = { id: "normal" };
  const hobby = { id: "hobby" };
  const nearest = (id, direction) => {
    lookups += 1;
    assert.equal(id, "mio");
    assert.equal(direction, "front", "an active sprite with no heading uses the normal initialized fallback");
    return normal;
  };
  const setTexture = (resident, texture) => { resident.mesh.material.map = texture; };

  const notReady = { id: "mio", direction: undefined };
  assert.equal(motion.clearWorldHobbyFrame(notReady, nearest, setTexture), false);
  assert.equal(lookups, 0, "an ordinary resident without a mesh is ignored");

  const ordinary = { id: "mio", direction: undefined, mesh: { material: { map: normal } } };
  assert.equal(motion.clearWorldHobbyFrame(ordinary, nearest, setTexture), false);
  assert.equal(lookups, 0, "an ordinary resident with a mesh does not inspect undefined direction");
  assert.equal(ordinary.mesh.material.map, normal);

  let cleared = 0;
  const pending = { id: "mio", direction: undefined, hobbyKey: "mio|fashion_show|pending", hobbyLoadState: { clear() { cleared += 1; } } };
  assert.equal(motion.clearWorldHobbyFrame(pending, nearest, setTexture), false);
  assert.equal(cleared, 1);
  assert.equal(pending.hobbyKey, null);
  assert.equal(lookups, 0, "a pending hobby without a mesh is invalidated without resolving a sprite");

  const active = { id: "mio", direction: undefined, hobbyActivityKey: "mio|fashion_show|start", hobbyFrameKey: "mio-frame", hobbyTexture: hobby,
    mesh: { material: { map: hobby } } };
  assert.equal(motion.clearWorldHobbyFrame(active, nearest, setTexture), true);
  assert.equal(active.mesh.material.map, normal, "an active hobby mesh returns to the resident sprite");
  assert.equal(lookups, 1);
});

test("catalog paths resolve to the unmodified 320px PNG assets", () => {
  const root = path.join(__dirname, "../web/living/assets/hobbies");
  const entries = motion.catalogIndex(catalog);
  assert.deepEqual([...entries.keys()], ["mio", "shiro", "kuro", "midori"]);
  for (const entry of entries.values()) {
    for (const asset of entry.assets.values()) {
      const bytes = fs.readFileSync(path.join(root, asset.image_path));
      assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      assert.equal(bytes.readUInt32BE(16), 320);
      assert.equal(bytes.readUInt32BE(20), 320);
      assert.deepEqual(asset.reference_position.target_anchor_px, [160, 318]);
    }
  }
});
