import * as THREE from "three";

export type MotionDecompositionBaseMode = "preserve" | "static";

export type MotionDecompositionOptions = {
  baseMode?: MotionDecompositionBaseMode;
  lowGain?: number;
  midGain?: number;
  fineGain?: number;
};

export type MotionDecompositionReport = {
  bands: 4;
  processedPositionTracks: number;
  processedQuaternionTracks: number;
  passthroughTracks: number;
  baseMode: MotionDecompositionBaseMode;
  lowGain: number;
  midGain: number;
  fineGain: number;
  maxPositionReconstructionError: number;
  maxQuaternionReconstructionAngle: number;
};

type VectorBands = {
  kind: "vector";
  source: THREE.VectorKeyframeTrack;
  base: Float32Array;
  low: Float32Array;
  mid: Float32Array;
  fine: Float32Array;
};

type QuaternionBands = {
  kind: "quaternion";
  source: THREE.QuaternionKeyframeTrack;
  base: Float32Array;
  low: Float32Array;
  mid: Float32Array;
  fine: Float32Array;
};

type PassthroughTrack = {
  kind: "passthrough";
  source: THREE.KeyframeTrack;
};

export type MotionDecompositionTrack = VectorBands | QuaternionBands | PassthroughTrack;

export type MotionDecomposition = {
  sourceName: string;
  duration: number;
  blendMode: THREE.AnimationBlendMode;
  tracks: MotionDecompositionTrack[];
};

const KERNEL = [1, 4, 6, 4, 1] as const;
const KERNEL_SUM = 16;
const DEFAULT_OPTIONS: Required<MotionDecompositionOptions> = {
  baseMode: "preserve",
  lowGain: 1,
  midGain: 1,
  fineGain: 1,
};

function clampIndex(index: number, count: number) {
  return Math.max(0, Math.min(count - 1, index));
}

function cloneValues(values: ArrayLike<number>) {
  return Float32Array.from(values);
}

function smoothVectorOnce(values: Float32Array) {
  const count = Math.floor(values.length / 3);
  const result = new Float32Array(values.length);
  for (let i = 0; i < count; i += 1) {
    for (let component = 0; component < 3; component += 1) {
      let sum = 0;
      for (let tap = -2; tap <= 2; tap += 1) {
        const sample = clampIndex(i + tap, count);
        sum += values[sample * 3 + component] * KERNEL[tap + 2];
      }
      result[i * 3 + component] = sum / KERNEL_SUM;
    }
  }
  return result;
}

function smoothVector(values: Float32Array, passes: number) {
  let result = values;
  for (let pass = 0; pass < passes; pass += 1) result = smoothVectorOnce(result);
  return result;
}

function quaternionDot(values: Float32Array, a: number, b: number) {
  const ai = a * 4;
  const bi = b * 4;
  return values[ai] * values[bi] + values[ai + 1] * values[bi + 1] + values[ai + 2] * values[bi + 2] + values[ai + 3] * values[bi + 3];
}

function smoothQuaternionOnce(values: Float32Array) {
  const count = Math.floor(values.length / 4);
  const result = new Float32Array(values.length);
  for (let i = 0; i < count; i += 1) {
    const center = i * 4;
    let x = 0;
    let y = 0;
    let z = 0;
    let w = 0;
    for (let tap = -2; tap <= 2; tap += 1) {
      const sample = clampIndex(i + tap, count);
      const si = sample * 4;
      const sign = quaternionDot(values, i, sample) < 0 ? -1 : 1;
      const weight = KERNEL[tap + 2] * sign;
      x += values[si] * weight;
      y += values[si + 1] * weight;
      z += values[si + 2] * weight;
      w += values[si + 3] * weight;
    }
    const length = Math.hypot(x, y, z, w) || 1;
    result[center] = x / length;
    result[center + 1] = y / length;
    result[center + 2] = z / length;
    result[center + 3] = w / length;
  }
  return result;
}

function smoothQuaternion(values: Float32Array, passes: number) {
  let result = values;
  for (let pass = 0; pass < passes; pass += 1) result = smoothQuaternionOnce(result);
  return result;
}

function subtractVectors(a: Float32Array, b: Float32Array) {
  const result = new Float32Array(a.length);
  for (let i = 0; i < a.length; i += 1) result[i] = a[i] - b[i];
  return result;
}

function relativeQuaternions(coarse: Float32Array, fine: Float32Array) {
  const result = new Float32Array(fine.length);
  const inverse = new THREE.Quaternion();
  const detail = new THREE.Quaternion();
  for (let i = 0; i < fine.length; i += 4) {
    inverse.set(coarse[i], coarse[i + 1], coarse[i + 2], coarse[i + 3]).invert();
    detail.set(fine[i], fine[i + 1], fine[i + 2], fine[i + 3]).premultiply(inverse).normalize();
    result[i] = detail.x;
    result[i + 1] = detail.y;
    result[i + 2] = detail.z;
    result[i + 3] = detail.w;
  }
  return result;
}

