import * as THREE from "three";

export type AnimationLoopFixMode = "cyclic" | "inertial";

export type AnimationLoopFixOptions = {
  mode?: AnimationLoopFixMode;
  inertialHalfLife?: number;
};

export type AnimationLoopFixReport = {
  repairedPositionTracks: number;
  repairedQuaternionTracks: number;
  skippedTracks: number;
};

type TrackFilter = (track: THREE.KeyframeTrack) => boolean;

const DEFAULT_INERTIAL_HALF_LIFE = 0.09;

function quinticCorrection(
  c0: number,
  d1: number,
  d2: number,
  duration: number,
  t: number,
) {
  const span = Math.max(1e-6, duration);
  const derivative = d1 * span;
  const acceleration = d2 * span * span;
  const a3 = 10 * c0 - 4 * derivative + 0.5 * acceleration;
  const a4 = -15 * c0 + 7 * derivative - acceleration;
  const a5 = 6 * c0 - 3 * derivative + 0.5 * acceleration;
  const t2 = t * t;
  const t3 = t2 * t;
  return a3 * t3 + a4 * t3 * t + a5 * t3 * t2;
}

function resolveSampleTimes(count: number, times?: ArrayLike<number>) {
  if (times && times.length === count) {
    const resolved = Array.from({ length: count }, (_, index) => Number(times[index]));
    if (resolved.every((value, index) => index === 0 || value > resolved[index - 1])) return resolved;
  }
  return Array.from({ length: count }, (_, index) => index);
}

function quadraticEndpointDerivatives(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x: number,
) {
  const d0 = (x0 - x1) * (x0 - x2);
  const d1 = (x1 - x0) * (x1 - x2);
  const d2 = (x2 - x0) * (x2 - x1);
  if (Math.abs(d0) < 1e-12 || Math.abs(d1) < 1e-12 || Math.abs(d2) < 1e-12) {
    return { first: 0, second: 0 };
  }
  return {
    first:
      y0 * (2 * x - x1 - x2) / d0
      + y1 * (2 * x - x0 - x2) / d1
      + y2 * (2 * x - x0 - x1) / d2,
    second: 2 * (y0 / d0 + y1 / d1 + y2 / d2),
  };
}

export function repairLoopScalarSamples(
  source: ArrayLike<number>,
  times?: ArrayLike<number>,
): Float32Array {
  const count = source.length;
  const corrected = new Float32Array(count);
  for (let i = 0; i < count; i += 1) corrected[i] = Number(source[i]);
  if (count < 4) return corrected;

  const at = (index: number) => Number(source[index]);
  const sampleTimes = resolveSampleTimes(count, times);
  const startTime = sampleTimes[0];
  const endTime = sampleTimes[count - 1];
  const duration = Math.max(1e-6, endTime - startTime);
  const start = quadraticEndpointDerivatives(
    sampleTimes[0], at(0), sampleTimes[1], at(1), sampleTimes[2], at(2), sampleTimes[0],
  );
  const end = quadraticEndpointDerivatives(
    sampleTimes[count - 3], at(count - 3),
    sampleTimes[count - 2], at(count - 2),
    sampleTimes[count - 1], at(count - 1),
    sampleTimes[count - 1],
  );
  const c0 = at(0) - at(count - 1);
  const d1 = start.first - end.first;
  const d2 = start.second - end.second;

  for (let i = 0; i < count; i += 1) {
    const t = (sampleTimes[i] - startTime) / duration;
    corrected[i] = at(i) + quinticCorrection(c0, d1, d2, duration, t);
  }
  return corrected;
}

/**
 * Matches the loop-point translation velocity while preserving the original
 * start/end positions and therefore the accumulated displacement.
 *
 * Root-local mode compares each endpoint velocity in that endpoint's Root
 * orientation frame. This keeps turning locomotion continuous without forcing
 * the world-space velocity direction to match across the loop boundary.
 */
export type LoopTranslationVelocitySpace = "track" | "root-local";

export const DEFAULT_LOOP_TRANSLATION_VELOCITY_SPACE: LoopTranslationVelocitySpace = "root-local";

export type LoopTranslationVelocityOptions = {
  space?: LoopTranslationVelocitySpace;
  orientationTrack?: THREE.QuaternionKeyframeTrack | null;
};

