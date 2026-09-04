import * as THREE from "three";

export type AnimationContactLoopAnalysis = {
  detected: boolean;
  confidence: "high" | "medium" | "low";
  chainBoneUuids: string[];
  chainBoneNames: string[];
  normalizedHeight: number | null;
  normalizedSpeed: number | null;
  score: number | null;
  reasons: string[];
};

export type AnimationContactLoopRepairReport = {
  applied: boolean;
  chainBoneNames: string[];
  sampleCount: number;
  reachClampCount: number;
  maxEffectorAnchorError: number;
  maxMarkerAnchorError: number;
};

type TrackBinding = {
  position?: THREE.KeyframeTrack;
  quaternion?: THREE.KeyframeTrack;
  scale?: THREE.KeyframeTrack;
};

function resolveTrackTarget(model: THREE.Object3D, track: THREE.KeyframeTrack) {
  try {
    const parsed = THREE.PropertyBinding.parseTrackName(track.name);
    return model.getObjectByProperty("uuid", parsed.nodeName) ?? model.getObjectByName(parsed.nodeName);
  } catch {
    return undefined;
  }
}

function sampleTrack(track: THREE.KeyframeTrack, time: number) {
  const buffer = new Float32Array(track.getValueSize());
  const factory = (track as unknown as {
    createInterpolant: (result: Float32Array) => { evaluate: (sampleTime: number) => ArrayLike<number> };
  }).createInterpolant;
  factory.call(track, buffer).evaluate(time);
  return buffer;
}

function buildBindings(model: THREE.Object3D, clip: THREE.AnimationClip) {
  const bindings = new Map<string, TrackBinding>();
  clip.tracks.forEach((track) => {
    const target = resolveTrackTarget(model, track);
    if (!(target instanceof THREE.Bone)) return;
    const binding = bindings.get(target.uuid) ?? {};
    if (track.name.endsWith(".position")) binding.position = track;
    else if (track.name.endsWith(".quaternion")) binding.quaternion = track;
    else if (track.name.endsWith(".scale")) binding.scale = track;
    bindings.set(target.uuid, binding);
  });
  return bindings;
}

function localMatrixAt(
  bone: THREE.Bone,
  binding: TrackBinding | undefined,
  time: number,
  quaternionOverride?: THREE.Quaternion,
) {
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
  if (quaternionOverride) quaternion.copy(quaternionOverride);
  if (binding?.scale) {
    const value = sampleTrack(binding.scale, time);
    scale.set(value[0], value[1], value[2]);
  }
  return new THREE.Matrix4().compose(position, quaternion, scale);
}

function worldMatrixAt(
  bone: THREE.Bone,
  bindings: Map<string, TrackBinding>,
  time: number,
  cache: Map<string, THREE.Matrix4>,
  overrides?: Map<string, THREE.Quaternion>,
): THREE.Matrix4 {
  const cached = cache.get(bone.uuid);
  if (cached) return cached;
  const local = localMatrixAt(bone, bindings.get(bone.uuid), time, overrides?.get(bone.uuid));
  let world: THREE.Matrix4;
  if (bone.parent instanceof THREE.Bone) {
    world = new THREE.Matrix4().multiplyMatrices(
      worldMatrixAt(bone.parent, bindings, time, cache, overrides),
      local,
    );
  } else if (bone.parent) {
    world = new THREE.Matrix4().multiplyMatrices(bone.parent.matrixWorld, local);
  } else {
    world = local;
  }
  cache.set(bone.uuid, world);
  return world;
}

function worldPositionAt(
  bone: THREE.Bone,
  bindings: Map<string, TrackBinding>,
  time: number,
  overrides?: Map<string, THREE.Quaternion>,
) {
  return new THREE.Vector3().setFromMatrixPosition(
    worldMatrixAt(bone, bindings, time, new Map(), overrides),
  );
}