function decomposeVectorTrack(track: THREE.VectorKeyframeTrack): VectorBands {
  const source = cloneValues(track.values);
  const level1 = smoothVector(source, 1);
  const level2 = smoothVector(level1, 2);
  const level3 = smoothVector(level2, 4);
  return {
    kind: "vector",
    source: track,
    base: level3,
    low: subtractVectors(level2, level3),
    mid: subtractVectors(level1, level2),
    fine: subtractVectors(source, level1),
  };
}

function decomposeQuaternionTrack(track: THREE.QuaternionKeyframeTrack): QuaternionBands {
  const source = cloneValues(track.values);
  const level1 = smoothQuaternion(source, 1);
  const level2 = smoothQuaternion(level1, 2);
  const level3 = smoothQuaternion(level2, 4);
  return {
    kind: "quaternion",
    source: track,
    base: level3,
    low: relativeQuaternions(level3, level2),
    mid: relativeQuaternions(level2, level1),
    fine: relativeQuaternions(level1, source),
  };
}

export function decomposeAnimationMotion(
  source: THREE.AnimationClip,
  shouldProcessTrack: (track: THREE.KeyframeTrack) => boolean = () => true,
): MotionDecomposition {
  const tracks = source.tracks.map<MotionDecompositionTrack>((track) => {
    if (!shouldProcessTrack(track) || track.times.length < 3) return { kind: "passthrough", source: track };
    if (track instanceof THREE.VectorKeyframeTrack && track.name.endsWith(".position")) return decomposeVectorTrack(track);
    if (track instanceof THREE.QuaternionKeyframeTrack && track.name.endsWith(".quaternion")) return decomposeQuaternionTrack(track);
    return { kind: "passthrough", source: track };
  });
  return { sourceName: source.name, duration: source.duration, blendMode: source.blendMode, tracks };
}

function representativeVector(values: Float32Array) {
  const count = Math.floor(values.length / 3);
  const result = new THREE.Vector3();
  for (let i = 0; i < count; i += 1) result.add(new THREE.Vector3(values[i * 3], values[i * 3 + 1], values[i * 3 + 2]));
  return count > 0 ? result.multiplyScalar(1 / count) : result;
}

function representativeQuaternion(values: Float32Array) {
  const count = Math.floor(values.length / 4);
  if (count === 0) return new THREE.Quaternion();
  const reference = new THREE.Quaternion(values[0], values[1], values[2], values[3]);
  let x = 0;
  let y = 0;
  let z = 0;
  let w = 0;
  const sample = new THREE.Quaternion();
  for (let i = 0; i < count; i += 1) {
    const offset = i * 4;
    sample.set(values[offset], values[offset + 1], values[offset + 2], values[offset + 3]);
    const sign = reference.dot(sample) < 0 ? -1 : 1;
    x += sample.x * sign;
    y += sample.y * sign;
    z += sample.z * sign;
    w += sample.w * sign;
  }
  return new THREE.Quaternion(x, y, z, w).normalize();
}

function addScaledVectorBands(track: VectorBands, options: Required<MotionDecompositionOptions>) {
  const result = new Float32Array(track.base.length);
  const stable = options.baseMode === "static" ? representativeVector(track.base) : null;
  for (let i = 0; i < result.length; i += 3) {
    result[i] = (stable ? stable.x : track.base[i]) + track.low[i] * options.lowGain + track.mid[i] * options.midGain + track.fine[i] * options.fineGain;
    result[i + 1] = (stable ? stable.y : track.base[i + 1]) + track.low[i + 1] * options.lowGain + track.mid[i + 1] * options.midGain + track.fine[i + 1] * options.fineGain;
    result[i + 2] = (stable ? stable.z : track.base[i + 2]) + track.low[i + 2] * options.lowGain + track.mid[i + 2] * options.midGain + track.fine[i + 2] * options.fineGain;
  }
  return result;
}

function scaledRelative(values: Float32Array, offset: number, gain: number, target: THREE.Quaternion) {
  const detail = new THREE.Quaternion(values[offset], values[offset + 1], values[offset + 2], values[offset + 3]);
  return target.identity().slerp(detail, gain).normalize();
}

function multiplyQuaternionBands(track: QuaternionBands, options: Required<MotionDecompositionOptions>) {
  const result = new Float32Array(track.base.length);
  const stable = options.baseMode === "static" ? representativeQuaternion(track.base) : null;
  const current = new THREE.Quaternion();
  const detail = new THREE.Quaternion();
  for (let i = 0; i < result.length; i += 4) {
    if (stable) current.copy(stable);
    else current.set(track.base[i], track.base[i + 1], track.base[i + 2], track.base[i + 3]);
    current.multiply(scaledRelative(track.low, i, options.lowGain, detail));
    current.multiply(scaledRelative(track.mid, i, options.midGain, detail));
    current.multiply(scaledRelative(track.fine, i, options.fineGain, detail));
    current.normalize();
    result[i] = current.x;
    result[i + 1] = current.y;
    result[i + 2] = current.z;
    result[i + 3] = current.w;
  }
  return result;
}