export type LoopTranslationVelocityMeasurement = {
  space: LoopTranslationVelocitySpace;
  start: [number, number, number];
  end: [number, number, number];
  mismatch: number;
};

function resolveLoopTranslationVelocitySpace(
  options?: LoopTranslationVelocityOptions,
): LoopTranslationVelocitySpace {
  return options?.space ?? DEFAULT_LOOP_TRANSLATION_VELOCITY_SPACE;
}

function trackNodeName(track: THREE.KeyframeTrack) {
  try {
    return THREE.PropertyBinding.parseTrackName(track.name).nodeName ?? null;
  } catch {
    return null;
  }
}

export function findLoopTranslationOrientationTrack(
  clip: THREE.AnimationClip,
  positionTrack: THREE.VectorKeyframeTrack,
): THREE.QuaternionKeyframeTrack | null {
  const nodeName = trackNodeName(positionTrack);
  if (!nodeName) return null;
  return clip.tracks.find((track): track is THREE.QuaternionKeyframeTrack => (
    track instanceof THREE.QuaternionKeyframeTrack
    && track.name.endsWith(".quaternion")
    && trackNodeName(track) === nodeName
  )) ?? null;
}

function sampleQuaternionTrack(
  track: THREE.QuaternionKeyframeTrack | null | undefined,
  time: number,
) {
  if (!track || track.times.length === 0 || track.values.length < 4) return new THREE.Quaternion();
  const count = track.times.length;
  const read = (index: number) => {
    const offset = index * 4;
    return new THREE.Quaternion(
      Number(track.values[offset]),
      Number(track.values[offset + 1]),
      Number(track.values[offset + 2]),
      Number(track.values[offset + 3]),
    ).normalize();
  };
  if (count === 1 || time <= Number(track.times[0])) return read(0);
  if (time >= Number(track.times[count - 1])) return read(count - 1);
  let upper = 1;
  while (upper < count && Number(track.times[upper]) < time) upper += 1;
  const lower = Math.max(0, upper - 1);
  const t0 = Number(track.times[lower]);
  const t1 = Number(track.times[upper]);
  const alpha = THREE.MathUtils.clamp((time - t0) / Math.max(1e-6, t1 - t0), 0, 1);
  return read(lower).slerp(read(upper), alpha).normalize();
}

function measureTrackEndpointTranslationVelocity(track: THREE.VectorKeyframeTrack) {
  const count = track.times.length;
  if (count < 3 || track.values.length !== count * 3) return null;
  const sampleTimes = resolveSampleTimes(count, track.times);
  const start = new THREE.Vector3();
  const end = new THREE.Vector3();
  for (let axis = 0; axis < 3; axis += 1) {
    const at = (index: number) => Number(track.values[index * 3 + axis]);
    start.setComponent(axis, quadraticEndpointDerivatives(
      sampleTimes[0], at(0), sampleTimes[1], at(1), sampleTimes[2], at(2), sampleTimes[0],
    ).first);
    end.setComponent(axis, quadraticEndpointDerivatives(
      sampleTimes[count - 3], at(count - 3),
      sampleTimes[count - 2], at(count - 2),
      sampleTimes[count - 1], at(count - 1),
      sampleTimes[count - 1],
    ).first);
  }
  return { start, end, sampleTimes };
}

export function repairLoopScalarVelocitySamples(
  source: ArrayLike<number>,
  times?: ArrayLike<number>,
): Float32Array {
  const count = source.length;
  const corrected = new Float32Array(count);
  for (let i = 0; i < count; i += 1) corrected[i] = Number(source[i]);
  if (count < 4) return corrected;

  const at = (index: number) => Number(source[index]);
  const sampleTimes = resolveSampleTimes(count, times);
  const startTime = sampleTimes[0];
  const endTime = sampleTimes[count - 1];
  const duration = Math.max(1e-6, endTime - startTime);
  const start = quadraticEndpointDerivatives(
    sampleTimes[0], at(0), sampleTimes[1], at(1), sampleTimes[2], at(2), sampleTimes[0],
  );
  const end = quadraticEndpointDerivatives(
    sampleTimes[count - 3], at(count - 3),
    sampleTimes[count - 2], at(count - 2),
    sampleTimes[count - 1], at(count - 1),
    sampleTimes[count - 1],
  );

  const velocityDelta = end.first - start.first;
  const startCorrectionVelocity = velocityDelta * 0.5;
  const endCorrectionVelocity = -velocityDelta * 0.5;

  for (let i = 0; i < count; i += 1) {
    const t = THREE.MathUtils.clamp((sampleTimes[i] - startTime) / duration, 0, 1);
    const t2 = t * t;
    const t3 = t2 * t;
    const startTangentBasis = t3 - 2 * t2 + t;
    const endTangentBasis = t3 - t2;
    const correction = duration * (
      startCorrectionVelocity * startTangentBasis
      + endCorrectionVelocity * endTangentBasis
    );
    corrected[i] = at(i) + correction;
  }

  return corrected;
}

