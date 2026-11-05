// Isolated content script, top frame only. The worker owns the turn state.
// Motion uses the official Codex cursor spring/curve parameters: a spring
// simulator (response + damping fraction), a "scoot" path for short moves and
// a bounds-aware cubic-Bezier arc for long moves, plus the thinking wobble.
(() => {
  globalThis.__dshCursorCleanup?.();

  const SIZE = 24;
  const CENTER = SIZE / 2;
  const IMAGE_W = 23;
  const IMAGE_H = 24;
  const IMAGE_X = 12;
  const IMAGE_Y = -2.5;
  const IMAGE_ROTATION = 44;
  const CLICK_ANGLE = -44;
  const MAX_SCOOT_DISTANCE = 196;
  const SIM_STEP = 1 / 240;
  const SETTLE_VELOCITY = 12;
  const SETTLE_DISTANCE = 0.4;

  const SPRING = {
    position: { response: 0.19, dampingFraction: 0.9 },
    rotation: { response: 0.12, dampingFraction: 0.9 },
    visibility: { response: 0.42, dampingFraction: 0.86 },
    stretch: { response: 0.2, dampingFraction: 0.85 },
    scootRotation: { response: 0.055, dampingFraction: 0.82 },
    scootStretch: { response: 0.12, dampingFraction: 0.86 },
    scootProgress: { response: 0.19, dampingFraction: 0.94 },
  };

  const PATH_CONFIG = {
    arcFlow: 0.5783555327868779,
    arcSize: 0.2765523188064277,
    boundsMargin: 20,
    candidateCount: 20,
    clickAngleDegrees: -44,
    endpointHandle: 0.15,
    startHandle: 0.41960295031576633,
  };

  let host;
  let layer;
  let arrow;
  let image;
  let ripple;
  let raf = 0;
  let lastFrame = 0;
  let revision = 0;
  let cursorVisible = false;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }
  function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
  function unit(vector) {
    const length = Math.hypot(vector.x, vector.y);
    return length < 0.001 ? { x: 1, y: 0 } : { x: vector.x / length, y: vector.y / length };
  }
  function angleNormalize(degrees) {
    const value = degrees % 360;
    return value < 0 ? value + 360 : value;
  }
  function angleDelta(from, to) {
    let value = to - from;
    while (value > 180) value -= 360;
    while (value < -180) value += 360;
    return value;
  }
  function clickVector(degrees) {
    const radians = (degrees * Math.PI) / 180;
    return { x: Math.sin(radians), y: -Math.cos(radians) };
  }
  function midpoint(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  function createSpring(value, config) {
    return {
      value,
      target: value,
      velocity: 0,
      force: 0,
      response: config.response,
      dampingFraction: config.dampingFraction,
      simulationTime: 0,
      scriptTime: 0,
    };
  }
  function snapSpring(spring, value) {
    spring.force = 0;
    spring.simulationTime = 0;
    spring.scriptTime = 0;
    spring.target = value;
    spring.value = value;
    spring.velocity = 0;
  }
  function springSettled(spring) {
    const positionTolerance = spring.target * 0.01;
    const delta = spring.target - spring.value;
    return (
      Math.max(spring.velocity * spring.velocity, spring.force * spring.force) <= 0.06 * 0.06 &&
      (positionTolerance === 0 || delta * delta <= positionTolerance * positionTolerance)
    );
  }
  function stepSpring(spring, dt) {
    const response = Math.max(0.001, spring.response);
    const maxStiffness = 1 / (2 * SIM_STEP * SIM_STEP);
    const stiffness = Math.min(((Math.PI * 2) ** 2) / (response * response), maxStiffness);
    const damping = Math.sqrt(stiffness) * 2 * spring.dampingFraction;
    spring.scriptTime += Math.max(0, dt);
    if (spring.scriptTime - spring.simulationTime > 1) spring.simulationTime = spring.scriptTime - SIM_STEP;
    while (spring.simulationTime < spring.scriptTime) {
      const half = SIM_STEP / 2;
      const velocity = spring.velocity + spring.force * half;
      spring.value += velocity * SIM_STEP;
      spring.force = velocity * -damping + (spring.target - spring.value) * stiffness;
      spring.velocity = velocity + spring.force * half;
      spring.simulationTime += SIM_STEP;
    }
    if (springSettled(spring)) spring.value = spring.target;
  }

  /* ---------------- path generation (official algorithm) ---------------- */

  function constrainToBounds(bounds, point, normal, maxDistance) {
    let allowed = maxDistance;
    if (normal.x < 0) allowed = Math.min(allowed, point.x / -normal.x);
    if (normal.x > 0) allowed = Math.min(allowed, (bounds.width - point.x) / normal.x);
    if (normal.y < 0) allowed = Math.min(allowed, point.y / -normal.y);
    if (normal.y > 0) allowed = Math.min(allowed, (bounds.height - point.y) / normal.y);
    return { x: point.x + normal.x * Math.max(0, allowed), y: point.y + normal.y * Math.max(0, allowed) };
  }

  function cubicPoint(start, control1, control2, end, t) {
    const inverse = 1 - t;
    return {
      x: start.x * inverse ** 3 + control1.x * 3 * inverse ** 2 * t + control2.x * 3 * inverse * t * t + end.x * t ** 3,
      y: start.y * inverse ** 3 + control1.y * 3 * inverse ** 2 * t + control2.y * 3 * inverse * t * t + end.y * t ** 3,
    };
  }
  function cubicTangent(start, control1, control2, end, t) {
    const inverse = 1 - t;
    return {
      x: 3 * inverse ** 2 * (control1.x - start.x) + 6 * inverse * t * (control2.x - control1.x) + 3 * t * t * (end.x - control2.x),
      y: 3 * inverse ** 2 * (control1.y - start.y) + 6 * inverse * t * (control2.y - control1.y) + 3 * t * t * (end.y - control2.y),
    };
  }
  function makeSegment(start, startControl, arcIn, arcOut, endControl, end) {
    return {
      start,
      startControl,
      end,
      segments: [
        { control1: startControl, control2: arcIn, end: arcIn === null ? end : arcIn },
        ...(arcIn === null ? [] : [{ control1: arcOut, control2: endControl, end }]),
      ],
      arc: arcIn,
    };
  }
  function twoSegmentCandidate(start, end, startControl, endControl, arc, arcIn, arcOut) {
    return {
      start,
      end,
      startControl,
      endControl,
      arc,
      segments: [
        { control1: startControl, control2: arcIn, end: arc },
        { control1: arcOut, control2: endControl, end },
      ],
    };
  }
  function straightCandidate(start, end, startControl, endControl) {
    return {
      start,
      end,
      startControl,
      endControl,
      arc: null,
      segments: [{ control1: startControl, control2: endControl, end }],
    };
  }
  function arcCandidates({ start, end, startControl, endControl, midpoint: middle, naturalArcNormal, clickTangent, arcTangent, candidates, arcDistanceBase, arcDistanceScale, arcHandleDistanceBase, arcHandleScale }) {
    for (const sign of [1, -1]) {
      const normal = { x: naturalArcNormal.x * sign, y: naturalArcNormal.y * sign };
      const arcDistance = arcDistanceBase * arcDistanceScale;
      const handleDistance = arcHandleDistanceBase * arcHandleScale;
      const arc = {
        x: middle.x + normal.x * arcDistance + clickTangent.x * handleDistance * 0.16,
        y: middle.y + normal.y * arcDistance + clickTangent.y * handleDistance * 0.16,
      };
      const arcIn = { x: arc.x - arcTangent.x * handleDistance, y: arc.y - arcTangent.y * handleDistance };
      const arcOut = { x: arc.x + arcTangent.x * handleDistance, y: arc.y + arcTangent.y * handleDistance };
      const candidate = twoSegmentCandidate(start, end, startControl, endControl, arc, arcIn, arcOut);
      // Keep the final control point consistent with the arc exit.
      candidate.segments[1] = { control1: arcOut, control2: endControl, end };
      candidates.push(candidate);
    }
  }
  function buildPath({ start, end, bounds }) {
    const click = clickVector(PATH_CONFIG.clickAngleDegrees);
    const totalDistance = distance(start, end);
    if (totalDistance < 0.001) return null;
    const direction = unit({ x: end.x - start.x, y: end.y - start.y });
    const startHandleDistance = Math.max(48, Math.min(640, totalDistance * PATH_CONFIG.startHandle, totalDistance * 0.9));
    const endHandleDistance = Math.max(48, Math.min(640, totalDistance * PATH_CONFIG.endpointHandle, totalDistance * 0.9));
    const backClick = { x: -click.x, y: -click.y };
    const startControl = constrainToBounds(bounds, start, click, startHandleDistance);
    const endControl = constrainToBounds(bounds, end, backClick, endHandleDistance);
    const normal = { x: -direction.y, y: direction.x };
    const side = normal.x * click.x + normal.y * click.y >= 0 ? 1 : -1;
    const naturalArcNormal = { x: normal.x * side, y: normal.y * side };
    const middle = midpoint(start, end);
    const startControlShort = constrainToBounds(bounds, start, click, startHandleDistance * 0.65);
    const endControlShort = constrainToBounds(bounds, end, backClick, endHandleDistance * 0.65);
    const arcTangent = unit({ x: end.x - start.x, y: end.y - start.y });
    const arcDistanceBase = Math.max(50, Math.min(520, totalDistance * PATH_CONFIG.arcSize));
    const arcHandleBase = Math.max(38, Math.min(440, totalDistance * PATH_CONFIG.arcFlow));
    const candidates = [
      straightCandidate(start, end, startControl, endControl),
      straightCandidate(start, end, startControlShort, endControlShort),
    ];
    const arcDistanceScales = [0.55, 0.8, 1.05];
    const arcHandleScales = [0.65, 1, 1.35];
    for (const arcDistanceScale of arcDistanceScales) {
      for (const arcHandleScale of arcHandleScales) {
        for (const controls of [
          { startControl, endControl },
          { startControl: startControlShort, endControl: endControlShort },
        ]) {
          arcCandidates({
            start,
            end,
            startControl: controls.startControl,
            endControl: controls.endControl,
            midpoint: middle,
            naturalArcNormal,
            clickTangent: click,
            arcTangent,
            candidates,
            arcDistanceBase,
            arcDistanceScale,
            arcHandleDistanceBase: arcHandleBase,
            arcHandleScale,
          });
        }
      }
    }
    return candidates.slice(0, PATH_CONFIG.candidateCount);
  }

  function scorePath(candidate, bounds) {
    let length = 0;
    let angleEnergy = 0;
    let maxAngle = 0;
    let totalTurn = 0;
    let previousAngle = null;
    let previous = candidate.start;
    let staysInBounds = true;
    for (const segment of candidate.segments) {
      for (let step = 1; step <= 24; step += 1) {
        const point = cubicPoint(previous, segment.control1, segment.control2, segment.end, step / 24);
        length += distance(previous, point);
        if (bounds !== undefined) {
          staysInBounds =
            staysInBounds &&
            point.x >= PATH_CONFIG.boundsMargin &&
            point.x <= bounds.width - PATH_CONFIG.boundsMargin &&
            point.y >= PATH_CONFIG.boundsMargin &&
            point.y <= bounds.height - PATH_CONFIG.boundsMargin;
        }
        const delta = { x: point.x - previous.x, y: point.y - previous.y };
        if (Math.hypot(delta.x, delta.y) > 0.01) {
          const angle = Math.atan2(delta.y, delta.x);
          if (previousAngle !== null) {
            const change = angleDelta(previousAngle, angle);
            angleEnergy += change * change;
            maxAngle = Math.max(maxAngle, Math.abs(change));
            totalTurn += Math.abs(change);
          }
          previousAngle = angle;
        }
        previous = point;
      }
    }
    const straightLine = Math.max(1, distance(candidate.start, candidate.end));
    const arcness = candidate.arc === null ? 0 : 45;
    const clickAlignment = (() => {
      const click = clickVector(PATH_CONFIG.clickAngleDegrees);
      const direction = unit({ x: candidate.end.x - candidate.start.x, y: candidate.end.y - candidate.start.y });
      return clamp((-(direction.x * click.x + direction.y * click.y) - 0.08) / 0.92, 0, 1);
    })();
    const cost =
      length +
      Math.max(0, length / straightLine - 1) * 320 +
      angleEnergy * 140 +
      maxAngle * 180 +
      totalTurn * 18 +
      clickAlignment * 90 +
      arcness;
    return { length, angleEnergy, maxAngle, totalTurn, staysInBounds, cost, clickAlignment };
  }

  function choosePath(start, end, bounds) {
    const candidates = buildPath({ start, end, bounds });
    if (candidates === null) return null;
    let inBoundsBest = null;
    let inBoundsCost = Infinity;
    let overallBest = candidates[0];
    let overallCost = Infinity;
    for (const candidate of candidates) {
      const metrics = scorePath(candidate, bounds);
      if (metrics.staysInBounds && metrics.cost < inBoundsCost) {
        inBoundsBest = candidate;
        inBoundsCost = metrics.cost;
      }
      if (metrics.cost < overallCost) {
        overallBest = candidate;
        overallCost = metrics.cost;
      }
    }
    const chosen = inBoundsBest ?? overallBest;
    return { path: chosen, metrics: scorePath(chosen, bounds) };
  }

  function samplePath(path, progress) {
    const clamped = clamp(progress, 0, 1);
    const scaled = clamped === 1 ? path.segments.length - 1 : clamped * path.segments.length;
    const index = Math.floor(scaled);
    const segment = path.segments[index];
    const previous = index === 0 ? path.start : path.segments[index - 1].end;
    const step = clamped === 1 ? 1 : scaled - index;
    return {
      point: cubicPoint(previous, segment.control1, segment.control2, segment.end, step),
      tangent: cubicTangent(previous, segment.control1, segment.control2, segment.end, step),
    };
  }

  function pathResponse(metrics, isArc) {
    const comparison = Math.max(1, metrics.length);
    const stretchRatio = Math.max(0, metrics.length / comparison - 1);
    const lengthScore = clamp((metrics.length - 180) / 760, 0, 1);
    const stretchScore = clamp(stretchRatio / 0.55, 0, 1);
    const turnScore = clamp(metrics.totalTurn / (Math.PI * 1.4), 0, 1);
    const angleScore = clamp(metrics.angleEnergy / 1.25, 0, 1);
    const combined = stretchScore * 0.42 + turnScore * 0.38 + angleScore * 0.2;
    return clamp(
      (0.42 + lengthScore * 0.22 + combined * 0.12 + metrics.clickAlignment * 0.28 + (isArc ? 0 : 0.04)) *
        (isArc ? 0.9 : 1) *
        0.7,
      0.12,
      2.2
    );
  }

  /* ------------------------------ state ------------------------------- */

  let state = null;

  function defaultPoint() {
    const width = window.visualViewport?.width ?? window.innerWidth;
    const height = window.visualViewport?.height ?? window.innerHeight;
    return { x: Math.round(width * 0.58), y: Math.round(height * 0.55) };
  }

  function createState(point) {
    const initial = point ?? defaultPoint();
    const click = clickVector(CLICK_ANGLE);
    const rotation = Math.atan2(click.y, click.x) * (180 / Math.PI) + 90;
    return {
      point: initial,
      positionX: createSpring(initial.x, SPRING.position),
      positionY: createSpring(initial.y, SPRING.position),
      rotation: angleNormalize(rotation),
      rotationSpring: createSpring(angleNormalize(rotation), SPRING.rotation),
      scootAxisRotation: 0,
      scootAxisSpring: createSpring(0, SPRING.rotation),
      scootRotationSpring: createSpring(0, SPRING.scootRotation),
      scootStretchSpring: createSpring(1, SPRING.scootStretch),
      stretchSpring: createSpring(1, SPRING.stretch),
      visibilitySpring: createSpring(1, SPRING.visibility),
      thinkStartedAt: null,
      motion: null,
      lastMoveSequence: null,
      lastTurnKey: null,
    };
  }

  function setAngleTarget(spring, degrees) {
    spring.target = spring.value + angleDelta(spring.value, angleNormalize(degrees));
  }

  function setMotionResponse(motion, response, dampingFraction) {
    motion.response = response;
    motion.dampingFraction = dampingFraction;
    if (motion.progressSpring) {
      motion.progressSpring.response = response;
      motion.progressSpring.dampingFraction = dampingFraction;
    }
  }

  function moveTo(target) {
    if (state === null) state = createState(target);
    const current = state.point;
    const delta = distance(current, target);
    if (delta < 0.5) {
      snapSpring(state.positionX, target.x);
      snapSpring(state.positionY, target.y);
      return;
    }
    if (delta <= MAX_SCOOT_DISTANCE) {
      const direction = { x: target.x - current.x, y: target.y - current.y };
      const axisRotation = delta < 0.001 ? 0 : (Math.atan2(direction.y, direction.x) * 180) / Math.PI;
      const rotationTarget = clamp(direction.x * 0.75 + -direction.y * 0.62, -1, 1) * 70;
      snapSpring(state.positionX, current.x);
      snapSpring(state.positionY, current.y);
      state.positionX.target = target.x;
      state.positionY.target = target.y;
      state.positionX.response = SPRING.position.response;
      state.positionY.response = SPRING.position.response;
      setAngleTarget(state.rotationSpring, CLICK_ANGLE);
      setAngleTarget(state.scootAxisSpring, axisRotation);
      state.scootRotationSpring.target = rotationTarget;
      state.scootStretchSpring.target = 1;
      const progressSpring = createSpring(0, SPRING.scootProgress);
      progressSpring.target = 1;
      state.motion = {
        mode: "scoot",
        start: current,
        end: target,
        axisRotation,
        rotationTarget,
        progressSpring,
      };
      return;
    }
    const bounds = { width: window.visualViewport?.width ?? window.innerWidth, height: window.visualViewport?.height ?? window.innerHeight };
    const chosen = choosePath(current, target, bounds);
    if (chosen === null) return;
    const isArc = chosen.path.arc !== null;
    state.positionX.response = pathResponse(chosen.metrics, isArc);
    state.positionY.response = pathResponse(chosen.metrics, isArc);
    state.positionX.dampingFraction = SPRING.position.dampingFraction;
    state.positionY.dampingFraction = SPRING.position.dampingFraction;
    state.rotationSpring.response = SPRING.rotation.response;
    state.scootAxisSpring.target = 0;
    const progressSpring = createSpring(0, { response: 0.12, dampingFraction: 0.9 });
    progressSpring.target = 1;
    const response = clamp(pathResponse(chosen.metrics, isArc) * 0.18, 0.035, 0.12);
    progressSpring.response = response;
    state.motion = {
      mode: "bezier",
      path: chosen.path,
      progressSpring,
    };
  }

  function updateState(dt, now) {
    if (state === null) return;
    stepSpring(state.positionX, dt);
    stepSpring(state.positionY, dt);
    stepSpring(state.rotationSpring, dt);
    stepSpring(state.scootAxisSpring, dt);
    stepSpring(state.scootRotationSpring, dt);
    stepSpring(state.scootStretchSpring, dt);
    stepSpring(state.stretchSpring, dt);
    stepSpring(state.visibilitySpring, dt);
    if (state.motion !== null) {
      const motion = state.motion;
      stepSpring(motion.progressSpring, dt);
      const progress = clamp(motion.progressSpring.value, 0, 1);
      if (motion.mode === "bezier") {
        const sampled = samplePath(motion.path, progress);
        state.positionX.target = sampled.point.x;
        state.positionY.target = sampled.point.y;
        const tangent = sampled.tangent;
        const rotation = angleNormalize((Math.atan2(tangent.y, tangent.x) * 180) / Math.PI + 90);
        setAngleTarget(state.rotationSpring, rotation);
        state.scootAxisSpring.target = 0;
        const previous = state.point;
        const speed = distance(previous, { x: state.positionX.value, y: state.positionY.value }) / Math.max(dt, 1 / 240);
        state.stretchSpring.target = clamp(1 - speed / 5500, 0.65, 1);
        if (
          progress >= 0.999 &&
          Math.abs(motion.progressSpring.velocity) < 0.01 &&
          distance(state.positionX.value, sampled.point.x) < 0.1 &&
          distance(state.positionY.value, sampled.point.y) < 0.1
        ) {
          const end = samplePath(motion.path, 1);
          state.point = end.point;
          snapSpring(state.positionX, end.point.x);
          snapSpring(state.positionY, end.point.y);
          state.rotation = angleNormalize((Math.atan2(end.tangent.y, end.tangent.x) * 180) / Math.PI + 90);
          snapSpring(state.rotationSpring, state.rotation);
          snapSpring(state.stretchSpring, 1);
          state.motion = null;
          state.thinkStartedAt = now;
        }
      } else {
        state.positionX.target = motion.end.x;
        state.positionY.target = motion.end.y;
        setAngleTarget(state.scootAxisSpring, motion.axisRotation);
        setAngleTarget(state.rotationSpring, CLICK_ANGLE);
        const arcProgress = Math.sin(progress * Math.PI);
        state.stretchSpring.target = 1;
        state.scootStretchSpring.target = 1 - 0.15 * arcProgress;
        state.scootRotationSpring.target = motion.rotationTarget * arcProgress;
        if (
          progress >= 0.999 &&
          Math.abs(motion.progressSpring.velocity) < 0.01 &&
          distance(state.positionX.value, motion.end.x) < 0.1 &&
          distance(state.positionY.value, motion.end.y) < 0.1
        ) {
          state.point = motion.end;
          snapSpring(state.positionX, motion.end.x);
          snapSpring(state.positionY, motion.end.y);
          snapSpring(state.rotationSpring, angleNormalize(CLICK_ANGLE));
          state.rotation = angleNormalize(CLICK_ANGLE);
          snapSpring(state.scootAxisSpring, 0);
          state.scootAxisRotation = 0;
          snapSpring(state.scootRotationSpring, 0);
          snapSpring(state.scootStretchSpring, 1);
          snapSpring(state.stretchSpring, 1);
          state.motion = null;
          state.thinkStartedAt = now;
        }
      }
    } else {
      state.point = { x: state.positionX.value, y: state.positionY.value };
      state.rotation = state.rotationSpring.value;
      state.scootAxisRotation = state.scootAxisSpring.value;
    }
    state.point = { x: state.positionX.value, y: state.positionY.value };
  }

  function thinkOffset(now) {
    if (state?.thinkStartedAt == null) return 0;
    const elapsed = (now - state.thinkStartedAt) / 1000;
    if (elapsed < 0) return 0;
    const progress = Math.min(1, elapsed / 1.41);
    const envelope = Math.sin(progress * Math.PI);
    const wave = Math.sin((elapsed / 0.66) * Math.PI * 2) * envelope;
    if (progress >= 1) {
      state.thinkStartedAt = null;
      return 0;
    }
    return wave * 12.5;
  }

  function render(now) {
    if (state === null || layer === null) return;
    const visibility = cursorVisible ? 1 : 0;
    const blur = 5 + (0 - 5) * visibility;
    const scootStretch = clamp(state.scootStretchSpring.value, 0, 1);
    const axis = state.scootAxisRotation;
    const rotation = angleNormalize(state.rotation + state.scootRotationSpring.value + thinkOffset(now));
    const transforms = [`translate3d(${(state.point.x - CENTER).toFixed(3)}px, ${(state.point.y - CENTER).toFixed(3)}px, 0)`];
    if (Math.abs(angleDelta(0, axis)) > 0.001 || Math.abs(scootStretch - 1) > 0.001) {
      transforms.push(`rotate(${axis.toFixed(3)}deg)`, `scale(1, ${scootStretch.toFixed(3)})`, `rotate(${(-axis).toFixed(3)}deg)`);
    }
    transforms.push(`rotate(${rotation.toFixed(3)}deg)`, `scale(1)`);
    layer.style.transform = transforms.join(" ");
    layer.style.opacity = String(visibility);
    layer.style.filter = `blur(${blur.toFixed(3)}px)`;
  }

  function frame(now) {
    const dt = lastFrame === 0 ? 1 / 60 : Math.min(0.05, Math.max(1 / 240, (now - lastFrame) / 1000));
    lastFrame = now;
    updateState(dt, now);
    render(now);
    raf = requestAnimationFrame(frame);
  }

  function ensureLoop() {
    if (raf !== 0) return;
    lastFrame = 0;
    raf = requestAnimationFrame(frame);
  }
  function stopLoop() {
    if (raf !== 0) cancelAnimationFrame(raf);
    raf = 0;
  }

  /* ------------------------------ DOM --------------------------------- */

  function mount() {
    if (host?.isConnected) return;
    const stale = document.getElementById("__dsh_cursor__");
    if (stale?.dataset.dshCursorVersion) stale.remove();
    host = document.createElement("div");
    host.dataset.dshCursorVersion = "4";
    host.id = "__dsh_cursor__";
    host.setAttribute("aria-hidden", "true");
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial !important; position: fixed !important; inset: 0 !important;
        z-index: 2147483646 !important; pointer-events: none !important; overflow: hidden !important; }
      @media print { :host { display: none !important; } }
      .layer, .ripple { position: absolute; left: 0; top: 0; pointer-events: none; }
      .layer { width: 24px; height: 24px; transform-origin: 12px 12px; will-change: transform, opacity, filter; }
      .inner { transform: translate3d(12px, -2.5px, 0); }
      img { position: absolute; left: 0; top: 0; width: 23px; height: 24px; display: block;
        transform-origin: 0 0; transform: rotate(44deg);
        filter: drop-shadow(0 0 6px #339cffdd) drop-shadow(0 0 15px #339cff77); }
      .ripple { width: 18px; height: 18px; margin-left: -9px; margin-top: -9px; border-radius: 50%; background: #339cff; opacity: 0; }
    `;
    layer = document.createElement("div");
    layer.className = "layer";
    const inner = document.createElement("div");
    inner.className = "inner";
    image = document.createElement("img");
    image.alt = "";
    image.src = chrome.runtime.getURL("images/cursor-chat.png");
    inner.append(image);
    layer.append(inner);
    ripple = document.createElement("span");
    ripple.className = "ripple";
    shadow.append(style, layer, ripple);
    document.documentElement.append(host);
  }

  function pulseRipple() {
    if (ripple === null || state === null) return;
    ripple.style.left = `${state.point.x}px`;
    ripple.style.top = `${state.point.y}px`;
    ripple.animate(
      [
        { opacity: 0.8, transform: "scale(.2)" },
        { opacity: 0, transform: "scale(2)" },
      ],
      { duration: 450, easing: "cubic-bezier(.2,.8,.2,1)" }
    );
  }

  function clear() {
    stopLoop();
    host?.remove();
    host = null;
    layer = null;
    image = null;
    ripple = null;
    state = null;
    cursorVisible = false;
  }

  function applyState(next) {
    const visible = next !== null && next !== undefined && next.visible !== false;
    if (!visible) {
      cursorVisible = false;
      if (state !== null) state.visibilitySpring.target = 0;
      ensureLoop();
      return;
    }
    if (state === null) state = createState(next.point ?? null);
    cursorVisible = true;
    const turnKey = next.turnKey ?? `${next.origin ?? ""}:${next.moveSequence ?? ""}`;
    const hasPoint = next.point !== null && next.point !== undefined;
    const animateMovement = next.animateMovement !== false;
    const freshTurn = next.moveSequence != null && state.visibilitySpring.value <= 0.001 && state.lastTurnKey !== turnKey;
    state.visibilitySpring.target = 1;
    if (freshTurn) {
      state.lastTurnKey = turnKey;
      snapSpring(state.visibilitySpring, 1);
      state.thinkStartedAt = next.kind === "begin" ? performance.now() : null;
    }
    if (!hasPoint) {
      // Observation-only state: keep the cursor in place, or show it at the
      // default anchor for the first state of a turn.
      if (next.moveSequence != null) state.lastMoveSequence = next.moveSequence;
      if (next.kind === "begin" && state.thinkStartedAt === null) state.thinkStartedAt = performance.now();
      ensureLoop();
      return;
    }
    const target = {
      x: clamp(next.point.x, 0, window.visualViewport?.width ?? window.innerWidth),
      y: clamp(next.point.y, 0, window.visualViewport?.height ?? window.innerHeight),
    };
    if (state.lastMoveSequence === next.moveSequence && next.moveSequence != null) {
      ensureLoop();
      return;
    }
    const shouldAnimate =
      animateMovement && !document.hidden && state.lastMoveSequence !== null && !freshTurn;
    if (next.moveSequence != null) state.lastMoveSequence = next.moveSequence;
    if (shouldAnimate) moveTo(target);
    else {
      state.point = target;
      snapSpring(state.positionX, target.x);
      snapSpring(state.positionY, target.y);
      snapSpring(state.rotationSpring, angleNormalize(CLICK_ANGLE));
      state.rotation = angleNormalize(CLICK_ANGLE);
      state.motion = null;
    }
    if (next.kind === "click") pulseRipple();
    ensureLoop();
  }

  function onMessage(message, _sender, respond) {
    if (message.type !== "dsh.cursor.state") return false;
    const current = ++revision;
    Promise.resolve()
      .then(async () => {
        if (!document.documentElement) {
          await new Promise((resolve) => document.addEventListener("DOMContentLoaded", resolve, { once: true }));
        }
        if (current !== revision) return;
        if (message.state === null || message.state === undefined || message.state.origin !== location.origin) {
          clear();
          return;
        }
        mount();
        applyState(message.state);
      })
      .then(
        () => respond(true),
        () => respond(false)
      );
    return true;
  }

  chrome.runtime.onMessage.addListener(onMessage);

  function restore() {
    const request = revision;
    chrome.runtime
      .sendMessage({ type: "dsh.cursor.get" })
      .then((next) => {
        if (request !== revision) return;
        if (next === null || next === undefined || next.origin !== location.origin) return;
        mount();
        applyState(next);
      })
      .catch(clear);
  }
  window.addEventListener("pageshow", restore);
  window.visualViewport?.addEventListener("resize", () => {
    if (state !== null) {
      state.positionX.target = clamp(state.positionX.target, 0, window.visualViewport?.width ?? window.innerWidth);
      state.positionY.target = clamp(state.positionY.target, 0, window.visualViewport?.height ?? window.innerHeight);
    }
  });

  globalThis.__dshCursorCleanup = () => {
    revision += 1;
    clear();
    window.removeEventListener("pageshow", restore);
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch {
      /* extension context invalidated */
    }
  };
  restore();
})();
