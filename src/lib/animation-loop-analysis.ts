import * as THREE from "three";
import {
  DEFAULT_LOOP_TRANSLATION_VELOCITY_SPACE,
  findLoopTranslationOrientationTrack,
  measureLoopTranslationVelocity,
  type LoopTranslationVelocitySpace,
} from "./animation-loop-fix";

export type AnimationLoopRootMode = "close" | "preserve";
export type AnimationLoopRootPolicy = "auto" | AnimationLoopRootMode;

export type AnimationLoopAnalysis = {
  rootMode: AnimationLoopRootMode;
  rootBoneNames: string[];
  rootBoneUuids: string[];
  rootMotionDetected: boolean;
  artificialEndpointDetected: boolean;
  endpointHoldRatio: number | null;
  rootVelocitySpace: LoopTranslationVelocitySpace;
  rootVelocityMismatch: number | null;
  rootVelocityStart: [number, number, number] | null;
  rootVelocityEnd: [number, number, number] | null;
  confidence: "high" | "medium" | "low";
  reasons: string[];
};

export type AnimationLoopAnalysisOptions = {
  rootVelocitySpace?: LoopTranslationVelocitySpace;
};

type TrackBinding = {
  position?: THREE.KeyframeTrack;
  quaternion?: THREE.KeyframeTrack;
  scale?: THREE.KeyframeTrack;
};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) * 0.5
    : sorted[mid];
}

function resolveTrackTarget(model: THREE.Object3D, track: THREE.KeyframeTrack) {
  try {
    const parsed = THREE.PropertyBinding.parseTrackName(track.name);
    return model.getObjectByProperty("uuid", parsed.nodeName) ?? model.getObjectByName(parsed.nodeName);
  } catch {
    return undefined;
  }
}

