import * as THREE from "three";
import {
  BinaryFbxDocument,
  type FbxNode,
} from "./binary-fbx";
import {
  repairLoopScalarSamples,
  repairLoopScalarSamplesInertial,
  type AnimationLoopFixMode,
} from "./animation-loop-fix";

export type BinaryFbxLoopFixReport = {
  repairedTranslationCurves: number;
  repairedRotationCurves: number;
  skippedRootCurves: number;
  skippedCurves: number;
};

export type BinaryFbxLoopFixOptions = {
  mode?: AnimationLoopFixMode;
  inertialHalfLife?: number;
  rootMode?: "close" | "preserve";
  rootModelNames?: readonly string[];
};

type CurveTarget = {
  modelId: bigint;
  modelName: string;
  propertyName: "Lcl Translation" | "Lcl Rotation";
};

const FBX_TIME_TICKS_PER_SECOND = 46186158000;
const DEFAULT_INERTIAL_HALF_LIFE = 0.09;

function bigintProperty(node: FbxNode, index: number): bigint | null {
  const property = node.properties[index];
  if (!property || property.code !== "L") return null;
  return BigInt(property.value as bigint | number);
}

function stringProperty(node: FbxNode, index: number): string {
  const property = node.properties[index];
  return property?.code === "S" ? String(property.value ?? "") : "";
}

function visibleObjectName(node: FbxNode): string {
  const raw = stringProperty(node, 1);
  const nul = raw.indexOf("\u0000");
  const withoutSuffix = nul >= 0 ? raw.slice(0, nul) : raw;
  return withoutSuffix.replace(/^[^:]+::/, "");
}

function modelNameAliases(name: string): string[] {
  const normalized = name.trim().toLowerCase();
  const leaf = normalized.split(":").pop() ?? normalized;
  return leaf === normalized ? [normalized] : [normalized, leaf];
}

function childProperty(node: FbxNode, childName: string) {
  return node.children.find((child) => child.name === childName)?.properties[0];
}

/** Restore only animation key values, preserving unrelated edits in the working FBX document. */
export function restoreBinaryFbxAnimationCurves(
  target: BinaryFbxDocument,
  pristine: BinaryFbxDocument,
): number {
  const sourceCurves = new Map<bigint, FbxNode>();
  pristine.findNodes("AnimationCurve").forEach((curve) => {
    const id = bigintProperty(curve, 0);
    if (id != null) sourceCurves.set(id, curve);
  });

  let restored = 0;
  target.findNodes("AnimationCurve").forEach((curve) => {
    const id = bigintProperty(curve, 0);
    if (id == null) return;
    const source = sourceCurves.get(id);
    if (!source) return;
    const targetValues = childProperty(curve, "KeyValueFloat");
    const sourceValues = childProperty(source, "KeyValueFloat");
    if (!targetValues || !sourceValues) return;
    targetValues.replaceArray(sourceValues.readArray());
    restored += 1;
  });
  return restored;
}