function cloneTrackWithValues(source: THREE.KeyframeTrack, values: Float32Array) {
  let track: THREE.KeyframeTrack;
  if (source instanceof THREE.VectorKeyframeTrack) track = new THREE.VectorKeyframeTrack(source.name, source.times.slice(), values);
  else if (source instanceof THREE.QuaternionKeyframeTrack) track = new THREE.QuaternionKeyframeTrack(source.name, source.times.slice(), values);
  else return source.clone();
  track.setInterpolation(source.getInterpolation());
  return track;
}

function vectorReconstructionError(track: VectorBands) {
  let error = 0;
  const rebuilt = addScaledVectorBands(track, DEFAULT_OPTIONS);
  for (let i = 0; i < rebuilt.length; i += 1) error = Math.max(error, Math.abs(rebuilt[i] - Number(track.source.values[i])));
  return error;
}

function quaternionReconstructionError(track: QuaternionBands) {
  let error = 0;
  const rebuilt = multiplyQuaternionBands(track, DEFAULT_OPTIONS);
  const a = new THREE.Quaternion();
  const b = new THREE.Quaternion();
  for (let i = 0; i < rebuilt.length; i += 4) {
    a.set(rebuilt[i], rebuilt[i + 1], rebuilt[i + 2], rebuilt[i + 3]);
    b.set(Number(track.source.values[i]), Number(track.source.values[i + 1]), Number(track.source.values[i + 2]), Number(track.source.values[i + 3]));
    error = Math.max(error, a.angleTo(b));
  }
  return error;
}

export function reconstructAnimationMotion(
  decomposition: MotionDecomposition,
  requestedOptions: MotionDecompositionOptions = {},
) {
  const options = { ...DEFAULT_OPTIONS, ...requestedOptions };
  let processedPositionTracks = 0;
  let processedQuaternionTracks = 0;
  let passthroughTracks = 0;
  let maxPositionReconstructionError = 0;
  let maxQuaternionReconstructionAngle = 0;

  const tracks = decomposition.tracks.map((track) => {
    if (track.kind === "passthrough") {
      passthroughTracks += 1;
      return track.source.clone();
    }
    if (track.kind === "vector") {
      processedPositionTracks += 1;
      maxPositionReconstructionError = Math.max(maxPositionReconstructionError, vectorReconstructionError(track));
      return cloneTrackWithValues(track.source, addScaledVectorBands(track, options));
    }
    processedQuaternionTracks += 1;
    maxQuaternionReconstructionAngle = Math.max(maxQuaternionReconstructionAngle, quaternionReconstructionError(track));
    return cloneTrackWithValues(track.source, multiplyQuaternionBands(track, options));
  });

  return {
    clip: new THREE.AnimationClip(decomposition.sourceName, decomposition.duration, tracks, decomposition.blendMode),
    report: {
      bands: 4,
      processedPositionTracks,
      processedQuaternionTracks,
      passthroughTracks,
      baseMode: options.baseMode,
      lowGain: options.lowGain,
      midGain: options.midGain,
      fineGain: options.fineGain,
      maxPositionReconstructionError,
      maxQuaternionReconstructionAngle,
    } satisfies MotionDecompositionReport,
  };
}

export function processAnimationMotionDecomposition(
  source: THREE.AnimationClip,
  options: MotionDecompositionOptions = {},
  shouldProcessTrack: (track: THREE.KeyframeTrack) => boolean = () => true,
) {
  return reconstructAnimationMotion(decomposeAnimationMotion(source, shouldProcessTrack), options);
}

export function mergeMotionDecompositionReports(reports: MotionDecompositionReport[]): MotionDecompositionReport | null {
  if (reports.length === 0) return null;
  const first = reports[0];
  return reports.reduce<MotionDecompositionReport>((merged, report) => ({
    ...merged,
    processedPositionTracks: merged.processedPositionTracks + report.processedPositionTracks,
    processedQuaternionTracks: merged.processedQuaternionTracks + report.processedQuaternionTracks,
    passthroughTracks: merged.passthroughTracks + report.passthroughTracks,
    maxPositionReconstructionError: Math.max(merged.maxPositionReconstructionError, report.maxPositionReconstructionError),
    maxQuaternionReconstructionAngle: Math.max(merged.maxQuaternionReconstructionAngle, report.maxQuaternionReconstructionAngle),
  }), { ...first, processedPositionTracks: 0, processedQuaternionTracks: 0, passthroughTracks: 0, maxPositionReconstructionError: 0, maxQuaternionReconstructionAngle: 0 });
}
