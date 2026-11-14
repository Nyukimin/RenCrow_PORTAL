(function (global) {
  "use strict";

  var HOUSE_SHA256 = "602a80fee5ce300ecfd3bee8cb4b316f4b3c95a6fda207a14cc95e06aaac840e";
  var RESIDENT_IDS = Object.freeze(["mio", "shiro", "kuro", "midori", "aka", "ao", "kin", "gin"]);
  var ROOM_LABELS = Object.freeze({
    living: "1F リビング",
    dining: "1F ダイニング",
    "stairs-ground": "1F 階段",
    "landing-second": "2F 踊り場",
    "stairs-attic": "2F 階段",
    "landing-attic": "屋根裏 踊り場",
    "hall-second": "2F 廊下",
    "hall-attic": "屋根裏 廊下",
    "upper-room-2-1": "2F 個室 1",
    "upper-room-2-2": "2F 個室 2",
    "upper-room-2-3": "2F 個室 3",
    "upper-room-2-4": "2F 個室 4",
    "upper-room-3-1": "3F 個室 1",
    "upper-room-3-2": "3F 個室 2",
    "upper-room-3-3": "3F 個室 3",
    "attic-window": "屋根裏 窓辺"
  });
  var MIRROR_POSES = Object.freeze({
    "mirror-greeting": "挨拶",
    "mirror-hero": "ヒーロー",
    "mirror-side": "横向き",
    "mirror-focus": "集中",
    "mirror-hands-on-hips": "腰に手",
    "mirror-over-shoulder": "振り返り",
    "mirror-open-arms": "両手を広げる",
    "mirror-bow": "お辞儀"
  });

  function finiteVector(value) {
    return Array.isArray(value) && value.length === 3 && value.every(function (part) {
      return typeof part === "number" && Number.isFinite(part);
    });
  }

  function validTimestamp(value) {
    return typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/.test(value) &&
      Number.isFinite(Date.parse(value));
  }

  function validateSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("WORLD snapshot is not an object");
    if (String(snapshot.scene_sha256 || "").toLowerCase() !== HOUSE_SHA256) throw new Error("WORLD snapshot HOUSE hash does not match");
    if (!Number.isSafeInteger(snapshot.state_seq) || snapshot.state_seq < 0) throw new Error("WORLD snapshot state_seq is invalid");
    if (!validTimestamp(snapshot.observed_at)) throw new Error("WORLD snapshot observed_at is invalid");
    if (!Array.isArray(snapshot.actors) || snapshot.actors.length > RESIDENT_IDS.length) throw new Error("WORLD snapshot actors are invalid");

    var seen = new Set();
    var actors = snapshot.actors.map(function (actor) {
      if (!actor || typeof actor !== "object" || Array.isArray(actor) || !RESIDENT_IDS.includes(actor.id) || seen.has(actor.id)) {
        throw new Error("WORLD snapshot actor id is invalid");
      }
      seen.add(actor.id);
      if (typeof actor.room_id !== "string" || !Object.hasOwn(ROOM_LABELS, actor.room_id) || !finiteVector(actor.position)) {
        throw new Error("WORLD snapshot actor location is invalid");
      }
      if (actor.move_points !== undefined && (!Array.isArray(actor.move_points) || actor.move_points.length < 2 || actor.move_points.length > 256 || !actor.move_points.every(finiteVector))) {
        throw new Error("WORLD snapshot move_points are invalid");
      }
      if (actor.active_kind !== undefined && !["move", "sleep", "exercise", "mirror_pose"].includes(actor.active_kind)) {
        throw new Error("WORLD snapshot active_kind is invalid");
      }
      if (actor.active_pose !== undefined && !Object.hasOwn(MIRROR_POSES, actor.active_pose)) {
        throw new Error("WORLD snapshot active_pose is invalid");
      }
      if (actor.activity_started_at !== undefined && !validTimestamp(actor.activity_started_at)) throw new Error("WORLD snapshot activity_started_at is invalid");
      if (actor.activity_due_at !== undefined && !validTimestamp(actor.activity_due_at)) throw new Error("WORLD snapshot activity_due_at is invalid");
      if (actor.target_room_id !== undefined && typeof actor.target_room_id !== "string") throw new Error("WORLD snapshot target_room_id is invalid");
      if (actor.mirror_pose_completions !== undefined && (!Number.isSafeInteger(actor.mirror_pose_completions) || actor.mirror_pose_completions < 0)) {
        throw new Error("WORLD snapshot mirror_pose_completions is invalid");
      }
      var accepted = { id: actor.id, room_id: actor.room_id, position: actor.position.slice() };
      ["active_kind", "active_pose", "activity_started_at", "activity_due_at", "target_room_id", "mirror_pose_completions"].forEach(function (key) {
        if (actor[key] !== undefined) accepted[key] = actor[key];
      });
      if (actor.move_points !== undefined) accepted.move_points = actor.move_points.map(function (point) { return point.slice(); });
      return accepted;
    });
    return {
      scene_sha256: HOUSE_SHA256,
      state_seq: snapshot.state_seq,
      observed_at: snapshot.observed_at,
      actors: actors
    };
  }

  function pathMetrics(points) {
    var lengths = [0];
    var total = 0;
    for (var index = 1; index < points.length; index += 1) {
      var a = points[index - 1];
      var b = points[index];
      total += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      lengths.push(total);
    }
    return { lengths: lengths, total: total };
  }

  function samplePolyline(points, metrics, fraction) {
    if (!points || points.length < 2 || metrics.total <= 0) {
      var fixed = (points && points.length ? points[points.length - 1] : [0, 0, 0]).slice();
      return { position: fixed, tangent: [0, 0, 0], distance: 0, segmentIndex: 0 };
    }
    var distance = Math.max(0, Math.min(1, fraction)) * metrics.total;
    var segment = points.length - 2;
    for (var index = 0; index < points.length - 1; index += 1) {
      if (distance <= metrics.lengths[index + 1]) {
        segment = index;
        break;
      }
    }
    var start = points[segment];
    var end = points[segment + 1];
    var segmentLength = metrics.lengths[segment + 1] - metrics.lengths[segment];
    var segmentProgress = segmentLength <= 0 ? 1 : (distance - metrics.lengths[segment]) / segmentLength;
    var tangent = segmentLength <= 0 ? [0, 0, 0] : [
      (end[0] - start[0]) / segmentLength,
      (end[1] - start[1]) / segmentLength,
      (end[2] - start[2]) / segmentLength
    ];
    return {
      position: start.map(function (part, axis) { return part + (end[axis] - part) * segmentProgress; }),
      tangent: tangent,
      distance: distance,
      segmentIndex: segment
    };
  }

  function createTimeline() {
    var current = null;
    var receiptMonotonicMs = 0;
    var actorMetrics = new Map();

    function accept(rawSnapshot, receivedAtMonotonicMs) {
      var snapshot = validateSnapshot(rawSnapshot);
      var receivedAt = Number.isFinite(receivedAtMonotonicMs) ? receivedAtMonotonicMs : 0;
      var nextMetrics = new Map();
      snapshot.actors.forEach(function (actor) {
        var movement = actor.active_kind === "move" && Array.isArray(actor.move_points) &&
          validTimestamp(actor.activity_started_at) && validTimestamp(actor.activity_due_at) &&
          Date.parse(actor.activity_due_at) > Date.parse(actor.activity_started_at);
        if (movement) nextMetrics.set(actor.id, pathMetrics(actor.move_points));
      });
      current = snapshot;
      receiptMonotonicMs = receivedAt;
      actorMetrics = nextMetrics;
      return snapshot;
    }

    function sample(actorId, nowMonotonicMs) {
      if (!current) return null;
      var actor = current.actors.find(function (entry) { return entry.id === actorId; });
      if (!actor) return null;
      var observedAt = Date.parse(current.observed_at);
      var serverNow = observedAt + (Number.isFinite(nowMonotonicMs) ? nowMonotonicMs - receiptMonotonicMs : 0);
      var metrics = actorMetrics.get(actorId);
      if (!metrics || !metrics.total) {
        return { position: actor.position.slice(), tangent: [0, 0, 0], distance: 0, segmentIndex: 0, moving: false, actor: actor };
      }
      var startedAt = Date.parse(actor.activity_started_at);
      var dueAt = Date.parse(actor.activity_due_at);
      var progress = Math.max(0, Math.min(1, (serverNow - startedAt) / (dueAt - startedAt)));
      var sample = samplePolyline(actor.move_points, metrics, progress);
      return Object.assign(sample, { moving: progress < 1, progress: progress, actor: actor });
    }

    return Object.freeze({ accept: accept, sample: sample, snapshot: function () { return current; } });
  }

  function roomLabel(roomId) {
    return ROOM_LABELS[roomId] || roomId || "場所未取得";
  }

  function describeActor(actor) {
    var room = roomLabel(actor.room_id);
    switch (actor.active_kind) {
      case "move":
        return actor.target_room_id && actor.target_room_id !== actor.room_id ? "移動中 → " + roomLabel(actor.target_room_id) : "移動中 · " + room;
      case "sleep":
        return "睡眠中 · " + room;
      case "exercise":
        return "運動中 · " + room;
      case "mirror_pose":
        return (MIRROR_POSES[actor.active_pose] || "ポーズ中") + " · " + (actor.mirror_pose_completions || 0) + "回 · " + room;
      default:
        return "待機 · " + room;
    }
  }

  var api = Object.freeze({
    houseSHA256: HOUSE_SHA256,
    residentIds: RESIDENT_IDS,
    roomLabels: ROOM_LABELS,
    mirrorPoses: MIRROR_POSES,
    validateSnapshot: validateSnapshot,
    createTimeline: createTimeline,
    describeActor: describeActor,
    roomLabel: roomLabel
  });
  global.houseWorldHome = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