function smallestPositiveStep(clip: THREE.AnimationClip) {
  let step = Number.POSITIVE_INFINITY;
  clip.tracks.forEach((track) => {
    for (let i = 1; i < track.times.length; i += 1) {
      const dt = Number(track.times[i]) - Number(track.times[i - 1]);
      if (dt > 1e-6) step = Math.min(step, dt);
    }
  });
  return Number.isFinite(step) ? step : null;
}

function topBoneAncestor(bone: THREE.Bone) {
  let result = bone;
  while (result.parent instanceof THREE.Bone) result = result.parent;
  return result;
}

/** Discover a stance/contact chain only from hierarchy, height and world-space motion. */
export function analyzeAnimationLoopContact(
  model: THREE.Object3D,
  clip: THREE.AnimationClip,
): AnimationContactLoopAnalysis {
  model.updateMatrixWorld(true);
  const bones: THREE.Bone[] = [];
  model.traverse((object) => {
    if (object instanceof THREE.Bone) bones.push(object);
  });
  const step = smallestPositiveStep(clip);
  if (bones.length < 4 || step == null || clip.duration < step * 4 - 1e-6) {
    return {
      detected: false,
      confidence: "low",
      chainBoneUuids: [],
      chainBoneNames: [],
      normalizedHeight: null,
      normalizedSpeed: null,
      score: null,
      reasons: ["insufficient skeleton samples for contact analysis"],
    };
  }

  const times = [4, 3, 2, 1].map((offset) => Math.max(0, clip.duration - step * offset));
  const bindings = buildBindings(model, clip);
  const samples = times.map((time) => {
    const cache = new Map<string, THREE.Matrix4>();
    return new Map(
      bones.map((bone) => [
        bone.uuid,
        new THREE.Vector3().setFromMatrixPosition(worldMatrixAt(bone, bindings, time, cache)),
      ]),
    );
  });

  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  samples.slice(1).forEach((sample) => sample.forEach((position) => {
    minY = Math.min(minY, position.y);
    maxY = Math.max(maxY, position.y);
  }));
  const skeletonHeight = Math.max(1e-6, maxY - minY);
  const roots = new Set(bones.filter((bone) => !(bone.parent instanceof THREE.Bone)).map((bone) => bone.uuid));

  type Candidate = {
    bone: THREE.Bone;
    height: number;
    speed: number;
    score: number;
  };
  const candidates: Candidate[] = bones
    .filter((bone) => !roots.has(bone.uuid))
    .map((bone) => {
      const positions = samples.map((sample) => sample.get(bone.uuid)!);
      const speed = (
        positions[0].distanceTo(positions[1]) +
        positions[1].distanceTo(positions[2]) +
        positions[2].distanceTo(positions[3])
      ) / (3 * skeletonHeight);
      const height = (
        ((positions[1].y + positions[2].y + positions[3].y) / 3) - minY
      ) / skeletonHeight;
      return { bone, height, speed, score: speed * (0.25 + height) ** 2 };
    })
    .sort((a, b) => a.score - b.score);
  const byUuid = new Map(candidates.map((candidate) => [candidate.bone.uuid, candidate]));
  const markerCandidate = candidates.find((candidate) => {
    const parent = candidate.bone.parent;
    if (!(parent instanceof THREE.Bone)) return false;
    const parentCandidate = byUuid.get(parent.uuid);
    return candidate.height < 0.25 && candidate.speed < 0.03 &&
      Boolean(parentCandidate && parentCandidate.height < 0.25 && parentCandidate.speed < 0.03);
  });

  if (!markerCandidate) {
    return {
      detected: false,
      confidence: "low",
      chainBoneUuids: [],
      chainBoneNames: [],
      normalizedHeight: null,
      normalizedSpeed: null,
      score: null,
      reasons: ["no coherent low/slow distal contact chain found"],
    };
  }

  const marker = markerCandidate.bone;
  const effector = marker.parent instanceof THREE.Bone ? marker.parent : null;
  const lower = effector?.parent instanceof THREE.Bone ? effector.parent : null;
  const upper = lower?.parent instanceof THREE.Bone ? lower.parent : null;
  if (!upper || !lower || !effector) {
    return {
      detected: false,
      confidence: "low",
      chainBoneUuids: [],
      chainBoneNames: [],
      normalizedHeight: markerCandidate.height,
      normalizedSpeed: markerCandidate.speed,
      score: markerCandidate.score,
      reasons: ["contact candidate does not have a four-bone articulated chain"],
    };
  }

  const family = new Set([upper.uuid, lower.uuid, effector.uuid, marker.uuid]);
  const nextIndependent = candidates.find((candidate) => !family.has(candidate.bone.uuid));
  const gap = nextIndependent ? nextIndependent.score / Math.max(markerCandidate.score, 1e-9) : Number.POSITIVE_INFINITY;
  const supportParent = byUuid.get(effector.uuid);
  const strongAbsoluteContact = markerCandidate.speed < 0.01 &&
    markerCandidate.height < 0.1 &&
    Boolean(supportParent && supportParent.speed < 0.02 && supportParent.height < 0.2);
  const confidence: AnimationContactLoopAnalysis["confidence"] =
    strongAbsoluteContact ? "high" : gap >= 2 ? "medium" : "low";

  return {
    detected: confidence !== "low",
    confidence,
    chainBoneUuids: [upper.uuid, lower.uuid, effector.uuid, marker.uuid],
    chainBoneNames: [upper.name, lower.name, effector.name, marker.name],
    normalizedHeight: markerCandidate.height,
    normalizedSpeed: markerCandidate.speed,
    score: markerCandidate.score,
    reasons: [
      `distal contact candidate normalized speed ${markerCandidate.speed.toFixed(4)}`,
      `normalized height ${markerCandidate.height.toFixed(4)}`,
      `independent candidate score gap ${Number.isFinite(gap) ? gap.toFixed(2) : "inf"}x`,
    ],
  };
}

