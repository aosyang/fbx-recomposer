import {
  BinaryFbxDocument,
  BinaryFbxError,
  FbxNode,
  FbxProperty,
} from "./binary-fbx";
import { objectId, objectType, topNode } from "./fbx-document/objects";
import { connectionIds } from "./fbx-document/connections";
import { collectUniqueNonMeshModelIdsByName } from "./fbx-document/skeleton";
import {
  ANIMATION_OBJECT_TYPES,
  appendRemappedAnimationGraph,
  isAnimationObject,
} from "./fbx-document/animation";

export type FbxExportSelection = {
  character: boolean;
  animation: boolean;
};

export type FbxExportAvailability = {
  character: boolean;
  animation: boolean;
};

function cloneValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return value.slice();
  if (Array.isArray(value)) return value.slice();
  return value;
}

function cloneProperty(property: FbxProperty): FbxProperty {
  return new FbxProperty(
    property.code,
    property.raw.slice(),
    cloneValue(property.value),
    property.arrayCount,
    property.arrayEncoding,
  );
}

function cloneNode(node: FbxNode): FbxNode {
  return new FbxNode(
    node.name,
    node.properties.map(cloneProperty),
    node.children.map(cloneNode),
    node.hasChildSentinel,
  );
}

export function cloneBinaryFbxDocument(
  document: BinaryFbxDocument,
): BinaryFbxDocument {
  return new BinaryFbxDocument(
    document.version,
    document.nodes.map(cloneNode),
    document.footer.slice(),
  );
}

function updateDefinitions(document: BinaryFbxDocument): void {
  const objects = topNode(document, "Objects");
  const definitions = topNode(document, "Definitions");
  if (!objects || !definitions) return;

  const counts = new Map<string, number>();
  for (const child of objects.children) {
    counts.set(child.name, (counts.get(child.name) ?? 0) + 1);
  }

  const objectTypes = definitions.children.filter((child) => child.name === "ObjectType");
  for (const definition of objectTypes) {
    const type =
      typeof definition.properties[0]?.value === "string"
        ? definition.properties[0].value
        : "";
    const countNode = definition.children.find((child) => child.name === "Count");
    if (countNode?.properties[0]) {
      countNode.properties[0].replaceScalar(counts.get(type) ?? 0);
    }
  }

  const definitionsCount = definitions.children.find((child) => child.name === "Count");
  if (definitionsCount?.properties[0]) {
    definitionsCount.properties[0].replaceScalar(objectTypes.length);
  }
}

function replaceTakesWithEmpty(document: BinaryFbxDocument): void {
  const takes = topNode(document, "Takes");
  if (!takes) return;
  takes.children = takes.children.filter((child) => child.name === "Current");
  const current = takes.children.find((child) => child.name === "Current");
  if (current?.properties[0]?.code === "S") current.properties[0].replaceString("");
}

function cloneTakesFrom(
  target: BinaryFbxDocument,
  source: BinaryFbxDocument,
): void {
  const sourceTakes = topNode(source, "Takes");
  if (!sourceTakes) return;
  const targetIndex = target.nodes.findIndex((node) => node.name === "Takes");
  if (targetIndex >= 0) target.nodes[targetIndex] = cloneNode(sourceTakes);
  else target.nodes.push(cloneNode(sourceTakes));
}

function mergeDefinitionTemplates(
  target: BinaryFbxDocument,
  source: BinaryFbxDocument,
  types: Set<string>,
): void {
  const targetDefinitions = topNode(target, "Definitions");
  const sourceDefinitions = topNode(source, "Definitions");
  if (!targetDefinitions || !sourceDefinitions) return;

  const existing = new Set(
    targetDefinitions.children
      .filter((child) => child.name === "ObjectType")
      .map((child) =>
        typeof child.properties[0]?.value === "string"
          ? child.properties[0].value
          : "",
      ),
  );

  for (const child of sourceDefinitions.children) {
    if (child.name !== "ObjectType") continue;
    const type =
      typeof child.properties[0]?.value === "string" ? child.properties[0].value : "";
    if (!types.has(type) || existing.has(type)) continue;
    targetDefinitions.children.push(cloneNode(child));
    existing.add(type);
  }
}

export function analyzeFbxExportContents(
  document: BinaryFbxDocument | null,
): FbxExportAvailability {
  if (!document) return { character: false, animation: false };
  const objects = topNode(document, "Objects");
  if (!objects) return { character: false, animation: false };

  const character = objects.children.some(
    (node) => node.name === "Geometry" || (node.name === "Model" && objectType(node) === "Mesh"),
  );
  const animation = objects.children.some(
    (node) => node.name === "AnimationStack" || node.name === "AnimationCurve",
  );
  return { character, animation };
}

