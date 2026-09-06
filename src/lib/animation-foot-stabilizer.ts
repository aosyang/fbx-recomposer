import * as THREE from "three";

export type FootContactDebugInterval = {
  startTime: number;
  endTime: number;
  anchorTime: number;
  anchorPosition: number;
  anchor: [number, number, number];
  inputPath: Array<[number, number, number]>;
  outputPath: Array<[number, number, number]>;
};

export type FootStabilizerSample = {
  time: number;
  height: number;
  horizontalSpeed: number;
  contact: boolean;
};

export type FootStabilizerFootReport = {
  side: "left" | "right";
  footName: string;
  chainBoneNames: string[];
  intervals: FootContactDebugInterval[];
  samples: FootStabilizerSample[];
  contactFrameCount: number;
  maxInputDrift: number;
  maxOutputDrift: number;
};

export type FootStabilizerReport = {
  applied: boolean;
  duration: number;
  sampleRate: number;
  skeletonHeight: number;
  movementThreshold: number;
  heightThreshold: number;
  feet: FootStabilizerFootReport[];
  reasons: string[];
};

type TrackBinding = {
  position?: THREE.KeyframeTrack;
  quaternion?: THREE.KeyframeTrack;
  scale?: THREE.KeyframeTrack;
};

type FootChain = {
  side: "left" | "right";
  upper: THREE.Bone;
  lower: THREE.Bone;
  foot: THREE.Bone;
};

type ContactInterval = {
  start: number;
  end: number;
  anchorFrame: number;
  anchorPosition: number;
  anchor: THREE.Vector3;
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

function normalizeBoneName(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function boneNameTokens(name: string) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-z0-9]+/i)
    .map((token) => token.toLowerCase())
    .filter(Boolean);
}

function sideToken(token: string): "left" | "right" | null {
  if (token === "l" || token === "left") return "left";
  if (token === "r" || token === "right") return "right";
  return null;
}

function sideHint(name: string): "left" | "right" | null {
  const value = normalizeBoneName(name);
  if (value.includes("left") || value.startsWith("lfoot") || value.endsWith("footl")) return "left";
  if (value.includes("right") || value.startsWith("rfoot") || value.endsWith("footr")) return "right";
  for (const token of boneNameTokens(name)) {
    const side = sideToken(token);
    if (side) return side;
  }
  return null;
}

function isMirroredBoneNamePair(a: string, b: string) {
  const aTokens = boneNameTokens(a);
  const bTokens = boneNameTokens(b);
  if (aTokens.length !== bTokens.length) return false;
  let difference = -1;
  for (let index = 0; index < aTokens.length; index += 1) {
    if (aTokens[index] === bTokens[index]) continue;
    if (difference >= 0) return false;
    difference = index;
  }
  if (difference < 0) return false;
  const aSide = sideToken(aTokens[difference]);
  const bSide = sideToken(bTokens[difference]);
  return Boolean(aSide && bSide && aSide !== bSide);
}

function isFootName(name: string) {
  const value = normalizeBoneName(name);
  return value.includes("foot") && !value.includes("toe");
}

function skeletonBounds(model: THREE.Object3D) {
  const box = new THREE.Box3();
  let hasPoint = false;
  model.updateMatrixWorld(true);
  model.traverse((object) => {
    if (!(object instanceof THREE.Bone)) return;
    box.expandByPoint(new THREE.Vector3().setFromMatrixPosition(object.matrixWorld));
    hasPoint = true;
  });
  if (!hasPoint) return { minY: 0, height: 1 };
  return { minY: box.min.y, height: Math.max(1e-6, box.max.y - box.min.y) };
}