function matrix(n: number) {
  return Array.from({ length: n }, () => Array<number>(n).fill(0));
}

function addStencilPenalty(h: number[][], stencil: number[], weight: number) {
  const n = h.length;
  for (let row = 0; row <= n - stencil.length; row += 1) {
    for (let i = 0; i < stencil.length; i += 1) {
      for (let j = 0; j < stencil.length; j += 1) {
        h[row + i][row + j] += weight * stencil[i] * stencil[j];
      }
    }
  }
}

function solveDense(a: number[][], b: number[]) {
  const n = a.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    }
    if (Math.abs(m[pivot][col]) < 1e-10) throw new Error("contact constraint system is singular");
    [m[col], m[pivot]] = [m[pivot], m[col]];
    const scale = m[col][col];
    for (let j = col; j <= n; j += 1) m[col][j] /= scale;
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = m[row][col];
      if (Math.abs(factor) < 1e-15) continue;
      for (let j = col; j <= n; j += 1) m[row][j] -= factor * m[col][j];
    }
  }
  return m.map((row) => row[n]);
}

function solveEndEffectorField(
  positions: THREE.Vector3[],
  constraints: Map<number, THREE.Vector3>,
) {
  const n = positions.length;
  const h = matrix(n);
  for (let i = 0; i < n; i += 1) h[i][i] = 1;
  addStencilPenalty(h, [-1, 1], 60);
  addStencilPenalty(h, [1, -2, 1], 12);
  addStencilPenalty(h, [-1, 3, -3, 1], 8);
  const entries = [...constraints.entries()].sort(([a], [b]) => a - b);
  const size = n + entries.length;
  const kkt = matrix(size);
  for (let i = 0; i < n; i += 1) for (let j = 0; j < n; j += 1) kkt[i][j] = h[i][j];
  entries.forEach(([frame], row) => {
    kkt[n + row][frame] = 1;
    kkt[frame][n + row] = 1;
  });
  const corrections = positions.map(() => new THREE.Vector3());
  for (let axis = 0; axis < 3; axis += 1) {
    const rhs = Array<number>(size).fill(0);
    entries.forEach(([frame, target], row) => {
      rhs[n + row] = target.getComponent(axis) - positions[frame].getComponent(axis);
    });
    const solution = solveDense(kkt, rhs);
    for (let i = 0; i < n; i += 1) corrections[i].setComponent(axis, solution[i]);
  }
  return corrections;
}