export function createCharacterOnlyDocument(
  source: BinaryFbxDocument,
): BinaryFbxDocument {
  const document = cloneBinaryFbxDocument(source);
  const objects = topNode(document, "Objects");
  const connections = topNode(document, "Connections");
  if (!objects) throw new BinaryFbxError("FBX Objects node is missing");

  const removedIds = new Set<string>();
  objects.children = objects.children.filter((node) => {
    if (!isAnimationObject(node)) return true;
    const id = objectId(node);
    if (id !== null) removedIds.add(id.toString());
    return false;
  });

  if (connections) {
    connections.children = connections.children.filter((node) => {
      const ids = connectionIds(node);
      if (!ids) return true;
      return !removedIds.has(ids[0].toString()) && !removedIds.has(ids[1].toString());
    });
  }

  replaceTakesWithEmpty(document);
  updateDefinitions(document);
  return document;
}

export function createAnimationOnlyDocument(
  source: BinaryFbxDocument,
): BinaryFbxDocument {
  const document = cloneBinaryFbxDocument(source);
  const objects = topNode(document, "Objects");
  const connections = topNode(document, "Connections");
  if (!objects) throw new BinaryFbxError("FBX Objects node is missing");

  const originalConnections = connections?.children ?? [];
  const keptModelIds = new Set<string>();
  for (const node of objects.children) {
    if (node.name !== "Model" || objectType(node) === "Mesh") continue;
    const id = objectId(node);
    if (id !== null) keptModelIds.add(id.toString());
  }

  const keptNodeAttributeIds = new Set<string>();
  for (const connection of originalConnections) {
    const ids = connectionIds(connection);
    if (!ids) continue;
    if (keptModelIds.has(ids[1].toString())) keptNodeAttributeIds.add(ids[0].toString());
  }

  const keepIds = new Set<string>();
  objects.children = objects.children.filter((node) => {
    const id = objectId(node);
    const idKey = id?.toString() ?? "";
    let keep = false;
    if (node.name === "Model") keep = keptModelIds.has(idKey);
    else if (node.name === "NodeAttribute") keep = keptNodeAttributeIds.has(idKey);
    else if (isAnimationObject(node)) keep = true;
    if (keep && id !== null) keepIds.add(idKey);
    return keep;
  });

  if (connections) {
    connections.children = originalConnections.filter((node) => {
      const ids = connectionIds(node);
      if (!ids) return false;
      const sourceKept = ids[0] === 0n || keepIds.has(ids[0].toString());
      const targetKept = ids[1] === 0n || keepIds.has(ids[1].toString());
      return sourceKept && targetKept;
    });
  }

  updateDefinitions(document);
  return document;
}

export function mergeCharacterAndAnimationDocuments(
  characterSource: BinaryFbxDocument,
  animationSource: BinaryFbxDocument,
): BinaryFbxDocument {
  const target = createCharacterOnlyDocument(characterSource);
  const source = createAnimationOnlyDocument(animationSource);
  const targetObjects = topNode(target, "Objects");
  const sourceObjects = topNode(source, "Objects");
  const targetConnections = topNode(target, "Connections");
  const sourceConnections = topNode(source, "Connections");
  if (!targetObjects || !sourceObjects || !targetConnections || !sourceConnections) {
    throw new BinaryFbxError("FBX Objects/Connections nodes are required for animation merge");
  }

  const targetModelIds = collectUniqueNonMeshModelIdsByName(targetObjects.children);
  appendRemappedAnimationGraph(
    sourceObjects.children,
    sourceConnections.children,
    targetObjects.children,
    targetConnections.children,
    targetModelIds,
    cloneNode,
  );

  mergeDefinitionTemplates(target, source, ANIMATION_OBJECT_TYPES);
  cloneTakesFrom(target, source);
  updateDefinitions(target);
  return target;
}

export function buildFbxExportDocument(
  characterDocument: BinaryFbxDocument | null,
  animationDocument: BinaryFbxDocument | null,
  selection: FbxExportSelection,
): BinaryFbxDocument {
  if (!selection.character && !selection.animation) {
    throw new BinaryFbxError("Select Character, Animation, or both before saving");
  }

  if (selection.character && !characterDocument) {
    throw new BinaryFbxError("No exportable character is loaded");
  }

  const embeddedAnimationAvailable =
    characterDocument !== null && analyzeFbxExportContents(characterDocument).animation;
  const resolvedAnimation =
    animationDocument ?? (embeddedAnimationAvailable ? characterDocument : null);

  if (selection.animation && !resolvedAnimation) {
    throw new BinaryFbxError("No exportable animation is loaded");
  }

  if (selection.character && selection.animation) {
    if (!characterDocument || !resolvedAnimation) {
      throw new BinaryFbxError("Character and animation are both required");
    }
    if (resolvedAnimation === characterDocument) {
      return cloneBinaryFbxDocument(characterDocument);
    }
    return mergeCharacterAndAnimationDocuments(characterDocument, resolvedAnimation);
  }

  if (selection.character) return createCharacterOnlyDocument(characterDocument!);
  return createAnimationOnlyDocument(resolvedAnimation!);
}
