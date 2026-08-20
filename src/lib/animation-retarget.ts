import * as THREE from "three";

function getTrackTargetName(trackName: string) {
  try {
    const parsed = THREE.PropertyBinding.parseTrackName(trackName);
    if (/^bones?$/i.test(parsed.objectName || "") && parsed.objectIndex) {
      return parsed.objectIndex;
    }
    return parsed.nodeName || null;
  } catch {
    return null;
  }
}

function isTransformTrack(track: THREE.KeyframeTrack) {
  try {
    const property = THREE.PropertyBinding.parseTrackName(track.name).propertyName;
    return property === "position" || property === "quaternion" || property === "rotation" || property === "scale";
  } catch {
    return false;
  }
}

function collectCanonicalBones(root: THREE.Object3D) {
  const result = new Map<string, THREE.Bone>();
  root.traverse((child) => {
    if (!(child instanceof THREE.Bone) || !child.name) return;

    // FastFBXLoader creates same-name identity proxy bones for skin clusters.
    // They are parented under the real bone with the same name. Animating a
    // proxy changes the skin's bind-relative transform twice; the canonical
    // hierarchy bone is the instance whose parent is not a same-name Bone.
    const isSameNameProxy =
      child.parent instanceof THREE.Bone && child.parent.name === child.name;
    if (isSameNameProxy) return;

    const existing = result.get(child.name);
    if (existing && existing !== child) {
      throw new Error(`Multiple canonical FBX bones named ${child.name}`);
    }
    result.set(child.name, child);
  });
  return result;
}

function cloneTrackForTarget(track: THREE.KeyframeTrack, target: THREE.Object3D) {
  try {
    const parsed = THREE.PropertyBinding.parseTrackName(track.name);
    if (!parsed.propertyName) return null;
    const propertyIndex = parsed.propertyIndex ? `[${parsed.propertyIndex}]` : "";
    const cloned = track.clone();
    cloned.name = `${target.uuid}.${parsed.propertyName}${propertyIndex}`;
    return cloned;
  } catch {
    return null;
  }
}

/**
 * Bind an animation-only FBX clip to the canonical bones of a separately loaded
 * skinned FBX character.
 *
 * The final character and animation assets already share the same FBX local
 * transform contract. FastFBXLoader, however, creates additional same-name
 * identity proxy Bones for individual skin clusters. A plain name -> Bone map
 * used to overwrite the canonical bone with one of those proxies, producing
 * severe skinning spikes. We keep the animation values unchanged and retarget
 * each source bone name only to the canonical hierarchy Bone UUID. Proxy bones
 * remain identity children and inherit the canonical world transform.
 */
export function retargetClipToCanonicalBones(
  sourceRoot: THREE.Object3D,
  targetRoot: THREE.Object3D,
  sourceClip: THREE.AnimationClip,
) {
  const sourceBoneNames = new Set<string>();
  sourceRoot.traverse((child) => {
    if (child instanceof THREE.Bone && child.name) sourceBoneNames.add(child.name);
  });

  const targetBones = collectCanonicalBones(targetRoot);
  const tracks: THREE.KeyframeTrack[] = [];
  const matchedNames = new Set<string>();
  const unmatchedNames = new Set<string>();

  for (const track of sourceClip.tracks) {
    const name = getTrackTargetName(track.name);
    if (!name || !sourceBoneNames.has(name) || !isTransformTrack(track)) continue;

    const target = targetBones.get(name);
    if (!target) {
      unmatchedNames.add(name);
      continue;
    }

    const cloned = cloneTrackForTarget(track, target);
    if (cloned) {
      matchedNames.add(name);
      tracks.push(cloned);
    }
  }

  return {
    clip: new THREE.AnimationClip(
      sourceClip.name || "Imported animation",
      sourceClip.duration,
      tracks,
    ),
    matchedBoneNames: [...matchedNames],
    unmatchedBoneNames: [...unmatchedNames],
    canonicalBoneCount: targetBones.size,
  };
}