export function repairBinaryFbxAnimationLoop(
  document: BinaryFbxDocument,
  options: BinaryFbxLoopFixOptions = {},
): BinaryFbxLoopFixReport {
  const mode = options.mode ?? "cyclic";
  const halfLife = options.inertialHalfLife ?? DEFAULT_INERTIAL_HALF_LIFE;
  const rootMode = options.rootMode ?? "close";
  const report: BinaryFbxLoopFixReport = {
    repairedTranslationCurves: 0,
    repairedRotationCurves: 0,
    skippedRootCurves: 0,
    skippedCurves: 0,
  };

  const models = new Map<bigint, FbxNode>();
  const curveNodes = new Map<bigint, FbxNode>();
  const curves = new Map<bigint, FbxNode>();
  document.findNodes("Model").forEach((node) => {
    const id = bigintProperty(node, 0);
    if (id != null) models.set(id, node);
  });
  document.findNodes("AnimationCurveNode").forEach((node) => {
    const id = bigintProperty(node, 0);
    if (id != null) curveNodes.set(id, node);
  });
  document.findNodes("AnimationCurve").forEach((node) => {
    const id = bigintProperty(node, 0);
    if (id != null) curves.set(id, node);
  });

  const curveNodeTargets = new Map<bigint, CurveTarget>();
  const curveToNode = new Map<bigint, bigint>();
  const modelParents = new Map<bigint, bigint>();
  document.findNodes("C").forEach((connection) => {
    const relation = stringProperty(connection, 0);
    const source = bigintProperty(connection, 1);
    const destination = bigintProperty(connection, 2);
    if (source == null || destination == null) return;
    if (relation === "OO" && models.has(source) && models.has(destination)) {
      modelParents.set(source, destination);
      return;
    }
    if (relation !== "OP") return;
    const propertyName = stringProperty(connection, 3);

    if (curveNodes.has(source) && models.has(destination)) {
      if (propertyName !== "Lcl Translation" && propertyName !== "Lcl Rotation") return;
      curveNodeTargets.set(source, {
        modelId: destination,
        modelName: visibleObjectName(models.get(destination)!),
        propertyName,
      });
    } else if (curves.has(source) && curveNodes.has(destination)) {
      curveToNode.set(source, destination);
    }
  });

  const animatedModelIds = new Set(Array.from(curveNodeTargets.values(), (target) => target.modelId));
  const inferredRootModelIds = new Set<bigint>();
  animatedModelIds.forEach((modelId) => {
    let parent = modelParents.get(modelId);
    const visited = new Set<bigint>();
    let hasAnimatedAncestor = false;
    while (parent != null && !visited.has(parent)) {
      visited.add(parent);
      if (animatedModelIds.has(parent)) {
        hasAnimatedAncestor = true;
        break;
      }
      parent = modelParents.get(parent);
    }
    if (!hasAnimatedAncestor) inferredRootModelIds.add(modelId);
  });
  const requestedRootNames = new Set(
    (options.rootModelNames ?? []).flatMap((name) => modelNameAliases(name)),
  );

  curves.forEach((curve, curveId) => {
    const curveNodeId = curveToNode.get(curveId);
    const target = curveNodeId == null ? undefined : curveNodeTargets.get(curveNodeId);
    if (!target) {
      report.skippedCurves += 1;
      return;
    }
    const targetAliases = modelNameAliases(target.modelName);
    const namedRoot = targetAliases.some((name) => requestedRootNames.has(name));
    const inferredRoot = inferredRootModelIds.has(target.modelId);
    if (rootMode === "preserve" && (namedRoot || inferredRoot)) {
      report.skippedRootCurves += 1;
      return;
    }

    const valuesProperty = childProperty(curve, "KeyValueFloat");
    if (!valuesProperty || valuesProperty.code !== "f") {
      report.skippedCurves += 1;
      return;
    }
    const values = valuesProperty.readArray().map(Number);
    if (values.length < 4) {
      report.skippedCurves += 1;
      return;
    }

    const keyTimeProperty = childProperty(curve, "KeyTime");
    if (!keyTimeProperty || keyTimeProperty.code !== "l") {
      report.skippedCurves += 1;
      return;
    }
    const keyTimes = keyTimeProperty.readArray().map((value) => Number(value) / FBX_TIME_TICKS_PER_SECOND);
    const repaired = mode === "inertial"
      ? repairLoopScalarSamplesInertial(values, keyTimes, halfLife)
      : repairLoopScalarSamples(values, keyTimes);

    valuesProperty.replaceArray(repaired);
    if (target.propertyName === "Lcl Translation") report.repairedTranslationCurves += 1;
    else report.repairedRotationCurves += 1;
  });

  return report;
}


export type BinaryFbxAnimationSyncReport = {
  syncedTranslationCurves: number;
  syncedRotationCurves: number;
  skippedCurves: number;
};

function resolveThreeTrackTarget(model: THREE.Object3D, track: THREE.KeyframeTrack) {
  try {
    const parsed = THREE.PropertyBinding.parseTrackName(track.name);
    return model.getObjectByProperty("uuid", parsed.nodeName) ?? model.getObjectByName(parsed.nodeName);
  } catch {
    return undefined;
  }
}