function vectorAt(values: ArrayLike<number>, index: number) {
  const offset = index * 3;
  return new THREE.Vector3(
    Number(values[offset]),
    Number(values[offset + 1]),
    Number(values[offset + 2]),
  );
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

function coefficientOfVariation(values: number[]) {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (mean <= 1e-8) return Number.POSITIVE_INFINITY;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

function hasCoherentTranslation(track: THREE.KeyframeTrack) {
  if (!(track instanceof THREE.VectorKeyframeTrack) || track.values.length < 9) return false;
  const count = track.times.length;
  if (count < 3 || track.values.length !== count * 3) return false;
  const points = Array.from({ length: count }, (_, index) => vectorAt(track.values, index));
  const steps = points.slice(1).map((point, index) => point.distanceTo(points[index]));
  const pathLength = steps.reduce((sum, value) => sum + value, 0);
  if (pathLength <= 1e-5) return false;
  const net = points[0].distanceTo(points[count - 1]);
  const meanStep = pathLength / steps.length;
  const activeFraction = steps.filter((step) => step > meanStep * 0.1).length / steps.length;
  return net / pathLength >= 0.7 && activeFraction >= 0.7 && coefficientOfVariation(steps) <= 0.55;
}

function quaternionAngle(a: THREE.Quaternion, b: THREE.Quaternion) {
  return 2 * Math.acos(THREE.MathUtils.clamp(Math.abs(a.dot(b)), -1, 1));
}

function hasCoherentRotation(track: THREE.KeyframeTrack) {
  if (!(track instanceof THREE.QuaternionKeyframeTrack) || track.values.length < 12) return false;
  const count = track.times.length;
  if (count < 3 || track.values.length !== count * 4) return false;
  const quaternions = Array.from({ length: count }, (_, index) => quaternionAt(track.values, index));
  const steps = quaternions.slice(1).map((q, index) => quaternionAngle(quaternions[index], q));
  const pathLength = steps.reduce((sum, value) => sum + value, 0);
  if (pathLength < THREE.MathUtils.degToRad(20)) return false;
  const net = quaternionAngle(quaternions[0], quaternions[count - 1]);
  const meanStep = pathLength / steps.length;
  const activeFraction = steps.filter((step) => step > meanStep * 0.1).length / steps.length;
  return net / pathLength >= 0.7 && activeFraction >= 0.7 && coefficientOfVariation(steps) <= 0.55;
}

function smallestPositiveTrackStep(clip: THREE.AnimationClip) {
  let smallest = Number.POSITIVE_INFINITY;
  clip.tracks.forEach((track) => {
    for (let index = 1; index < track.times.length; index += 1) {
      const step = Number(track.times[index]) - Number(track.times[index - 1]);
      if (step > 1e-6) smallest = Math.min(smallest, step);
    }
  });
  return Number.isFinite(smallest) ? smallest : null;
}

function sampleTrack(track: THREE.KeyframeTrack, time: number) {
  const buffer = new Float32Array(track.getValueSize());
  const interpolantFactory = (track as unknown as {
    createInterpolant: (result: Float32Array) => { evaluate: (sampleTime: number) => ArrayLike<number> };
  }).createInterpolant;
  interpolantFactory.call(track, buffer).evaluate(time);
  return buffer;
}

function buildTrackBindings(model: THREE.Object3D, clip: THREE.AnimationClip) {
  const bindings = new Map<string, TrackBinding>();
  clip.tracks.forEach((track) => {
    const target = resolveTrackTarget(model, track);
    if (!(target instanceof THREE.Bone)) return;
    let binding = bindings.get(target.uuid);
    if (!binding) {
      binding = {};
      bindings.set(target.uuid, binding);
    }
    if (track.name.endsWith(".position")) binding.position = track;
    else if (track.name.endsWith(".quaternion")) binding.quaternion = track;
    else if (track.name.endsWith(".scale")) binding.scale = track;
  });
  return bindings;
}

function localMatrixAt(bone: THREE.Bone, binding: TrackBinding | undefined, time: number) {
  const position = bone.position.clone();
  const quaternion = bone.quaternion.clone();
  const scale = bone.scale.clone();
  if (binding?.position) {
    const value = sampleTrack(binding.position, time);
    position.set(value[0], value[1], value[2]);
  }
  if (binding?.quaternion) {
    const value = sampleTrack(binding.quaternion, time);
    quaternion.set(value[0], value[1], value[2], value[3]).normalize();
  }
  if (binding?.scale) {
    const value = sampleTrack(binding.scale, time);
    scale.set(value[0], value[1], value[2]);
  }
  return new THREE.Matrix4().compose(position, quaternion, scale);
}

function worldPositionAt(
  bone: THREE.Bone,
  bindings: Map<string, TrackBinding>,
  time: number,
  cache: Map<string, THREE.Matrix4>,
) {
  const cached = cache.get(bone.uuid);
  if (cached) return new THREE.Vector3().setFromMatrixPosition(cached);
  const local = localMatrixAt(bone, bindings.get(bone.uuid), time);
  let world: THREE.Matrix4;
  if (bone.parent instanceof THREE.Bone) {
    world = new THREE.Matrix4().multiplyMatrices(
      matrixAt(bone.parent, bindings, time, cache),
      local,
    );
  } else if (bone.parent) {
    world = new THREE.Matrix4().multiplyMatrices(bone.parent.matrixWorld, local);
  } else {
    world = local;
  }
  cache.set(bone.uuid, world);
  return new THREE.Vector3().setFromMatrixPosition(world);
}

function matrixAt(
  bone: THREE.Bone,
  bindings: Map<string, TrackBinding>,
  time: number,
  cache: Map<string, THREE.Matrix4>,
): THREE.Matrix4 {
  const cached = cache.get(bone.uuid);
  if (cached) return cached;
  const local = localMatrixAt(bone, bindings.get(bone.uuid), time);
  let world: THREE.Matrix4;
  if (bone.parent instanceof THREE.Bone) {
    world = new THREE.Matrix4().multiplyMatrices(matrixAt(bone.parent, bindings, time, cache), local);
  } else if (bone.parent) {
    world = new THREE.Matrix4().multiplyMatrices(bone.parent.matrixWorld, local);
  } else {
    world = local;
  }
  cache.set(bone.uuid, world);
  return world;
}

function endpointHoldRatio(model: THREE.Object3D, bones: THREE.Bone[], clip: THREE.AnimationClip) {
  const step = smallestPositiveTrackStep(clip);
  if (step == null || clip.duration < step * 3 - 1e-6) return null;
  const times = [clip.duration - step * 3, clip.duration - step * 2, clip.duration - step, clip.duration]
    .map((time) => Math.max(0, time));
  const bindings = buildTrackBindings(model, clip);
  const samples = times.map((time) => {
    const cache = new Map<string, THREE.Matrix4>();
    return new Map(bones.map((bone) => [bone.uuid, worldPositionAt(bone, bindings, time, cache)]));
  });
  const ratios: number[] = [];
  bones.forEach((bone) => {
    const p0 = samples[0].get(bone.uuid)!;
    const p1 = samples[1].get(bone.uuid)!;
    const p2 = samples[2].get(bone.uuid)!;
    const p3 = samples[3].get(bone.uuid)!;
    const baseline = (p0.distanceTo(p1) + p1.distanceTo(p2)) * 0.5;
    if (baseline <= 1e-5) return;
    ratios.push(p2.distanceTo(p3) / baseline);
  });
  const required = Math.max(6, Math.ceil(bones.length * 0.35));
  if (ratios.length < required) return null;
  return median(ratios);
}

function measureDominantRootVelocity(
  model: THREE.Object3D,
  roots: THREE.Bone[],
  clips: THREE.AnimationClip[],
  space: LoopTranslationVelocitySpace,
) {
  const rootIds = new Set(roots.map((bone) => bone.uuid));
  const candidates: Array<{ displacement: number; measurement: NonNullable<ReturnType<typeof measureLoopTranslationVelocity>> }> = [];

  clips.forEach((clip) => {
    clip.tracks.forEach((track) => {
      if (!(track instanceof THREE.VectorKeyframeTrack) || !track.name.endsWith(".position")) return;
      let target: THREE.Object3D | undefined;
      try {
        const parsed = THREE.PropertyBinding.parseTrackName(track.name);
        target = model.getObjectByProperty("uuid", parsed.nodeName) ?? model.getObjectByName(parsed.nodeName);
      } catch {
        return;
      }
      if (!(target instanceof THREE.Bone) || !rootIds.has(target.uuid) || track.times.length < 2) return;
      const measurement = measureLoopTranslationVelocity(track, {
        space,
        orientationTrack: space === "root-local"
          ? findLoopTranslationOrientationTrack(clip, track)
          : null,
      });
      if (!measurement) return;
      const last = (track.times.length - 1) * 3;
      const displacement = Math.hypot(
        Number(track.values[last]) - Number(track.values[0]),
        Number(track.values[last + 1]) - Number(track.values[1]),
        Number(track.values[last + 2]) - Number(track.values[2]),
      );
      candidates.push({ displacement, measurement });
    });
  });

  return candidates.reduce<typeof candidates[number] | null>(
    (best, candidate) => !best || candidate.displacement > best.displacement ? candidate : best,
    null,
  )?.measurement ?? null;
}

/** Analyze loop semantics without relying on rig names or asset-specific frame numbers. */
export function analyzeAnimationLoop(
  model: THREE.Object3D,
  clips: THREE.AnimationClip[],
  options?: AnimationLoopAnalysisOptions,
): AnimationLoopAnalysis {
  const rootVelocitySpace = options?.rootVelocitySpace ?? DEFAULT_LOOP_TRANSLATION_VELOCITY_SPACE;
  model.updateMatrixWorld(true);
  const bones: THREE.Bone[] = [];
  model.traverse((object) => {
    if (object instanceof THREE.Bone) bones.push(object);
  });
  const roots = bones.filter((bone) => !(bone.parent instanceof THREE.Bone));
  const rootIds = new Set(roots.map((bone) => bone.uuid));

  let rootMotionDetected = false;
  clips.forEach((clip) => {
    clip.tracks.forEach((track) => {
      const target = resolveTrackTarget(model, track);
      if (!(target instanceof THREE.Bone) || !rootIds.has(target.uuid)) return;
      if (track.name.endsWith(".position") && hasCoherentTranslation(track)) rootMotionDetected = true;
      if (track.name.endsWith(".quaternion") && hasCoherentRotation(track)) rootMotionDetected = true;
    });
  });

  const holdRatios = clips
    .map((clip) => endpointHoldRatio(model, bones, clip))
    .filter((value): value is number => value != null && Number.isFinite(value));
  const holdRatio = holdRatios.length ? Math.min(...holdRatios) : null;
  const artificialEndpointDetected = holdRatio != null && holdRatio < 0.15;
  const rootMode: AnimationLoopRootMode = rootMotionDetected ? "preserve" : "close";
  const rootVelocity = measureDominantRootVelocity(model, roots, clips, rootVelocitySpace);
  const reasons: string[] = [];
  reasons.push(rootMotionDetected
    ? "Coherent motion was detected on a skeleton root, so root motion should be preserved."
    : "No coherent root-motion trajectory was detected, so closing the root is safe by default.");
  if (artificialEndpointDetected) {
    reasons.push(`A broad end-of-clip hold was detected (median final-step ratio ${holdRatio!.toFixed(3)}).`);
  }
  const confidence: AnimationLoopAnalysis["confidence"] = roots.length === 0
    ? "low"
    : rootMotionDetected || artificialEndpointDetected
      ? "high"
      : "medium";

  return {
    rootMode,
    rootBoneNames: roots.map((bone) => bone.name),
    rootBoneUuids: roots.map((bone) => bone.uuid),
    rootMotionDetected,
    artificialEndpointDetected,
    endpointHoldRatio: holdRatio,
    rootVelocitySpace,
    rootVelocityMismatch: rootVelocity?.mismatch ?? null,
    rootVelocityStart: rootVelocity?.start ?? null,
    rootVelocityEnd: rootVelocity?.end ?? null,
    confidence,
    reasons,
  };
}