export function measureLoopTranslationVelocity(
  track: THREE.VectorKeyframeTrack,
  options?: LoopTranslationVelocityOptions,
): LoopTranslationVelocityMeasurement | null {
  const space = resolveLoopTranslationVelocitySpace(options);
  const measured = measureTrackEndpointTranslationVelocity(track);
  if (!measured) return null;

  const start = measured.start.clone();
  const end = measured.end.clone();
  if (space === "root-local") {
    const startOrientation = sampleQuaternionTrack(options?.orientationTrack, measured.sampleTimes[0]);
    const endOrientation = sampleQuaternionTrack(
      options?.orientationTrack,
      measured.sampleTimes[measured.sampleTimes.length - 1],
    );
    start.applyQuaternion(startOrientation.invert());
    end.applyQuaternion(endOrientation.invert());
  }

  return {
    space,
    start: [start.x, start.y, start.z],
    end: [end.x, end.y, end.z],
    mismatch: start.distanceTo(end),
  };
}

function finiteSupportDecay(time: number, duration: number, halfLife: number) {
  const lambda = Math.LN2 / Math.max(1e-4, halfLife);
  const horizon = Math.max(1e-4, Math.min(duration, halfLife * 6));
  const s = THREE.MathUtils.clamp(time / horizon, 0, 1);
  const cutoff = 1 - (3 * s * s - 2 * s * s * s);
  return { lambda, cutoff };
}

export function repairLoopScalarSamplesInertial(
  source: ArrayLike<number>,
  times: ArrayLike<number>,
  halfLife = DEFAULT_INERTIAL_HALF_LIFE,
): Float32Array {
  const count = source.length;
  const corrected = new Float32Array(count);
  for (let i = 0; i < count; i += 1) corrected[i] = Number(source[i]);
  if (count < 3 || times.length !== count) return corrected;

  const t0 = Number(times[0]);
  const duration = Math.max(1e-4, Number(times[count - 1]) - t0);
  const startDt = Math.max(1e-6, Number(times[1]) - Number(times[0]));
  const endDt = Math.max(1e-6, Number(times[count - 1]) - Number(times[count - 2]));
  const start = Number(source[0]);
  const end = Number(source[count - 1]);
  const startVelocity = (Number(source[1]) - start) / startDt;
  const endVelocity = (end - Number(source[count - 2])) / endDt;
  const positionOffset = end - start;
  const velocityOffset = endVelocity - startVelocity;
  const lambda = Math.LN2 / Math.max(1e-4, halfLife);
  const linearTerm = velocityOffset + lambda * positionOffset;

  for (let i = 0; i < count; i += 1) {
    const time = Math.max(0, Number(times[i]) - t0);
    const { cutoff } = finiteSupportDecay(time, duration, halfLife);
    const correction = (positionOffset + linearTerm * time) * Math.exp(-lambda * time) * cutoff;
    corrected[i] = Number(source[i]) + correction;
  }
  return corrected;
}

function repairVectorTrack(
  track: THREE.VectorKeyframeTrack,
  mode: AnimationLoopFixMode,
  inertialHalfLife: number,
) {
  const count = track.times.length;
  if (count < 4 || track.values.length !== count * 3) return false;
  const values = track.values;
  const corrected = new Float32Array(values.length);
  corrected.set(values as ArrayLike<number>);

  for (let axis = 0; axis < 3; axis += 1) {
    const axisValues = Array.from({ length: count }, (_, index) => Number(values[index * 3 + axis]));
    const repaired = mode === "inertial"
      ? repairLoopScalarSamplesInertial(axisValues, track.times, inertialHalfLife)
      : repairLoopScalarSamples(axisValues, track.times);
    for (let i = 0; i < count; i += 1) corrected[i * 3 + axis] = repaired[i];
  }

  track.values = corrected;
  return true;
}