function twoBoneMiddleTarget(
  upper: THREE.Vector3,
  middle: THREE.Vector3,
  end: THREE.Vector3,
  target: THREE.Vector3,
) {
  const l1 = middle.distanceTo(upper);
  const l2 = end.distanceTo(middle);
  const v = target.clone().sub(upper);
  const d0 = v.length();
  if (d0 < 1e-8) return { target: middle.clone(), clamped: false };
  const lo = Math.abs(l1 - l2) + 1e-5;
  const hi = l1 + l2 - 1e-5;
  const d = THREE.MathUtils.clamp(d0, lo, hi);
  const direction = v.multiplyScalar(1 / d0);
  const x = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const height = Math.sqrt(Math.max(0, l1 * l1 - x * x));
  let pole = middle.clone().sub(upper).addScaledVector(direction, -middle.clone().sub(upper).dot(direction));
  if (pole.lengthSq() < 1e-12) {
    pole = new THREE.Vector3().crossVectors(direction, new THREE.Vector3(0, 1, 0));
    if (pole.lengthSq() < 1e-12) pole.crossVectors(direction, new THREE.Vector3(1, 0, 0));
  }
  pole.normalize();
  const a = upper.clone().addScaledVector(direction, x).addScaledVector(pole, height);
  const b = upper.clone().addScaledVector(direction, x).addScaledVector(pole, -height);
  return { target: a.distanceTo(middle) <= b.distanceTo(middle) ? a : b, clamped: Math.abs(d - d0) > 1e-7 };
}

function uniqueChainTimes(clip: THREE.AnimationClip, chain: THREE.Bone[]) {
  const uuids = new Set(chain.map((bone) => bone.uuid));
  const names = new Set(chain.map((bone) => bone.name));
  const values = new Set<number>();
  clip.tracks.forEach((track) => {
    const parsed = (() => { try { return THREE.PropertyBinding.parseTrackName(track.name); } catch { return null; } })();
    if (!parsed || (!uuids.has(parsed.nodeName) && !names.has(parsed.nodeName))) return;
    track.times.forEach((time) => values.add(Number(time)));
  });
  return [...values].sort((a, b) => a - b);
}

function aimBoneAtTarget(
  bone: THREE.Bone,
  child: THREE.Bone,
  target: THREE.Vector3,
  bindings: Map<string, TrackBinding>,
  time: number,
  overrides: Map<string, THREE.Quaternion>,
) {
  let cache = new Map<string, THREE.Matrix4>();
  const boneWorld = worldMatrixAt(bone, bindings, time, cache, overrides);
  const childWorld = worldMatrixAt(child, bindings, time, cache, overrides);
  const bonePosition = new THREE.Vector3().setFromMatrixPosition(boneWorld);
  const childPosition = new THREE.Vector3().setFromMatrixPosition(childWorld);
  const from = childPosition.sub(bonePosition);
  const to = target.clone().sub(bonePosition);
  if (from.lengthSq() < 1e-12 || to.lengthSq() < 1e-12) return;
  const delta = new THREE.Quaternion().setFromUnitVectors(from.normalize(), to.normalize());
  const currentGlobal = new THREE.Quaternion().setFromRotationMatrix(boneWorld);
  const targetGlobal = delta.multiply(currentGlobal).normalize();
  const parentGlobal = bone.parent
    ? new THREE.Quaternion().setFromRotationMatrix(
        bone.parent instanceof THREE.Bone
          ? worldMatrixAt(bone.parent, bindings, time, new Map(), overrides)
          : bone.parent.matrixWorld,
      )
    : new THREE.Quaternion();
  overrides.set(bone.uuid, parentGlobal.invert().multiply(targetGlobal).normalize());
}

