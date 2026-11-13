(function (global) {
  "use strict";

  const directions = ["front", "front-right", "right", "back-right", "back", "back-left", "left", "front-left"];
  const cardinal = ["front", "right", "back", "left"];
  const angleStep = Math.PI / 4;
  const footLine = 318;
  const beats = {
    mio: [.64, .19, .031], shiro: [.62, .23, .038], kuro: [.65, .20, .030], midori: [.67, .17, .028], lumina: [.66, .17, .028],
    aka: [.66, .15, .033], gin: [.73, .26, .029], kin: [.80, .15, .019], ao: [.74, .24, .024]
  };
  const quadrupeds = new Set(["gin", "kin", "ao"]);
  const phases = { gin: [0, .50, .73, .23], kin: [0, .50, .81, .31], ao: [0, .50, .67, .17] };
  // Pixel centres measured on the original 320 px sprites, ordered left to right.
  const feet = {
    mio: [[100, 126], [110, 130], [102, 129], [59, 79]],
    shiro: [[69, 112], [112, 135], [71, 121], [52, 73]],
    kuro: [[80, 126], [95, 117], [70, 114], [65, 87]],
    midori: [[83, 109], [96, 111], [85, 114], [52, 71]],
    lumina: [[66, 94], null, null, null],
    aka: [[93, 157], [177, 208], [92, 160], [41, 65]],
    gin: [[36, 85, 136, 197], [66, 113, 221, 247], [36, 103, 141, 190], [35, 63, 145, 226]],
    kin: [[32, 58, 167, 213], [65, 87, 203, 238], [40, 85, 170, 216], [53, 87, 214, 249]],
    ao: [[40, 56, 114, 139], [129, 157, 236, 255], [55, 89, 142, 170], [42, 65, 143, 170]]
  };

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const smooth = t => t * t * (3 - 2 * t);
  const wrap = x => x - Math.floor(x);

  function facing(right, front, previous) {
    if (Math.hypot(right, front) < 1e-6) return previous || "front";
    const angle = Math.atan2(right, front);
    const index = directions.indexOf(previous);
    if (index >= 0) {
      const delta = angle - index * angleStep;
      if (Math.abs(Math.atan2(Math.sin(delta), Math.cos(delta))) < angleStep * .56) return previous;
    }
    return directions[(Math.round(angle / angleStep) + 8) % 8];
  }

  function fallback(view) {
    if (cardinal.includes(view)) return view;
    return view.startsWith("back") ? "back" : "front";
  }

  function step(phase, duty, stride, lift) {
    const p = wrap(phase);
    if (p < duty) return { stride: stride * (duty / 2 - p), lift: 0 };
    const air = (p - duty) / (1 - duty);
    return { stride: stride * duty * (smooth(air) - .5), lift: lift * Math.sin(Math.PI * air) };
  }

  function canvas(width, height) {
    const result = global.document.createElement("canvas");
    result.width = width;
    result.height = height;
    return result.getContext("2d");
  }

  function footCenters(context, width, height, count) {
    const top = height - 18;
    const data = context.getImageData(0, top, width, height - top).data;
    const spans = [];
    let start = -1;
    for (let x = 0; x <= width; x += 1) {
      let visible = false;
      for (let y = 0; x < width && y < height - top; y += 1) {
        if (data[(y * width + x) * 4 + 3] > 130) { visible = true; break; }
      }
      if (visible && start < 0) start = x;
      if (!visible && start >= 0) {
        if (x - start > 3) spans.push([start, x]);
        start = -1;
      }
    }
    if (!spans.length) return Array.from({ length: count }, (_, index) => width * (.34 + .32 * index / Math.max(1, count - 1)));
    if (spans.length >= count) return spans.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0])).slice(0, count)
      .map(([a, b]) => (a + b) / 2).sort((a, b) => a - b);
    return Array.from({ length: count }, (_, index) => {
      const left = spans[0][0], right = spans.at(-1)[1];
      return left + (right - left) * (index + .5) / count;
    });
  }

  function prepare(image, id, view) {
    const width = image.naturalWidth, height = image.naturalHeight;
    const body = canvas(width, height);
    body.drawImage(image, 0, 0);
    const source = canvas(width, height);
    source.drawImage(image, 0, 0);
    const four = quadrupeds.has(id);
    const centres = feet[id][cardinal.indexOf(view)] || footCenters(body, width, height, four ? 4 : 2);
    const cut = height - (id === "aka" ? 31 : id === "kin" ? 26 : four ? 28 : 23);
    const limbs = centres.map((centre, index) => {
      const reach = four ? 29 : id === "aka" ? 26 : 22;
      const previous = index === 0 ? 0 : (centres[index - 1] + centre) / 2;
      const next = index === centres.length - 1 ? width : (centres[index + 1] + centre) / 2;
      const x = Math.max(previous, Math.round(centre - reach), 0);
      const right = Math.min(next, Math.round(centre + reach), width);
      const pixels = canvas(Math.ceil(right - x), height - cut);
      pixels.drawImage(image, -x, -cut);
      body.clearRect(x, cut + 5, right - x, height - cut - 5);
      const bottom = measureLimb(source, width, height, (x + right) / 2, Math.max(1, Math.floor((right - x) / 2)));
      return { pixels: pixels.canvas, x, centre, cut, bottom };
    });
    return { width, height, body: body.canvas, limbs };
  }

  function paintWalk(context, rig, id, view, phase) {
    const [duty, stride, lift] = beats[id];
    const heading = directions.indexOf(view) * angleStep;
    const projection = Math.sin(heading);
    const depth = Math.cos(heading);
    const offsets = phases[id] || [0, .5];
    const oscillation = (1 - Math.cos(phase * Math.PI * 4)) / 2;
    const bodyDrop = (id === "kin" ? 1 : quadrupeds.has(id) ? 2 : 3) * oscillation;
    context.clearRect(0, 0, rig.width, rig.height);
    context.drawImage(rig.body, 0, bodyDrop);
    rig.limbs.forEach((limb, index) => {
      const movement = step(phase + offsets[index], duty, stride * rig.height, lift * rig.height);
      const dx = projection * movement.stride;
      const dy = -movement.lift + depth * movement.stride * .11;
      const angle = clamp(-dx / 55, -.32, .32);
      const contact = (limb.bottom - limb.cut) * (1 - Math.cos(angle));
      context.save();
      context.translate(limb.centre + dx * .16, limb.cut + dy + contact);
      context.rotate(angle);
      context.drawImage(limb.pixels, limb.x - limb.centre, 0);
      context.restore();
    });
  }

  function strideLength(id, height) { return beats[id][1] * height; }

  function seatedView(direction) {
    if (direction === "left" || direction === "back-left") return "sit-left";
    if (direction === "right" || direction === "back-right") return "sit-right";
    return direction === "front-left" ? "sit-front-left" : "sit-front-right";
  }

  function measureLimb(context, width, height, center, reach) {
    const x = Math.max(0, Math.floor(center - reach));
    const columns = Math.min(width - x, reach * 2);
    const region = 35;
    const top = height - region;
    const data = context.getImageData(x, top, columns, region).data;
    let bottom = 0;
    for (let row = 0; row < region; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        if (data[(row * columns + column) * 4 + 3] > 170) bottom = row;
      }
    }
    return bottom + top;
  }

  const actions = {
    walk: { front:"正面", "front-right":"斜め前・右", right:"右", "back-right":"斜め後ろ・右", back:"背面", "back-left":"斜め後ろ・左", left:"左", "front-left":"斜め前・左" },
    dining: { sit:"着席", tea:"お茶", read:"読書", talk:"雑談" },
    sofa: { sit:"着席", relax:"くつろぐ", sleep:"眠る", read:"読書", talk:"雑談" },
    desk: { sit:"着席", type:"パソコン入力", review:"画面を確認", notes:"資料を見てメモ", draw:"タブレット・盤面操作" }
  };

  function paintActivity(context, image, activity, elapsed, size) {
    const width = image.naturalWidth, height = image.naturalHeight;
    const drawX = (size - width) / 2;
    context.clearRect(0, 0, size, height);
    context.save();
    context.translate(drawX, 0);
    const pulse = elapsed * 2 * Math.PI;
    const pose = { sleep:[.006, 4], relax:[.018, 3], talk:[.019, 1.1], read:[.011, 2], tea:[.026, 2], type:[.012, .52], notes:[.014, 1.2], review:[.016, 2.2], draw:[.015, 1.5] }[activity];
    if (pose) {
      context.translate(width / 2, footLine);
      context.rotate(Math.sin(pulse / pose[1]) * pose[0]);
      context.translate(-width / 2, -footLine);
    }
    context.drawImage(image, 0, 0);
    context.restore();
  }

  function clipFor(kind, action, seat, floor, approach) {
    const points = approach.map(point => [point[0], floor, point[1]]);
    const length = points.slice(1).reduce((total, point, index) => total + Math.hypot(point[0] - points[index][0], point[2] - points[index][2]), 0);
    const active = { sit:1.1, type:3.3, review:3.4, notes:3.7, draw:3.7, tea:3.6, read:4.0, talk:4.2, relax:3.6, sleep:4.4 }[action];
    return { kind, action, seat, points, approachSeconds: Math.max(1.3, length / 1.75), active, length };
  }

  function walkClip(direction, floor, cameraHeading) {
    const heading = directions.indexOf(direction) * angleStep + cameraHeading;
    const dx = Math.sin(heading), dz = Math.cos(heading);
    const x = -.75, z = 3.85, half = .74;
    return { kind:"walk", action:direction, heading, length:2*half, approachSeconds:1.65,
      points:[[x-dx*half, floor, z-dz*half], [x+dx*half, floor, z+dz*half]] };
  }

  function routePoint(points, fraction, length) {
    let distance = fraction * length;
    for (let i = 1; i < points.length; i += 1) {
      const from = points[i - 1], to = points[i];
      const span = Math.hypot(to[0] - from[0], to[2] - from[2]);
      if (distance <= span || i === points.length - 1) {
        const t = clamp(distance / Math.max(span, .00001), 0, 1);
        return { position: from.map((n, axis) => n + (to[axis] - n) * t), heading: Math.atan2(to[0] - from[0], to[2] - from[2]) };
      }
      distance -= span;
    }
  }

  function sampleClip(clip, elapsed) {
    const { seat, points, approachSeconds, active, length } = clip;
    if (clip.kind === "walk") {
      const fraction = clamp(elapsed / approachSeconds, 0, 1);
      return { ...routePoint(points, fraction, length), stage:fraction === 1 ? "done" : "approach", distance:fraction * length, mix:0, time:elapsed };
    }
    const entry = points.at(-1);
    const pose = { position:entry, heading:seat.heading, stage:"turn", distance:length, mix:0, time:0 };
    if (elapsed < approachSeconds) {
      const fraction = elapsed / approachSeconds;
      return { ...pose, ...routePoint(points, fraction, length), stage:"approach", distance:fraction * length };
    }
    const local = elapsed - approachSeconds;
    if (local < .38) {
      const start = routePoint(points, 1, length).heading;
      const turn = Math.atan2(Math.sin(seat.heading - start), Math.cos(seat.heading - start));
      return { ...pose, heading:start + turn * smooth(local / .38) };
    }
    const transition = local - .38;
    const at = mix => ({ ...pose, mix, position:[entry[0] + (seat.x - entry[0]) * mix, entry[1], entry[2] + (seat.z - entry[2]) * mix] });
    if (transition < .52) return { ...at(smooth(transition / .52)), stage:"sit" };
    if (transition < .52 + active) return { ...at(1), stage:"activity", time:transition - .52 };
    const exit = transition - .52 - active;
    if (exit < .52) return { ...at(1 - smooth(exit / .52)), stage:"stand" };
    const leave = clamp((exit - .52) / 1.25, 0, 1);
    const fraction = 1 - leave * Math.min(1, 1.8 / length);
    const retreat = routePoint(points, fraction, length);
    return { ...pose, ...retreat, heading:retreat.heading + Math.PI,
      stage:leave >= 1 ? "done" : "leave", distance:length + (1 - fraction) * length };
  }

  global.houseSDMotion = Object.freeze({ directions, cardinal, footLine, facing, fallback, prepare, paintWalk, strideLength, step, seatedView, actions, paintActivity, clipFor, walkClip, sampleClip });
})(typeof window !== "undefined" ? window : globalThis);
