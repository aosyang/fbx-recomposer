import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

type LoadState = "empty" | "loading" | "ready" | "error";

type BoneNode = {
  id: string;
  name: string;
  children: BoneNode[];
};

type TreeCommand = {
  expanded: boolean;
  version: number;
};

type AnimationImportPreview = {
  fileName: string;
  clips: Array<{ name: string; duration: number }>;
  selectedClipIndex: number;
  matchedBones: string[];
  unmatchedBones: string[];
  matchedRootNodes: string[];
  unmatchedRootNodes: string[];
  matchedTrackCount: number;
  error?: string;
};

type AnimationTimeline = {
  clipName: string;
  time: number;
  duration: number;
  isPlaying: boolean;
};

function getTrackBoneName(trackName: string) {
  try {
    const parsed = THREE.PropertyBinding.parseTrackName(trackName);
    if (/^bones?$/i.test(parsed.objectName) && parsed.objectIndex) {
      return parsed.objectIndex;
    }
    return parsed.nodeName || null;
  } catch {
    return null;
  }
}

function cloneTrackForObject(
  track: THREE.KeyframeTrack,
  targetObject: THREE.Object3D,
) {
  try {
    const parsed = THREE.PropertyBinding.parseTrackName(track.name);
    if (!parsed.propertyName) return null;

    const propertyIndex = parsed.propertyIndex
      ? `[${parsed.propertyIndex}]`
      : "";
    const clonedTrack = track.clone();
    clonedTrack.name = `${targetObject.uuid}.${parsed.propertyName}${propertyIndex}`;
    return clonedTrack;
  } catch {
    return null;
  }
}

function collectRootAncestorNodeNames(object: THREE.Object3D) {
  const names = new Set<string>();

  object.traverse((child) => {
    if (!(child instanceof THREE.Bone) || child.parent instanceof THREE.Bone) {
      return;
    }

    let ancestor: THREE.Object3D | null = child.parent;
    while (ancestor) {
      if (!(ancestor instanceof THREE.Bone) && ancestor.name) {
        names.add(ancestor.name);
      }
      if (ancestor === object) break;
      ancestor = ancestor.parent;
    }
  });

  return names;
}

function collectUniqueNonBoneNodes(object: THREE.Object3D) {
  const nodes = new Map<string, THREE.Object3D>();
  const duplicateNames = new Set<string>();

  object.traverse((child) => {
    if (child instanceof THREE.Bone || !child.name) return;
    if (nodes.has(child.name)) {
      nodes.delete(child.name);
      duplicateNames.add(child.name);
    } else if (!duplicateNames.has(child.name)) {
      nodes.set(child.name, child);
    }
  });

  return nodes;
}

function isTransformTrack(track: THREE.KeyframeTrack) {
  try {
    const propertyName =
      THREE.PropertyBinding.parseTrackName(track.name).propertyName;
    return ["position", "quaternion", "rotation", "scale"].includes(
      propertyName,
    );
  } catch {
    return false;
  }
}

function collectBoneHierarchy(object: THREE.Object3D): BoneNode[] {
  return object.children.flatMap((child) => {
    const children = collectBoneHierarchy(child);

    if (child instanceof THREE.Bone) {
      return [{
        id: child.uuid,
        name: child.name || "Unnamed bone",
        children,
      }];
    }

    return children;
  });
}

function filterBoneHierarchy(nodes: BoneNode[], query: string): BoneNode[] {
  if (!query) return nodes;

  return nodes.flatMap((node) => {
    const children = filterBoneHierarchy(node.children, query);
    if (!node.name.toLowerCase().includes(query) && children.length === 0) {
      return [];
    }
    return [{ ...node, children }];
  });
}

function countBoneMatches(nodes: BoneNode[], query: string): number {
  if (!query) return nodes.length;
  return nodes.reduce(
    (count, node) =>
      count +
      Number(node.name.toLowerCase().includes(query)) +
      countBoneMatches(node.children, query),
    0,
  );
}

