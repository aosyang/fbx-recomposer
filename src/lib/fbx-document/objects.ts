import { BinaryFbxDocument, BinaryFbxError, FbxNode, FbxProperty } from "../binary-fbx";

export function topNode(document: BinaryFbxDocument, name: string): FbxNode | undefined {
  return document.nodes.find((node) => node.name === name);
}

export function scalarId(property: FbxProperty | undefined): bigint | null {
  if (!property) return null;
  if (typeof property.value === "bigint") return property.value;
  if (typeof property.value === "number" && Number.isFinite(property.value)) {
    return BigInt(Math.trunc(property.value));
  }
  return null;
}

export function objectId(node: FbxNode): bigint | null {
  return scalarId(node.properties[0]);
}

export function objectType(node: FbxNode): string {
  return typeof node.properties[2]?.value === "string" ? node.properties[2].value : "";
}

export function visibleObjectName(node: FbxNode): string {
  const raw = typeof node.properties[1]?.value === "string" ? node.properties[1].value : "";
  const marker = raw.indexOf("\u0000\u0001");
  const withoutClass = marker >= 0 ? raw.slice(0, marker) : raw;
  const namespace = withoutClass.lastIndexOf("::");
  return namespace >= 0 ? withoutClass.slice(namespace + 2) : withoutClass;
}

export function setScalarId(property: FbxProperty | undefined, value: bigint): void {
  if (!property) throw new BinaryFbxError("FBX object is missing its ID property");
  property.replaceScalar(value);
}

export function createObjectIdAllocator(nodes: Iterable<FbxNode>): () => bigint {
  let maxId = 0n;
  for (const node of nodes) {
    const id = objectId(node);
    if (id !== null && id > maxId) maxId = id;
  }
  return () => {
    maxId += 1n;
    return maxId;
  };
}