function discoverFootChains(model: THREE.Object3D) {
  const bones: THREE.Bone[] = [];
  model.traverse((object) => {
    if (object instanceof THREE.Bone) bones.push(object);
  });
  const { minY, height } = skeletonBounds(model);

  const makeChain = (foot: THREE.Bone): FootChain | null => {
    const lower = foot.parent instanceof THREE.Bone ? foot.parent : null;
    const upper = lower?.parent instanceof THREE.Bone ? lower.parent : null;
    if (!upper || !lower) return null;
    return { side: "left", upper, lower, foot };
  };

  const named = bones
    .filter((bone) => isFootName(bone.name))
    .map((bone) => ({ bone, chain: makeChain(bone), side: sideHint(bone.name) }))
    .filter((entry) => entry.chain !== null);

  const byNamedSide = new Map<"left" | "right", FootChain>();
  for (let index = 0; index < named.length; index += 1) {
    const first = named[index];
    if (!first.side || !first.chain) continue;
    for (let nextIndex = index + 1; nextIndex < named.length; nextIndex += 1) {
      const second = named[nextIndex];
      if (!second.side || !second.chain || first.side === second.side) continue;
      if (!isMirroredBoneNamePair(first.bone.name, second.bone.name)) continue;
      byNamedSide.set(first.side, { ...first.chain, side: first.side });
      byNamedSide.set(second.side, { ...second.chain, side: second.side });
      break;
    }
    if (byNamedSide.size === 2) break;
  }
  named.forEach((entry) => {
    if (entry.side && entry.chain && !byNamedSide.has(entry.side)) {
      byNamedSide.set(entry.side, { ...entry.chain, side: entry.side });
    }
  });
  if (byNamedSide.size === 2) {
    return [byNamedSide.get("left")!, byNamedSide.get("right")!];
  }

  const candidates = bones
    .map((bone) => {
      const chain = makeChain(bone);
      if (!chain) return null;
      const p = new THREE.Vector3().setFromMatrixPosition(bone.matrixWorld);
      const parentP = new THREE.Vector3().setFromMatrixPosition(chain.lower.matrixWorld);
      const normalizedHeight = (p.y - minY) / height;
      const parentRise = (parentP.y - p.y) / height;
      const distalChildren = bone.children.filter((child) => child instanceof THREE.Bone).length;
      const nameBonus = isFootName(bone.name) ? -0.2 : 0;
      const score = normalizedHeight - Math.max(0, parentRise) * 0.35 + distalChildren * 0.02 + nameBonus;
      return { chain, p, score, parentRise };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .filter((entry) => entry.parentRise > 0.02)
    .sort((a, b) => a.score - b.score);

  let first: typeof candidates[number] | null = null;
  let second: typeof candidates[number] | null = null;
  for (const candidate of candidates) {
    if (!first) {
      first = candidate;
      continue;
    }
    if (
      candidate.chain.upper.uuid !== first.chain.upper.uuid &&
      candidate.chain.lower.uuid !== first.chain.lower.uuid &&
      candidate.p.distanceTo(first.p) > height * 0.04
    ) {
      second = candidate;
      break;
    }
  }
  if (!first || !second) return [];

  const pair = [first, second].sort((a, b) => a.p.x - b.p.x);
  pair[0].chain.side = "left";
  pair[1].chain.side = "right";
  return pair.map((entry) => entry.chain);
}

function uniformTimes(duration: number, fps: number) {
  const frameCount = Math.max(2, Math.round(duration * fps) + 1);
  return Array.from({ length: frameCount }, (_, index) => Math.min(duration, index / fps));
}

function horizontalSpeed(points: THREE.Vector3[], index: number, dt: number) {
  if (points.length < 2) return 0;
  const a = points[Math.max(0, index - 1)];
  const b = points[Math.min(points.length - 1, index + 1)];
  const span = index === 0 || index === points.length - 1 ? dt : dt * 2;
  return Math.hypot(b.x - a.x, b.z - a.z) / Math.max(span, 1e-6);
}

function smoothContactMask(mask: boolean[]) {
  const result = [...mask];
  for (let i = 1; i < result.length - 1; i += 1) {
    if (!result[i] && result[i - 1] && result[i + 1]) result[i] = true;
  }
  return result;
}

type DetectedContactInterval = Pick<ContactInterval, "start" | "end">;

function intervalsFromMask(mask: boolean[]) {
  const intervals: DetectedContactInterval[] = [];
  let start = -1;
  for (let i = 0; i <= mask.length; i += 1) {
    const active = i < mask.length && mask[i];
    if (active && start < 0) start = i;
    if (!active && start >= 0) {
      const end = i - 1;
      if (end - start + 1 >= 3) {
        intervals.push({ start, end });
      }
      start = -1;
    }
  }
  return intervals;
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
  if (d0 < 1e-8) return middle.clone();
  const lo = Math.abs(l1 - l2) + 1e-5;
  const hi = Math.max(lo, l1 + l2 - 1e-5);
  const d = THREE.MathUtils.clamp(d0, lo, hi);
  const direction = v.multiplyScalar(1 / d0);
  const x = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - x * x));
  let pole = middle.clone().sub(upper);
  pole.addScaledVector(direction, -pole.dot(direction));
  if (pole.lengthSq() < 1e-12) {
    pole.crossVectors(direction, new THREE.Vector3(0, 1, 0));
    if (pole.lengthSq() < 1e-12) pole.crossVectors(direction, new THREE.Vector3(1, 0, 0));
  }
  pole.normalize();
  const a = upper.clone().addScaledVector(direction, x).addScaledVector(pole, h);
  const b = upper.clone().addScaledVector(direction, x).addScaledVector(pole, -h);
  return a.distanceTo(middle) <= b.distanceTo(middle) ? a : b;
}

