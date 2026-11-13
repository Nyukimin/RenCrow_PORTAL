(function (global) {
  "use strict";

  var RESIDENT_IDS = ["mio", "shiro", "kuro", "midori", "aka", "ao", "kin", "gin"];
  var DIRECTIONS = ["front", "left", "right", "back"];
  var NAVY = 0x111e36;
  var ASSET_ROOT = "/assets/living/assets/";
  // Each directional image has a two-pixel transparent strip below the feet.
  var SPRITE_FOOT_INSET = 2 / 320;
  var TOP_TREAD_EDGE = -2.455;
  var UPPER_LANDING_EDGE = -2.725;

  function createHouseScene(canvas, options) {
    options = options || {};
    if (!canvas || typeof canvas.getBoundingClientRect !== "function") {
      throw new TypeError("createHouseScene expects a canvas element");
    }

    var THREE = global.THREE;
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

    var residents = metadata.residents.map(function (resident, index) {
      var route = resident && (resident.route ? metadata.routes && metadata.routes[resident.route] : resident.points);
      if (!resident || !resident.id || !Array.isArray(route) || route.length < 2) {
        throw new Error("HOUSE_105の住人経路データが不完全です。");
      }
      if (![0, 1, 2].includes(Number(resident.floor))) throw new Error("HOUSE_105の住人フロアが不正です。");
      if (resident.stairs && metadata.stairTrip) route = addStairTrip(route, metadata.stairTrip);
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
      return {
        id: resident.id,
        floor: Number(resident.floor),
        landingHeight: resident.stairs && metadata.stairTrip ? metadata.stairTrip.landing[0][1] : Infinity,
        points: points,
        lengths: lengths,
        totalLength: Math.max(totalLength, 0.001),
        phase: resident.phase === undefined ? index / metadata.residents.length : resident.phase,
        speed: resident.pace > 0 ? resident.pace / Math.max(totalLength, 0.001) : 0.075 + (index % 4) * 0.012,
        group: new THREE.Group(),
        mesh: null,
        highlight: null,
        height: 1.35
      };
    });

    function addStairTrip(route, stairs) {
      var entryIndex = route.findIndex(function (point, index) {
        var next = route[index + 1];
        return next && point[2] === stairs.entry[2] && next[2] === stairs.entry[2] &&
          point[0] > stairs.entry[0] && next[0] < stairs.entry[0];
      });
      if (entryIndex < 0) throw new Error("HOUSE_105の階段入口が見つかりません。");

      var ascent = [stairs.entry];
      var height = stairs.entry[1];
      for (var step = 0; step < stairs.steps; step += 1) {
        var z = stairs.firstEdge - stairs.treadDepth * step;
        ascent.push([stairs.entry[0], height, z]);
        height = stairs.firstHeight + stairs.riserHeight * step;
        ascent.push([stairs.entry[0], height, z]);
      }
      ascent = ascent.concat(stairs.landing);
      return route.slice(0, entryIndex + 1).concat(ascent, ascent.slice(0, -1).reverse(), route.slice(entryIndex + 1));
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

    var imageCount = 0;
    var failedImageCount = 0;
    var expectedImages = RESIDENT_IDS.length * DIRECTIONS.length;
    var imageTextures = Object.create(null);
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
    var residentClock = 0;
    var lastFrame = 0;
    var paused = false;
    var markerOn = false;
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

    function pathState(resident, time) {
      var distance = ((time * resident.speed + resident.phase) % 1) * resident.totalLength;
      var chosen = null;
      for (var i = 0; i < resident.points.length; i += 1) {
        var startDistance = resident.lengths[i];
        var endDistance = resident.lengths[i + 1];
        if (distance < endDistance || i === resident.points.length - 1) {
          var span = Math.max(0.0001, endDistance - startDistance);
          var amount = clamp((distance - startDistance) / span, 0, 1);
          var from = resident.points[i];
          var to = resident.points[(i + 1) % resident.points.length];
          var tangent = to.clone().sub(from);
          if (tangent.x === 0 && tangent.z === 0) {
            // A riser is vertical. Use the next tread to keep facing uphill or downhill even after a pause.
            tangent = resident.points[(i + 2) % resident.points.length].clone().sub(to);
          }
          chosen = { position: from.clone().lerp(to, amount), tangent: tangent };
          break;
        }
      }
      if (!chosen) chosen = { position: resident.points[0].clone(), tangent: new THREE.Vector3() };
      chosen.tangent.y = 0;
      if (chosen.tangent.lengthSq() > 0.000001) {
        chosen.tangent.normalize();
      } else {
        // A pause or a degenerate route segment keeps the last meaningful heading.
        chosen.tangent.copy(resident.lastTangent || new THREE.Vector3(0, 0, 1));
      }
      return chosen;
    }

    function residentFloor(resident, position) {
      return position.y >= resident.landingHeight - 0.00001 && position.z <= UPPER_LANDING_EDGE ? 1 : resident.floor;
    }

    function residentOpacity(resident, position) {
      if (position.y < resident.landingHeight - 0.00001) return floorOpacity(resident.floor);
      return lerp(1, floorOpacity(1), smooth((TOP_TREAD_EDGE - position.z) / (TOP_TREAD_EDGE - UPPER_LANDING_EDGE)));
    }

    function directionFor(tangent) {
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
      if (Math.abs(rightDot) > Math.abs(observerDot)) return rightDot >= 0 ? "right" : "left";
      return observerDot >= 0 ? "front" : "back";
    }

    function nearestAvailableTexture(residentId, direction) {
      var directions = [direction, "front", "left", "right", "back"];
      var seen = Object.create(null);
      for (var i = 0; i < directions.length; i += 1) {
        var candidate = directions[i];
        if (seen[candidate]) continue;
        seen[candidate] = true;
        if (imageTextures[residentId] && imageTextures[residentId][candidate]) return imageTextures[residentId][candidate];
      }
      return null;
    }

    function updateSpriteTexture(resident, direction) {
      if (!resident.mesh) return;
      var texture = nearestAvailableTexture(resident.id, direction);
      if (!texture || resident.mesh.material.map === texture) return;
      resident.mesh.material.map = texture;
      resident.mesh.material.needsUpdate = true;
      resizeResidentMesh(resident);
    }

    function resizeResidentMesh(resident) {
      var image = resident.mesh.material.map.image;
      var aspect = image && image.naturalWidth && image.naturalHeight ? image.naturalWidth / image.naturalHeight : 1;
      resident.mesh.scale.set(resident.height * aspect, resident.height, 1);
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
        DIRECTIONS.forEach(function (direction) {
          var key = id + "-" + direction;
          var image = new global.Image();
          image.onload = function () {
            imageCount += 1;
            var texture = new THREE.Texture(image);
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.flipY = true;
            texture.premultiplyAlpha = false;
            texture.generateMipmaps = true;
            texture.minFilter = THREE.LinearMipmapLinearFilter;
            texture.magFilter = THREE.LinearFilter;
            texture.needsUpdate = true;
            imageTextures[id][direction] = texture;
            var resident = residents.find(function (entry) { return entry.id === id; });
            if (resident) {
              buildResidentMesh(resident);
              if (resident.mesh) updateSpriteTexture(resident, resident.direction || "front");
            }
            finishImageLoad();
          };
          image.onerror = function () {
            failedImageCount += 1;
            finishImageLoad();
          };
          image.src = ASSET_ROOT + key + ".webp";
        });
      });
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
      });
    }

    function countModelResources(object) {
      var materialSet = new Set();
      var textureSet = new Set();
      var meshes = 0;
      object.traverse(function (item) {
        if (!item.isMesh) return;
        meshes += 1;
        item.castShadow = true;
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

    function arrangeGroundFloor(ground) {
      var nodes = new Map();
      ground.traverse(function (node) {
        if (node.userData.name) nodes.set(node.userData.name, node);
      });
      (metadata.groundLayout || []).forEach(function (group) {
        group.objects.forEach(function (name) {
          var node = nodes.get(name);
          if (!node || node.parent !== ground) {
            throw new Error("HOUSE_105の家具を配置できません: " + name);
          }
          node.position.x += group.offset[0];
          node.position.y += group.offset[1];
          node.position.z += group.offset[2];
        });
      });

      extendGroundFloor(nodes);
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
        arrangeGroundFloor(groundRoot);
        if (metadata.stairTrip) connectStairLanding(groundRoot);
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
        global.fetch(ASSET_ROOT + "house-105.glb", { credentials: "same-origin" })
          .then(function (response) {
            if (!response.ok) throw new Error("HOUSE_105 GLB request failed: " + response.status);
            return response.arrayBuffer();
          })
          .then(function (data) {
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
      residents.forEach(function (resident) {
        var state = pathState(resident, residentClock);
        var position = state.position;
        resident.lastTangent = state.tangent.clone();
        resident.group.position.copy(position);
        resident.direction = directionFor(state.tangent);
        var opacity = residentOpacity(resident, position);
        resident.group.visible = opacity > 0.001;
        if (resident.mesh) resident.mesh.material.opacity = resident.spriteOpacity * opacity;
        if (resident.highlight) resident.highlight.material.opacity = resident.highlightOpacity * opacity;
        if (resident.mesh) {
          resident.mesh.quaternion.copy(camera.quaternion);
          updateSpriteTexture(resident, resident.direction);
        }
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
        sprite.visible = markerOn && modelLoaded;
      });
      markerGroup.visible = markerOn && modelLoaded;
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
        var state = pathState(resident, residentClock);
        var position = state.position;
        var direction = directionFor(state.tangent);
        var center = new THREE.Vector3(0, resident.height * (0.5 - SPRITE_FOOT_INSET), 0);
        var screen = screenPoint(center.applyQuaternion(camera.quaternion).add(position));
        var floor = residentFloor(resident, position);
        var opacity = residentOpacity(resident, position);
        var spriteLoaded = Boolean(resident.mesh);
        residentMap[resident.id] = {
          id: resident.id,
          x: position.x,
          y: position.y,
          z: position.z,
          floor: floor,
          visible: Boolean(modelLoaded && !loadFailed && opacity > 0.001 && spriteLoaded && screen.depth >= -1 && screen.depth <= 1 && screen.x >= -40 && screen.x <= viewportWidth + 40 && screen.y >= -90 && screen.y <= viewportHeight + 40),
          spriteLoaded: spriteLoaded,
          opacity: opacity,
          direction: direction,
          heading: Math.atan2(state.tangent.x, state.tangent.z),
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

    function draw() {
      resize();
      applyCamera();
      updateResidentWorldPositions();
      var renderStart = currentTime();
      renderer.render(scene, camera);
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
      if (!paused) residentClock += dt;
      advanceProgress(dt);
      draw();
      global.requestAnimationFrame(tick);
    }

    function setView(next) {
      next = next === "living" ? "living" : "house";
      var target = next === "living" ? 1 : 0;
      if (next === view && progressTarget === target) return;
      view = next;
      progressTarget = target;
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
      snapshot: snapshot
    };
  }

  global.createHouseScene = createHouseScene;
})(typeof window !== "undefined" ? window : globalThis);