function repairVectorTrackVelocityContinuity(
  track: THREE.VectorKeyframeTrack,
  options?: LoopTranslationVelocityOptions,
) {
  const space = resolveLoopTranslationVelocitySpace(options);
  const count = track.times.length;
  if (count < 4 || track.values.length !== count * 3) return false;

  const baseMeasured = measureTrackEndpointTranslationVelocity(track);
  if (!baseMeasured) return false;
  const startTime = baseMeasured.sampleTimes[0];
  const endTime = baseMeasured.sampleTimes[count - 1];
  const duration = Math.max(1e-6, endTime - startTime);
  const startOrientation = space === "root-local"
    ? sampleQuaternionTrack(options?.orientationTrack, startTime)
    : new THREE.Quaternion();
  const endOrientation = space === "root-local"
    ? sampleQuaternionTrack(options?.orientationTrack, endTime)
    : new THREE.Quaternion();
  const turningRoot = space === "root-local"
    && startOrientation.angleTo(endOrientation) > 1e-5;
  const maxIterations = turningRoot ? 10 : 1;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const measured = measureTrackEndpointTranslationVelocity(track);
    if (!measured) return false;
    let startCorrectionVelocity: THREE.Vector3;
    let endCorrectionVelocity: THREE.Vector3;

    if (turningRoot) {
      const localStart = measured.start.clone().applyQuaternion(startOrientation.clone().invert());
      const localEnd = measured.end.clone().applyQuaternion(endOrientation.clone().invert());
      const localDelta = localEnd.sub(localStart);
      if (localDelta.length() <= 1e-6) break;
      startCorrectionVelocity = localDelta.clone().multiplyScalar(0.5).applyQuaternion(startOrientation);
      endCorrectionVelocity = localDelta.clone().multiplyScalar(-0.5).applyQuaternion(endOrientation);
    } else {
      const velocityDelta = measured.end.clone().sub(measured.start);
      startCorrectionVelocity = velocityDelta.clone().multiplyScalar(0.5);
      endCorrectionVelocity = velocityDelta.multiplyScalar(-0.5);
    }

    const corrected = new Float32Array(track.values.length);
    for (let i = 0; i < count; i += 1) {
      const t = THREE.MathUtils.clamp((measured.sampleTimes[i] - startTime) / duration, 0, 1);
      const t2 = t * t;
      const t3 = t2 * t;
      const startTangentBasis = t3 - 2 * t2 + t;
      const endTangentBasis = t3 - t2;
      const correction = startCorrectionVelocity.clone().multiplyScalar(startTangentBasis)
        .addScaledVector(endCorrectionVelocity, endTangentBasis)
        .multiplyScalar(duration);
      const offset = i * 3;
      corrected[offset] = Number(track.values[offset]) + correction.x;
      corrected[offset + 1] = Number(track.values[offset + 1]) + correction.y;
      corrected[offset + 2] = Number(track.values[offset + 2]) + correction.z;
    }
    track.values = corrected;
  }

  return true;
}

function quaternionAt(values: ArrayLike<number>, index: number) {
  const offset = index * 4;
  return new THREE.Quaternion(
    Number(values[offset]),
    Number(values[offset + 1]),
    Number(values[offset + 2]),
    Number(values[offset + 3]),
  ).normalize();
}

function quaternionStep(from: THREE.Quaternion, to: THREE.Quaternion) {
  const delta = from.clone().invert().multiply(to).normalize();
  if (delta.w < 0) {
    delta.x *= -1;
    delta.y *= -1;
    delta.z *= -1;
    delta.w *= -1;
  }
  const sinHalf = Math.hypot(delta.x, delta.y, delta.z);
  if (sinHalf < 1e-8) return new THREE.Vector3();
  const angle = 2 * Math.atan2(sinHalf, THREE.MathUtils.clamp(delta.w, -1, 1));
  return new THREE.Vector3(delta.x, delta.y, delta.z).multiplyScalar(angle / sinHalf);
}