function aimBoneAtTarget(
  bone: THREE.Bone,
  child: THREE.Bone,
  target: THREE.Vector3,
  bindings: Map<string, TrackBinding>,
  time: number,
  overrides: Map<string, THREE.Quaternion>,
) {
  const boneWorld = worldMatrixAt(bone, bindings, time, new Map(), overrides);
  const childWorld = worldMatrixAt(child, bindings, time, new Map(), overrides);
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

function sampleQuaternion(bone: THREE.Bone, bindings: Map<string, TrackBinding>, time: number) {
  const track = bindings.get(bone.uuid)?.quaternion;
  if (!track) return bone.quaternion.clone();
  const value = sampleTrack(track, time);
  return new THREE.Quaternion(value[0], value[1], value[2], value[3]).normalize();
}

function replaceQuaternionTrack(
  model: THREE.Object3D,
  clip: THREE.AnimationClip,
  bone: THREE.Bone,
  times: number[],
  quaternions: THREE.Quaternion[],
) {
  const index = clip.tracks.findIndex((track) =>
    track instanceof THREE.QuaternionKeyframeTrack &&
    resolveTrackTarget(model, track) === bone,
  );
  if (index < 0) return false;
  const existing = clip.tracks[index] as THREE.QuaternionKeyframeTrack;
  const values: number[] = [];
  quaternions.forEach((q) => values.push(q.x, q.y, q.z, q.w));
  clip.tracks[index] = new THREE.QuaternionKeyframeTrack(existing.name, times, values);
  return true;
}

function contactWeight(index: number, interval: ContactInterval, fadeFrames: number) {
  if (index >= interval.start && index <= interval.end) return 1;
  if (index < interval.start && index >= interval.start - fadeFrames) {
    const t = (index - (interval.start - fadeFrames)) / fadeFrames;
    return t * t * (3 - 2 * t);
  }
  if (index > interval.end && index <= interval.end + fadeFrames) {
    const t = ((interval.end + fadeFrames) - index) / fadeFrames;
    return t * t * (3 - 2 * t);
  }
  return 0;
}

function vecTuple(value: THREE.Vector3): [number, number, number] {
  return [value.x, value.y, value.z];
}

function intervalDrift(path: THREE.Vector3[], anchor: THREE.Vector3) {
  return path.reduce((max, point) => Math.max(max, point.distanceTo(anchor)), 0);
}

export type FootStabilizerOptions = {
  movementThreshold?: number;
  heightThreshold?: number;
  warpAirborneMotion?: boolean;
  contactReferenceClip?: THREE.AnimationClip;
  anchorPositions?: {
    initial?: number;
    intermediate?: number;
    final?: number;
  };
};

export function stabilizeFootContacts(
  model: THREE.Object3D,
  sourceClip: THREE.AnimationClip,
  fps = 30,
  options: FootStabilizerOptions = {},
): { clip: THREE.AnimationClip; report: FootStabilizerReport } {
  model.updateMatrixWorld(true);
  const chains = discoverFootChains(model);
  const bounds = skeletonBounds(model);
  const movementThreshold = Math.max(0, options.movementThreshold ?? 0.12);
  const normalizedHeightThreshold = Math.max(0, options.heightThreshold ?? 0.035);
  const emptyReport = (reason: string): FootStabilizerReport => ({
    applied: false,
    duration: Math.max(0, sourceClip.duration),
    sampleRate: fps,
    skeletonHeight: bounds.height,
    movementThreshold,
    heightThreshold: normalizedHeightThreshold,
    feet: [],
    reasons: [reason],
  });
  if (chains.length < 2) return { clip: sourceClip.clone(), report: emptyReport("could not identify two articulated foot chains") };
  if (sourceClip.duration <= 0) return { clip: sourceClip.clone(), report: emptyReport("clip has no duration") };

  const times = uniformTimes(sourceClip.duration, fps);
  const dt = 1 / fps;
  const warpAirborneMotion = options.warpAirborneMotion ?? true;
  const anchorPositions = {
    initial: THREE.MathUtils.clamp(options.anchorPositions?.initial ?? 0, 0, 1),
    intermediate: THREE.MathUtils.clamp(options.anchorPositions?.intermediate ?? 0.5, 0, 1),
    final: THREE.MathUtils.clamp(options.anchorPositions?.final ?? 1, 0, 1),
  };
  const contactReferenceClip = options.contactReferenceClip ?? sourceClip;
  const referenceBindings = buildBindings(model, contactReferenceClip);
  const desiredBindings = buildBindings(model, sourceClip);
  const referenceSamples = chains.map((chain) =>
    times.map((time) => worldPositionAt(chain.foot, referenceBindings, time))
  );
  const desiredSamples = chains.map((chain) =>
    times.map((time) => worldPositionAt(chain.foot, desiredBindings, time))
  );
  const groundY = Math.min(...referenceSamples.flat().map((point) => point.y));
  const heightThreshold = groundY + bounds.height * normalizedHeightThreshold;
  const speedThreshold = bounds.height * movementThreshold;

  const detected = chains.map((chain, footIndex) => {
    const points = referenceSamples[footIndex];
    const desiredPoints = desiredSamples[footIndex];
    const heights = points.map((point) => (point.y - groundY) / bounds.height);
    const speeds = points.map((_, index) => horizontalSpeed(points, index, dt) / bounds.height);
    const rawMask = points.map((point, index) =>
      point.y <= heightThreshold &&
      horizontalSpeed(points, index, dt) <= speedThreshold,
    );
    const lastFrame = times.length - 1;
    const intervals = intervalsFromMask(smoothContactMask(rawMask)).map((interval) => {
      const anchorPosition = interval.start === 0
        ? anchorPositions.initial
        : interval.end === lastFrame
          ? anchorPositions.final
          : anchorPositions.intermediate;
      const anchorFrame = Math.round(
        THREE.MathUtils.lerp(interval.start, interval.end, anchorPosition),
      );
      return {
        ...interval,
        anchorFrame,
        anchorPosition,
        anchor: desiredPoints[anchorFrame].clone(),
      };
    });
    return { chain, points, desiredPoints, heights, speeds, intervals };
  });

  const clip = sourceClip.clone();
  let anyApplied = false;

  const smoothStep01 = (value: number) => {
    const t = THREE.MathUtils.clamp(value, 0, 1);
    return t * t * (3 - 2 * t);
  };

  for (const foot of detected) {
    if (foot.intervals.length === 0) continue;
    const bindings = buildBindings(model, clip);
    const upperBinding = bindings.get(foot.chain.upper.uuid)?.quaternion;
    const lowerBinding = bindings.get(foot.chain.lower.uuid)?.quaternion;
    if (!upperBinding || !lowerBinding) continue;

    const upperQ: THREE.Quaternion[] = [];
    const lowerQ: THREE.Quaternion[] = [];
    const footQ: THREE.Quaternion[] = [];

    const intervalAtFrame = (frame: number) =>
      foot.intervals.find((interval) => frame >= interval.start && frame <= interval.end) ?? null;

    const previousInterval = (frame: number) => {
      for (let index = foot.intervals.length - 1; index >= 0; index -= 1) {
        if (foot.intervals[index].end < frame) return foot.intervals[index];
      }
      return null;
    };

    const nextInterval = (frame: number) =>
      foot.intervals.find((interval) => interval.start > frame) ?? null;

    const targetPositionAtFrame = (frame: number) => {
      const contact = intervalAtFrame(frame);
      if (contact) return contact.anchor.clone();

      if (!warpAirborneMotion) return foot.desiredPoints[frame].clone();

      const previous = previousInterval(frame);
      const next = nextInterval(frame);
      const reference = foot.points[frame].clone();

      if (previous && next) {
        const startDelta = previous.anchor.clone().sub(foot.points[previous.end]);
        const endDelta = next.anchor.clone().sub(foot.points[next.start]);
        const alpha = smoothStep01(
          (frame - previous.end) / Math.max(1, next.start - previous.end),
        );
        return reference.add(startDelta.lerp(endDelta, alpha));
      }

      if (previous) {
        const lastFrame = times.length - 1;
        const startDelta = previous.anchor.clone().sub(foot.points[previous.end]);
        const endDelta = foot.desiredPoints[lastFrame].clone().sub(foot.points[lastFrame]);
        const alpha = smoothStep01(
          (frame - previous.end) / Math.max(1, lastFrame - previous.end),
        );
        return reference.add(startDelta.lerp(endDelta, alpha));
      }

      if (next) {
        const startDelta = foot.desiredPoints[0].clone().sub(foot.points[0]);
        const endDelta = next.anchor.clone().sub(foot.points[next.start]);
        const alpha = smoothStep01(frame / Math.max(1, next.start));
        return reference.add(startDelta.lerp(endDelta, alpha));
      }

      return foot.desiredPoints[frame].clone();
    };

    for (let frame = 0; frame < times.length; frame += 1) {
      const time = times[frame];

      const target = targetPositionAtFrame(frame);
      const upperPosition = worldPositionAt(foot.chain.upper, bindings, time);
      const lowerPosition = worldPositionAt(foot.chain.lower, bindings, time);
      const footPosition = worldPositionAt(foot.chain.foot, bindings, time);

      if (target.distanceToSquared(footPosition) <= 1e-12) {
        upperQ.push(sampleQuaternion(foot.chain.upper, bindings, time));
        lowerQ.push(sampleQuaternion(foot.chain.lower, bindings, time));
        footQ.push(sampleQuaternion(foot.chain.foot, bindings, time));
        continue;
      }

      const middleTarget = twoBoneMiddleTarget(
        upperPosition,
        lowerPosition,
        footPosition,
        target,
      );
      const overrides = new Map<string, THREE.Quaternion>();
      aimBoneAtTarget(
        foot.chain.upper,
        foot.chain.lower,
        middleTarget,
        bindings,
        time,
        overrides,
      );
      aimBoneAtTarget(
        foot.chain.lower,
        foot.chain.foot,
        target,
        bindings,
        time,
        overrides,
      );
      upperQ.push(
        overrides.get(foot.chain.upper.uuid)
          ?? sampleQuaternion(foot.chain.upper, bindings, time),
      );
      lowerQ.push(
        overrides.get(foot.chain.lower.uuid)
          ?? sampleQuaternion(foot.chain.lower, bindings, time),
      );
      footQ.push(sampleQuaternion(foot.chain.foot, bindings, time));
    }

    const upperReplaced = replaceQuaternionTrack(model, clip, foot.chain.upper, times, upperQ);
    const lowerReplaced = replaceQuaternionTrack(model, clip, foot.chain.lower, times, lowerQ);
    replaceQuaternionTrack(model, clip, foot.chain.foot, times, footQ);
    anyApplied ||= upperReplaced && lowerReplaced;
  }

  const finalBindings = buildBindings(model, clip);
  const feet: FootStabilizerFootReport[] = detected.map((foot) => {
    const outputPoints = times.map((time) => worldPositionAt(foot.chain.foot, finalBindings, time));
    let contactFrameCount = 0;
    let maxInputDrift = 0;
    let maxOutputDrift = 0;
    const intervals = foot.intervals.map((interval) => {
      const inputPath = foot.points.slice(interval.start, interval.end + 1);
      const outputPath = outputPoints.slice(interval.start, interval.end + 1);
      contactFrameCount += inputPath.length;
      maxInputDrift = Math.max(maxInputDrift, intervalDrift(inputPath, interval.anchor));
      maxOutputDrift = Math.max(maxOutputDrift, intervalDrift(outputPath, interval.anchor));
      return {
        startTime: times[interval.start],
        endTime: times[interval.end],
        anchorTime: times[interval.anchorFrame],
        anchorPosition: interval.anchorPosition,
        anchor: vecTuple(interval.anchor),
        inputPath: inputPath.map(vecTuple),
        outputPath: outputPath.map(vecTuple),
      };
    });
    const samples = times.map((time, frame) => ({
      time,
      height: foot.heights[frame],
      horizontalSpeed: foot.speeds[frame],
      contact: foot.intervals.some((interval) => frame >= interval.start && frame <= interval.end),
    }));
    return {
      side: foot.chain.side,
      footName: foot.chain.foot.name,
      chainBoneNames: [foot.chain.upper.name, foot.chain.lower.name, foot.chain.foot.name],
      intervals,
      samples,
      contactFrameCount,
      maxInputDrift,
      maxOutputDrift,
    };
  });

  const contactCount = feet.reduce((sum, foot) => sum + foot.intervals.length, 0);
  return {
    clip,
    report: {
      applied: anyApplied && contactCount > 0,
      duration: sourceClip.duration,
      sampleRate: fps,
      skeletonHeight: bounds.height,
      movementThreshold,
      heightThreshold: normalizedHeightThreshold,
      feet,
      reasons: contactCount > 0
        ? [`detected ${contactCount} ground-contact interval${contactCount === 1 ? "" : "s"}`]
        : ["two feet were identified, but no stable low-speed ground contacts passed the automatic detector"],
    },
  };
}
