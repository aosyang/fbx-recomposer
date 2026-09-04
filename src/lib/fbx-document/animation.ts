import { BinaryFbxError, FbxNode } from "../binary-fbx";
import { connectionIds } from "./connections";
import {
  createObjectIdAllocator,
  objectId,
  setScalarId,
} from "./objects";
import { collectModelNamesById } from "./skeleton";

export const ANIMATION_OBJECT_TYPES = new Set([
  "AnimationStack",
  "AnimationLayer",
  "AnimationCurveNode",
  "AnimationCurve",
]);

export function isAnimationObject(node: FbxNode): boolean {
  return ANIMATION_OBJECT_TYPES.has(node.name);
}

export function appendRemappedAnimationGraph(
  sourceObjects: FbxNode[],
  sourceConnections: FbxNode[],
  targetObjects: FbxNode[],
  targetConnections: FbxNode[],
  targetModelIds: Map<string, bigint>,
  cloneNode: (node: FbxNode) => FbxNode,
): void {
  const sourceModelsById = collectModelNamesById(sourceObjects);
  const nextObjectId = createObjectIdAllocator(targetObjects);
  const animationIdMap = new Map<string, bigint>();

  for (const node of sourceObjects) {
    if (!isAnimationObject(node)) continue;
    const sourceId = objectId(node);
    if (sourceId === null) {
      throw new BinaryFbxError(`${node.name} is missing an object ID`);
    }
    const targetId = nextObjectId();
    const cloned = cloneNode(node);
    setScalarId(cloned.properties[0], targetId);
    animationIdMap.set(sourceId.toString(), targetId);
    targetObjects.push(cloned);
  }

  const mapEndpoint = (id: bigint): bigint | null => {
    if (id === 0n) return 0n;
    const animationId = animationIdMap.get(id.toString());
    if (animationId !== undefined) return animationId;
    const modelName = sourceModelsById.get(id.toString());
    if (modelName !== undefined) return targetModelIds.get(modelName) ?? null;
    return null;
  };

  for (const connection of sourceConnections) {
    const ids = connectionIds(connection);
    if (!ids) continue;
    const touchesAnimation =
      animationIdMap.has(ids[0].toString()) || animationIdMap.has(ids[1].toString());
    if (!touchesAnimation) continue;

    const mappedSource = mapEndpoint(ids[0]);
    const mappedTarget = mapEndpoint(ids[1]);
    if (mappedSource === null || mappedTarget === null) {
      const missingModelId = sourceModelsById.has(ids[0].toString())
        ? ids[0]
        : sourceModelsById.has(ids[1].toString())
          ? ids[1]
          : null;
      if (missingModelId !== null) {
        const name = sourceModelsById.get(missingModelId.toString()) ?? "unknown";
        throw new BinaryFbxError(
          `animation target ${name} is missing or ambiguous in the character FBX`,
        );
      }
      continue;
    }

    const cloned = cloneNode(connection);
    setScalarId(cloned.properties[1], mappedSource);
    setScalarId(cloned.properties[2], mappedTarget);
    targetConnections.push(cloned);
  }
}
