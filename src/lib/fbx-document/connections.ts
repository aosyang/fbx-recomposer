import { FbxNode } from "../binary-fbx";
import { scalarId } from "./objects";

export function connectionIds(node: FbxNode): [bigint, bigint] | null {
  if (node.name !== "C") return null;
  const source = scalarId(node.properties[1]);
  const target = scalarId(node.properties[2]);
  if (source === null || target === null) return null;
  return [source, target];
}