function quaternionExp(rotationVector: THREE.Vector3) {
  const angle = rotationVector.length();
  if (angle < 1e-8) {
    return new THREE.Quaternion(
      rotationVector.x * 0.5,
      rotationVector.y * 0.5,
      rotationVector.z * 0.5,
      1,
    ).normalize();
  }
  const half = angle * 0.5;
  const scale = Math.sin(half) / angle;
  return new THREE.Quaternion(
    rotationVector.x * scale,
    rotationVector.y * scale,
    rotationVector.z * scale,
    Math.cos(half),
  );
}

function continuousQuaternions(track: THREE.QuaternionKeyframeTrack) {
  const quaternions = Array.from(
    { length: track.times.length },
    (_, index) => quaternionAt(track.values, index),
  );
  for (let i = 1; i < quaternions.length; i += 1) {
    if (quaternions[i - 1].dot(quaternions[i]) < 0) {
      quaternions[i].x *= -1;
      quaternions[i].y *= -1;
      quaternions[i].z *= -1;
      quaternions[i].w *= -1;
    }
  }
  return quaternions;
}

function repairQuaternionTrackCyclic(track: THREE.QuaternionKeyframeTrack) {
  const count = track.times.length;
  if (count < 4 || track.values.length !== count * 4) return false;
  const quaternions = continuousQuaternions(track);
  const times = resolveSampleTimes(count, track.times);
  const startTime = times[0];
  const duration = Math.max(1e-6, times[count - 1] - startTime);
  const startDt = Math.max(1e-6, times[1] - times[0]);
  const nextDt = Math.max(1e-6, times[2] - times[1]);
  const previousDt = Math.max(1e-6, times[count - 2] - times[count - 3]);
  const endDt = Math.max(1e-6, times[count - 1] - times[count - 2]);

  const startVelocity = quaternionStep(quaternions[0], quaternions[1]).multiplyScalar(1 / startDt);
  const nextVelocity = quaternionStep(quaternions[1], quaternions[2]).multiplyScalar(1 / nextDt);
  const previousVelocity = quaternionStep(quaternions[count - 3], quaternions[count - 2]).multiplyScalar(1 / previousDt);
  const endVelocity = quaternionStep(quaternions[count - 2], quaternions[count - 1]).multiplyScalar(1 / endDt);
  const c0 = quaternionStep(quaternions[count - 1], quaternions[0]);
  const d1 = startVelocity.clone().sub(endVelocity);
  const startAcceleration = nextVelocity.clone().sub(startVelocity)
    .multiplyScalar(2 / Math.max(1e-6, times[2] - times[0]));
  const endAcceleration = endVelocity.clone().sub(previousVelocity)
    .multiplyScalar(2 / Math.max(1e-6, times[count - 1] - times[count - 3]));
  const d2 = startAcceleration.sub(endAcceleration);

  const corrected = new Float32Array(count * 4);
  for (let i = 0; i < count; i += 1) {
    const t = (times[i] - startTime) / duration;
    const correction = new THREE.Vector3(
      quinticCorrection(c0.x, d1.x, d2.x, duration, t),
      quinticCorrection(c0.y, d1.y, d2.y, duration, t),
      quinticCorrection(c0.z, d1.z, d2.z, duration, t),
    );
    const q = quaternions[i].clone().multiply(quaternionExp(correction)).normalize();
    const offset = i * 4;
    corrected[offset] = q.x;
    corrected[offset + 1] = q.y;
    corrected[offset + 2] = q.z;
    corrected[offset + 3] = q.w;
  }
  track.values = corrected;
  return true;
}