function sampleThreeTrack(track: THREE.KeyframeTrack, time: number) {
  const buffer = new Float32Array(track.getValueSize());
  const factory = (track as unknown as {
    createInterpolant: (result: Float32Array) => { evaluate: (sampleTime: number) => ArrayLike<number> };
  }).createInterpolant;
  factory.call(track, buffer).evaluate(time);
  return buffer;
}

function quaternionToFbxEulerDegrees(object: THREE.Object3D, q: THREE.Quaternion) {
  const data = object.userData?.transformData as {
    preRotation?: number[];
    postRotation?: number[];
    eulerOrder?: THREE.EulerOrder;
  } | undefined;
  const xyz = "XYZ" as THREE.EulerOrder;
  const pre = data?.preRotation
    ? new THREE.Quaternion().setFromEuler(new THREE.Euler(
        THREE.MathUtils.degToRad(data.preRotation[0] ?? 0),
        THREE.MathUtils.degToRad(data.preRotation[1] ?? 0),
        THREE.MathUtils.degToRad(data.preRotation[2] ?? 0), xyz))
    : new THREE.Quaternion();
  const postAuthored = data?.postRotation
    ? new THREE.Quaternion().setFromEuler(new THREE.Euler(
        THREE.MathUtils.degToRad(data.postRotation[0] ?? 0),
        THREE.MathUtils.degToRad(data.postRotation[1] ?? 0),
        THREE.MathUtils.degToRad(data.postRotation[2] ?? 0), xyz))
    : new THREE.Quaternion();
  // Loader relation: qLocal = qPre * qEuler * inverse(qPostAuthored).
  const eulerQuaternion = pre.invert().multiply(q).multiply(postAuthored).normalize();
  const order = data?.eulerOrder ?? xyz;
  const euler = new THREE.Euler().setFromQuaternion(eulerQuaternion, order);
  return [euler.x, euler.y, euler.z].map(THREE.MathUtils.radToDeg);
}

function closestEulerBranch(value: number, reference: number) {
  return value + 360 * Math.round((reference - value) / 360);
}

/**
 * Synchronize the final browser animation back into existing FBX animation curves.
 * This keeps Save FBX semantically aligned with the Three.js preview, including
 * hierarchy-aware contact corrections. Existing curve topology/key times are preserved.
 */
