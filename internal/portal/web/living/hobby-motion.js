(function (global) {
  "use strict";

  // The KIT has no frame timing. These display intervals are PORTAL presentation
  // choices, not WORLD activity durations or movement claims.
  var START_SECONDS = 0.6;
  var FRAME_SECONDS = 0.8;
  var END_SECONDS = 0.6;
  var WORLD_KINDS = Object.freeze({
    mio: "fashion_show",
    shiro: "exercise",
    kuro: "mirror_pose",
    midori: "reading"
  });
  // Only the semantically matching pose is mapped. The remaining WORLD poses
  // have no equivalent KIT frame and keep their regular resident sprite.
  var MIRROR_POSES = Object.freeze({
    "mirror-hands-on-hips": "kuro-hip",
    "mirror-crossed-arms": "kuro-crossed",
    "mirror-hand-near-face": "kuro-face"
  });
  var catalogs = new WeakMap();

  function catalogIndex(catalog) {
    if (catalog && typeof catalog === "object" && catalogs.has(catalog)) return catalogs.get(catalog);
    var result = new Map();
    if (!catalog || typeof catalog !== "object" || !Array.isArray(catalog.characters)) return result;
    catalog.characters.forEach(function (character) {
      if (!character || typeof character.character !== "string" || !Array.isArray(character.assets)) return;
      var byId = new Map();
      character.assets.forEach(function (asset) {
        if (asset && typeof asset.id === "string" && typeof asset.image_path === "string") byId.set(asset.id, asset);
      });
      result.set(character.character.toLowerCase(), { character: character, assets: byId, plans: new Map() });
    });
    if (catalog && typeof catalog === "object") catalogs.set(catalog, result);
    return result;
  }

  function sequenceFor(entry, kind) {
    var playback = entry.character.playback || {};
    var ordered = Array.isArray(playback.suggested_order) ? playback.suggested_order : [];
    var assets = entry.assets;
    var activity = ordered.map(function (id) { return assets.get(id); }).filter(function (asset) {
      return asset && asset.activity === kind && asset.phase === "active";
    });
    var used = new Set();
    var sequence = [];
    (Array.isArray(playback.loops) ? playback.loops : []).forEach(function (loop) {
      if (!loop || !Array.isArray(loop.asset_ids)) return;
      loop.asset_ids.forEach(function (id) {
        var asset = assets.get(id);
        if (asset && asset.activity === kind && (asset.phase === "active" || asset.phase === "start")) {
          sequence.push(asset);
          used.add(id);
        }
      });
    });
    activity.forEach(function (asset) {
      if (!used.has(asset.id)) sequence.push(asset);
    });
    return { ordered: ordered.map(function (id) { return assets.get(id); }).filter(Boolean), sequence: sequence };
  }

  function durationFor(asset) {
    if (asset && asset.id === "mio-present-active-01") return 1.5;
    if (asset && asset.id === "mio-present-active-02-blink") return 0.12;
    return FRAME_SECONDS;
  }

  function selectAsset(catalog, actor, serverNowMs) {
    if (!actor || typeof actor.id !== "string" || !Number.isFinite(serverNowMs)) return null;
    var kind = WORLD_KINDS[actor.id];
    if (!kind || actor.active_kind !== kind) return null;
    var timingStart = Date.parse(actor.activity_started_at);
    var timingDue = Date.parse(actor.activity_due_at);
    if (!Number.isFinite(timingStart) || !Number.isFinite(timingDue) || timingDue <= timingStart || serverNowMs < timingStart) return null;
    if (kind === "mirror_pose") {
      var mappedId = MIRROR_POSES[actor.active_pose];
      if (!mappedId) return null;
      var kuro = catalogIndex(catalog).get("kuro");
      if (!kuro) return null;
      var pose = kuro.assets.get(mappedId);
      if (serverNowMs < timingStart + START_SECONDS * 1000) return kuro.assets.get("kuro-check") || null;
      if (serverNowMs >= timingDue - END_SECONDS * 1000) return kuro.assets.get("kuro-satisfied") || null;
      return pose || null;
    }
    var entries = catalogIndex(catalog);
    var entry = entries.get(actor.id);
    if (!entry) return null;
    var start = entry.character.assets.find(function (asset) { return asset.activity === kind && asset.phase === "start"; });
    var end = entry.character.assets.find(function (asset) { return asset.activity === kind && asset.phase === "end"; });
    var plan = entry.plans.get(kind);
    if (!plan) {
      plan = sequenceFor(entry, kind);
      entry.plans.set(kind, plan);
    }
    if (serverNowMs < timingStart + START_SECONDS * 1000) return start || null;
    if (serverNowMs >= timingDue - END_SECONDS * 1000) return end || plan.sequence.at(-1) || null;
    if (!plan.sequence.length) return null;
    var elapsed = serverNowMs - timingStart - START_SECONDS * 1000;
    var cycleMs = plan.sequence.reduce(function (total, asset) { return total + durationFor(asset) * 1000; }, 0);
    var position = elapsed % cycleMs;
    for (var index = 0; index < plan.sequence.length; index += 1) {
      var durationMs = durationFor(plan.sequence[index]) * 1000;
      if (position < durationMs) return plan.sequence[index];
      position -= durationMs;
    }
    return plan.sequence[plan.sequence.length - 1] || null;
  }

  function createLoadState(maxAttempts) {
    var limit = Number.isSafeInteger(maxAttempts) && maxAttempts > 0 ? maxAttempts : 2;
    var attempts = new Map();
    var currentKey = null;
    var generation = 0;
    return Object.freeze({
      begin: function (key) {
        if (typeof key !== "string" || !key || (attempts.get(key) || 0) >= limit) return null;
        if (currentKey === key) return null;
        currentKey = key;
        generation += 1;
        return Object.freeze({ key: key, generation: generation });
      },
      isCurrent: function (token) { return Boolean(token && token.key === currentKey && token.generation === generation); },
      fail: function (token) {
        if (!token || token.key !== currentKey || token.generation !== generation) return false;
        currentKey = null;
        generation += 1;
        var count = (attempts.get(token.key) || 0) + 1;
        attempts.set(token.key, count);
        return count < limit;
      },
      clear: function () { currentKey = null; generation += 1; }
    });
  }

  function createCatalogLoader(fetchCatalog, maxAttempts) {
    var limit = Number.isSafeInteger(maxAttempts) && maxAttempts > 0 ? maxAttempts : 2;
    var attempts = 0;
    var pending = null;
    var value = null;
    return Object.freeze({
      load: function () {
        if (value) return Promise.resolve(value);
        if (pending) return pending;
        if (attempts >= limit || typeof fetchCatalog !== "function") return Promise.resolve(null);
        attempts += 1;
        pending = Promise.resolve().then(fetchCatalog).then(function (catalog) {
          if (!catalog || typeof catalog !== "object" || !Array.isArray(catalog.characters)) throw new Error("Invalid hobby catalog");
          value = catalog;
          return value;
        }).catch(function () {
          return null;
        }).then(function (result) {
          pending = null;
          return result;
        });
        return pending;
      },
      attempts: function () { return attempts; },
      value: function () { return value; }
    });
  }

  function applyFrame(resident, activityKey, frameKey, texture, fallbackTexture, setTexture) {
    if (!resident || !resident.mesh || typeof setTexture !== "function") return false;
    var material = resident.mesh.material;
    if (!activityKey || !frameKey) {
      setTexture(resident, fallbackTexture);
      resident.hobbyActivityKey = null;
      resident.hobbyFrameKey = null;
      resident.hobbyTexture = null;
      return false;
    }
    if (texture) {
      if (material.map !== texture) setTexture(resident, texture);
      resident.hobbyActivityKey = activityKey;
      resident.hobbyFrameKey = frameKey;
      resident.hobbyTexture = texture;
      return true;
    }
    if (resident.hobbyActivityKey === activityKey && resident.hobbyTexture && material.map === resident.hobbyTexture) {
      resident.hobbyFrameKey = frameKey;
      return true;
    }
    if (material.map !== fallbackTexture) setTexture(resident, fallbackTexture);
    resident.hobbyActivityKey = activityKey;
    resident.hobbyFrameKey = frameKey;
    resident.hobbyTexture = null;
    return true;
  }

  function clearWorldHobbyFrame(resident, nearestAvailableTexture, setTexture) {
    if (!resident) return false;
    var hasHobbyFrame = Boolean(resident.hobbyKey || resident.hobbyAssetId || resident.hobbyActivityKey || resident.hobbyTexture);
    if (!hasHobbyFrame) return false;
    if (resident.hobbyLoadState && typeof resident.hobbyLoadState.clear === "function") resident.hobbyLoadState.clear();
    resident.hobbyKey = null;
    resident.hobbyAssetId = null;
    if (!resident.mesh) {
      resident.hobbyActivityKey = null;
      resident.hobbyFrameKey = null;
      resident.hobbyTexture = null;
      return false;
    }
    var direction = typeof resident.direction === "string" && resident.direction ? resident.direction : "front";
    var fallback = typeof nearestAvailableTexture === "function"
      ? nearestAvailableTexture(resident.id, direction)
      : null;
    applyFrame(resident, null, null, null, fallback, setTexture);
    return true;
  }

  var api = Object.freeze({
    startSeconds: START_SECONDS,
    frameSeconds: FRAME_SECONDS,
    endSeconds: END_SECONDS,
    worldKinds: WORLD_KINDS,
    mirrorPoses: MIRROR_POSES,
    catalogIndex: catalogIndex,
    selectAsset: selectAsset,
    createLoadState: createLoadState,
    createCatalogLoader: createCatalogLoader,
    applyFrame: applyFrame,
    clearWorldHobbyFrame: clearWorldHobbyFrame
  });
  global.houseHobbyMotion = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
