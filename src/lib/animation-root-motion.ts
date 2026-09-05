import * as THREE from "three";

export type RootMotionExtractionMode = "linear" | "velocity-guided";
export type RootMotionYawMode = "rdp" | "linear";

export type RootMotionExtractionOptions = {
  mode: RootMotionExtractionMode;
  fps?: number;
  velocitySmoothingWindow?: number;
  velocityTolerance?: number;
  extractX?: boolean;
  extractZ?: boolean;
  extractYaw?: boolean;
  yawMode?: RootMotionYawMode;
  yawToleranceDegrees?: number;
};

export type RootMotionExtractionReport = {
  rootName: string;
  hipsName: string;
  mode: RootMotionExtractionMode;
  sampleCount: number;
  rootKeyCount: number;
  rootKeyTimes: number[];
  planarDisplacement: [number, number];
  planarDistance: number;
  extractedYawDegrees: number;
  yawKeyCount: number;
};

export type RootMotionAnalysisSample = {
  time: number;
  characterX: number;
  characterZ: number;
  rootX: number;
  rootZ: number;
  characterYaw: number;
  rootYaw: number;
};

export type RootMotionAnalysis = {
  duration: number;
  rootName: string;
  hipsName: string;
  samples: RootMotionAnalysisSample[];
};

type PositionTrackInfo = {
  track: THREE.VectorKeyframeTrack;
  target: THREE.Object3D;
};

function resolveTrackTarget(model: THREE.Object3D, track: THREE.KeyframeTrack) {
  try {
    const parsed = THREE.PropertyBinding.parseTrackName(track.name);
    return (
      model.getObjectByProperty("uuid", parsed.nodeName) ??
      model.getObjectByName(parsed.nodeName) ??
      null
    );
  } catch {
    return null;
  }
}

function positionTracks(model: THREE.Object3D, clip: THREE.AnimationClip) {
  return clip.tracks.flatMap<PositionTrackInfo>((track) => {
    if (!(track instanceof THREE.VectorKeyframeTrack)) return [];
    try {
      const parsed = THREE.PropertyBinding.parseTrackName(track.name);
      if (parsed.propertyName !== "position") return [];
    } catch {
      return [];
    }
    const target = resolveTrackTarget(model, track);
    return target ? [{ track, target }] : [];
  });
}

function findHipsTrack(model: THREE.Object3D, clip: THREE.AnimationClip) {
  const candidates = positionTracks(model, clip).filter(({ target }) => target instanceof THREE.Bone);
  const scored = candidates
    .map((entry) => {
      const name = entry.target.name.toLowerCase();
      let score = 0;
      if (/(^|[:_])hips?$/.test(name) || /j_bip_c_hips/.test(name)) score += 100;
      if (name.includes("hips")) score += 80;
      if (name.includes("pelvis")) score += 70;
      const parent = entry.target.parent;
      if (parent && !(parent instanceof THREE.Bone)) score += 4;
      return { ...entry, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.target.name.localeCompare(b.target.name));
  if (scored.length === 0) {
    throw new Error("Could not find an animated Hips/Pelvis position track.");
  }
  return scored[0];
}

function evaluateVectorTrack(track: THREE.VectorKeyframeTrack, time: number) {
  const times = track.times;
  const values = track.values;
  const read = (index: number) => new THREE.Vector3(
    Number(values[index * 3]),
    Number(values[index * 3 + 1]),
    Number(values[index * 3 + 2]),
  );
  if (times.length === 0) return new THREE.Vector3();
  if (time <= Number(times[0])) return read(0);
  const last = times.length - 1;
  if (time >= Number(times[last])) return read(last);
  let lo = 0;
  let hi = last;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (Number(times[mid]) <= time) lo = mid;
    else hi = mid;
  }
  const t0 = Number(times[lo]);
  const t1 = Number(times[hi]);
  const alpha = t1 === t0 ? 0 : (time - t0) / (t1 - t0);
  return read(lo).lerp(read(hi), alpha);
}

function quaternionTracks(model: THREE.Object3D, clip: THREE.AnimationClip) {
  return clip.tracks.flatMap<{ track: THREE.QuaternionKeyframeTrack; target: THREE.Object3D }>((track) => {
    if (!(track instanceof THREE.QuaternionKeyframeTrack)) return [];
    try {
      const parsed = THREE.PropertyBinding.parseTrackName(track.name);
      if (parsed.propertyName !== "quaternion") return [];
    } catch {
      return [];
    }
    const target = resolveTrackTarget(model, track);
    return target ? [{ track, target }] : [];
  });
}

function evaluateQuaternionTrack(track: THREE.QuaternionKeyframeTrack, time: number) {
  const times = track.times;
  const values = track.values;
  const read = (index: number) => new THREE.Quaternion(
    Number(values[index * 4]), Number(values[index * 4 + 1]),
    Number(values[index * 4 + 2]), Number(values[index * 4 + 3]),
  ).normalize();
  if (times.length === 0) return new THREE.Quaternion();
  if (time <= Number(times[0])) return read(0);
  const last = times.length - 1;
  if (time >= Number(times[last])) return read(last);
  let lo = 0;
  let hi = last;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (Number(times[mid]) <= time) lo = mid;
    else hi = mid;
  }
  const t0 = Number(times[lo]);
  const t1 = Number(times[hi]);
  return read(lo).slerp(read(hi), t1 === t0 ? 0 : (time - t0) / (t1 - t0)).normalize();
}