export function syncBinaryFbxAnimationFromThreeClips(
  document: BinaryFbxDocument,
  model: THREE.Object3D,
  clips: THREE.AnimationClip[],
): BinaryFbxAnimationSyncReport {
  const report: BinaryFbxAnimationSyncReport = {
    syncedTranslationCurves: 0,
    syncedRotationCurves: 0,
    skippedCurves: 0,
  };
  const clip = clips[0];
  if (!clip) return report;
  model.updateMatrixWorld(true);

  const models = new Map<bigint, FbxNode>();
  const curveNodes = new Map<bigint, FbxNode>();
  const curves = new Map<bigint, FbxNode>();
  document.findNodes("Model").forEach((node) => {
    const id = bigintProperty(node, 0); if (id != null) models.set(id, node);
  });
  document.findNodes("AnimationCurveNode").forEach((node) => {
    const id = bigintProperty(node, 0); if (id != null) curveNodes.set(id, node);
  });
  document.findNodes("AnimationCurve").forEach((node) => {
    const id = bigintProperty(node, 0); if (id != null) curves.set(id, node);
  });

  const curveNodeTargets = new Map<bigint, CurveTarget>();
  const curveToNode = new Map<bigint, bigint>();
  const curveAxes = new Map<bigint, number>();
  document.findNodes("C").forEach((connection) => {
    const relation = stringProperty(connection, 0);
    const source = bigintProperty(connection, 1);
    const destination = bigintProperty(connection, 2);
    if (source == null || destination == null || relation !== "OP") return;
    const propertyName = stringProperty(connection, 3);
    if (curveNodes.has(source) && models.has(destination)) {
      if (propertyName !== "Lcl Translation" && propertyName !== "Lcl Rotation") return;
      curveNodeTargets.set(source, {
        modelId: destination,
        modelName: visibleObjectName(models.get(destination)!),
        propertyName,
      });
    } else if (curves.has(source) && curveNodes.has(destination)) {
      curveToNode.set(source, destination);
      const axis = /X$/i.test(propertyName) ? 0 : /Y$/i.test(propertyName) ? 1 : /Z$/i.test(propertyName) ? 2 : -1;
      if (axis >= 0) curveAxes.set(source, axis);
    }
  });

  const syncModelAliases = (name: string) => {
    const compact = name.trim().toLowerCase().replace(/[:_\s.-]+/g, "");
    return Array.from(new Set([...modelNameAliases(name), compact]));
  };
  const objectByAlias = new Map<string, THREE.Object3D>();
  model.traverse((object) => {
    if (!object.name) return;
    syncModelAliases(object.name).forEach((alias) => {
      if (!objectByAlias.has(alias)) objectByAlias.set(alias, object);
    });
  });
  const trackByObject = new Map<string, { position?: THREE.KeyframeTrack; quaternion?: THREE.KeyframeTrack }>();
  clip.tracks.forEach((track) => {
    const object = resolveThreeTrackTarget(model, track);
    if (!object) return;
    const entry = trackByObject.get(object.uuid) ?? {};
    if (track.name.endsWith(".position")) entry.position = track;
    else if (track.name.endsWith(".quaternion")) entry.quaternion = track;
    trackByObject.set(object.uuid, entry);
  });

  let startTick: bigint | null = null;
  curves.forEach((curve) => {
    const prop = childProperty(curve, "KeyTime");
    if (!prop || prop.code !== "l") return;
    const values = prop.readArray();
    values.forEach((value) => {
      const tick = BigInt(value as bigint | number);
      if (startTick == null || tick < startTick) startTick = tick;
    });
  });
  const origin = startTick ?? 0n;

  curves.forEach((curve, curveId) => {
    const nodeId = curveToNode.get(curveId);
    const target = nodeId == null ? undefined : curveNodeTargets.get(nodeId);
    const axis = curveAxes.get(curveId);
    if (!target || axis == null) { report.skippedCurves += 1; return; }
    const object = syncModelAliases(target.modelName).map((alias) => objectByAlias.get(alias)).find(Boolean);
    if (!object) { report.skippedCurves += 1; return; }
    const tracks = trackByObject.get(object.uuid);
    const track = target.propertyName === "Lcl Translation" ? tracks?.position : tracks?.quaternion;
    if (!track) { report.skippedCurves += 1; return; }
    const timeProperty = childProperty(curve, "KeyTime");
    const valuesProperty = childProperty(curve, "KeyValueFloat");
    if (!timeProperty || timeProperty.code !== "l" || !valuesProperty || valuesProperty.code !== "f") {
      report.skippedCurves += 1; return;
    }
    const keyTimes = timeProperty.readArray().map((value) => Number(BigInt(value as bigint | number) - origin) / FBX_TIME_TICKS_PER_SECOND);
    const original = valuesProperty.readArray().map(Number);
    if (keyTimes.length !== original.length) { report.skippedCurves += 1; return; }
    const output = keyTimes.map((time, index) => {
      const sample = sampleThreeTrack(track, THREE.MathUtils.clamp(time, 0, clip.duration));
      if (target.propertyName === "Lcl Translation") return Number(sample[axis]);
      const q = new THREE.Quaternion(sample[0], sample[1], sample[2], sample[3]).normalize();
      return closestEulerBranch(quaternionToFbxEulerDegrees(object, q)[axis], original[index]);
    });
    valuesProperty.replaceArray(new Float32Array(output));
    if (target.propertyName === "Lcl Translation") report.syncedTranslationCurves += 1;
    else report.syncedRotationCurves += 1;
  });
  return report;
}