function BoneTreeNode({
  node,
  depth,
  command,
  forceOpen,
  selectedBoneId,
  onSelect,
}: {
  node: BoneNode;
  depth: number;
  command: TreeCommand | null;
  forceOpen: boolean;
  selectedBoneId: string | null;
  onSelect: (bone: BoneNode) => void;
}) {
  const [isOpen, setIsOpen] = useState(depth < 1);
  const nodeIsOpen = forceOpen || isOpen;

  useEffect(() => {
    if (command) setIsOpen(command.expanded);
  }, [command]);

  return (
    <li role="none">
      <div
        className={`bone-row ${selectedBoneId === node.id ? "is-selected" : ""}`}
        role="treeitem"
        aria-selected={selectedBoneId === node.id}
        aria-expanded={node.children.length ? nodeIsOpen : undefined}
      >
        {node.children.length ? (
          <button
            className={`bone-expander ${nodeIsOpen ? "is-open" : ""}`}
            aria-label={`${nodeIsOpen ? "Collapse" : "Expand"} ${node.name}`}
            disabled={forceOpen}
            onClick={() => setIsOpen((current) => !current)}
          >
            ›
          </button>
        ) : (
          <span className="bone-expander-spacer" />
        )}
        <button
          className="bone-select"
          title={node.name}
          onClick={() => onSelect(node)}
        >
          <span className="bone-icon" aria-hidden="true" />
          <span>{node.name}</span>
        </button>
      </div>
      {node.children.length > 0 && nodeIsOpen && (
        <ul role="group">
          {node.children.map((child) => (
            <BoneTreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              command={command}
              forceOpen={forceOpen}
              selectedBoneId={selectedBoneId}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry?.dispose();
    const materials = Array.isArray(child.material)
      ? child.material
      : [child.material];
    materials.forEach((material) => {
      Object.values(material).forEach((value) => {
        if (value instanceof THREE.Texture) value.dispose();
      });
      material.dispose();
    });
  });
}

function getSkeletonMaterials(helper: THREE.SkeletonHelper) {
  return Array.isArray(helper.material) ? helper.material : [helper.material];
}

function disposeSkeletonHelper(helper: THREE.SkeletonHelper) {
  helper.geometry.dispose();
  getSkeletonMaterials(helper).forEach((material) => material.dispose());
}

function getBoundsIncludingBones(object: THREE.Object3D) {
  object.updateWorldMatrix(true, true);

  const bounds = new THREE.Box3().setFromObject(object, true);
  const worldPosition = new THREE.Vector3();

  object.traverse((child) => {
    if (child instanceof THREE.Bone) {
      worldPosition.setFromMatrixPosition(child.matrixWorld);
      bounds.expandByPoint(worldPosition);
    }
  });

  if (bounds.isEmpty()) {
    bounds.expandByPoint(object.getWorldPosition(worldPosition));
  }

  return bounds;
}

export default function App() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const boneLabelRef = useRef<HTMLDivElement>(null);
  const panelResizeRef = useRef<{ startX: number; startWidth: number } | null>(
    null,
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const animationInputRef = useRef<HTMLInputElement>(null);
  const loadModelRef = useRef<(file: File) => void>(() => undefined);
  const loadAnimationRef = useRef<(file: File) => void>(() => undefined);
  const selectAnimationClipRef = useRef<(index: number) => void>(
    () => undefined,
  );
  const applyAnimationRef = useRef<(clipIndex: number) => void>(
    () => undefined,
  );
  const cancelAnimationImportRef = useRef<() => void>(() => undefined);
  const selectBoneRef = useRef<(boneId: string) => void>(() => undefined);
  const frameObjectRef = useRef<() => void>(() => undefined);
  const seekAnimationRef = useRef<(time: number) => void>(() => undefined);
  const setAnimationPlayingRef = useRef<(playing: boolean) => void>(
    () => undefined,
  );
  const setBonesVisibilityRef = useRef<(visible: boolean) => void>(
    () => undefined,
  );
  const setBoneNameVisibilityRef = useRef<(visible: boolean) => void>(
    () => undefined,
  );
  const [loadState, setLoadState] = useState<LoadState>("empty");
  const [fileName, setFileName] = useState("");
  const [message, setMessage] = useState("Drop an FBX file here");
  const [isDragging, setIsDragging] = useState(false);
  const [hasBones, setHasBones] = useState(false);
  const [showBones, setShowBones] = useState(false);
  const [showBoneName, setShowBoneName] = useState(false);
  const [boneHierarchy, setBoneHierarchy] = useState<BoneNode[]>([]);
  const [boneCount, setBoneCount] = useState(0);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelWidth, setPanelWidth] = useState(260);
  const [boneSearch, setBoneSearch] = useState("");
  const [treeCommand, setTreeCommand] = useState<TreeCommand | null>(null);
  const [animationImport, setAnimationImport] =
    useState<AnimationImportPreview | null>(null);
  const [animationTimeline, setAnimationTimeline] =
    useState<AnimationTimeline | null>(null);
  const [mappingDetailsOpen, setMappingDetailsOpen] = useState(false);
  const [selectedBoneId, setSelectedBoneId] = useState<string | null>(null);
  const [droppedFile, setDroppedFile] = useState<File | null>(null);
  const normalizedBoneSearch = boneSearch.trim().toLowerCase();
  const filteredBoneHierarchy = useMemo(
    () => filterBoneHierarchy(boneHierarchy, normalizedBoneSearch),
    [boneHierarchy, normalizedBoneSearch],
  );
  const boneMatchCount = useMemo(
    () => countBoneMatches(boneHierarchy, normalizedBoneSearch),
    [boneHierarchy, normalizedBoneSearch],
  );

  useEffect(() => {
    setMappingDetailsOpen(false);
  }, [animationImport?.fileName, animationImport?.selectedClipIndex]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const boneLabel = boneLabelRef.current;
    if (!viewport || !boneLabel) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x101214);

    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100000);
    camera.position.set(4, 3, 6);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    viewport.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;

    scene.add(new THREE.HemisphereLight(0xffffff, 0x39424e, 2.2));
    const keyLight = new THREE.DirectionalLight(0xffffff, 3);
    keyLight.position.set(5, 8, 6);
    keyLight.castShadow = true;
    scene.add(keyLight);

    const grid = new THREE.GridHelper(20, 20, 0x555b63, 0x252a30);
    scene.add(grid);

    const selectionMarker = new THREE.Mesh(
      new THREE.SphereGeometry(1, 18, 12),
      new THREE.MeshBasicMaterial({
        color: 0xffd45c,
        depthTest: false,
        depthWrite: false,
      }),
    );
    selectionMarker.visible = false;
    selectionMarker.renderOrder = 1000;
    scene.add(selectionMarker);

    let model: THREE.Group | null = null;
    let mixer: THREE.AnimationMixer | null = null;
    let animationActions: THREE.AnimationAction[] = [];
    let animationDuration = 0;
    let animationClipName = "";
    let lastTimelineUpdate = 0;
    let skeletonHelper: THREE.SkeletonHelper | null = null;
    let selectedBone: THREE.Bone | null = null;
    let showSelectedBoneName = false;
    const projectedBonePosition = new THREE.Vector3();
    let referenceTransforms = new Map<
      string,
      {
        position: THREE.Vector3;
        quaternion: THREE.Quaternion;
        scale: THREE.Vector3;
      }
    >();
    let pendingAnimationSource: THREE.Group | null = null;
    let pendingAnimationFileName = "";
    let animationLoadVersion = 0;
    let lastFrame = performance.now();
    let frameId = 0;

    const resize = () => {
      const { clientWidth, clientHeight } = viewport;
      renderer.setSize(clientWidth, clientHeight, false);
      camera.aspect = clientWidth / Math.max(clientHeight, 1);
      camera.updateProjectionMatrix();
    };

    const frameObject = () => {
      if (!model) return;
      const box = getBoundsIncludingBones(model);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const radius = Math.max(size.length() * 0.5, 0.1);
      const distance = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2));
      const viewDirection = camera.position.clone().sub(controls.target);
      if (viewDirection.lengthSq() < 0.000001) {
        viewDirection.set(0.7, 0.45, 1);
      }
      viewDirection.normalize();

      controls.target.copy(center);
      camera.position.copy(center).addScaledVector(viewDirection, distance);
      camera.near = Math.max(radius / 1000, 0.001);
      camera.far = Math.max(radius * 100, 1000);
      camera.updateProjectionMatrix();
      controls.update();
    };

    frameObjectRef.current = frameObject;
    const getAnimationTime = () => animationActions[0]?.time ?? 0;
    const syncAnimationTimeline = (force = false) => {
      if (!mixer || animationDuration <= 0 || animationActions.length === 0) {
        setAnimationTimeline(null);
        return;
      }

      const now = performance.now();
      if (!force && now - lastTimelineUpdate < 80) return;
      lastTimelineUpdate = now;

      setAnimationTimeline({
        clipName: animationClipName,
        time: Math.min(getAnimationTime(), animationDuration),
        duration: animationDuration,
        isPlaying: animationActions.some((action) => !action.paused),
      });
    };

    const setActiveAnimation = (
      nextMixer: THREE.AnimationMixer,
      clips: THREE.AnimationClip[],
    ) => {
      mixer = nextMixer;
      animationActions = clips.map((clip) =>
        nextMixer.clipAction(clip).reset().play(),
      );
      animationDuration = Math.max(...clips.map((clip) => clip.duration), 0);
      animationClipName =
        clips.length === 1
          ? clips[0].name || "Animation"
          : `${clips.length} animations`;
      syncAnimationTimeline(true);
    };

    seekAnimationRef.current = (time: number) => {
      if (!mixer || animationDuration <= 0) return;
      const pausedStates = animationActions.map((action) => action.paused);
      animationActions.forEach((action) => {
        action.paused = false;
      });
      mixer.setTime(THREE.MathUtils.clamp(time, 0, animationDuration));
      mixer.update(0);
      animationActions.forEach((action, index) => {
        action.paused = pausedStates[index] ?? false;
      });
      syncAnimationTimeline(true);
    };
    setAnimationPlayingRef.current = (playing: boolean) => {
      animationActions.forEach((action) => {
        action.paused = !playing;
      });
      syncAnimationTimeline(true);
    };

    setBonesVisibilityRef.current = (visible: boolean) => {
      if (skeletonHelper) skeletonHelper.visible = visible;
    };
    setBoneNameVisibilityRef.current = (visible: boolean) => {
      showSelectedBoneName = visible;
      boneLabel.hidden = !visible || !selectedBone;
    };
    selectBoneRef.current = (boneId: string) => {
      if (!model) return;
      const object = model.getObjectByProperty("uuid", boneId);
      if (!(object instanceof THREE.Bone)) return;

      selectedBone = object;
      const position = object.getWorldPosition(new THREE.Vector3());
      const bounds = getBoundsIncludingBones(model);
      const modelRadius = Math.max(
        bounds.getSize(new THREE.Vector3()).length() * 0.5,
        0.1,
      );

      selectionMarker.visible = true;
      selectionMarker.position.copy(position);
      selectionMarker.scale.setScalar(modelRadius * 0.022);
      boneLabel.textContent = object.name || "Unnamed bone";
      boneLabel.hidden = !showSelectedBoneName;
    };

    const discardPendingAnimation = () => {
      animationLoadVersion += 1;
      if (pendingAnimationSource) {
        disposeObject(pendingAnimationSource);
        pendingAnimationSource = null;
      }
      pendingAnimationFileName = "";
      setAnimationImport(null);
    };

    const clearCurrentAnimation = () => {
      if (!model) return;

      if (mixer) {
        mixer.stopAllAction();
        mixer.uncacheRoot(model);
        mixer = null;
      }
      animationActions = [];
      animationDuration = 0;
      animationClipName = "";
      setAnimationTimeline(null);

      model.traverse((child) => {
        if (child instanceof THREE.SkinnedMesh) {
          child.skeleton.pose();
        }
      });
      model.traverse((child) => {
        const reference = referenceTransforms.get(child.uuid);
        if (!reference) return;
        child.position.copy(reference.position);
        child.quaternion.copy(reference.quaternion);
        child.scale.copy(reference.scale);
      });
      model.updateWorldMatrix(true, true);
    };

    const buildAnimationPreview = (clipIndex: number) => {
      if (!model || !pendingAnimationSource) return;

      const clips = pendingAnimationSource.animations;
      const clip = clips[clipIndex];
      if (!clip) return;

      const targetBoneNames = new Set<string>();
      model.traverse((child) => {
        if (child instanceof THREE.Bone && child.name) {
          targetBoneNames.add(child.name);
        }
      });
      const targetRootNodes = collectUniqueNonBoneNodes(model);

      const sourceBoneNames = new Set<string>();
      pendingAnimationSource.traverse((child) => {
        if (child instanceof THREE.Bone && child.name) {
          sourceBoneNames.add(child.name);
        }
      });
      const sourceRootNodeNames =
        collectRootAncestorNodeNames(pendingAnimationSource);

      const animatedBoneNames = new Set<string>();
      const animatedRootNodeNames = new Set<string>();
      let matchedTrackCount = 0;

      clip.tracks.forEach((track) => {
        const targetName = getTrackBoneName(track.name);
        if (!targetName) return;

        if (sourceBoneNames.has(targetName) && isTransformTrack(track)) {
          animatedBoneNames.add(targetName);
          if (targetBoneNames.has(targetName)) matchedTrackCount += 1;
          return;
        }

        if (
          sourceRootNodeNames.has(targetName) &&
          isTransformTrack(track)
        ) {
          animatedRootNodeNames.add(targetName);
          if (targetRootNodes.has(targetName)) matchedTrackCount += 1;
        }
      });

      const matchedBones = [...animatedBoneNames]
        .filter((name) => targetBoneNames.has(name))
        .sort();
      const unmatchedBones = [...animatedBoneNames]
        .filter((name) => !targetBoneNames.has(name))
        .sort();
      const matchedRootNodes = [...animatedRootNodeNames]
        .filter((name) => targetRootNodes.has(name))
        .sort();
      const unmatchedRootNodes = [...animatedRootNodeNames]
        .filter((name) => !targetRootNodes.has(name))
        .sort();

      setAnimationImport({
        fileName: pendingAnimationFileName,
        clips: clips.map((item, index) => ({
          name: item.name || `Animation ${index + 1}`,
          duration: item.duration,
        })),
        selectedClipIndex: clipIndex,
        matchedBones,
        unmatchedBones,
        matchedRootNodes,
        unmatchedRootNodes,
        matchedTrackCount,
        error: animatedBoneNames.size + animatedRootNodeNames.size
          ? undefined
          : "No animated bone or root-parent transform tracks were found in this FBX.",
      });
    };

    cancelAnimationImportRef.current = discardPendingAnimation;
    selectAnimationClipRef.current = buildAnimationPreview;

    loadAnimationRef.current = (file: File) => {
      if (!model || !file.name.toLowerCase().endsWith(".fbx")) return;

      discardPendingAnimation();
      const loadVersion = animationLoadVersion;
      const reader = new FileReader();
      reader.onerror = () => {
        if (loadVersion !== animationLoadVersion) return;
        setAnimationImport({
          fileName: file.name,
          clips: [],
          selectedClipIndex: 0,
          matchedBones: [],
          unmatchedBones: [],
          matchedRootNodes: [],
          unmatchedRootNodes: [],
          matchedTrackCount: 0,
          error: "Could not read this animation FBX.",
        });
      };
      reader.onload = () => {
        if (loadVersion !== animationLoadVersion) return;
        try {
          pendingAnimationSource = new FBXLoader().parse(
            reader.result as ArrayBuffer,
            "",
          );
          pendingAnimationFileName = file.name;

          if (!pendingAnimationSource.animations.length) {
            setAnimationImport({
              fileName: file.name,
              clips: [],
              selectedClipIndex: 0,
              matchedBones: [],
              unmatchedBones: [],
              matchedRootNodes: [],
              unmatchedRootNodes: [],
              matchedTrackCount: 0,
              error: "This FBX does not contain any animation clips.",
            });
            return;
          }

          buildAnimationPreview(0);
        } catch {
          setAnimationImport({
            fileName: file.name,
            clips: [],
            selectedClipIndex: 0,
            matchedBones: [],
            unmatchedBones: [],
            matchedRootNodes: [],
            unmatchedRootNodes: [],
            matchedTrackCount: 0,
            error: "This animation FBX could not be parsed.",
          });
        }
      };
      reader.readAsArrayBuffer(file);
    };

    applyAnimationRef.current = (clipIndex: number) => {
      if (!model || !pendingAnimationSource) return;

      const sourceClip = pendingAnimationSource.animations[clipIndex];
      if (!sourceClip) return;

      const targetBones = new Map<string, THREE.Bone>();
      model.traverse((child) => {
        if (child instanceof THREE.Bone && child.name) {
          targetBones.set(child.name, child);
        }
      });
      const targetRootNodes = collectUniqueNonBoneNodes(model);

      const sourceBoneNames = new Set<string>();
      pendingAnimationSource.traverse((child) => {
        if (child instanceof THREE.Bone && child.name) {
          sourceBoneNames.add(child.name);
        }
      });
      const sourceRootNodeNames =
        collectRootAncestorNodeNames(pendingAnimationSource);

      const tracks = sourceClip.tracks.flatMap((track) => {
        const targetName = getTrackBoneName(track.name);
        if (!targetName) return [];

        let targetObject: THREE.Object3D | undefined;
        if (sourceBoneNames.has(targetName) && isTransformTrack(track)) {
          targetObject = targetBones.get(targetName);
        } else if (
          sourceRootNodeNames.has(targetName) &&
          isTransformTrack(track)
        ) {
          targetObject = targetRootNodes.get(targetName);
        }

        if (!targetObject) return [];
        const clonedTrack = cloneTrackForObject(track, targetObject);
        return clonedTrack ? [clonedTrack] : [];
      });

      if (!tracks.length) return;

      clearCurrentAnimation();

      const importedClip = new THREE.AnimationClip(
        sourceClip.name || "Imported animation",
        sourceClip.duration,
        tracks,
      );
      mixer = new THREE.AnimationMixer(model);
      setActiveAnimation(mixer, [importedClip]);
      mixer.update(0);
      discardPendingAnimation();
    };

    loadModelRef.current = (file: File) => {
      if (!file.name.toLowerCase().endsWith(".fbx")) {
        setLoadState("error");
        setMessage("Please choose a .fbx file");
        return;
      }

      setLoadState("loading");
      setFileName(file.name);
      setMessage("Loading model…");
      setHasBones(false);
      setShowBones(false);
      setShowBoneName(false);
      setBoneHierarchy([]);
      setBoneCount(0);
      setPanelOpen(false);
      setBoneSearch("");
      setTreeCommand(null);
      setSelectedBoneId(null);
      setAnimationTimeline(null);
      selectedBone = null;
      selectionMarker.visible = false;
      showSelectedBoneName = false;
      boneLabel.hidden = true;
      discardPendingAnimation();
      if (skeletonHelper) skeletonHelper.visible = false;

      const reader = new FileReader();
      reader.onerror = () => {
        setLoadState("error");
        setMessage("Could not read this file");
      };
      reader.onload = () => {
        try {
          if (skeletonHelper) {
            scene.remove(skeletonHelper);
            disposeSkeletonHelper(skeletonHelper);
            skeletonHelper = null;
          }
          if (model) {
            scene.remove(model);
            disposeObject(model);
          }
          mixer = null;
          animationActions = [];
          animationDuration = 0;
          animationClipName = "";
          const loader = new FBXLoader();
          model = loader.parse(reader.result as ArrayBuffer, "");
          referenceTransforms = new Map();
          model.traverse((child) => {
            referenceTransforms.set(child.uuid, {
              position: child.position.clone(),
              quaternion: child.quaternion.clone(),
              scale: child.scale.clone(),
            });
          });
          let modelHasBones = false;
          let modelBoneCount = 0;
          model.traverse((child) => {
            if (child instanceof THREE.Bone) {
              modelHasBones = true;
              modelBoneCount += 1;
            }
            if (child instanceof THREE.Mesh) {
              child.castShadow = true;
              child.receiveShadow = true;
            }
          });
          scene.add(model);

          if (modelHasBones) {
            skeletonHelper = new THREE.SkeletonHelper(model);
            skeletonHelper.visible = false;
            getSkeletonMaterials(skeletonHelper).forEach((material) => {
              material.depthTest = false;
              material.transparent = true;
              material.opacity = 0.92;
            });
            skeletonHelper.renderOrder = 999;
            scene.add(skeletonHelper);
          }

          if (model.animations.length) {
            setActiveAnimation(
              new THREE.AnimationMixer(model),
              model.animations,
            );
          }

          frameObject();
          setHasBones(modelHasBones);
          setBoneHierarchy(collectBoneHierarchy(model));
          setBoneCount(modelBoneCount);
          setPanelOpen(modelHasBones);
          setLoadState("ready");
          setMessage("Model ready");
        } catch {
          setLoadState("error");
          setMessage("This FBX could not be parsed");
        }
      };
      reader.readAsArrayBuffer(file);
    };

    const animate = (time: number) => {
      const delta = Math.min((time - lastFrame) / 1000, 0.1);
      lastFrame = time;
      if (mixer && animationActions.some((action) => !action.paused)) {
        mixer.update(delta);
        syncAnimationTimeline();
      }
      if (selectedBone) {
        selectedBone.getWorldPosition(selectionMarker.position);
      }
      controls.update();
      if (selectedBone && showSelectedBoneName) {
        projectedBonePosition
          .copy(selectionMarker.position)
          .project(camera);
        const isVisible =
          projectedBonePosition.z >= -1 && projectedBonePosition.z <= 1;
        boneLabel.hidden = !isVisible;
        if (isVisible) {
          boneLabel.style.left =
            `${(projectedBonePosition.x * 0.5 + 0.5) * viewport.clientWidth}px`;
          boneLabel.style.top =
            `${(-projectedBonePosition.y * 0.5 + 0.5) * viewport.clientHeight}px`;
        }
      }
      renderer.render(scene, camera);
      frameId = requestAnimationFrame(animate);
    };

    const observer = new ResizeObserver(resize);
    observer.observe(viewport);
    resize();
    frameId = requestAnimationFrame(animate);

    return () => {
      observer.disconnect();
      cancelAnimationFrame(frameId);
      controls.dispose();
      if (skeletonHelper) {
        disposeSkeletonHelper(skeletonHelper);
      }
      if (pendingAnimationSource) disposeObject(pendingAnimationSource);
      if (model) disposeObject(model);
      selectionMarker.geometry.dispose();
      if (Array.isArray(selectionMarker.material)) {
        selectionMarker.material.forEach((material) => material.dispose());
      } else {
        selectionMarker.material.dispose();
      }
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  const openFile = useCallback((file?: File) => {
    if (file) loadModelRef.current(file);
  }, []);

  const formatAnimationTime = useCallback((time: number) => {
    if (!Number.isFinite(time)) return "0:00.00";
    const minutes = Math.floor(time / 60);
    const seconds = time - minutes * 60;
    return `${minutes}:${seconds.toFixed(2).padStart(5, "0")}`;
  }, []);
  const animationProgress = animationTimeline
    ? Math.min(
        100,
        Math.max(
          0,
          (animationTimeline.time / Math.max(animationTimeline.duration, 0.001)) *
            100,
        ),
      )
    : 0;
  const seekAnimationByFrame = useCallback(
    (direction: -1 | 1) => {
      if (!animationTimeline) return;
      const frameDuration = 1 / 30;
      seekAnimationRef.current(animationTimeline.time + frameDuration * direction);
    },
    [animationTimeline],
  );
  const seekAnimationFromPointer = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!animationTimeline) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const progress = Math.min(
        1,
        Math.max(0, (event.clientX - rect.left) / Math.max(rect.width, 1)),
      );
      seekAnimationRef.current(progress * animationTimeline.duration);
    },
    [animationTimeline],
  );
  const seekAnimationFromKeyboard = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!animationTimeline) return;

      const smallStep = animationTimeline.duration / 200;
      const largeStep = animationTimeline.duration / 20;
      const step = event.shiftKey ? largeStep : smallStep;

      if (event.key === "ArrowLeft") {
        seekAnimationRef.current(animationTimeline.time - step);
      } else if (event.key === "ArrowRight") {
        seekAnimationRef.current(animationTimeline.time + step);
      } else if (event.key === "Home") {
        seekAnimationRef.current(0);
      } else if (event.key === "End") {
        seekAnimationRef.current(animationTimeline.duration);
      } else {
        return;
      }

      event.preventDefault();
    },
    [animationTimeline],
  );

  const startPanelResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const panel = event.currentTarget.nextElementSibling;
      if (!(panel instanceof HTMLElement)) return;

      panelResizeRef.current = {
        startX: event.clientX,
        startWidth: panel.getBoundingClientRect().width,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.classList.add("is-active");
      event.preventDefault();
    },
    [],
  );

  const resizePanel = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const resize = panelResizeRef.current;
      const viewer = event.currentTarget.parentElement;
      if (!resize || !viewer) return;

      const maxWidth = Math.max(180, viewer.getBoundingClientRect().width * 0.6);
      const nextWidth = resize.startWidth + resize.startX - event.clientX;
      setPanelWidth(Math.round(Math.min(maxWidth, Math.max(180, nextWidth))));
    },
    [],
  );

  const stopPanelResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      panelResizeRef.current = null;
      event.currentTarget.classList.remove("is-active");
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [],
  );

  const matchedBoneCount = animationImport?.matchedBones.length ?? 0;
  const unmatchedBoneCount = animationImport?.unmatchedBones.length ?? 0;
  const totalAnimatedBoneCount = matchedBoneCount + unmatchedBoneCount;
  const unmatchedRootCount = animationImport?.unmatchedRootNodes.length ?? 0;
  const hasMappingIssues = unmatchedBoneCount + unmatchedRootCount > 0;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-left">
          <a className="brand" href="./" aria-label="FBX Viewer home">
            <span className="brand-mark">F</span>
            <span>FBX Viewer</span>
          </a>
          <div className="file-actions">
            <button className="primary-button" onClick={() => inputRef.current?.click()}>
              Open FBX
            </button>
            <button
              className="secondary-button"
              disabled={loadState !== "ready" || !hasBones}
              title={
                hasBones
                  ? "Import exact-name bone animation from another FBX"
                  : "Open a rigged FBX before importing animation"
              }
              onClick={() => animationInputRef.current?.click()}
            >
              Import Animation
            </button>
          </div>
        </div>
        <div className="viewport-display" aria-label="Viewport display controls">
          {loadState === "ready" && (
            <>
              <span className="display-label">Viewport</span>
              <button
                className={`display-toggle ${showBones ? "is-active" : ""}`}
                aria-pressed={showBones}
                disabled={!hasBones}
                title={hasBones ? "Toggle skeleton overlay" : "This model has no bones"}
                onClick={() => {
                  const nextValue = !showBones;
                  setShowBones(nextValue);
                  setBonesVisibilityRef.current(nextValue);
                }}
              >
                <span className="display-check" aria-hidden="true" />
                Bones
              </button>
              <button
                className={`display-toggle ${showBoneName ? "is-active" : ""}`}
                aria-pressed={showBoneName}
                title={
                  selectedBoneId
                    ? "Show the selected bone name in the viewport"
                    : "Show selected bone names when a bone is selected"
                }
                onClick={() => {
                  const nextValue = !showBoneName;
                  setShowBoneName(nextValue);
                  setBoneNameVisibilityRef.current(nextValue);
                }}
              >
                <span className="display-check" aria-hidden="true" />
                Bone Names
              </button>
            </>
          )}
        </div>
      </header>

      <section
        className={`viewer ${isDragging ? "is-dragging" : ""} ${
          panelOpen ? "has-panel" : ""
        }`}
        onDragEnter={(event) => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          if (event.currentTarget === event.target) setIsDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setIsDragging(false);
          const file = event.dataTransfer.files[0];
          if (!file) return;
          if (file.name.toLowerCase().endsWith(".fbx")) {
            setDroppedFile(file);
          } else {
            openFile(file);
          }
        }}
      >
        <div className="viewport-stage">
          <div ref={viewportRef} className="viewport" />
          <div ref={boneLabelRef} className="selected-bone-label" hidden />

          {loadState !== "ready" && (
            <button
              className="drop-card"
              type="button"
              onClick={() => inputRef.current?.click()}
            >
              <span className="upload-icon" aria-hidden="true">↑</span>
              <strong>{message}</strong>
              <span>
                {loadState === "loading"
                  ? fileName
                  : "or click to choose a file from your device"}
              </span>
            </button>
          )}

          {loadState === "ready" && (
            <>
              <div className="file-pill">
                <span className="status-dot" />
                <span>{fileName}</span>
              </div>
              {animationTimeline && (
                <div className="timeline-control" aria-label="Animation timeline">
                  <div className="timeline-transport">
                    <button
                      className="timeline-step timeline-step-back"
                      type="button"
                      aria-label="Step back one frame"
                      title="Step back one frame"
                      onClick={() => seekAnimationByFrame(-1)}
                    >
                      <span className="timeline-step-icon" aria-hidden="true" />
                    </button>
                    <button
                      className="timeline-play"
                      type="button"
                      aria-label={
                        animationTimeline.isPlaying
                          ? "Pause animation"
                          : "Play animation"
                      }
                      onClick={() =>
                        setAnimationPlayingRef.current(
                          !animationTimeline.isPlaying,
                        )
                      }
                    >
                      <span
                        className={`timeline-play-icon ${
                          animationTimeline.isPlaying ? "is-pause" : "is-play"
                        }`}
                        aria-hidden="true"
                      />
                    </button>
                    <button
                      className="timeline-step timeline-step-forward"
                      type="button"
                      aria-label="Step forward one frame"
                      title="Step forward one frame"
                      onClick={() => seekAnimationByFrame(1)}
                    >
                      <span className="timeline-step-icon" aria-hidden="true" />
                    </button>
                  </div>
                  <div className="timeline-meta">
                    <span title={animationTimeline.clipName}>
                      {animationTimeline.clipName}
                    </span>
                    <span>
                      {formatAnimationTime(animationTimeline.time)} /{" "}
                      {formatAnimationTime(animationTimeline.duration)}
                    </span>
                  </div>
                  <div
                    id="animation-timeline"
                    className="timeline-scrubber"
                    role="slider"
                    aria-label="Animation time"
                    aria-valuemin={0}
                    aria-valuemax={Number(animationTimeline.duration.toFixed(3))}
                    aria-valuenow={Number(animationTimeline.time.toFixed(3))}
                    aria-valuetext={`${formatAnimationTime(
                      animationTimeline.time,
                    )} of ${formatAnimationTime(animationTimeline.duration)}`}
                    tabIndex={0}
                    onPointerDown={(event) => {
                      event.currentTarget.setPointerCapture(event.pointerId);
                      setAnimationPlayingRef.current(false);
                      seekAnimationFromPointer(event);
                    }}
                    onPointerMove={(event) => {
                      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                        seekAnimationFromPointer(event);
                      }
                    }}
                    onKeyDown={seekAnimationFromKeyboard}
                  >
                    <span className="timeline-track">
                      <span
                        className="timeline-fill"
                        style={{ width: `${animationProgress}%` }}
                      />
                    </span>
                    <span
                      className="timeline-thumb"
                      style={{ left: `${animationProgress}%` }}
                    />
                  </div>
                </div>
              )}
              <div className="help">Drag to orbit · Scroll to zoom · Right-drag to pan</div>
              <div className="viewport-tools">
                <button
                  className="frame-view"
                  type="button"
                  aria-label="Frame object"
                  title="Center and fit the object without changing the viewing angle"
                  onClick={() => frameObjectRef.current()}
                >
                  <span aria-hidden="true" />
                  Frame
                </button>
                {hasBones && !panelOpen && (
                  <button
                    className="hierarchy-reopen"
                    type="button"
                    aria-label="Open bone hierarchy"
                    title="Open bone hierarchy"
                    onClick={() => setPanelOpen(true)}
                  >
                    <span aria-hidden="true" />
                  </button>
                )}
              </div>
            </>
          )}
        </div>

        {loadState === "ready" && hasBones && panelOpen && (
          <>
            <div
              className="panel-resizer"
              role="separator"
              aria-label="Resize bone hierarchy panel"
              aria-orientation="vertical"
              aria-valuemin={180}
              aria-valuenow={panelWidth}
              tabIndex={0}
              onPointerDown={startPanelResize}
              onPointerMove={resizePanel}
              onPointerUp={stopPanelResize}
              onPointerCancel={stopPanelResize}
              onLostPointerCapture={(event) => {
                panelResizeRef.current = null;
                event.currentTarget.classList.remove("is-active");
              }}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
                  return;
                }
                const viewerWidth =
                  event.currentTarget.parentElement?.getBoundingClientRect()
                    .width ?? window.innerWidth;
                const maxWidth = Math.max(180, viewerWidth * 0.6);
                const delta = event.key === "ArrowLeft" ? 16 : -16;
                setPanelWidth((current) =>
                  Math.round(
                    Math.min(maxWidth, Math.max(180, current + delta)),
                  ),
                );
                event.preventDefault();
              }}
            />
            <aside
              className="bone-panel"
              aria-label="Bone hierarchy"
              style={{ width: panelWidth }}
            >
            <div className="bone-panel-header">
              <div>
                <h2>Bone hierarchy</h2>
                <span>{boneCount} bones</span>
              </div>
              <button
                className="close-panel"
                aria-label="Close bone hierarchy"
                onClick={() => setPanelOpen(false)}
              >
                ×
              </button>
            </div>
            <div className="bone-panel-search">
              <span className="bone-search-icon" aria-hidden="true">⌕</span>
              <input
                type="search"
                value={boneSearch}
                placeholder="Search bones"
                aria-label="Search bones by name"
                onChange={(event) => setBoneSearch(event.target.value)}
              />
              {normalizedBoneSearch && (
                <>
                  <span className="bone-search-count">
                    {boneMatchCount}
                  </span>
                  <button
                    className="bone-search-clear"
                    aria-label="Clear bone search"
                    onClick={() => setBoneSearch("")}
                  >
                    ×
                  </button>
                </>
              )}
            </div>
            <div className="bone-panel-actions">
              <button
                disabled={Boolean(normalizedBoneSearch)}
                onClick={() =>
                  setTreeCommand((current) => ({
                    expanded: true,
                    version: (current?.version ?? 0) + 1,
                  }))
                }
              >
                Expand all
              </button>
              <button
                disabled={Boolean(normalizedBoneSearch)}
                onClick={() =>
                  setTreeCommand((current) => ({
                    expanded: false,
                    version: (current?.version ?? 0) + 1,
                  }))
                }
              >
                Collapse all
              </button>
            </div>
            <div className="bone-tree">
              {filteredBoneHierarchy.length > 0 ? (
                <ul role="tree">
                  {filteredBoneHierarchy.map((bone) => (
                    <BoneTreeNode
                      key={bone.id}
                      node={bone}
                      depth={0}
                      command={treeCommand}
                      forceOpen={Boolean(normalizedBoneSearch)}
                      selectedBoneId={selectedBoneId}
                      onSelect={(bone) => {
                        setSelectedBoneId(bone.id);
                        selectBoneRef.current(bone.id);
                      }}
                    />
                  ))}
                </ul>
              ) : (
                <div className="bone-search-empty">No matching bones</div>
              )}
            </div>
            </aside>
          </>
        )}

        <input
          ref={inputRef}
          className="visually-hidden"
          type="file"
          accept=".fbx"
          onChange={(event) => {
            openFile(event.target.files?.[0]);
            event.currentTarget.value = "";
          }}
        />
        <input
          ref={animationInputRef}
          className="visually-hidden"
          type="file"
          accept=".fbx"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) loadAnimationRef.current(file);
            event.currentTarget.value = "";
          }}
        />
      </section>

      {droppedFile && (
        <div className="import-backdrop">
          <section
            className="drop-choice-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="drop-choice-title"
            aria-describedby="drop-choice-description"
          >
            <div className="drop-choice-header">
              <div>
                <h2 id="drop-choice-title">How should this FBX be opened?</h2>
                <p>{droppedFile.name}</p>
              </div>
              <button
                className="close-panel"
                aria-label="Cancel"
                onClick={() => setDroppedFile(null)}
              >
                ×
              </button>
            </div>
            <p id="drop-choice-description" className="drop-choice-description">
              Open it as a new model, or import its animation onto the current model.
            </p>
            <div className="drop-choice-actions">
              <button
                className="primary-button"
                onClick={() => {
                  const file = droppedFile;
                  setDroppedFile(null);
                  openFile(file);
                }}
              >
                Open as Model
              </button>
              <button
                className="secondary-button"
                disabled={loadState !== "ready" || !hasBones}
                title={
                  hasBones
                    ? "Import exact-name bone animation"
                    : "Open a rigged model before importing animation"
                }
                onClick={() => {
                  const file = droppedFile;
                  setDroppedFile(null);
                  loadAnimationRef.current(file);
                }}
              >
                Import as Animation
              </button>
            </div>
            {(loadState !== "ready" || !hasBones) && (
              <p className="drop-choice-hint">
                Import as Animation requires a rigged model to be open first.
              </p>
            )}
          </section>
        </div>
      )}

      {animationImport && (
        <div className="import-backdrop">
          <section
            className="import-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="import-dialog-title"
          >
            <div className="import-dialog-header">
              <div>
                <h2 id="import-dialog-title">Import FBX Animation</h2>
                <p>{animationImport.fileName}</p>
              </div>
              <button
                className="close-panel"
                aria-label="Cancel animation import"
                onClick={() => cancelAnimationImportRef.current()}
              >
                ×
              </button>
            </div>

            <div className="import-dialog-body">
              {animationImport.clips.length > 0 && (
                <label className="clip-field">
                  <span>Animation clip</span>
                  <select
                    value={animationImport.selectedClipIndex}
                    onChange={(event) =>
                      selectAnimationClipRef.current(Number(event.target.value))
                    }
                  >
                    {animationImport.clips.map((clip, index) => (
                      <option key={`${clip.name}-${index}`} value={index}>
                        {clip.name} · {clip.duration.toFixed(2)}s
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {animationImport.error ? (
                <div className="import-error">{animationImport.error}</div>
              ) : (
                <>
                  <div
                    className={`import-summary ${
                      hasMappingIssues ? "is-warning" : "is-ready"
                    }`}
                  >
                    <span className="import-summary-icon" aria-hidden="true">
                      {hasMappingIssues ? "!" : "✓"}
                    </span>
                    <div>
                      <strong>
                        {totalAnimatedBoneCount > 0
                          ? unmatchedBoneCount > 0
                            ? `${matchedBoneCount} of ${totalAnimatedBoneCount} bones matched`
                            : `All ${totalAnimatedBoneCount} bones matched`
                          : hasMappingIssues
                            ? "Animation has mapping issues"
                            : "Animation is ready to import"}
                      </strong>
                      {unmatchedBoneCount > 0 && (
                        <span>
                          {unmatchedBoneCount} unmatched{" "}
                          {unmatchedBoneCount === 1 ? "bone will" : "bones will"}{" "}
                          remain in reference pose.
                        </span>
                      )}
                      {unmatchedRootCount > 0 && (
                        <span>
                          {unmatchedRootCount} unmatched root{" "}
                          {unmatchedRootCount === 1
                            ? "transform will"
                            : "transforms will"}{" "}
                          be ignored.
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="import-rule-compact">
                    <span>Bones are matched by exact name.</span>
                    <span
                      className="import-info"
                      aria-describedby="animation-matching-tooltip"
                      tabIndex={0}
                    >
                      ⓘ
                      <span
                        id="animation-matching-tooltip"
                        className="import-tooltip"
                        role="tooltip"
                      >
                        Root-parent transforms are imported only when a unique,
                        identically named target node exists. Unmatched bones
                        remain in reference pose.
                      </span>
                    </span>
                  </div>

                  {hasMappingIssues && (
                    <div className="mapping-issues">
                      {animationImport.unmatchedBones.length > 0 && (
                        <section>
                          <h3>
                            Unmatched bones
                            <span>{animationImport.unmatchedBones.length}</span>
                          </h3>
                          <p>These bones will stay in reference pose.</p>
                          <ul>
                            {animationImport.unmatchedBones.map((name) => (
                              <li key={name} title={name}>{name}</li>
                            ))}
                          </ul>
                        </section>
                      )}
                      {animationImport.unmatchedRootNodes.length > 0 && (
                        <section>
                          <h3>
                            Unmatched root transforms
                            <span>{animationImport.unmatchedRootNodes.length}</span>
                          </h3>
                          <ul>
                            {animationImport.unmatchedRootNodes.map((name) => (
                              <li key={name} title={name}>{name}</li>
                            ))}
                          </ul>
                        </section>
                      )}
                    </div>
                  )}

                  <button
                    className={`mapping-details-toggle ${
                      mappingDetailsOpen ? "is-open" : ""
                    }`}
                    aria-expanded={mappingDetailsOpen}
                    onClick={() => setMappingDetailsOpen((current) => !current)}
                  >
                    <span>Bone mapping details</span>
                    <span className="mapping-details-chevron" aria-hidden="true">
                      ›
                    </span>
                  </button>

                  {mappingDetailsOpen && (
                    <div className="mapping-details">
                      {animationImport.matchedBones.length > 0 && (
                        <section>
                          <h3>
                            Matched bones
                            <span>{animationImport.matchedBones.length}</span>
                          </h3>
                          <ul>
                            {animationImport.matchedBones.map((name) => (
                              <li key={name} title={name}>{name}</li>
                            ))}
                          </ul>
                        </section>
                      )}
                      {animationImport.matchedRootNodes.length > 0 && (
                        <section>
                          <h3>
                            Matched root transforms
                            <span>{animationImport.matchedRootNodes.length}</span>
                          </h3>
                          <ul>
                            {animationImport.matchedRootNodes.map((name) => (
                              <li key={name} title={name}>{name}</li>
                            ))}
                          </ul>
                        </section>
                      )}
                      {hasMappingIssues && (
                        <section>
                          <h3>
                            Unmatched
                            <span>
                              {unmatchedBoneCount + unmatchedRootCount}
                            </span>
                          </h3>
                          <p>Shown above because they require attention.</p>
                        </section>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="import-dialog-actions">
              <button
                className="dialog-cancel"
                onClick={() => cancelAnimationImportRef.current()}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                disabled={
                  Boolean(animationImport.error) ||
                  animationImport.matchedTrackCount === 0
                }
                onClick={() =>
                  applyAnimationRef.current(animationImport.selectedClipIndex)
                }
              >
                Import &amp; Play
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