function unwrapYawSamples(samples: THREE.Quaternion[]) {
  const raw = samples.map((q) => {
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    return Math.atan2(forward.x, forward.z);
  });
  for (let i = 1; i < raw.length; i += 1) {
    while (raw[i] - raw[i - 1] > Math.PI) raw[i] -= Math.PI * 2;
    while (raw[i] - raw[i - 1] < -Math.PI) raw[i] += Math.PI * 2;
  }
  const start = raw[0] ?? 0;
  return raw.map((value) => value - start);
}

function sampleTimes(duration: number, requestedFps: number) {
  if (!(duration > 0)) throw new Error("Animation duration must be positive.");
  const fps = Number.isFinite(requestedFps) && requestedFps > 0 ? requestedFps : 30;
  const intervals = Math.max(1, Math.round(duration * fps));
  return Array.from({ length: intervals + 1 }, (_, index) => (duration * index) / intervals);
}

function normalizeWindow(value: number | undefined) {
  let result = Math.max(1, Math.round(value ?? 5));
  if (result % 2 === 0) result += 1;
  return result;
}

function movingAverage(values: number[], window: number) {
  const radius = Math.floor(window / 2);
  return values.map((_, index) => {
    const lo = Math.max(0, index - radius);
    const hi = Math.min(values.length, index + radius + 1);
    let sum = 0;
    for (let i = lo; i < hi; i += 1) sum += values[i];
    return sum / (hi - lo);
  });
}

function simplifyVelocity(times: number[], values: number[], tolerance: number) {
  const recurse = (lo: number, hi: number): number[] => {
    if (hi <= lo + 1) return hi > lo ? [lo, hi] : [lo];
    const t0 = times[lo];
    const t1 = times[hi];
    const v0 = values[lo];
    const v1 = values[hi];
    let bestError = -1;
    let bestIndex = -1;
    for (let i = lo + 1; i < hi; i += 1) {
      const alpha = t1 === t0 ? 0 : (times[i] - t0) / (t1 - t0);
      const predicted = v0 + (v1 - v0) * alpha;
      const error = Math.abs(values[i] - predicted);
      if (error > bestError) {
        bestError = error;
        bestIndex = i;
      }
    }
    if (bestIndex >= 0 && bestError > tolerance) {
      const left = recurse(lo, bestIndex);
      const right = recurse(bestIndex, hi);
      return [...left.slice(0, -1), ...right];
    }
    return [lo, hi];
  };
  return recurse(0, values.length - 1);
}

function selectVelocityGuidedKeys(
  times: number[],
  planarLocal: THREE.Vector3[],
  smoothingWindow: number,
  tolerance: number,
) {
  const final = planarLocal[planarLocal.length - 1];
  const distance = Math.hypot(final.x, final.z);
  if (distance < 1e-5) {
    throw new Error("Final planar Hips displacement is too small for projected velocity.");
  }
  const ux = final.x / distance;
  const uz = final.z / distance;
  const velocity = planarLocal.map((point, index) => {
    if (index === 0) {
      const dt = times[1] - times[0];
      const delta = planarLocal[1].clone().sub(planarLocal[0]);
      return dt > 0 ? (delta.x * ux + delta.z * uz) / dt : 0;
    }
    const dt = times[index] - times[index - 1];
    const delta = point.clone().sub(planarLocal[index - 1]);
    return dt > 0 ? (delta.x * ux + delta.z * uz) / dt : 0;
  });
  const smoothed = movingAverage(velocity, smoothingWindow);
  return Array.from(new Set([
    ...simplifyVelocity(times, smoothed, Math.max(1e-4, tolerance)),
    0,
    times.length - 1,
  ])).sort((a, b) => a - b);
}

