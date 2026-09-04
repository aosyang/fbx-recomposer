import * as THREE from "three";
import type { FbxNode } from "../binary-fbx";
import { objectId, objectType, visibleObjectName } from "./objects";

export function collectCanonicalBones(root: THREE.Object3D): Map<string, THREE.Bone> {
  const result = new Map<string, THREE.Bone>();
  root.traverse((child) => {
    if (!(child instanceof THREE.Bone) || !child.name) return;

    // FastFBXLoader creates same-name identity proxy bones for skin clusters.
    // Keep the canonical hierarchy bone, whose parent is not a same-name Bone.
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

export function collectUniqueNonMeshModelIdsByName(
  nodes: Iterable<FbxNode>,
): Map<string, bigint> {
  const result = new Map<string, bigint>();
  const duplicates = new Set<string>();
  for (const node of nodes) {
    if (node.name !== "Model" || objectType(node) === "Mesh") continue;
    const id = objectId(node);
    const name = visibleObjectName(node);
    if (id === null || !name) continue;
    if (result.has(name)) duplicates.add(name);
    else result.set(name, id);
  }
  for (const name of duplicates) result.delete(name);
  return result;
}

export function collectModelNamesById(nodes: Iterable<FbxNode>): Map<string, string> {
  const result = new Map<string, string>();
  for (const node of nodes) {
    if (node.name !== "Model") continue;
    const id = objectId(node);
    if (id !== null) result.set(id.toString(), visibleObjectName(node));
  }
  return result;
}