function repairQuaternionTrackInertial(
  track: THREE.QuaternionKeyframeTrack,
  halfLife: number,
) {
  const count = track.times.length;
  if (count < 3 || track.values.length !== count * 4) return false;
  const quaternions = continuousQuaternions(track);
  const t0 = Number(track.times[0]);
  const duration = Math.max(1e-4, Number(track.times[count - 1]) - t0);
  const startDt = Math.max(1e-6, Number(track.times[1]) - Number(track.times[0]));
  const endDt = Math.max(1e-6, Number(track.times[count - 1]) - Number(track.times[count - 2]));
  const poseOffset = quaternionStep(quaternions[0], quaternions[count - 1]);
  const startVelocity = quaternionStep(quaternions[0], quaternions[1]).multiplyScalar(1 / startDt);
  const endVelocity = quaternionStep(quaternions[count - 2], quaternions[count - 1]).multiplyScalar(1 / endDt);
  const velocityOffset = endVelocity.sub(startVelocity);
  const lambda = Math.LN2 / Math.max(1e-4, halfLife);
  const linearTerm = velocityOffset.addScaledVector(poseOffset, lambda);

  const corrected = new Float32Array(count * 4);
  for (let i = 0; i < count; i += 1) {
    const time = Math.max(0, Number(track.times[i]) - t0);
    const { cutoff } = finiteSupportDecay(time, duration, halfLife);
    const correction = poseOffset.clone()
      .addScaledVector(linearTerm, time)
      .multiplyScalar(Math.exp(-lambda * time) * cutoff);
    const q = quaternions[i].clone().multiply(quaternionExp(correction)).normalize();
    const offset = i * 4;
    corrected[offset] = q.x;
    corrected[offset + 1] = q.y;
    corrected[offset + 2] = q.z;
    corrected[offset + 3] = q.w;
  }
  track.values = corrected;
  return true;
}

/** Repairs one pristine clip for the requested loop strategy. */
export function repairAnimationLoop(
  source: THREE.AnimationClip,
  shouldRepairTrack: TrackFilter = () => true,
  options: AnimationLoopFixOptions = {},
): { clip: THREE.AnimationClip; report: AnimationLoopFixReport } {
  const mode = options.mode ?? "cyclic";
  const inertialHalfLife = options.inertialHalfLife ?? DEFAULT_INERTIAL_HALF_LIFE;
  const clip = source.clone();
  const report: AnimationLoopFixReport = {
    repairedPositionTracks: 0,
    repairedQuaternionTracks: 0,
    skippedTracks: 0,
  };

  clip.tracks.forEach((track) => {
    if (!shouldRepairTrack(track)) {
      report.skippedTracks += 1;
      return;
    }
    if (track instanceof THREE.QuaternionKeyframeTrack) {
      const repaired = mode === "inertial"
        ? repairQuaternionTrackInertial(track, inertialHalfLife)
        : repairQuaternionTrackCyclic(track);
      if (repaired) report.repairedQuaternionTracks += 1;
      else report.skippedTracks += 1;
      return;
    }
    if (track instanceof THREE.VectorKeyframeTrack && track.name.endsWith(".position")) {
      if (repairVectorTrack(track, mode, inertialHalfLife)) report.repairedPositionTracks += 1;
      else report.skippedTracks += 1;
      return;
    }
    report.skippedTracks += 1;
  });

  const suffix = mode === "inertial" ? "Inertial Loop Fixed" : "Cyclic Loop Fixed";
  clip.name = source.name ? `${source.name} (${suffix})` : suffix;
  clip.resetDuration();
  return { clip, report };
}

/**
 * Repairs only translation-velocity continuity for selected position tracks.
 * Unlike the normal cyclic repair, this intentionally keeps endpoint
 * positions unchanged so root-motion displacement continues accumulating.
 */
export function repairAnimationLoopTranslationVelocity(
  source: THREE.AnimationClip,
  shouldRepairTrack: TrackFilter = () => true,
  options?: LoopTranslationVelocityOptions,
): { clip: THREE.AnimationClip; report: AnimationLoopFixReport } {
  const space = resolveLoopTranslationVelocitySpace(options);
  const clip = source.clone();
  const report: AnimationLoopFixReport = {
    repairedPositionTracks: 0,
    repairedQuaternionTracks: 0,
    skippedTracks: 0,
  };

  clip.tracks.forEach((track) => {
    if (
      !shouldRepairTrack(track)
      || !(track instanceof THREE.VectorKeyframeTrack)
      || !track.name.endsWith('.position')
    ) {
      report.skippedTracks += 1;
      return;
    }
    const trackOptions: LoopTranslationVelocityOptions = space === "root-local"
      ? {
        ...options,
        orientationTrack: options?.orientationTrack ?? findLoopTranslationOrientationTrack(source, track),
      }
      : options ?? { space };
    if (repairVectorTrackVelocityContinuity(track, trackOptions)) report.repairedPositionTracks += 1;
    else report.skippedTracks += 1;
  });

  const suffix = 'Root Velocity Loop Fixed';
  clip.name = source.name ? `${source.name} (${suffix})` : suffix;
  clip.resetDuration();
  return { clip, report };
}