function selectYawRdpKeys(times: number[], yawRadians: number[], toleranceDegrees: number) {
  const toleranceRadians = THREE.MathUtils.degToRad(Math.max(0.01, toleranceDegrees));
  return Array.from(new Set([
    ...simplifyVelocity(times, yawRadians, toleranceRadians),
    0,
    times.length - 1,
  ])).sort((a, b) => a - b);
}

function interpolateScalarAnchors(
  sampleIndex: number,
  keyIndices: number[],
  values: number[],
) {
  if (sampleIndex <= keyIndices[0]) return values[keyIndices[0]];
  const last = keyIndices[keyIndices.length - 1];
  if (sampleIndex >= last) return values[last];
  for (let i = 0; i < keyIndices.length - 1; i += 1) {
    const a = keyIndices[i];
    const b = keyIndices[i + 1];
    if (sampleIndex < a || sampleIndex > b) continue;
    const alpha = b === a ? 0 : (sampleIndex - a) / (b - a);
    return values[a] + (values[b] - values[a]) * alpha;
  }
  return values[0] ?? 0;
}

function interpolateAnchors(
  sampleIndex: number,
  keyIndices: number[],
  planarLocal: THREE.Vector3[],
) {
  if (sampleIndex <= keyIndices[0]) return planarLocal[keyIndices[0]].clone();
  const last = keyIndices[keyIndices.length - 1];
  if (sampleIndex >= last) return planarLocal[last].clone();
  for (let i = 0; i < keyIndices.length - 1; i += 1) {
    const a = keyIndices[i];
    const b = keyIndices[i + 1];
    if (sampleIndex < a || sampleIndex > b) continue;
    const alpha = b === a ? 0 : (sampleIndex - a) / (b - a);
    return planarLocal[a].clone().lerp(planarLocal[b], alpha);
  }
  return new THREE.Vector3();
}

export function analyzeRootMotion(
  model: THREE.Object3D,
  clip: THREE.AnimationClip,
  fps = 30,
): RootMotionAnalysis {
  const hipsInfo = findHipsTrack(model, clip);
  const hips = hipsInfo.target;
  const root = hips.parent;
  if (!root) throw new Error(`${hips.name || "Hips"} has no parent Root.`);

  const rootTrackInfo = positionTracks(model, clip).find(({ target }) => target === root);
  const allQuaternionTracks = quaternionTracks(model, clip);
  const rootQuaternionTrackInfo = allQuaternionTracks.find(({ target }) => target === root);
  const hipsQuaternionTrackInfo = allQuaternionTracks.find(({ target }) => target === hips);
  const times = sampleTimes(clip.duration, fps);
  const hipsSamples = times.map((time) => evaluateVectorTrack(hipsInfo.track, time));
  const rootSamples = times.map((time) =>
    rootTrackInfo ? evaluateVectorTrack(rootTrackInfo.track, time) : root.position.clone(),
  );
  const rootQuaternionSamples = times.map((time) =>
    rootQuaternionTrackInfo ? evaluateQuaternionTrack(rootQuaternionTrackInfo.track, time) : root.quaternion.clone(),
  );
  const hipsQuaternionSamples = times.map((time) =>
    hipsQuaternionTrackInfo ? evaluateQuaternionTrack(hipsQuaternionTrackInfo.track, time) : hips.quaternion.clone(),
  );
  const characterQuaternionSamples = rootQuaternionSamples.map((rootQ, index) =>
    rootQ.clone().multiply(hipsQuaternionSamples[index]).normalize(),
  );
  const rootYawSamples = unwrapYawSamples(rootQuaternionSamples).map(THREE.MathUtils.radToDeg);
  const characterYawSamples = unwrapYawSamples(characterQuaternionSamples).map(THREE.MathUtils.radToDeg);
  const hipsStart = hipsSamples[0].clone();
  const rootStart = rootSamples[0].clone();

  return {
    duration: clip.duration,
    rootName: root.name || "Root",
    hipsName: hips.name || "Hips",
    samples: times.map((time, index) => {
      const hipsDelta = hipsSamples[index].clone().sub(hipsStart);
      const rootDelta = rootSamples[index].clone().sub(rootStart);
      return {
        time,
        characterX: rootDelta.x + hipsDelta.x,
        characterZ: rootDelta.z + hipsDelta.z,
        rootX: rootDelta.x,
        rootZ: rootDelta.z,
        characterYaw: characterYawSamples[index],
        rootYaw: rootYawSamples[index],
      };
    }),
  };
}