function replaceQuaternionTrack(
  clip: THREE.AnimationClip,
  bone: THREE.Bone,
  times: number[],
  quaternions: THREE.Quaternion[],
) {
  const index = clip.tracks.findIndex((track) => {
    if (!track.name.endsWith(".quaternion")) return false;
    return resolveTrackTarget(bone.parent ?? bone, track) === bone || (() => {
      try {
        const parsed = THREE.PropertyBinding.parseTrackName(track.name);
        return parsed.nodeName === bone.uuid || parsed.nodeName === bone.name;
      } catch { return false; }
    })();
  });
  const existing = index >= 0 ? clip.tracks[index] : undefined;
  if (!(existing instanceof THREE.QuaternionKeyframeTrack)) return false;
  const values: number[] = [];
  quaternions.forEach((q) => values.push(q.x, q.y, q.z, q.w));
  clip.tracks[index] = new THREE.QuaternionKeyframeTrack(existing.name, times, values);
  return true;
}

/** Apply hierarchy-aware stance projection to a generic cyclic core result. */
export function repairAnimationLoopContact(
  model: THREE.Object3D,
  sourceClip: THREE.AnimationClip,
  coreClip: THREE.AnimationClip,
  analysis: AnimationContactLoopAnalysis,
): { clip: THREE.AnimationClip; report: AnimationContactLoopRepairReport } {
  const empty = (reasonNames = analysis.chainBoneNames): AnimationContactLoopRepairReport => ({
    applied: false,
    chainBoneNames: reasonNames,
    sampleCount: 0,
    reachClampCount: 0,
    maxEffectorAnchorError: 0,
    maxMarkerAnchorError: 0,
  });
  if (!analysis.detected || analysis.chainBoneUuids.length !== 4) return { clip: coreClip.clone(), report: empty() };
  const chain = analysis.chainBoneUuids.map((uuid) => model.getObjectByProperty("uuid", uuid));
  if (!chain.every((bone) => bone instanceof THREE.Bone)) return { clip: coreClip.clone(), report: empty() };
  const [upper, lower, effector, marker] = chain as THREE.Bone[];
  const times = uniqueChainTimes(coreClip, [upper, lower, effector, marker]);
  if (times.length < 5) return { clip: coreClip.clone(), report: empty() };
  model.updateMatrixWorld(true);
  const bindings = buildBindings(model, coreClip);
  if (![upper, lower, effector].every((bone) => bindings.get(bone.uuid)?.quaternion)) {
    return { clip: coreClip.clone(), report: empty() };
  }

  const positions = (bone: THREE.Bone) => times.map((time) => worldPositionAt(bone, bindings, time));
  const root = topBoneAncestor(marker);
  const rootPositions = positions(root);
  const rootCycle = rootPositions[rootPositions.length - 1].clone().sub(rootPositions[0]);
  const upperPositions = positions(upper);
  const lowerPositions = positions(lower);
  const effectorPositions = positions(effector);
  const markerPositions = positions(marker);
  const n = times.length;
  const effectorAnchor = effectorPositions[n - 2].clone()
    .add(effectorPositions[0].clone().add(rootCycle))
    .multiplyScalar(0.5);
  const endDirection = markerPositions[n - 2].clone().sub(effectorPositions[n - 2]);
  const startDirection = markerPositions[0].clone().sub(effectorPositions[0]);
  const markerLength = (endDirection.length() + startDirection.length()) * 0.5;
  const markerDirection = endDirection.normalize().add(startDirection.normalize()).normalize();
  const markerAnchor = effectorAnchor.clone().addScaledVector(markerDirection, markerLength);

  const effectorConstraints = new Map<number, THREE.Vector3>([
    [n - 3, effectorAnchor], [n - 2, effectorAnchor], [n - 1, effectorAnchor],
    [0, effectorAnchor.clone().sub(rootCycle)], [1, effectorAnchor.clone().sub(rootCycle)],
  ]);
  const markerConstraints = new Map<number, THREE.Vector3>([
    [n - 3, markerAnchor], [n - 2, markerAnchor], [n - 1, markerAnchor],
    [0, markerAnchor.clone().sub(rootCycle)], [1, markerAnchor.clone().sub(rootCycle)],
  ]);
  const effectorCorrection = solveEndEffectorField(effectorPositions, effectorConstraints);
  const markerCorrection = solveEndEffectorField(markerPositions, markerConstraints);
  const effectorTargets = effectorPositions.map((position, i) => position.clone().add(effectorCorrection[i]));
  const markerRawTargets = markerPositions.map((position, i) => position.clone().add(markerCorrection[i]));
  const markerTargets = markerRawTargets.map((target, i) => {
    const direction = target.clone().sub(effectorTargets[i]);
    if (direction.lengthSq() < 1e-12) direction.copy(markerPositions[i]).sub(effectorPositions[i]);
    return effectorTargets[i].clone().addScaledVector(direction.normalize(), markerPositions[i].distanceTo(effectorPositions[i]));
  });

  const middleTargets: THREE.Vector3[] = [];
  let reachClampCount = 0;
  for (let i = 0; i < n; i += 1) {
    const result = twoBoneMiddleTarget(upperPositions[i], lowerPositions[i], effectorPositions[i], effectorTargets[i]);
    middleTargets.push(result.target);
    reachClampCount += Number(result.clamped);
  }

  const upperQ: THREE.Quaternion[] = [];
  const lowerQ: THREE.Quaternion[] = [];
  const effectorQ: THREE.Quaternion[] = [];
  for (let i = 0; i < n; i += 1) {
    const overrides = new Map<string, THREE.Quaternion>();
    aimBoneAtTarget(upper, lower, middleTargets[i], bindings, times[i], overrides);
    aimBoneAtTarget(lower, effector, effectorTargets[i], bindings, times[i], overrides);
    aimBoneAtTarget(effector, marker, markerTargets[i], bindings, times[i], overrides);
    upperQ.push(overrides.get(upper.uuid) ?? upper.quaternion.clone());
    lowerQ.push(overrides.get(lower.uuid) ?? lower.quaternion.clone());
    effectorQ.push(overrides.get(effector.uuid) ?? effector.quaternion.clone());
  }

  const clip = coreClip.clone();
  if (!replaceQuaternionTrack(clip, upper, times, upperQ) ||
      !replaceQuaternionTrack(clip, lower, times, lowerQ) ||
      !replaceQuaternionTrack(clip, effector, times, effectorQ)) {
    return { clip: coreClip.clone(), report: empty() };
  }

  const finalBindings = buildBindings(model, clip);
  const cyclicAnchorError = (bone: THREE.Bone, anchor: THREE.Vector3) => {
    const final = times.map((time) => worldPositionAt(bone, finalBindings, time));
    const points = [final[n - 3], final[n - 2], final[n - 1], final[0].clone().add(rootCycle), final[1].clone().add(rootCycle)];
    return Math.max(...points.map((point) => point.distanceTo(anchor)));
  };
  return {
    clip,
    report: {
      applied: true,
      chainBoneNames: analysis.chainBoneNames,
      sampleCount: n,
      reachClampCount,
      maxEffectorAnchorError: cyclicAnchorError(effector, effectorAnchor),
      maxMarkerAnchorError: cyclicAnchorError(marker, markerAnchor),
    },
  };
}
