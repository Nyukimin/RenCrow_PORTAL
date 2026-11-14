(function (global) {
  "use strict";

  var RESIDENT_IDS = ["mio", "shiro", "kuro", "midori", "aka", "ao", "kin", "gin"];
  var CARDINAL = ["front", "left", "right", "back"];
  var NAVY = 0x111e36;
  var ASSET_ROOT = "/assets/living/assets/";
  // Each directional image has a two-pixel transparent strip below the feet.
  var SPRITE_FOOT_INSET = 2 / 320;
  var STAIR_FOOT_CLEARANCE = 0.07;
  var STAIR_LIFT_APPROACH = 0.12;
  var TOP_TREAD_EDGE = -2.455;
  var UPPER_LANDING_EDGE = -2.725;
  var ATTIC_HEIGHT = 7.25;
  var RESIDENT_CLEARANCE = 1.45;
  var RESIDENT_VERTICAL_CLEARANCE = 1.55;

  function createHouseScene(canvas, options) {
    options = options || {};
    if (!canvas || typeof canvas.getBoundingClientRect !== "function") {
      throw new TypeError("createHouseScene expects a canvas element");
    }

    var THREE = global.THREE;
    var motion = global.houseSDMotion;
    var motionEnabled = Boolean(motion && options.motionPreview);
    var directions = motionEnabled ? motion.directions : CARDINAL;
    var GLTFLoader = global.GLTFLoader;
    if (!THREE || !GLTFLoader) {
      throw new Error("ローカルの3Dライブラリを読み込めませんでした。vendor/three-kit.js を確認してください。");
    }
    if (!global.housePreviewData) {
      throw new Error("HOUSE_105の配置データが見つかりません。assets/house-data.js を確認してください。");
    }

    var metadata = global.housePreviewData;
    var cameraInfo = metadata.cameras || {};
    if (!cameraInfo.house || !cameraInfo.living || !Array.isArray(metadata.desks) || !Array.isArray(metadata.residents)) {
      throw new Error("HOUSE_105のカメラまたは配置データが不完全です。");
    }
    function isVector3(value) {
      return Array.isArray(value) && value.length >= 3 && value.slice(0, 3).every(function (part) { return isFinite(Number(part)); });
    }
    if (!isVector3(cameraInfo.house.position) || !isVector3(cameraInfo.house.target) || !isVector3(cameraInfo.living.position) || !isVector3(cameraInfo.living.target)) {
      throw new Error("HOUSE_105のカメラ座標が不正です。");
    }

    var statusNode = global.document && global.document.getElementById("scene-load-status");
    function setStatus(message) {
      if (statusNode) statusNode.textContent = message || "";
    }

    var renderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas: canvas, alpha: false, antialias: true, powerPreference: "high-performance" });
      if (!renderer.capabilities.isWebGL2) throw new Error("WebGL 2 is unavailable");
    } catch (error) {
      throw new Error("WebGLを利用できないため、HOUSE_105を表示できません。");
    }

    setStatus("HOUSE_105を読み込んでいます…");
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = false;

    var scene = new THREE.Scene();
    scene.background = new THREE.Color(NAVY);
    var camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.05, 1000);
    camera.up.set(0, 1, 0);
    // The mesh pivots at the feet when it tilts toward the camera.
    var residentGeometry = new THREE.PlaneGeometry(1, 1).translate(0, 0.5 - SPRITE_FOOT_INSET, 0);
    var housePosition = new THREE.Vector3().fromArray(cameraInfo.house.position);
    var houseTarget = new THREE.Vector3().fromArray(cameraInfo.house.target);
    var livingPosition = new THREE.Vector3().fromArray(cameraInfo.living.position);
    var livingTarget = new THREE.Vector3().fromArray(cameraInfo.living.target);
    var houseOffset = housePosition.clone().sub(houseTarget);
    var livingOffset = livingPosition.clone().sub(livingTarget);
    var houseYaw = Math.atan2(houseOffset.x, houseOffset.z);
    var livingYaw = Math.atan2(livingOffset.x, livingOffset.z);
    var housePitch = Math.atan2(houseOffset.y, Math.hypot(houseOffset.x, houseOffset.z));
    var livingPitch = Math.atan2(livingOffset.y, Math.hypot(livingOffset.x, livingOffset.z));
    var houseDistance = houseOffset.length();
    var livingDistance = livingOffset.length();
    var houseBaseSpan = Number(cameraInfo.house.span);
    var livingBaseSpan = Number(cameraInfo.living.span);
    if (!isFinite(houseBaseSpan) || houseBaseSpan <= 0 || !isFinite(livingBaseSpan) || livingBaseSpan <= 0) {
      throw new Error("HOUSE_105のカメラサイズが不正です。");
    }

    var root = null;
    var groundRoot = null;
    var secondRoot = null;
    var atticRoot = null;
    var secondFadeMaterials = [];
    var atticFadeMaterials = [];
    var secondRootVisible = true;
    var atticRootVisible = true;
    var shadowLight = null;
    var baseShadowIntensity = 1;
    var markerGroup = new THREE.Group();
    markerGroup.name = "preview-seat-markers";
    markerGroup.visible = false;
    scene.add(markerGroup);
    var markerSprites = [];
    var markerTextureCache = Object.create(null);
    var routesWithStairs = new Map();
    var stairOccupant = null;
    var stairQueue = [];
    var hallwayLabels = new Map();
    var heartbeatBubbleLayer = global.document && global.document.getElementById("scene-heartbeat-bubbles");
    var heartbeatBubbleNodes = new Map();
    var heartbeatBubbleContent = new Map();
    var upperRooms = new Map();

    var residents = metadata.residents.map(function (resident, index) {
      var route = resident && (resident.route ? metadata.routes && metadata.routes[resident.route] : resident.points);
      if (!resident || !resident.id || !Array.isArray(route) || route.length < 2) {
        throw new Error("HOUSE_105の住人経路データが不完全です。");
      }
      if (![0, 1, 2].includes(Number(resident.floor))) throw new Error("HOUSE_105の住人フロアが不正です。");
      var stairPasses = null;
      if (resident.stairs && metadata.stairTrip) {
        if (!routesWithStairs.has(route)) routesWithStairs.set(route, addStairTrip(route, metadata.stairTrip, metadata.atticTrip));
        var tour = routesWithStairs.get(route);
        route = tour.points;
        stairPasses = tour.stairPasses;
      }
      var points = route.map(function (point) {
        if (!Array.isArray(point) || point.length < 3 || point.some(function (value) { return !isFinite(Number(value)); })) {
          throw new Error("HOUSE_105の住人経路に不正な座標があります。");
        }
        return new THREE.Vector3(Number(point[0]), Number(point[1]), Number(point[2]));
      });
      var lengths = [0];
      var totalLength = 0;
      for (var i = 0; i < points.length; i += 1) {
        var segmentLength = points[i].distanceTo(points[(i + 1) % points.length]);
        totalLength += segmentLength;
        lengths.push(totalLength);
      }
      totalLength = Math.max(totalLength, 0.001);
      var phase = resident.phase === undefined ? index / metadata.residents.length : resident.phase;
      var distance = phase * totalLength;
      var passes = (stairPasses || []).map(function (pass) {
        return { entry: lengths[pass.entry], exit: lengths[pass.exit] };
      });
      var walker = {
        id: resident.id,
        floor: Number(resident.floor),
        landingHeight: resident.stairs && metadata.stairTrip ? metadata.stairTrip.landing[0][1] : Infinity,
        points: points,
        lengths: lengths,
        totalLength: totalLength,
        distance: distance,
        pace: resident.pace > 0 ? resident.pace : totalLength * (0.075 + (index % 4) * 0.012),
        stairPasses: passes,
        stairPass: passes.find(function (pass) { return distance > pass.entry && distance < pass.exit; }),
        group: new THREE.Group(),
        mesh: null,
        highlight: null,
        height: 1.35,
        locationLabel: null
      };
      if (walker.stairPass) {
        if (stairOccupant) throw new Error("HOUSE_105の階段に複数の住人が配置されています。");
        stairOccupant = walker;
      }
      walker.position = positionOnPath(walker, distance);
      return walker;
    });

    function addStairTrip(route, stairs, atticStairs) {
      var entryIndex = route.findIndex(function (point, index) {
        var next = route[index + 1];
        return next && point[2] === stairs.entry[2] && next[2] === stairs.entry[2] &&
          point[0] > stairs.entry[0] && next[0] < stairs.entry[0];
      });
      if (entryIndex < 0) throw new Error("HOUSE_105の階段入口が見つかりません。");

      var points = route.slice(0, entryIndex);
      // Stop on the deck before the ground-floor stairs meet the walking loop.
      var upEntry = points.length - 1;
      points.push(route[entryIndex]);
      var firstFlight = [stairs.entry].concat(stairSteps(stairs, stairs.entry, 2, -1));
      var ascent = firstFlight.concat(stairs.landing);
      if (atticStairs) {
        var secondFlight = stairSteps(atticStairs, stairs.landing[stairs.landing.length - 1], 0, 1).concat(atticStairs.landing);
        var landing = stairs.landing;
        if (stairs.roomVisit) {
          var split = stairs.roomVisitAfter + 1;
          landing = landing.slice(0, split).concat(stairs.roomVisit, landing.slice(split));
        }
        points = points.concat(firstFlight, landing, secondFlight, atticStairs.arrival);
        var upExit = points.length - 1;
        points = points.concat(atticStairs.aisle, atticStairs.departure);
        var downEntry = points.length - atticStairs.departure.length;
        var descent = ascent.concat(secondFlight).slice(0, -1).reverse();
        var groundExit = points.length + descent.length;
        points = points.concat(descent, route.slice(entryIndex + 1));
        return {
          points: points,
          stairPasses: [{ entry: upEntry, exit: upExit }, { entry: downEntry, exit: groundExit }]
        };
      }
      points = points.concat(ascent, ascent.slice(0, -1).reverse());
      return {
        points: points.concat(route.slice(entryIndex + 1)),
        stairPasses: [{ entry: upEntry, exit: points.length }]
      };
    }

    function stairSteps(stairs, entry, axis, direction) {
      var points = [];
      var height = entry[1];
      for (var step = 0; step < stairs.steps; step += 1) {
        var point = entry.slice();
        point[axis] = stairs.firstEdge + direction * stairs.treadDepth * step;
        point[1] = height;
        points.push(point);
        height = stairs.firstHeight + stairs.riserHeight * step;
        points.push([point[0], height, point[2]]);
      }
      return points;
    }

    var desks = metadata.desks.map(function (desk) {
      if (!desk || !desk.id || !desk.residentId || !Array.isArray(desk.position) || desk.position.length < 3) {
        throw new Error("HOUSE_105の席マーカー座標が不完全です。");
      }
      if (desk.position.slice(0, 3).some(function (value) { return !isFinite(Number(value)); })) {
        throw new Error("HOUSE_105の席マーカー座標が不正です。");
      }
      return {
        id: desk.id,
        residentId: desk.residentId,
        position: new THREE.Vector3(Number(desk.position[0]), Number(desk.position[1]), Number(desk.position[2]))
      };
    });
    if (residents.length !== RESIDENT_IDS.length || desks.length !== 8) {
      throw new Error("HOUSE_105には8人分の住人と席データが必要です。");
    }
    residents.forEach(function (resident) {
      var highlight = new THREE.Mesh(
        new THREE.RingGeometry(0.34, 0.44, 28),
        new THREE.MeshBasicMaterial({ color: 0xffe2a0, transparent: true, opacity: 0.82, depthWrite: false, side: THREE.DoubleSide, toneMapped: false })
      );
      highlight.name = "resident-position-" + resident.id;
      highlight.rotation.x = -Math.PI * 0.5;
      highlight.position.y = 0.035;
      highlight.renderOrder = 2;
      highlight.visible = false;
      resident.highlightOpacity = highlight.material.opacity;
      resident.group.add(highlight);
      resident.highlight = highlight;
      scene.add(resident.group);
    });
    var residentIds = new Set(residents.map(function (resident) { return resident.id; }));
    if (RESIDENT_IDS.some(function (id) { return !residentIds.has(id); })) {
      throw new Error("HOUSE_105の住人IDが8人分そろっていません。");
    }
    var residentsById = new Map(residents.map(function (resident) { return [resident.id, resident]; }));
    if (heartbeatBubbleLayer && global.document && typeof global.document.createElement === "function") {
      RESIDENT_IDS.forEach(function (id) {
        var bubble = global.document.createElement("div");
        bubble.className = "scene-heartbeat-bubble";
        bubble.setAttribute("data-heartbeat-actor", id);
        bubble.setAttribute("role", "note");
        bubble.setAttribute("aria-live", "off");
        bubble.hidden = true;
        var label = global.document.createElement("span");
        label.className = "scene-heartbeat-bubble__label";
        var title = global.document.createElement("span");
        title.className = "scene-heartbeat-bubble__title";
        title.hidden = true;
        bubble.appendChild(label);
        bubble.appendChild(title);
        heartbeatBubbleLayer.appendChild(bubble);
        heartbeatBubbleNodes.set(id, { root: bubble, label: label, title: title });
      });
    }

    var imageCount = 0;
    var failedImageCount = 0;
    var expectedImages = RESIDENT_IDS.length * CARDINAL.length;
    var imageTextures = Object.create(null);
    var imageCache = new Map();
    var seats = new Map();
    var worktops = new Map();
    var demonstration = null;
    var demonstrationRequest = 0;
    var demonstrationArt = new Map();
    var demonstrationGroup = new THREE.Group();
    var upAxis = new THREE.Vector3(0, 1, 0);
    if (motionEnabled) scene.add(demonstrationGroup);
    var modelLoaded = false;
    var loadFailed = false;
    var modelCounts = { roots: 0, meshes: 0, materials: 0, textures: 0 };
    var sourceMeshCount = 0;
    var mergedMeshCount = 0;
    var triangleCount = 0;
    var lastFrameMs = 0;
    var averageFrameMs = 0;
    var frameIntervalMs = 0;
    var measuredFrames = 0;
    var clock = 0;
    var lastFrame = 0;
    var paused = false;
    var markerOn = false;
    var worldHomeMode = false;
    var worldHomeTimeline = global.houseWorldHome ? global.houseWorldHome.createTimeline() : null;
    var houseAssetVerified = false;
    var selectedId = null;
    var cameraMotionEnabled = options.cameraMotionEnabled === undefined ? !options.reducedMotion : Boolean(options.cameraMotionEnabled);
    var view = options.initialView === "living" ? "living" : "house";
    var progress = view === "living" ? 1 : 0;
    var progressTarget = progress;
    var progressVelocity = 0;
    var viewportWidth = 1;
    var viewportHeight = 1;
    var pixelRatio = 1;
    var houseFraming = { span: houseBaseSpan, x: 0, y: 0 };
    var livingFraming = { span: livingBaseSpan, x: 0, y: 0 };
    var houseProjection;
    var livingProjection;
    var modelBounds = new THREE.Box3();
    var groundBounds = new THREE.Box3();
    var temporaryCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.05, 1000);
    var projectionMatrix = new THREE.Matrix4();
    var reusableVector = new THREE.Vector3();
    var statusSummary = "loading";

    function clamp(value, minimum, maximum) {
      return Math.max(minimum, Math.min(maximum, value));
    }

    function smooth(value) {
      var t = clamp(value, 0, 1);
      return t * t * (3 - 2 * t);
    }

    function lerp(a, b, t) {
      return a + (b - a) * t;
    }

    function currentTime() {
      return global.performance && typeof global.performance.now === "function" ? global.performance.now() : Date.now();
    }

    function projectedBounds(object, position, target) {
      temporaryCamera.position.copy(position);
      temporaryCamera.lookAt(target);
      temporaryCamera.updateMatrixWorld(true);
      // Project the meshes once so empty corners of the room's 3D bounds don't dictate the zoom.
      var bounds = new THREE.Box2();
      object.traverse(function (mesh) {
        if (!mesh.isMesh) return;
        var points = mesh.geometry.getAttribute("position");
        if (!points) return;
        projectionMatrix.multiplyMatrices(temporaryCamera.matrixWorldInverse, mesh.matrixWorld);
        for (var i = 0; i < points.count; i += 1) {
          reusableVector.fromBufferAttribute(points, i).applyMatrix4(projectionMatrix);
          bounds.min.x = Math.min(bounds.min.x, reusableVector.x);
          bounds.max.x = Math.max(bounds.max.x, reusableVector.x);
          bounds.min.y = Math.min(bounds.min.y, reusableVector.y);
          bounds.max.y = Math.max(bounds.max.y, reusableVector.y);
        }
      });
      return bounds;
    }

    function fitFraming(bounds, aspect) {
      return {
        span: Math.max((bounds.max.y - bounds.min.y) / 0.93, (bounds.max.x - bounds.min.x) / (aspect * 0.95)),
        x: (bounds.min.x + bounds.max.x) * 0.5,
        y: (bounds.min.y + bounds.max.y) * 0.5
      };
    }

    function resize() {
      var rect = canvas.getBoundingClientRect();
      var width = Math.max(1, Math.round(rect.width || canvas.clientWidth || 1));
      var height = Math.max(1, Math.round(rect.height || canvas.clientHeight || 1));
      var nextPixelRatio = Math.min(1.25, Math.max(1, global.devicePixelRatio || 1));
      if (width !== viewportWidth || height !== viewportHeight || nextPixelRatio !== pixelRatio) {
        viewportWidth = width;
        viewportHeight = height;
        pixelRatio = nextPixelRatio;
        renderer.setPixelRatio(pixelRatio);
        renderer.setSize(width, height, false);
        if (modelLoaded) updateFraming(width / height);
      }
    }

    function updateFraming(aspect) {
      houseFraming = fitFraming(houseProjection, aspect);
      livingFraming = fitFraming(livingProjection, aspect);
    }

    function floorOpacity(floor, value) {
      value = value === undefined ? progress : value;
      if (floor === 2) return 1 - smooth((value - 0.10) / 0.30);
      if (floor === 1) return 1 - smooth((value - 0.32) / 0.34);
      return 1;
    }

    function shadowIntensityScale(value) {
      var entering = smooth((value - 0.34) / 0.12);
      var leaving = 1 - smooth((value - 0.62) / 0.12);
      var upperFloorBlend = entering * leaving;
      return 1 - 0.12 * upperFloorBlend;
    }

    function advanceProgress(dt) {
      if (!cameraMotionEnabled) {
        progress = progressTarget;
        progressVelocity = 0;
        return;
      }
      var frequency = 5.6;
      var displacement = progress - progressTarget;
      var coefficient = progressVelocity + frequency * displacement;
      var decay = Math.exp(-frequency * dt);
      var nextDisplacement = (displacement + coefficient * dt) * decay;
      var nextVelocity = (progressVelocity - frequency * coefficient * dt) * decay;
      progress = progressTarget + nextDisplacement;
      progressVelocity = nextVelocity;
      if (progress <= 0 && progressVelocity < 0) {
        progress = 0;
        progressVelocity = 0;
      } else if (progress >= 1 && progressVelocity > 0) {
        progress = 1;
        progressVelocity = 0;
      }
      if (Math.abs(progress - progressTarget) < 0.0008 && Math.abs(progressVelocity) < 0.008) {
        progress = progressTarget;
        progressVelocity = 0;
      }
    }

    function applyCamera() {
      var target = houseTarget.clone().lerp(livingTarget, progress);
      var yaw = lerp(houseYaw, livingYaw, progress);
      var pitch = lerp(housePitch, livingPitch, progress);
      var closeView = demonstration && demonstration.closeView && progress > .995;
      if (closeView && demonstration.clip.kind === "desk") { yaw = Math.PI - .87; pitch = .43; }
      if (closeView && demonstration.clip.kind === "dining") { yaw = -2.05; pitch = .52; }
      var distance = lerp(houseDistance, livingDistance, progress);
      var horizontalDistance = Math.cos(pitch) * distance;
      camera.position.set(
        target.x + Math.sin(yaw) * horizontalDistance,
        target.y + Math.sin(pitch) * distance,
        target.z + Math.cos(yaw) * horizontalDistance
      );
      camera.lookAt(target);
      var aspect = Math.max(0.1, viewportWidth / viewportHeight);
      var span = lerp(houseFraming.span, livingFraming.span, progress);
      var centerX = lerp(houseFraming.x, livingFraming.x, progress);
      var centerY = lerp(houseFraming.y, livingFraming.y, progress);
      if (closeView) {
        camera.updateMatrixWorld(true);
        var anchor = demonstration.clip.seat || { x:-.75, y:.21, z:3.85 };
        var close = new THREE.Vector3(anchor.x, anchor.y + .46, anchor.z).applyMatrix4(camera.matrixWorldInverse);
        span = 5.4;
        centerX = close.x;
        centerY = close.y;
      }
      camera.top = centerY + span * 0.5;
      camera.bottom = centerY - span * 0.5;
      camera.left = centerX - span * 0.5 * aspect;
      camera.right = centerX + span * 0.5 * aspect;
      camera.near = 0.05;
      camera.far = Math.max(1000, span * 80);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);

      var secondOpacity = floorOpacity(1);
      var atticOpacity = floorOpacity(2);
      var showSecond = secondOpacity > 0.001;
      var showAttic = atticOpacity > 0.001;
      if (secondRoot) secondRoot.visible = showSecond;
      if (atticRoot) atticRoot.visible = showAttic;
      secondFadeMaterials.forEach(function (entry) { entry.material.opacity = entry.opacity * secondOpacity; });
      atticFadeMaterials.forEach(function (entry) { entry.material.opacity = entry.opacity * atticOpacity; });
      if ((showSecond !== secondRootVisible || showAttic !== atticRootVisible) && modelLoaded) {
        secondRootVisible = showSecond;
        atticRootVisible = showAttic;
        renderer.shadowMap.needsUpdate = true;
      }
      if (shadowLight) shadowLight.shadow.intensity = baseShadowIntensity * shadowIntensityScale(progress);
      return { target: target, span: span };
    }

    function pathSegment(resident, distance) {
      var first = 0;
      var last = resident.points.length - 1;
      while (first < last) {
        var middle = Math.floor((first + last) / 2);
        if (distance < resident.lengths[middle + 1]) last = middle;
        else first = middle + 1;
      }
      return first;
    }

    function positionOnPath(resident, distance, index) {
      if (index === undefined) index = pathSegment(resident, distance);
      var start = resident.lengths[index];
      var length = Math.max(0.0001, resident.lengths[index + 1] - start);
      return resident.points[index].clone().lerp(
        resident.points[(index + 1) % resident.points.length], clamp((distance - start) / length, 0, 1)
      );
    }

    function advanceResidents(dt) {
      if (!dt) return;
      residents.forEach(function (resident) {
        resident.walking = false;
        if (resident.waitingFor) return;
        var previous = resident.distance;
        var distance = previous + resident.pace * dt;
        var nextPass = !resident.stairPass && resident.stairPasses.find(function (pass) {
          return previous <= pass.entry && distance >= pass.entry;
        });
        if (nextPass) distance = nextPass.entry;
        distance %= resident.totalLength;
        var position = positionOnPath(resident, distance);
        // The lower aisle crosses beneath the stairs. Only test characters whose heights overlap.
        var obstructed = residents.some(function (other) {
          if (other === resident || Math.abs(position.y - other.position.y) >= RESIDENT_VERTICAL_CLEARANCE) return false;
          var dx = position.x - other.position.x;
          var dz = position.z - other.position.z;
          return dx * dx + dz * dz < RESIDENT_CLEARANCE * RESIDENT_CLEARANCE;
        });
        if (obstructed) return;

        resident.distance = distance;
        var covered = (distance - previous + resident.totalLength) % resident.totalLength;
        resident.walkDistance = (resident.walkDistance || 0) + covered;
        resident.walking = covered > 0.0001;
        resident.position = position;
        if (nextPass && !resident.waitingFor) {
          resident.waitingFor = nextPass;
          stairQueue.push(resident);
        }
        if (resident.stairPass && distance >= resident.stairPass.exit) {
          resident.stairPass = null;
          stairOccupant = null;
        }
      });
      // Both staircases and the connecting hallway share one queue, including for the way down.
      if (!stairOccupant && stairQueue.length) {
        stairOccupant = stairQueue.shift();
        stairOccupant.stairPass = stairOccupant.waitingFor;
        stairOccupant.waitingFor = null;
      }
    }

    function pathState(resident) {
      var i = pathSegment(resident, resident.distance);
      var from = resident.points[i];
      var to = resident.points[(i + 1) % resident.points.length];
      var tangent = to.clone().sub(from);
      if (tangent.x === 0 && tangent.z === 0) {
        // A riser is vertical. Use the next tread to keep facing uphill or downhill even after a pause.
        tangent = resident.points[(i + 2) % resident.points.length].clone().sub(to);
      }
      tangent.y = 0;
      if (tangent.lengthSq() > 0.000001) tangent.normalize();
      else tangent.copy(resident.lastTangent || new THREE.Vector3(0, 0, 1));
      return {
        position: resident.position,
        tangent: tangent,
        footLift: stairFootLift(resident, resident.position, i, tangent)
      };
    }

    function stairFootLift(resident, position, index, tangent) {
      var stairs = metadata.stairTrip;
      if (progress === 0 || resident.landingHeight === Infinity || tangent.z === 0 || position.x !== stairs.entry[0]) return 0;
      if (position.z <= TOP_TREAD_EDGE || position.z >= stairs.firstEdge + STAIR_LIFT_APPROACH) return 0;

      var points = resident.points;
      var from = points[index];
      var to = points[(index + 1) % points.length];
      // During a riser crossing, clear the higher of the two treads.
      var lift = STAIR_FOOT_CLEARANCE + Math.max(from.y, to.y) - position.y;
      if (from.y === to.y) {
        var ascending = tangent.z < 0;
        var edge = ascending ? to : from;
        var neighbor = ascending ? index + 2 : index + points.length - 1;
        var higherTread = points[neighbor % points.length];
        var edgeBlend = smooth(1 - (position.z - edge.z) / STAIR_LIFT_APPROACH);
        lift += edgeBlend * Math.max(0, higherTread.y - edge.y);
        if (position.y === stairs.entry[1]) lift -= (1 - edgeBlend) * STAIR_FOOT_CLEARANCE;
      }
      if (position.y >= resident.landingHeight - 0.00001) {
        lift *= smooth((position.z - TOP_TREAD_EDGE) / STAIR_LIFT_APPROACH);
      }
      return lift * smooth(progress);
    }

    function residentFloor(resident, position) {
      if (position.y >= ATTIC_HEIGHT - 0.00001) return 2;
      return position.y >= resident.landingHeight - 0.00001 && position.z <= UPPER_LANDING_EDGE ? 1 : resident.floor;
    }

    function residentOpacity(resident, position) {
      if (position.y < resident.landingHeight - 0.00001) return floorOpacity(resident.floor);
      if (position.y > resident.landingHeight + 0.00001) return floorOpacity(position.y < ATTIC_HEIGHT - 0.00001 ? 1 : 2);
      return lerp(1, floorOpacity(1), smooth((TOP_TREAD_EDGE - position.z) / (TOP_TREAD_EDGE - UPPER_LANDING_EDGE)));
    }

    function directionFor(tangent, previous) {
      var right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
      right.y = 0;
      if (right.lengthSq() < 0.000001) right.set(1, 0, 0);
      else right.normalize();
      // Camera local +Z points from the view target toward the viewer.
      var towardObserver = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 2);
      towardObserver.y = 0;
      if (towardObserver.lengthSq() < 0.000001) towardObserver.set(0, 0, 1);
      else towardObserver.normalize();
      var rightDot = tangent.x * right.x + tangent.z * right.z;
      var observerDot = tangent.x * towardObserver.x + tangent.z * towardObserver.z;
      if (motionEnabled) return motion.facing(rightDot, observerDot, previous);
      if (Math.abs(rightDot) > Math.abs(observerDot)) return rightDot >= 0 ? "right" : "left";
      return observerDot >= 0 ? "front" : "back";
    }

    function nearestAvailableTexture(residentId, direction) {
      var candidates = [direction, motion ? motion.fallback(direction) : direction].concat(CARDINAL);
      var seen = Object.create(null);
      for (var i = 0; i < candidates.length; i += 1) {
        var candidate = candidates[i];
        if (seen[candidate]) continue;
        seen[candidate] = true;
        if (imageTextures[residentId] && imageTextures[residentId][candidate]) return imageTextures[residentId][candidate];
      }
      return null;
    }

    function setSpriteTexture(resident, texture) {
      if (!resident.mesh) return;
      if (!texture || resident.mesh.material.map === texture) return;
      resident.mesh.material.map = texture;
      resident.mesh.material.needsUpdate = true;
      resizeResidentMesh(resident);
    }

    function resizeResidentMesh(resident) {
      var image = resident.mesh.material.map.image;
      var aspect = image && image.width && image.height ? image.width / image.height : 1;
      resident.mesh.scale.set(resident.height * aspect, resident.height, 1);
    }

    function textureFrom(image) {
      var texture = new THREE.Texture(image);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.generateMipmaps = true;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.needsUpdate = true;
      return texture;
    }

    function imageFor(key) {
      if (!imageCache.has(key)) {
        var image = new global.Image();
        var version = options.assetVersion ? "?v=" + encodeURIComponent(options.assetVersion) : "";
        image.src = ASSET_ROOT + key + ".webp" + version;
        imageCache.set(key, image.decode().then(function () { return image; }).catch(function (error) {
          imageCache.delete(key);
          throw error;
        }));
      }
      return imageCache.get(key);
    }

    function motionCanvas(resident, width, height) {
      if (!resident.motionCanvas) {
        var surface = global.document.createElement("canvas");
        resident.motionCanvas = surface.getContext("2d");
        resident.motionTexture = textureFrom(surface);
        resident.motionTexture.generateMipmaps = false;
        resident.motionTexture.minFilter = THREE.LinearFilter;
      }
      var canvas = resident.motionCanvas.canvas;
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      return resident.motionCanvas;
    }

    function updateSpriteTexture(resident, direction, walkDistance) {
      var texture = nearestAvailableTexture(resident.id, direction);
      if (!motionEnabled || walkDistance == null || !texture || !resident.mesh) {
        setSpriteTexture(resident, texture);
        return;
      }
      var frames = resident.walkRigs || (resident.walkRigs = new Map());
      if (!frames.has(texture)) frames.set(texture, motion.prepare(texture.image, resident.id, texture.userData.direction));
      var rig = frames.get(texture);
      var phase = walkDistance / motion.strideLength(resident.id, resident.height);
      var frame = Math.floor(phase * 16) % 16;
      var context = motionCanvas(resident, rig.width, rig.height);
      if (resident.walkFrame !== frame || resident.walkFacing !== direction || resident.walkSource !== texture) {
        motion.paintWalk(context, rig, resident.id, direction, frame / 16);
        resident.walkFrame = frame;
        resident.walkFacing = direction;
        resident.walkSource = texture;
        resident.motionTexture.needsUpdate = true;
      }
      setSpriteTexture(resident, resident.motionTexture);
      resizeResidentMesh(resident);
    }

    function buildResidentMesh(resident) {
      if (resident.mesh || !imageTextures[resident.id]) return;
      var texture = nearestAvailableTexture(resident.id, "front");
      if (!texture) return;
      var material = new THREE.MeshBasicMaterial({
        map: texture,
        color: 0xffffff,
        transparent: true,
        alphaTest: 0.012,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false
      });
      var mesh = new THREE.Mesh(residentGeometry, material);
      mesh.name = "resident-sprite-" + resident.id;
      mesh.renderOrder = 4;
      resident.group.add(mesh);
      resident.mesh = mesh;
      resident.spriteOpacity = material.opacity;
      resizeResidentMesh(resident);
      updateSpriteTexture(resident, directionFor(resident.lastTangent || new THREE.Vector3(0, 0, 1)));
    }

    function finishImageLoad() {
      if (imageCount + failedImageCount < expectedImages) return;
      if (failedImageCount && modelLoaded && !loadFailed) {
        setStatus("一部の住人画像を読み込めませんでした（" + imageCount + "/" + expectedImages + "）。");
      }
    }

    function loadSprites() {
      if (typeof global.Image !== "function") {
        failedImageCount = expectedImages;
        return;
      }
      RESIDENT_IDS.forEach(function (id) {
        imageTextures[id] = Object.create(null);
        imageFor(id + "-sleep").then(function (image) {
          imageTextures[id].sleep = textureFrom(image);
          var resident = residents.find(function (entry) { return entry.id === id; });
          var sample = worldHomeMode && worldHomeTimeline && worldHomeTimeline.sample(id, currentTime());
          if (sample && sample.actor.active_kind === "sleep" && resident && resident.mesh) setSpriteTexture(resident, imageTextures[id].sleep);
        }).catch(function () {});
        directions.forEach(function (direction) {
          var key = id + "-" + direction;
          var required = CARDINAL.includes(direction);
          imageFor(key).then(function (image) {
            if (required) imageCount += 1;
            var texture = textureFrom(image);
            texture.userData.direction = direction;
            imageTextures[id][direction] = texture;
            var resident = residents.find(function (entry) { return entry.id === id; });
            if (resident) {
              buildResidentMesh(resident);
              if (resident.mesh) updateSpriteTexture(resident, resident.direction || "front");
            }
            if (required) finishImageLoad();
          }).catch(function () {
            if (required) {
              failedImageCount += 1;
              finishImageLoad();
            }
          });
        });
      });
    }

    function registerSeats(nodes) {
      var office = ["Seat_v4", "Seat_v4__PORTAL_EXTRA_SEAT", "Seat.002_v4", "Seat.002_v4__PORTAL_EXTRA_SEAT",
        "Seat.003_v4", "Seat.003_v4__PORTAL_EXTRA_SEAT", "Seat.005_v4", "Seat.005_v4__PORTAL_EXTRA_SEAT"];
      function bounds(name) {
        var object = nodes.get(name);
        if (!object) throw new Error("HOUSE_105の座面が見つかりません: " + name);
        return new THREE.Box3().setFromObject(object);
      }
      function register(key, name, heading) {
        var box = bounds(name);
        var center = box.getCenter(new THREE.Vector3());
        seats.set(key, { x: center.x, y: box.max.y, z: center.z, heading: heading });
      }
      register("dining", "Seat.010_v4", -Math.PI / 2);
      register("dining-guest", "Seat.007_v4", Math.PI / 2);
      register("sofa", "Main seat cushion.001_v4", 0);
      register("sofa-guest", "Main seat cushion.002_v4", 0);
      desks.forEach(function (desk, index) { register("desk-" + desk.residentId, office[index], Math.PI); });
      register("desk-lumina", office[3], Math.PI);
      worktops.set("dining", bounds("Wood tabletop.006_v4").max.y);
      ["Wood tabletop_v4", "Wood tabletop.002_v4", "Wood tabletop.003_v4", "Wood tabletop.005_v4"].forEach(function (name, index) {
        var height = bounds(name).max.y;
        worktops.set("desk-" + desks[index * 2].residentId, height);
        worktops.set("desk-" + desks[index * 2 + 1].residentId, height);
      });
      worktops.set("desk-lumina", worktops.get("desk-midori"));
    }

    function demoPath(kind, seat) {
      if (kind === "dining") return [[11.17, 3.36], [11.17, seat.z], [seat.x + .64, seat.z]];
      if (kind === "sofa") return [[-.32, 3.76], [1.13, 3.34], [seat.x, 3.27], [seat.x, seat.z + .77]];
      var back = seat.z < 0;
      return [[-3.55, back ? .36 : 4.65], [seat.x, back ? .36 : 4.16], [seat.x, seat.z + .71]];
    }

    function demoActor(id) {
      var resident = residents.find(function (entry) { return entry.id === id; });
      var actor = { id: id, height: resident ? resident.height : residents[0].height, group: new THREE.Group() };
      demonstrationGroup.add(actor.group);
      buildResidentMesh(actor);
      return actor;
    }

    function disposeActor(actor) {
      if (!actor) return;
      if (actor.mesh) actor.mesh.material.dispose();
      if (actor.motionTexture) actor.motionTexture.dispose();
      actor.group.removeFromParent();
    }

    function stopMotionPreview() {
      demonstrationRequest += 1;
      if (!demonstration) return;
      disposeActor(demonstration.actor);
      disposeActor(demonstration.guest);
      demonstration.props.traverse(function (item) {
        if (item.geometry) item.geometry.dispose();
        if (item.material) item.material.dispose();
      });
      demonstration.props.removeFromParent();
      demonstration = null;
    }

    function boxProp(group, color, w, h, d, x, y, z) {
      var item = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color: color, roughness: .71 }));
      item.position.set(x, y, z);
      group.add(item);
      return item;
    }

    function buildProps(clip) {
      var group = new THREE.Group();
      var item;
      if (clip.action === "tea") {
        item = new THREE.Group();
        item.add(new THREE.Mesh(new THREE.CylinderGeometry(.065, .052, .105, 14), new THREE.MeshStandardMaterial({ color: 0xe78a52 })));
        var handle = new THREE.Mesh(new THREE.TorusGeometry(.030, .008, 6, 14), new THREE.MeshStandardMaterial({ color: 0xe78a52 }));
        handle.position.x = .065;
        item.add(handle);
        group.add(item);
      } else if (clip.action === "read" || clip.action === "notes") {
        item = new THREE.Group();
        boxProp(item, 0x39538a, .32, .027, .22, 0, 0, 0);
        boxProp(item, 0xf4ebcf, .29, .013, .20, 0, .017, 0);
        var page = new THREE.Group();
        boxProp(page, 0xfff4db, .142, .003, .199, .072, .025, 0);
        item.add(page);
        item.userData.page = page;
        group.add(item);
        if (clip.action === "notes") item.userData.pen = boxProp(item, 0x98613a, .11, .012, .012, .083, .044, .047);
      } else if (clip.action === "type" || clip.action === "review" || clip.action === "draw") {
        item = new THREE.Group();
        boxProp(item, 0x1c2b48, .34, .025, .17, 0, 0, 0);
        var accents = clip.action === "type" ? 8 : clip.action === "review" ? 2 : 3;
        item.userData.keys = [];
        for (var index = 0; index < accents; index += 1) {
          item.userData.keys.push(boxProp(item, 0x5b85b5, clip.action === "review" ? .105 : .029, .013, .073,
            (index - (accents - 1) / 2) * (accents > 3 ? .035 : .12), .018, 0));
        }
        if (clip.action === "draw") item.userData.pen = boxProp(item, 0xead5a9, .13, .012, .012, 0, .045, -.02);
        group.add(item);
      }
      group.userData.item = item;
      demonstrationGroup.add(group);
      return group;
    }

    function updateProps(preview, state) {
      var item = preview.props.userData.item;
      if (!item) return;
      var clip = preview.clip;
      var time = state.time;
      var sofa = clip.kind === "sofa";
      var ahead = clip.kind === "desk" ? .79 : sofa ? .34 : .61;
      var height = sofa ? clip.seat.y + preview.actor.height * .32 : clip.table + (clip.action === "tea" ? .052 : .013);
      var sip = clip.action === "tea" ? Math.pow(Math.max(0, Math.sin(Math.PI * time / clip.active)), 3) : 0;
      ahead -= sip * .41;
      height += sip * Math.max(.08, clip.seat.y + preview.actor.height * .58 - height);
      item.position.set(clip.seat.x + Math.sin(clip.seat.heading) * ahead, height, clip.seat.z + Math.cos(clip.seat.heading) * ahead);
      item.rotation.y = clip.seat.heading;
      item.rotation.x = sip * -.26;
      if (item.userData.page) {
        var flip = clamp((time / clip.active - .40) / .23, 0, 1);
        item.userData.page.rotation.z = Math.PI * Math.sin(Math.PI * flip);
      }
      if (item.userData.pen) item.userData.pen.position.z = Math.sin(time * 6) * .045;
      if (item.userData.keys) item.userData.keys.forEach(function (key, index) {
        var active = index === Math.floor(time * 12) % item.userData.keys.length;
        key.position.y = active ? .011 : .018;
        key.material.emissive.setHex(active ? 0x14283e : 0);
      });
      item.visible = (!sofa || state.stage === "activity") && !preview.actor.activityOwnsProp;
    }

    function seatedActor(actor, images, state, activity) {
      actor.group.position.set.apply(actor.group.position, state.position);
      var tangent = new THREE.Vector3(Math.sin(state.heading), 0, Math.cos(state.heading));
      actor.direction = directionFor(tangent, actor.direction);
      if (!actor.mesh) return;
      actor.mesh.quaternion.copy(camera.quaternion);
      actor.mesh.position.set(0, 0, 0);
      actor.activityOwnsProp = false;
      if (state.mix < .5) {
        var moving = state.stage === "approach" || state.stage === "leave";
        updateSpriteTexture(actor, actor.direction, moving ? state.distance : null);
        return;
      }
      var action = state.stage === "activity" ? activity : "sit";
      var cameraYaw = Math.atan2(camera.position.x - actor.group.position.x, camera.position.z - actor.group.position.z);
      actor.mesh.quaternion.setFromAxisAngle(upAxis, cameraYaw);
      var image = action === "sleep" ? images.sleep : images[motion.seatedView(actor.direction)];
      var pose = images["activity-" + action] || (action === "review" ? images["activity-read"] :
        ["draw", "notes"].includes(action) ? images["activity-type"] : null);
      var allowedPose = pose && ["front", "front-right", "right"].includes(actor.direction);
      if (allowedPose) {
        image = pose;
        actor.activityOwnsProp = actor.id === "mio" && ["read", "tea", "notes"].includes(action);
      }
      var time = state.time;
      var frame = Math.floor(time * 16);
      var context = motionCanvas(actor, image.naturalWidth, image.naturalHeight);
      if (actor.activityFrame !== frame || actor.activityImage !== image || actor.activity !== action) {
        motion.paintActivity(context, image, action, frame / 16, image.naturalWidth);
        actor.activityFrame = frame;
        actor.activityImage = image;
        actor.activity = action;
        actor.motionTexture.needsUpdate = true;
        actor.walkSource = null;
      }
      setSpriteTexture(actor, actor.motionTexture);
      resizeResidentMesh(actor);
      var feetToHip = action === "sleep" || ["aka", "gin", "kin", "ao"].includes(actor.id) ? .015 : .145 * actor.height;
      actor.mesh.position.y = state.seatY - state.position[1] - feetToHip;
      var forward = state.seatKind === "sofa" ? .22 : .13;
      actor.mesh.position.x = Math.sin(state.heading) * forward;
      actor.mesh.position.z = Math.cos(state.heading) * forward;
      if (state.seatKind === "sofa") {
        if (action === "sleep") actor.mesh.position.y += .035;
      }
    }

    function updateMotionPreview(dt) {
      if (!demonstration) return;
      var preview = demonstration;
      preview.time += dt;
      var state = motion.sampleClip(preview.clip, preview.time);
      preview.stage = state.stage;
      state.seatY = preview.clip.seat?.y;
      state.seatKind = preview.clip.kind;
      if (state.stage === "done" && preview.doneAt === undefined) preview.doneAt = preview.time;
      if (preview.doneAt !== undefined && preview.time > preview.doneAt + .6) {
        stopMotionPreview();
        return;
      }
      var guestTalking = preview.guest && state.stage === "activity" && Math.floor(state.time / .95) % 2 === 1;
      seatedActor(preview.actor, preview.images, state, guestTalking ? "sit" : preview.clip.action);
      if (preview.guest) {
        var seat = seats.get(preview.clip.kind + "-guest");
        var heading = Math.atan2(preview.clip.seat.x - seat.x, preview.clip.seat.z - seat.z);
        seatedActor(preview.guest, preview.guestImages, { position:[seat.x, .21, seat.z], heading:heading, stage:"activity", time:state.time, mix:1, seatY:seat.y, seatKind:preview.clip.kind }, guestTalking ? "talk" : "sit");
      }
      updateProps(preview, state);
    }

    async function loadDemoArt(id) {
      var views = ["sit-right", "sit-front-right", "sit-left", "sit-front-left", "sleep"];
      views.push.apply(views, ["type", "tea", "read", "talk"].map(function (action) { return "activity-" + action; }));
      if (id === "mio") views.push("activity-relax", "activity-draw", "activity-notes");
      if (!demonstrationArt.has(id)) demonstrationArt.set(id, Promise.all([
        Promise.all(views.map(async function (view) { return [view, await imageFor(id + "-" + view)]; })),
        id === "lumina" && !imageTextures[id] ? Promise.all(directions.map(async function (direction) {
          var texture = textureFrom(await imageFor(id + "-" + direction));
          texture.userData.direction = direction;
          return [direction, texture];
        })) : null
      ]).then(function (results) {
        if (results[1]) imageTextures[id] = Object.fromEntries(results[1]);
        return Object.fromEntries(results[0]);
      }).catch(function (error) {
        demonstrationArt.delete(id);
        throw error;
      }));
      return demonstrationArt.get(id);
    }

    async function startMotionPreview(id, kind, action) {
      if (!motionEnabled || !modelLoaded || !Object.hasOwn(motion.actions, kind) || !Object.hasOwn(motion.actions[kind], action)) return false;
      if (!RESIDENT_IDS.includes(id) && id !== "lumina") return false;
      stopMotionPreview();
      var request = demonstrationRequest;
      var guestId = action === "talk" ? (id === "mio" ? "shiro" : "mio") : null;
      var results = await Promise.all([loadDemoArt(id), guestId ? loadDemoArt(guestId) : null]);
      if (request !== demonstrationRequest) return false;
      var seatId = kind === "desk" ? kind + "-" + id : kind;
      var seat = seats.get(seatId);
      var previewHeading = Math.atan2(livingPosition.x - livingTarget.x, livingPosition.z - livingTarget.z);
      var clip = kind === "walk" ? motion.walkClip(action, .21, previewHeading) : motion.clipFor(kind, action, seat, .21, demoPath(kind, seat));
      clip.table = worktops.get(seatId);
      demonstration = { id:id, clip:clip, time:0, stage:"approach", actor:demoActor(id), images:results[0], closeView:false,
        guest:guestId ? demoActor(guestId) : null, guestImages:results[1], props:buildProps(clip) };
      updateMotionPreview(0);
      return true;
    }

    function seekMotionPreview() {
      if (!demonstration || demonstration.clip.kind === "walk") return false;
      demonstration.time = demonstration.clip.approachSeconds + .91;
      demonstration.doneAt = undefined;
      updateMotionPreview(0);
      return true;
    }

    function setMotionCloseView(enabled) {
      if (demonstration) demonstration.closeView = Boolean(enabled);
    }

    function motionPreviewState() {
      return demonstration ? { id: demonstration.id, stage: demonstration.stage, action: demonstration.clip.action,
        position: demonstration.actor.group.position.toArray(), direction: demonstration.actor.direction,
        walkFrame: demonstration.actor.walkFrame, elapsed: demonstration.time } : null;
    }

    function configureRoomLighting(bounds) {
      var size = bounds.getSize(new THREE.Vector3());
      var center = bounds.getCenter(new THREE.Vector3());
      var radius = Math.max(size.length() * 0.62, 4);
      scene.add(new THREE.HemisphereLight(0xd8e3ff, 0x503728, 1.05));
      scene.add(new THREE.AmbientLight(0xffdfbd, 0.38));
      var warmLight = new THREE.DirectionalLight(0xffd4a6, 2.15);
      shadowLight = warmLight;
      baseShadowIntensity = warmLight.shadow.intensity;
      warmLight.position.set(center.x - radius * 0.72, center.y + radius * 1.35, center.z + radius * 0.9);
      warmLight.target.position.copy(center);
      warmLight.castShadow = true;
      warmLight.shadow.mapSize.set(1536, 1536);
      warmLight.shadow.camera.left = -radius * 1.2;
      warmLight.shadow.camera.right = radius * 1.2;
      warmLight.shadow.camera.top = radius * 1.2;
      warmLight.shadow.camera.bottom = -radius * 1.2;
      warmLight.shadow.camera.near = 0.1;
      warmLight.shadow.camera.far = radius * 5;
      warmLight.shadow.camera.updateProjectionMatrix();
      warmLight.shadow.bias = -0.00018;
      warmLight.shadow.normalBias = 0.018;
      warmLight.shadow.radius = 3;
      scene.add(warmLight, warmLight.target);
    }

    function prepareUpperFade(object, fadeMaterials) {
      var cloned = new Map();
      object.traverse(function (item) {
        if (!item.isMesh || !item.material) return;
        var replace = function (source) {
          if (cloned.has(source)) return cloned.get(source);
          var material = source.clone();
          var opaque = !source.transparent && source.opacity >= 0.999;
          material.opacity = source.opacity;
          material.alphaHash = opaque;
          if (!opaque) {
            material.transparent = true;
            material.depthWrite = false;
          }
          cloned.set(source, material);
          fadeMaterials.push({ material: material, opacity: source.opacity });
          return material;
        };
        item.material = Array.isArray(item.material) ? item.material.map(replace) : replace(item.material);
        if (upperRooms.has(item.parent)) {
          upperRooms.get(item.parent).materials.add(item.material);
          item.userData.skipShadow = true;
        }
      });
    }

    function countModelResources(object) {
      var materialSet = new Set();
      var textureSet = new Set();
      var meshes = 0;
      object.traverse(function (item) {
        if (!item.isMesh) return;
        meshes += 1;
        item.castShadow = !item.userData.skipShadow;
        item.receiveShadow = true;
        var materials = Array.isArray(item.material) ? item.material : [item.material];
        materials.forEach(function (material) {
          if (!material) return;
          materialSet.add(material);
          Object.keys(material).forEach(function (key) {
            var value = material[key];
            if (value && value.isTexture) textureSet.add(value);
          });
        });
      });
      modelCounts.meshes = meshes;
      modelCounts.materials = materialSet.size;
      modelCounts.textures = textureSet.size;
      modelCounts.roots = [groundRoot, secondRoot, atticRoot].filter(Boolean).length;
    }

    function geometrySignature(geometry) {
      var names = Object.keys(geometry.attributes).sort();
      return names.map(function (name) {
        var attribute = geometry.attributes[name];
        var array = attribute.array || (attribute.data && attribute.data.array);
        var constructorName = array && array.constructor ? array.constructor.name : "unknown";
        var stride = attribute.data && attribute.data.stride ? attribute.data.stride : 0;
        return name + ":" + attribute.itemSize + ":" + Boolean(attribute.normalized) + ":" + constructorName + ":" + stride;
      }).join("|") + ";index:" + (geometry.index ? geometry.index.array.constructor.name : "none");
    }

    function fullGeometryGroup(geometry) {
      if (geometry.groups.length === 0) return true;
      if (geometry.groups.length !== 1) return false;
      var group = geometry.groups[0];
      var count = geometry.index ? geometry.index.count : geometry.attributes.position.count;
      return group.start === 0 && group.count === count && group.materialIndex === 0;
    }

    function mergeableMesh(mesh) {
      if (!mesh.isMesh || mesh.isSkinnedMesh || mesh.isInstancedMesh || mesh.children.length || !mesh.geometry || Array.isArray(mesh.material)) return false;
      var material = mesh.material;
      var geometry = mesh.geometry;
      if (!material || material.transparent || material.opacity < 0.999 || material.visible === false) return false;
      if (Object.keys(geometry.morphAttributes).length || !fullGeometryGroup(geometry)) return false;
      if (Object.keys(geometry.attributes).some(function (name) { return geometry.attributes[name].isInterleavedBufferAttribute; })) return false;
      var range = geometry.drawRange;
      var elementCount = geometry.index ? geometry.index.count : geometry.attributes.position.count;
      if (range.start !== 0 || (range.count !== Infinity && range.count !== elementCount)) return false;
      return true;
    }

    function optimizeFloorMeshes(floorRoot, geometryReferences) {
      var buckets = new Map();
      var inverseRoot = new THREE.Matrix4().copy(floorRoot.matrixWorld).invert();
      floorRoot.traverse(function (item) {
        if (!item.isMesh) return;
        sourceMeshCount += 1;
        var geometry = item.geometry;
        if (geometry && geometry.attributes.position) {
          var elementCount = geometry.index ? geometry.index.count : geometry.attributes.position.count;
          triangleCount += Math.floor(elementCount / 3);
        }
        if (!mergeableMesh(item) || item.renderOrder !== 0) return;
        item.updateWorldMatrix(true, false);
        var transform = new THREE.Matrix4().multiplyMatrices(inverseRoot, item.matrixWorld);
        if (transform.determinant() < 0) return;

        var signature = geometrySignature(geometry);
        var key = item.material.uuid + "|" + signature;
        var bucket = buckets.get(key);
        if (!bucket) {
          bucket = { material: item.material, signature: signature, meshes: [], geometries: [] };
          buckets.set(key, bucket);
        }
        var baked = geometry.clone();
        baked.applyMatrix4(transform);
        bucket.meshes.push(item);
        bucket.geometries.push(baked);
      });

      buckets.forEach(function (bucket) {
        if (bucket.geometries.length < 2) {
          bucket.geometries.forEach(function (geometry) { geometry.dispose(); });
          return;
        }
        var merged = global.BufferGeometryUtils && global.BufferGeometryUtils.mergeGeometries(bucket.geometries, false);
        if (!merged) {
          bucket.geometries.forEach(function (geometry) { geometry.dispose(); });
          return;
        }
        bucket.meshes.forEach(function (mesh) {
          if (mesh.parent) mesh.parent.remove(mesh);
          var references = (geometryReferences.get(mesh.geometry) || 1) - 1;
          if (references <= 0) {
            mesh.geometry.dispose();
            geometryReferences.delete(mesh.geometry);
          } else {
            geometryReferences.set(mesh.geometry, references);
          }
        });
        bucket.geometries.forEach(function (geometry) { geometry.dispose(); });
        var batchedMesh = new THREE.Mesh(merged, bucket.material);
        batchedMesh.name = "batched-" + floorRoot.name + "-" + bucket.material.name;
        batchedMesh.castShadow = true;
        batchedMesh.receiveShadow = true;
        floorRoot.add(batchedMesh);
        mergedMeshCount += 1;
      });
    }

    function optimizeRoomGeometry() {
      if (!global.BufferGeometryUtils || typeof global.BufferGeometryUtils.mergeGeometries !== "function") return;
      try {
        root.updateMatrixWorld(true);
        var references = new Map();
        root.traverse(function (item) {
          if (item.isMesh && item.geometry) references.set(item.geometry, (references.get(item.geometry) || 0) + 1);
        });
        [groundRoot, secondRoot, atticRoot].forEach(function (floorRoot) {
          floorRoot.updateWorldMatrix(true, true);
          optimizeFloorMeshes(floorRoot, references);
        });
      } catch (error) {
        console.error("HOUSE_105 mesh batching skipped after an error; keeping the room visible", error);
      }
      console.info("HOUSE_105 static mesh batches", {
        sourceMeshes: sourceMeshCount,
        batchedMeshes: mergedMeshCount,
        triangles: triangleCount
      });
    }

    function showUnavailable(message) {
      loadFailed = true;
      statusSummary = "unavailable";
      setStatus(message);
      if (root && root.parent) root.parent.remove(root);
      root = groundRoot = secondRoot = atticRoot = null;
      modelLoaded = false;
      modelCounts = { roots: 0, meshes: 0, materials: 0, textures: 0 };
    }

    function arrangeFloor(floor, layout) {
      var nodes = new Map();
      floor.traverse(function (node) {
        if (node.userData.name) nodes.set(node.userData.name, node);
      });
      (layout || []).forEach(function (group) {
        var names = group.objects.slice();
        (group.series || []).forEach(function (series) {
          for (var index = series[1]; index <= series[2]; index += 1) {
            names.push(series[0] + String(index).padStart(3, "0") + "_v4");
          }
        });
        names.forEach(function (name) {
          var node = nodes.get(name);
          if (!node || node.parent !== floor) {
            throw new Error("HOUSE_105の家具を配置できません: " + name);
          }
          node.position.x += group.offset[0];
          node.position.y += group.offset[1];
          node.position.z += group.offset[2];
        });
      });

      return nodes;
    }

    function extendGroundFloor(nodes) {
      // Keep the rear edge at -4.2 and continue the same planks through to the old deck's front edge.
      var extension = 5.7 - 4.2;
      var floor = nodes.get("1F_subfloor_v4");
      var frontJoints = [];
      nodes.forEach(function (node, name) {
        if (/^(?:1F_Plank_\d+|1F_subfloor)_v4$/.test(name)) {
          node.scale.z *= (8.4 + extension) / 8.4;
          node.position.z += extension / 2;
        } else if (/^(?:Front_deck|Deck_plank(?:\.\d+)?)_v4$/.test(name)) {
          node.removeFromParent();
        } else if (name.indexOf("V2_staggered_plank_joint") === 0 && Math.abs(node.position.z - 0.9) < 0.001) {
          var joint = node.clone();
          joint.name = "extended-floor-joint";
          joint.position.z = 4.5;
          frontJoints.push(joint);
        }
      });
      floor.parent.add.apply(floor.parent, frontJoints);
    }

    function connectStairLanding(ground) {
      var topTread = ground.getObjectByName("Step_20_v4");
      // Connect the top tread to the landing, with the bridge visible in the cutaway.
      var gap = TOP_TREAD_EDGE - UPPER_LANDING_EDGE;
      var bridge = new THREE.Mesh(new THREE.BoxGeometry(1.95, 0.174, gap), topTread.material);
      bridge.name = "stair-landing-bridge";
      bridge.position.set(topTread.position.x, topTread.position.y, (TOP_TREAD_EDGE + UPPER_LANDING_EDGE) * 0.5);
      bridge.receiveShadow = true;
      ground.add(bridge);
    }

    function connectAtticLanding(second, attic, tread) {
      var landing = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.13, 1.05), tread.material);
      landing.name = "attic-landing-step";
      landing.position.set(9.27, 7.185, -3.45);
      landing.receiveShadow = true;
      second.add(landing);
      var bridge = new THREE.Mesh(new THREE.BoxGeometry(0.84, 0.24, 1.18), tread.material);
      bridge.name = "attic-landing-bridge";
      bridge.position.set(9.65, 7.13, -3.39);
      bridge.receiveShadow = true;
      attic.add(bridge);
    }

    function buildUpperHallway(layout, floor) {
      var planks = new THREE.MeshStandardMaterial({ color: 0x9b6743, roughness: 0.92 });
      var trim = new THREE.MeshStandardMaterial({ color: 0x613b2a, roughness: 0.85 });
      function piece(name, x, y, z, w, h, d, material) {
        var mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
        mesh.name = name;
        mesh.position.set(x, y, z);
        floor.add(mesh);
      }

      var left = layout.x[0];
      var right = layout.x[1];
      var back = layout.z[0];
      var front = layout.z[1];
      var y = layout.height;
      var width = right - left;
      var depth = front - back;
      var plankCount = Math.ceil(width / 0.48);
      var plankWidth = width / plankCount;
      for (var i = 0; i < plankCount; i += 1) {
        piece("hallway-plank", left + (i + 0.5) * plankWidth, y - 0.105, (back + front) / 2,
          plankWidth - 0.012, 0.22, depth, planks);
      }
      piece("hallway-edge", (left + right) / 2, y + 0.06, front, width, 0.13, 0.10, trim);
      layout.rooms.forEach(function (room, index) {
        buildRoomFront(layout, room, floor, index);
      });
    }

    function buildRoomFront(layout, room, floor, index) {
      var group = new THREE.Group();
      var facade = new THREE.Group();
      group.name = "upper-room-" + (layout.floor + 1) + "-" + (index + 1);
      facade.name = group.name + "-facade";
      group.add(facade);
      floor.add(group);
      var y = layout.height;
      var z = layout.z[0];
      var left = room.x[0];
      var right = room.x[1];
      var doorHeight = layout.doorHeight;
      var doorHalfWidth = layout.floor === 2 ? 0.77 : 0.85;
      var wall = new THREE.MeshStandardMaterial({ color: room.color, roughness: 0.94, side: THREE.DoubleSide });
      var leaf = new THREE.MeshStandardMaterial({ color: 0x875a3d, roughness: 0.81 });
      var handle = new THREE.MeshStandardMaterial({ color: 0xc99b51, roughness: 0.48, metalness: 0.34 });

      function top(x) {
        if (layout.floor === 1) return 3.38;
        return Math.min(2.88, (12.50 - Math.abs(x)) * 0.685);
      }

      function panel(start, end, bottom) {
        var spans = [start];
        [-8.30, 8.30].forEach(function (eave) {
          if (start < eave && eave < end) spans.push(eave);
        });
        spans.push(end);
        var shape = new THREE.Shape();
        shape.moveTo(start, bottom);
        shape.lineTo(end, bottom);
        spans.reverse().forEach(function (x) { shape.lineTo(x, top(x)); });
        shape.closePath();
        var panelMesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), wall);
        panelMesh.position.set(0, y, z);
        facade.add(panelMesh);
      }

      function box(parent, x, height, depth, width, h, d, material) {
        var mesh = new THREE.Mesh(new THREE.BoxGeometry(width, h, d), material);
        mesh.position.set(x, y + height, z + depth);
        parent.add(mesh);
        return mesh;
      }

      var doorX = (left + right) / 2;
      var doorLeft = doorX - doorHalfWidth;
      var doorRight = doorX + doorHalfWidth;
      panel(left, doorLeft, 0);
      panel(doorLeft, doorRight, doorHeight);
      panel(doorRight, right, 0);
      var door = box(facade, doorX, doorHeight / 2, 0, doorHalfWidth * 2, doorHeight, 0.10, leaf);
      door.name = "room-door";
      box(facade, doorX + doorHalfWidth - 0.20, doorHeight * 0.46, 0.08, 0.13, 0.10, 0.08, handle);
      if (layout.floor === 2 || index === 0) {
        box(group, left, top(left) / 2, (layout.roomBack - z) / 2,
          0.1, top(left), z - layout.roomBack, wall.clone());
      }
      if (index === layout.rooms.length - 1) {
        box(group, right, top(right) / 2, (layout.roomBack - z) / 2,
          0.1, top(right), z - layout.roomBack, wall.clone());
      }

      [wall, leaf, handle].forEach(function (material) {
        material.transparent = true;
        material.alphaTest = 0.001;
      });
      facade.children.forEach(function (item) { item.renderOrder = 1; });
      upperRooms.set(facade, {
        layout: layout, x: room.x, roomId: "upper-room-" + (layout.floor + 1) + "-" + (index + 1),
        door: door, doorX: doorX, doorHalfWidth: doorHalfWidth, doorAmount: 0,
        materials: new Set(), amount: 1, occupied: false
      });
    }

    function occupiedRoom(position) {
      for (var room of upperRooms.values()) {
        var layout = room.layout;
        if (Math.abs(layout.height - position.y) < 0.00001 &&
          room.x[0] < position.x && position.x < room.x[1] &&
          layout.roomBack <= position.z && position.z < layout.z[0]) return room;
      }
    }

    function updateRoomFronts(dt) {
      upperRooms.forEach(function (room) { room.occupied = false; });
      if (worldHomeMode && worldHomeTimeline && worldHomeTimeline.snapshot()) {
        worldHomeTimeline.snapshot().actors.forEach(function (actor) {
          upperRooms.forEach(function (room) {
            if (actor.room_id === room.roomId) room.occupied = true;
          });
        });
      } else if (!worldHomeMode) {
        residents.forEach(function (resident) {
          var room = occupiedRoom(resident.position);
          if (room) room.occupied = true;
        });
      }
      upperRooms.forEach(function (room, facade) {
        var target = room.occupied ? 0.13 : 1;
        var step = dt * 4.2;
        room.amount += clamp(target - room.amount, -step, step);
        var opacity = room.amount * floorOpacity(room.layout.floor);
        facade.userData.occupied = room.occupied;
        var doorTarget = worldHomeMode && worldHomeDoorPassing(room) ? 1 : 0;
        room.doorAmount += clamp(doorTarget - room.doorAmount, -dt * 4.5, dt * 4.5);
        room.door.rotation.y = Math.PI * 0.48 * room.doorAmount;
        room.door.userData.measuredRoutePassing = doorTarget === 1;
        room.materials.forEach(function (material) {
          material.opacity = opacity;
          material.depthWrite = opacity >= 0.999;
        });
      });
    }

    function worldHomeDoorPassing(room) {
      if (!worldHomeTimeline || !room || !room.door) return false;
      var snapshot = worldHomeTimeline.snapshot();
      if (!snapshot) return false;
      var now = currentTime();
      return snapshot.actors.some(function (actor) {
        if (actor.active_kind !== "move" || !Array.isArray(actor.move_points)) return false;
        var sample = worldHomeTimeline.sample(actor.id, now);
        if (!sample || !sample.moving) return false;
        var start = actor.move_points[sample.segmentIndex];
        var end = actor.move_points[sample.segmentIndex + 1];
        if (!start || !end) return false;
        var doorZ = room.layout.z[0];
        var dz = end[2] - start[2];
        if (Math.abs(dz) < 0.000001 || (start[2] - doorZ) * (end[2] - doorZ) > 0) return false;
        var fraction = (doorZ - start[2]) / dz;
        if (fraction < 0 || fraction > 1) return false;
        var crossingX = start[0] + (end[0] - start[0]) * fraction;
        var crossingY = start[1] + (end[1] - start[1]) * fraction;
        if (Math.abs(crossingX - room.doorX) > room.doorHalfWidth || crossingY < room.layout.height || crossingY > room.layout.height + room.layout.doorHeight) return false;
        return Math.hypot(sample.position[0] - crossingX, sample.position[2] - doorZ) < 1.15;
      });
    }

    function updateHallwayLabel(resident, position, opacity) {
      if (worldHomeMode) {
        if (resident.locationLabel) resident.locationLabel.visible = false;
        return;
      }
      var room = occupiedRoom(position);
      var hallway = (metadata.upperHallways || []).find(function (layout) {
        return Math.abs(layout.height - position.y) < 0.00001 &&
          position.x >= layout.x[0] && position.x <= layout.x[1] &&
          position.z >= layout.z[0] && position.z <= layout.z[1];
      });
      var layout = room ? room.layout : hallway;
      if (!layout || opacity < 0.5) {
        if (resident.locationLabel) resident.locationLabel.visible = false;
        return;
      }
      var inHall = !room;
      var text = (layout.floor + 1) + "F " + (inHall ? "廊下" : "在室");
      if (!hallwayLabels.has(text)) {
        var badge = global.document.createElement("canvas");
        badge.width = 192;
        badge.height = 58;
        var ctx = badge.getContext("2d");
        ctx.fillStyle = inHall ? "#234756" : "#693a26";
        ctx.beginPath();
        ctx.roundRect(1, 1, 190, 56, 16);
        ctx.fill();
        ctx.strokeStyle = "#ffdfa9";
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.fillStyle = "#fff1d9";
        ctx.font = "bold 34px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(text, 96, 31);
        var texture = new THREE.CanvasTexture(badge);
        texture.colorSpace = THREE.SRGBColorSpace;
        hallwayLabels.set(text, texture);
      }
      if (!resident.locationLabel) {
        var label = new THREE.Sprite(new THREE.SpriteMaterial({
          transparent: true, depthWrite: false, toneMapped: false, map: hallwayLabels.get(text)
        }));
        label.name = "resident-location-" + resident.id;
        label.renderOrder = 5;
        label.position.set(0, resident.height + 0.21, 0);
        label.scale.set(1.38, 0.42, 1);
        resident.group.add(label);
        resident.locationLabel = label;
      }
      resident.locationLabel.material.map = hallwayLabels.get(text);
      resident.locationLabel.material.opacity = opacity;
      resident.locationLabel.visible = true;
    }

    function onModelLoaded(gltf) {
      try {
        var loadedRoot = gltf.scene;
        var loadedGround = loadedRoot.getObjectByName("RC_GROUND");
        var loadedSecond = loadedRoot.getObjectByName("RC_SECOND");
        var loadedAttic = loadedRoot.getObjectByName("RC_ATTIC");
        if (!loadedGround || !loadedSecond || !loadedAttic) {
          throw new Error("HOUSE_105の階層名（RC_GROUND / RC_SECOND / RC_ATTIC）が見つかりません。");
        }
        root = loadedRoot;
        groundRoot = loadedGround;
        secondRoot = loadedSecond;
        atticRoot = loadedAttic;
        var groundNodes = arrangeFloor(groundRoot, metadata.groundLayout);
        extendGroundFloor(groundNodes);
        if (motionEnabled) {
          root.updateMatrixWorld(true);
          registerSeats(groundNodes);
        }
        var secondNodes = arrangeFloor(secondRoot, metadata.secondLayout);
        arrangeFloor(atticRoot, metadata.atticLayout);
        if (metadata.stairTrip) connectStairLanding(groundRoot);
        if (metadata.atticTrip) connectAtticLanding(secondRoot, atticRoot, secondNodes.get("Attic stair step.016_v4"));
        (metadata.upperHallways || []).forEach(function (layout) {
          buildUpperHallway(layout, layout.floor === 1 ? secondRoot : atticRoot);
        });
        prepareUpperFade(secondRoot, secondFadeMaterials);
        prepareUpperFade(atticRoot, atticFadeMaterials);
        root.name = root.name || "HOUSE_105";
        scene.add(root);
        optimizeRoomGeometry();
        modelBounds.setFromObject(root);
        groundBounds.setFromObject(groundRoot);
        if (modelBounds.isEmpty() || groundBounds.isEmpty()) throw new Error("HOUSE_105のメッシュが空です。");
        var avatarHeight = clamp(modelBounds.getSize(new THREE.Vector3()).y / 8, 0.75, 1.8);
        residents.forEach(function (resident) {
          resident.height = avatarHeight;
          if (resident.mesh) resizeResidentMesh(resident);
          else buildResidentMesh(resident);
        });
        configureRoomLighting(modelBounds);
        countModelResources(root);
        houseProjection = projectedBounds(root, housePosition, houseTarget);
        livingProjection = projectedBounds(groundRoot, livingPosition, livingTarget);
        updateFraming(viewportWidth / viewportHeight);
        modelLoaded = true;
        loadFailed = false;
        statusSummary = "loaded";
        if (failedImageCount && imageCount + failedImageCount >= expectedImages) {
          setStatus("一部の住人画像を読み込めませんでした（" + imageCount + "/" + expectedImages + "）。");
        } else {
          setStatus("");
        }
        renderer.shadowMap.needsUpdate = true;
        refreshMarkers();
      } catch (error) {
        console.error("HOUSE_105 model setup failed", error);
        showUnavailable("HOUSE_105を読み込めませんでした。モデルの階層とGLBデータを確認してください。");
      }
    }

    function loadModel() {
      try {
        if (typeof global.fetch !== "function") throw new Error("fetch is unavailable");
        var loader = new GLTFLoader();
        global.fetch(ASSET_ROOT + "house-105.glb?sha256=" + encodeURIComponent(options.houseSha256 || ""), { credentials: "same-origin", cache: "force-cache" })
          .then(function (response) {
            if (!response.ok) throw new Error("HOUSE_105 GLB request failed: " + response.status);
            return response.arrayBuffer();
          })
          .then(function (data) {
            houseAssetVerified = Boolean(global.houseWorldHome && options.houseAssetVerified &&
              String(options.houseSha256 || "").toLowerCase() === global.houseWorldHome.houseSHA256);
            loader.parse(data, ASSET_ROOT, onModelLoaded, function (error) {
              console.error("HOUSE_105 GLB parse failed", error);
              showUnavailable("HOUSE_105を読み込めませんでした。GLBデータを確認してください。");
            });
          })
          .catch(function (error) {
            console.error("HOUSE_105 GLB fetch failed", error);
            showUnavailable("HOUSE_105を読み込めませんでした。GLBファイルを確認してください。");
        });
      } catch (error) {
        console.error("HOUSE_105 load failed", error);
        showUnavailable("HOUSE_105を読み込めませんでした。GLBファイルを確認してください。");
      }
    }

    function updateResidentWorldPositions() {
      if (worldHomeMode) {
        residents.forEach(function (resident) {
          var sample = worldHomeTimeline && worldHomeTimeline.sample(resident.id, currentTime());
          if (!sample || !modelLoaded || !houseAssetVerified) {
            resident.group.visible = false;
            if (resident.locationLabel) resident.locationLabel.visible = false;
            return;
          }
          var actor = sample.actor;
          var position = new THREE.Vector3().fromArray(sample.position);
          resident.group.position.copy(position);
          if (sample.tangent.some(function (value) { return Math.abs(value) > 0.000001; })) {
            resident.lastTangent.set(sample.tangent[0], sample.tangent[1], sample.tangent[2]);
          }
          resident.direction = directionFor(resident.lastTangent || new THREE.Vector3(0, 0, 1), resident.direction);
          var opacity = residentOpacity(resident, position);
          resident.group.visible = opacity > 0.001 && Boolean(resident.mesh);
          if (resident.mesh) {
            resident.mesh.quaternion.copy(camera.quaternion);
            if (actor.active_kind === "sleep" && imageTextures[resident.id] && imageTextures[resident.id].sleep) {
              setSpriteTexture(resident, imageTextures[resident.id].sleep);
              resident.mesh.position.y = 0;
              resident.walking = false;
            } else {
              updateSpriteTexture(resident, resident.direction, sample.moving ? sample.distance : null);
              resident.walking = Boolean(sample.moving);
            }
            resident.mesh.material.opacity = resident.spriteOpacity * opacity;
          }
          if (resident.highlight) resident.highlight.material.opacity = resident.highlightOpacity * opacity;
          if (resident.locationLabel) resident.locationLabel.visible = false;
        });
        return;
      }
      residents.forEach(function (resident) {
        var state = pathState(resident);
        var position = state.position;
        resident.lastTangent = state.tangent.clone();
        resident.group.position.copy(position);
        resident.group.position.y += state.footLift;
        resident.direction = directionFor(state.tangent, resident.direction);
        var opacity = residentOpacity(resident, position);
        resident.group.visible = opacity > 0.001 && (!demonstration || (resident.id !== demonstration.id && resident.id !== demonstration.guest?.id));
        if (resident.mesh) resident.mesh.material.opacity = resident.spriteOpacity * opacity;
        if (resident.highlight) resident.highlight.material.opacity = resident.highlightOpacity * opacity;
        if (resident.mesh) {
          resident.mesh.quaternion.copy(camera.quaternion);
          var walkDistance = resident.walking ? resident.walkDistance : null;
          updateSpriteTexture(resident, resident.direction, walkDistance);
        }
        updateHallwayLabel(resident, position, opacity);
      });
    }

    function hideHeartbeatBubbles() {
      heartbeatBubbleNodes.forEach(function (bubble) { bubble.root.hidden = true; });
    }

    function updateHeartbeatBubblePositions() {
      if (!heartbeatBubbleLayer) return;
      var bounds = canvas.getBoundingClientRect();
      if (!bounds.width || !bounds.height || view !== "living") {
        hideHeartbeatBubbles();
        return;
      }
      var candidates = [];
      heartbeatBubbleNodes.forEach(function (bubble, id) {
        var resident = residentsById.get(id);
        if (!heartbeatBubbleContent.has(id) || !resident || !resident.group.visible || !resident.mesh || resident.mesh.material.opacity < 0.5) {
          bubble.root.hidden = true;
          return;
        }
        var anchor = new THREE.Vector3(0, resident.height + 0.75, 0);
        resident.group.localToWorld(anchor);
        anchor.project(camera);
        var left = (anchor.x + 1) * bounds.width / 2;
        var top = (1 - anchor.y) * bounds.height / 2;
        if (anchor.z < -1 || anchor.z > 1 || left < 0 || left > bounds.width || top < 0 || top > bounds.height) {
          bubble.root.hidden = true;
          return;
        }
        bubble.root.hidden = false;
        candidates.push({
          bubble: bubble,
          left: left,
          top: top,
          width: bubble.root.offsetWidth || 104,
          height: bubble.root.offsetHeight || 28
        });
      });
      candidates.sort(function (a, b) { return a.top - b.top || a.left - b.left; });
      var placed = [];
      candidates.forEach(function (candidate) {
        var top = candidate.top;
        var lift = 0;
        var tries = 0;
        function overlapsPlaced() {
          var box = { left: candidate.left - candidate.width / 2, top: top - candidate.height - 8, right: candidate.left + candidate.width / 2, bottom: top - 8 };
          return placed.some(function (other) {
            return box.left < other.right + 3 && box.right > other.left - 3 && box.top < other.bottom + 3 && box.bottom > other.top - 3;
          });
        }
        while (overlapsPlaced() && tries < 4 && top - candidate.height - 8 > 4) {
          top -= candidate.height + 4;
          lift += candidate.height + 4;
          tries += 1;
        }
        if (overlapsPlaced()) {
          top = candidate.top;
          lift = 0;
        }
        candidate.bubble.root.style.left = candidate.left + "px";
        candidate.bubble.root.style.top = top + "px";
        candidate.bubble.root.style.setProperty("--scene-heartbeat-bubble-stem", lift ? (lift + 8) + "px" : "0px");
        placed.push({
          left: candidate.left - candidate.width / 2,
          right: candidate.left + candidate.width / 2,
          top: top - candidate.height - 8,
          bottom: top - 8
        });
      });
    }

    function setHeartbeatBubbles(items) {
      heartbeatBubbleContent.clear();
      hideHeartbeatBubbles();
      if (!Array.isArray(items)) return;
      items.forEach(function (item) {
        if (!item || typeof item.actor_id !== "string" || !RESIDENT_IDS.includes(item.actor_id) || typeof item.label !== "string") return;
        var bubble = heartbeatBubbleNodes.get(item.actor_id);
        if (!bubble) return;
        var label = item.label.slice(0, 48);
        var title = typeof item.title === "string" ? item.title.trim().slice(0, 120) : "";
        bubble.label.textContent = label;
        bubble.title.textContent = title;
        bubble.title.hidden = title === "";
        bubble.root.setAttribute("aria-label", (item.actor_name || item.actor_id) + ": " + label + (title ? ": " + title : ""));
        heartbeatBubbleContent.set(item.actor_id, true);
      });
    }

    function createMarker(desk, index) {
      var selected = desk.residentId === selectedId || (!selectedId && desk.residentId === "mio");
      var sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: markerTexture(index, selected),
        color: 0xffffff,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        toneMapped: false
      }));
      sprite.name = "seat-marker-" + desk.id;
      sprite.position.copy(desk.position);
      sprite.position.y += 0.46;
      sprite.scale.set(selected ? 0.62 : 0.5, selected ? 0.62 : 0.5, 1);
      sprite.renderOrder = 8;
      sprite.userData = { id: desk.id, residentId: desk.residentId, index: index + 1, anchor: [desk.position.x, desk.position.y, desk.position.z] };
      return sprite;
    }

    function markerTexture(index, selected) {
      var key = index + ":" + (selected ? "selected" : "normal");
      if (markerTextureCache[key]) return markerTextureCache[key];
      var canvas = global.document.createElement("canvas");
      canvas.width = 128;
      canvas.height = 128;
      var context = canvas.getContext("2d");
      if (context) {
        context.clearRect(0, 0, 128, 128);
        context.shadowColor = selected ? "rgba(255,225,145,.9)" : "rgba(255,184,78,.65)";
        context.shadowBlur = selected ? 12 : 7;
        context.beginPath();
        context.arc(64, 64, selected ? 53 : 49, 0, Math.PI * 2);
        context.fillStyle = selected ? "#fff0b4" : "#d89a48";
        context.fill();
        context.shadowBlur = 0;
        context.lineWidth = selected ? 7 : 5;
        context.strokeStyle = selected ? "#fffdf0" : "#ffe3aa";
        context.stroke();
        context.fillStyle = selected ? "#25304b" : "#fff8e8";
        context.font = "900 60px Arial, sans-serif";
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(String(index + 1), 64, 66);
      }
      var texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.premultiplyAlpha = false;
      texture.generateMipmaps = true;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.needsUpdate = true;
      markerTextureCache[key] = texture;
      return texture;
    }

    function refreshMarkers() {
      if (!markerSprites.length) {
        desks.forEach(function (desk, index) {
          var sprite = createMarker(desk, index);
          markerSprites.push(sprite);
          markerGroup.add(sprite);
        });
      }
      markerSprites.forEach(function (sprite, index) {
        var selected = sprite.userData.residentId === selectedId || (!selectedId && sprite.userData.residentId === "mio");
        sprite.material.map = markerTexture(index, selected);
        sprite.material.needsUpdate = true;
        sprite.scale.set(selected ? 0.62 : 0.5, selected ? 0.62 : 0.5, 1);
        sprite.visible = markerOn && modelLoaded && !worldHomeMode;
      });
      markerGroup.visible = markerOn && modelLoaded && !worldHomeMode;
    }

    function screenPoint(point) {
      var projected = point.clone().project(camera);
      return {
        x: (projected.x * 0.5 + 0.5) * viewportWidth,
        y: (-projected.y * 0.5 + 0.5) * viewportHeight,
        depth: projected.z
      };
    }

    function makeSnapshot() {
      var residentMap = Object.create(null);
      residents.forEach(function (resident) {
        var state = pathState(resident);
        var worldSample = worldHomeMode && worldHomeTimeline ? worldHomeTimeline.sample(resident.id, currentTime()) : null;
        var actor = worldSample && worldSample.actor;
        var position = worldSample ? new THREE.Vector3().fromArray(worldSample.position) : state.position;
        var tangent = worldSample && worldSample.moving ? new THREE.Vector3().fromArray(worldSample.tangent) : state.tangent;
        var direction = directionFor(tangent, resident.direction);
        var center = new THREE.Vector3(0, resident.height * (0.5 - SPRITE_FOOT_INSET), 0);
        center.applyQuaternion(camera.quaternion).add(position);
        if (!worldHomeMode) center.y += state.footLift;
        var screen = screenPoint(center);
        var floor = residentFloor(resident, position);
        var opacity = residentOpacity(resident, position);
        var spriteLoaded = Boolean(resident.mesh);
        residentMap[resident.id] = {
          id: resident.id,
          x: position.x,
          y: position.y,
          z: position.z,
          room_id: actor ? actor.room_id : null,
          active_kind: actor ? actor.active_kind : null,
          active_pose: actor ? actor.active_pose : null,
          floor: floor,
          visible: Boolean(modelLoaded && !loadFailed && opacity > 0.001 && spriteLoaded && resident.group.visible && (!worldHomeMode || actor) && screen.depth >= -1 && screen.depth <= 1 && screen.x >= -40 && screen.x <= viewportWidth + 40 && screen.y >= -90 && screen.y <= viewportHeight + 40),
          spriteLoaded: spriteLoaded,
          opacity: opacity,
          direction: direction,
          heading: Math.atan2(tangent.x, tangent.z),
          walkFrame: resident.walking ? resident.walkFrame : null,
          screen: { x: screen.x, y: screen.y }
        };
      });

      var anchors = desks.map(function (desk, index) {
        var point = desk.position.clone();
        var screen = screenPoint(point);
        var resident = residents.find(function (entry) { return entry.id === desk.residentId; });
        return {
          id: desk.id,
          residentId: desk.residentId,
          x: point.x,
          y: point.y,
          z: point.z,
          floor: resident ? resident.floor : null,
          index: index + 1,
          screen: { x: screen.x, y: screen.y }
        };
      });
      var primary = desks.find(function (desk) { return desk.residentId === selectedId; }) || desks.find(function (desk) { return desk.residentId === "mio"; }) || desks[0];
      var primaryScreen = primary ? screenPoint(primary.position) : { x: 0, y: 0 };
      var target = houseTarget.clone().lerp(livingTarget, progress);
      var offset = camera.position.clone().sub(target);
      return {
        view: view,
        progress: progress,
        elapsed: clock,
        residents: residentMap,
        desks: anchors,
        marker: {
          on: markerOn,
          primaryId: primary ? primary.id : null,
          primary: primary ? { id: primary.id, residentId: primary.residentId, x: primary.position.x, y: primary.position.y, z: primary.position.z, screen: { x: primaryScreen.x, y: primaryScreen.y } } : null,
          anchors: anchors
        },
        selectedResident: selectedId,
        motionPreview: motionPreviewState(),
        paused: paused,
        assetsReady: imageCount,
        assetsTotal: expectedImages,
        sceneSource: metadata.source || "HOUSE_105",
        assetCounts: {
          modelLoaded: modelLoaded,
          loadState: statusSummary,
          rootNames: root ? [groundRoot.name, secondRoot.name, atticRoot.name] : [],
          sourceMeshes: sourceMeshCount,
          batchedMeshes: mergedMeshCount,
          triangles: triangleCount,
          drawCalls: renderer.info.render.calls,
          trianglesRendered: renderer.info.render.triangles,
          seatMarkers: desks.length,
          roots: modelCounts.roots,
          meshes: modelCounts.meshes,
          materials: modelCounts.materials,
          textures: modelCounts.textures,
          spriteImagesReady: imageCount,
          spriteImagesFailed: failedImageCount,
          spriteImagesTotal: expectedImages
        },
        camera: {
          position: [camera.position.x, camera.position.y, camera.position.z],
          target: [target.x, target.y, target.z],
          yaw: Math.atan2(offset.x, offset.z),
          pitch: Math.atan2(offset.y, Math.hypot(offset.x, offset.z)),
          scale: 2 / (camera.top - camera.bottom),
          span: camera.top - camera.bottom,
          focus: { x: target.x, y: target.y, z: target.z }
        },
        floors: { ground: 1, second: floorOpacity(1), attic: floorOpacity(2) },
        frame: {
          intervalMs: frameIntervalMs,
          renderMs: lastFrameMs,
          averageRenderMs: averageFrameMs,
          fpsEstimate: frameIntervalMs > 0 ? 1000 / frameIntervalMs : 0
        }
      };
    }

    function draw(dt) {
      resize();
      applyCamera();
      updateRoomFronts(dt);
      updateMotionPreview(paused || worldHomeMode ? 0 : dt);
      updateResidentWorldPositions();
      var renderStart = currentTime();
      renderer.render(scene, camera);
      updateHeartbeatBubblePositions();
      lastFrameMs = currentTime() - renderStart;
      measuredFrames += 1;
      averageFrameMs += (lastFrameMs - averageFrameMs) / measuredFrames;
    }

    function tick(now) {
      if (!lastFrame) lastFrame = now;
      else frameIntervalMs = now - lastFrame;
      var dt = clamp((now - lastFrame) / 1000, 0, 0.06);
      lastFrame = now;
      clock += dt;
      if (!paused && !worldHomeMode) advanceResidents(dt);
      advanceProgress(dt);
      draw(dt);
      global.requestAnimationFrame(tick);
    }

    function setView(next) {
      next = next === "living" ? "living" : "house";
      var target = next === "living" ? 1 : 0;
      if (next === view && progressTarget === target) return;
      view = next;
      progressTarget = target;
      if (view !== "living") hideHeartbeatBubbles();
      if (!cameraMotionEnabled) {
        progress = progressTarget;
        progressVelocity = 0;
        applyCamera();
        updateResidentWorldPositions();
      }
    }

    function setCameraMotionEnabled(enabled) {
      cameraMotionEnabled = Boolean(enabled);
      if (!cameraMotionEnabled) {
        progress = progressTarget;
        progressVelocity = 0;
        applyCamera();
        updateResidentWorldPositions();
      }
    }

    function selectResident(id) {
      if (id == null || id === "") selectedId = null;
      else selectedId = residents.some(function (resident) { return resident.id === id; }) ? id : null;
      residents.forEach(function (resident) { resident.highlight.visible = resident.id === selectedId; });
      refreshMarkers();
    }

    function setPaused(value) {
      paused = Boolean(value);
    }

    function setMarker(value) {
      markerOn = Boolean(value);
      refreshMarkers();
    }

    function setWorldHomeMode(value) {
      var enabled = Boolean(value);
      if (enabled === worldHomeMode) return true;
      worldHomeMode = enabled;
      if (enabled) {
        if (demonstration) stopMotionPreview();
        worldHomeTimeline = global.houseWorldHome ? global.houseWorldHome.createTimeline() : null;
        residents.forEach(function (resident) { resident.group.visible = false; });
      } else {
        worldHomeTimeline = global.houseWorldHome ? global.houseWorldHome.createTimeline() : null;
        updateResidentWorldPositions();
      }
      refreshMarkers();
      return Boolean(worldHomeTimeline);
    }

    function setWorldHomeSnapshot(snapshot) {
      if (!worldHomeMode || !houseAssetVerified || !modelLoaded || !worldHomeTimeline) return false;
      try {
        worldHomeTimeline.accept(snapshot, currentTime());
      } catch (error) {
        return false;
      }
      return true;
    }

    function worldHomeReady() {
      return Boolean(worldHomeTimeline && modelLoaded && houseAssetVerified && !loadFailed);
    }

    function snapshot() {
      return makeSnapshot();
    }

    resize();
    applyCamera();
    if (typeof global.requestAnimationFrame === "function") global.requestAnimationFrame(tick);
    loadSprites();
    loadModel();

    return {
      setView: setView,
      setCameraMotionEnabled: setCameraMotionEnabled,
      setPaused: setPaused,
      selectResident: selectResident,
      setMarker: setMarker,
      setHeartbeatBubbles: setHeartbeatBubbles,
      startMotionPreview: startMotionPreview,
      stopMotionPreview: stopMotionPreview,
      seekMotionPreview: seekMotionPreview,
      setMotionCloseView: setMotionCloseView,
      motionPreviewState: motionPreviewState,
      setWorldHomeMode: setWorldHomeMode,
      setWorldHomeSnapshot: setWorldHomeSnapshot,
      worldHomeReady: worldHomeReady,
      snapshot: snapshot
    };
  }

  global.createHouseScene = createHouseScene;
})(typeof window !== "undefined" ? window : globalThis);