export function extractRootMotionFromHips(
  model: THREE.Object3D,
  clip: THREE.AnimationClip,
  options: RootMotionExtractionOptions,
) {
  const hipsInfo = findHipsTrack(model, clip);
  const hips = hipsInfo.target;
  const root = hips.parent;
  if (!root) throw new Error(`${hips.name || "Hips"} has no parent to receive Root Motion.`);

  const allPositionTracks = positionTracks(model, clip);
  const allQuaternionTracks = quaternionTracks(model, clip);
  const rootTrackInfo = allPositionTracks.find(({ target }) => target === root);
  const rootQuaternionTrackInfo = allQuaternionTracks.find(({ target }) => target === root);
  const hipsQuaternionTrackInfo = allQuaternionTracks.find(({ target }) => target === hips);
  const times = sampleTimes(clip.duration, options.fps ?? 30);
  const hipsSamples = times.map((time) => evaluateVectorTrack(hipsInfo.track, time));
  const hipsStart = hipsSamples[0].clone();
  const planarLocal = hipsSamples.map((sample) =>
    new THREE.Vector3(sample.x - hipsStart.x, 0, sample.z - hipsStart.z),
  );

  const rootBase = rootTrackInfo
    ? evaluateVectorTrack(rootTrackInfo.track, 0)
    : root.position.clone();
  const rootRotation = rootQuaternionTrackInfo
    ? evaluateQuaternionTrack(rootQuaternionTrackInfo.track, 0)
    : root.quaternion.clone();
  const inverseRootRotation = rootRotation.clone().invert();

  const extractX = options.extractX !== false;
  const extractZ = options.extractZ !== false;
  const extractPosition = extractX || extractZ;
  const selectedParentPlanar = planarLocal.map((sample) => {
    const parentSpace = sample.clone().applyQuaternion(rootRotation);
    parentSpace.y = 0;
    if (!extractX) parentSpace.x = 0;
    if (!extractZ) parentSpace.z = 0;
    return parentSpace;
  });
  const selectedLocal = selectedParentPlanar.map((sample) => {
    const local = sample.clone().applyQuaternion(inverseRootRotation);
    local.y = 0;
    return local;
  });
  const finalSelectedParent = selectedParentPlanar[selectedParentPlanar.length - 1];
  const planarDistance = Math.hypot(finalSelectedParent.x, finalSelectedParent.z);
  if (extractPosition && extractX && extractZ && planarDistance < 1e-5) {
    throw new Error("Hips has almost no net planar displacement to extract.");
  }

  const smoothingWindow = normalizeWindow(options.velocitySmoothingWindow);
  const tolerance = options.velocityTolerance ?? 0.2;
  const keyIndices = extractPosition
    ? (options.mode === "linear"
      ? [0, times.length - 1]
      : selectVelocityGuidedKeys(times, selectedParentPlanar, smoothingWindow, tolerance))
    : [0];

  const extractYaw = options.extractYaw === true;
  if (extractYaw && !hipsQuaternionTrackInfo) {
    throw new Error("Extract Yaw requires an animated Hips/Pelvis quaternion track.");
  }
  const hipsQuaternionSamples = extractYaw
    ? times.map((time) => evaluateQuaternionTrack(hipsQuaternionTrackInfo!.track, time))
    : [];
  const rawYaw = extractYaw ? unwrapYawSamples(hipsQuaternionSamples) : times.map(() => 0);
  const yawMode = options.yawMode ?? "rdp";
  const yawKeyIndices = extractYaw
    ? (yawMode === "linear"
      ? [0, times.length - 1]
      : selectYawRdpKeys(times, rawYaw, options.yawToleranceDegrees ?? 1))
    : [0];
  const extractedYaw = extractYaw
    ? rawYaw.map((_, index) => interpolateScalarAnchors(index, yawKeyIndices, rawYaw))
    : rawYaw;

  const rootTimes = extractPosition ? keyIndices.map((index) => times[index]) : [];
  let rootTrack: THREE.VectorKeyframeTrack | null = null;
  if (extractPosition) {
    const rootValues: number[] = [];
    keyIndices.forEach((index) => {
      const parentSpaceOffset = selectedParentPlanar[index];
      rootValues.push(
        rootBase.x + parentSpaceOffset.x,
        rootBase.y,
        rootBase.z + parentSpaceOffset.z,
      );
    });
    const rootTrackName = rootTrackInfo?.track.name ?? `${root.uuid}.position`;
    rootTrack = new THREE.VectorKeyframeTrack(rootTrackName, rootTimes, rootValues);
  }

  let rootQuaternionTrack: THREE.QuaternionKeyframeTrack | null = null;
  if (extractYaw) {
    const rootQuaternionValues: number[] = [];
    yawKeyIndices.forEach((index) => {
      const yawQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), extractedYaw[index]);
      const q = rootRotation.clone().multiply(yawQ).normalize();
      rootQuaternionValues.push(q.x, q.y, q.z, q.w);
    });
    rootQuaternionTrack = new THREE.QuaternionKeyframeTrack(
      rootQuaternionTrackInfo?.track.name ?? `${root.uuid}.quaternion`,
      yawKeyIndices.map((index) => times[index]),
      rootQuaternionValues,
    );
  }

  let compensatedHipsTrack: THREE.VectorKeyframeTrack | null = null;
  if (extractPosition || extractYaw) {
    const compensatedHipsValues: number[] = [];
    hipsSamples.forEach((sample, index) => {
      const extractedLocal = extractPosition
        ? interpolateAnchors(index, keyIndices, selectedLocal)
        : new THREE.Vector3();
      const residual = new THREE.Vector3(
        sample.x - extractedLocal.x,
        sample.y,
        sample.z - extractedLocal.z,
      );
      if (extractYaw) residual.applyAxisAngle(new THREE.Vector3(0, 1, 0), -extractedYaw[index]);
      compensatedHipsValues.push(residual.x, residual.y, residual.z);
    });
    compensatedHipsTrack = new THREE.VectorKeyframeTrack(
      hipsInfo.track.name,
      times,
      compensatedHipsValues,
    );
  }

  let compensatedHipsQuaternionTrack: THREE.QuaternionKeyframeTrack | null = null;
  if (extractYaw && hipsQuaternionTrackInfo) {
    const values: number[] = [];
    hipsQuaternionSamples.forEach((q, index) => {
      const inverseYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -extractedYaw[index]);
      const residual = inverseYaw.multiply(q.clone()).normalize();
      values.push(residual.x, residual.y, residual.z, residual.w);
    });
    compensatedHipsQuaternionTrack = new THREE.QuaternionKeyframeTrack(hipsQuaternionTrackInfo.track.name, times, values);
  }

  const tracks = clip.tracks
    .filter((track) =>
      (!(extractPosition || extractYaw) || track !== hipsInfo.track) &&
      (!extractPosition || track !== rootTrackInfo?.track) &&
      (!extractYaw || (track !== rootQuaternionTrackInfo?.track && track !== hipsQuaternionTrackInfo?.track))
    )
    .map((track) => track.clone());
  if (compensatedHipsTrack) tracks.push(compensatedHipsTrack);
  if (rootTrack) tracks.push(rootTrack);
  if (compensatedHipsQuaternionTrack) tracks.push(compensatedHipsQuaternionTrack);
  if (rootQuaternionTrack) tracks.push(rootQuaternionTrack);
  const resultClip = new THREE.AnimationClip(clip.name, clip.duration, tracks);

  const report: RootMotionExtractionReport = {
    rootName: root.name || "<unnamed root>",
    hipsName: hips.name || "<unnamed hips>",
    mode: options.mode,
    sampleCount: times.length,
    rootKeyCount: extractPosition ? keyIndices.length : 0,
    rootKeyTimes: rootTimes,
    planarDisplacement: [finalSelectedParent.x, finalSelectedParent.z],
    planarDistance,
    extractedYawDegrees: THREE.MathUtils.radToDeg(extractedYaw[extractedYaw.length - 1] ?? 0),
    yawKeyCount: extractYaw ? yawKeyIndices.length : 0,
  };
  return { clip: resultClip, report };
}