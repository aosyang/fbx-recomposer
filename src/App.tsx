import { useCallback, useEffect, useRef, useState } from "react";
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

function BoneTreeNode({
  node,
  depth,
  command,
  selectedBoneId,
  onSelect,
}: {
  node: BoneNode;
  depth: number;
  command: TreeCommand | null;
  selectedBoneId: string | null;
  onSelect: (bone: BoneNode) => void;
}) {
  const [isOpen, setIsOpen] = useState(depth < 1);

  useEffect(() => {
    if (command) setIsOpen(command.expanded);
  }, [command]);

  return (
    <li role="none">
      <div
        className={`bone-row ${selectedBoneId === node.id ? "is-selected" : ""}`}
        role="treeitem"
        aria-selected={selectedBoneId === node.id}
        aria-expanded={node.children.length ? isOpen : undefined}
      >
        {node.children.length ? (
          <button
            className={`bone-expander ${isOpen ? "is-open" : ""}`}
            aria-label={`${isOpen ? "Collapse" : "Expand"} ${node.name}`}
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
      {node.children.length > 0 && isOpen && (
        <ul role="group">
          {node.children.map((child) => (
            <BoneTreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              command={command}
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
  const resetViewRef = useRef<() => void>(() => undefined);
  const setBonesVisibilityRef = useRef<(visible: boolean) => void>(
    () => undefined,
  );
  const [loadState, setLoadState] = useState<LoadState>("empty");
  const [fileName, setFileName] = useState("");
  const [message, setMessage] = useState("Drop an FBX file here");
  const [isDragging, setIsDragging] = useState(false);
  const [hasBones, setHasBones] = useState(false);
  const [showBones, setShowBones] = useState(false);
  const [boneHierarchy, setBoneHierarchy] = useState<BoneNode[]>([]);
  const [boneCount, setBoneCount] = useState(0);
  const [panelOpen, setPanelOpen] = useState(false);
  const [treeCommand, setTreeCommand] = useState<TreeCommand | null>(null);
  const [animationImport, setAnimationImport] =
    useState<AnimationImportPreview | null>(null);
  const [selectedBoneId, setSelectedBoneId] = useState<string | null>(null);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

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
    let skeletonHelper: THREE.SkeletonHelper | null = null;
    let selectedBone: THREE.Bone | null = null;
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
    let lastFrame = performance.now();
    let frameId = 0;

    const resize = () => {
      const { clientWidth, clientHeight } = viewport;
      renderer.setSize(clientWidth, clientHeight, false);
      camera.aspect = clientWidth / Math.max(clientHeight, 1);
      camera.updateProjectionMatrix();
    };

    const frameModel = () => {
      if (!model) return;
      const box = getBoundsIncludingBones(model);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const radius = Math.max(size.length() * 0.5, 0.1);
      const distance = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2));

      controls.target.copy(center);
      camera.position.copy(
        center.clone().add(new THREE.Vector3(0.7, 0.45, 1).normalize().multiplyScalar(distance)),
      );
      camera.near = Math.max(radius / 1000, 0.001);
      camera.far = Math.max(radius * 100, 1000);
      camera.updateProjectionMatrix();
      controls.update();
    };

    resetViewRef.current = frameModel;
    setBonesVisibilityRef.current = (visible: boolean) => {
      if (skeletonHelper) skeletonHelper.visible = visible;
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
    };

    const discardPendingAnimation = () => {
      if (pendingAnimationSource) {
        disposeObject(pendingAnimationSource);
        pendingAnimationSource = null;
      }
      pendingAnimationFileName = "";
      setAnimationImport(null);
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

        if (sourceBoneNames.has(targetName)) {
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
      const reader = new FileReader();
      reader.onerror = () => {
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
        if (sourceBoneNames.has(targetName)) {
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

      mixer?.stopAllAction();
      mixer?.uncacheRoot(model);
      model.traverse((child) => {
        const reference = referenceTransforms.get(child.uuid);
        if (!reference) return;
        child.position.copy(reference.position);
        child.quaternion.copy(reference.quaternion);
        child.scale.copy(reference.scale);
      });
      model.traverse((child) => {
        if (child instanceof THREE.SkinnedMesh) child.skeleton.pose();
      });
      model.updateWorldMatrix(true, true);

      const importedClip = new THREE.AnimationClip(
        sourceClip.name || "Imported animation",
        sourceClip.duration,
        tracks,
      );
      mixer = new THREE.AnimationMixer(model);
      mixer.clipAction(importedClip).reset().play();
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
      setBoneHierarchy([]);
      setBoneCount(0);
      setPanelOpen(false);
      setTreeCommand(null);
      setSelectedBoneId(null);
      selectedBone = null;
      selectionMarker.visible = false;
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
            mixer = new THREE.AnimationMixer(model);
            model.animations.forEach((clip) => mixer?.clipAction(clip).play());
          }

          frameModel();
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
      mixer?.update(delta);
      if (selectedBone) {
        selectedBone.getWorldPosition(selectionMarker.position);
      }
      controls.update();
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

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="./" aria-label="FBX Viewer home">
          <span className="brand-mark">F</span>
          <span>FBX Viewer</span>
        </a>
        <div className="actions">
          {loadState === "ready" && (
            <>
              <button
                className={`panel-button ${panelOpen ? "is-active" : ""}`}
                aria-pressed={panelOpen}
                disabled={!hasBones}
                onClick={() => setPanelOpen((current) => !current)}
              >
                Hierarchy
              </button>
              <button
                className={`toggle-button ${showBones ? "is-active" : ""}`}
                aria-pressed={showBones}
                disabled={!hasBones}
                title={hasBones ? "Toggle skeleton overlay" : "This model has no bones"}
                onClick={() => {
                  const nextValue = !showBones;
                  setShowBones(nextValue);
                  setBonesVisibilityRef.current(nextValue);
                }}
              >
                <span className="toggle-indicator" />
                Bones
              </button>
              <button className="text-button" onClick={() => resetViewRef.current()}>
                Reset view
              </button>
            </>
          )}
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
          <button className="primary-button" onClick={() => inputRef.current?.click()}>
            Open FBX
          </button>
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
          openFile(event.dataTransfer.files[0]);
        }}
      >
        <div className="viewport-stage">
          <div ref={viewportRef} className="viewport" />

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
              <div className="help">Drag to orbit · Scroll to zoom · Right-drag to pan</div>
            </>
          )}
        </div>

        {loadState === "ready" && hasBones && panelOpen && (
          <aside className="bone-panel" aria-label="Bone hierarchy">
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
            <div className="bone-panel-actions">
              <button
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
              <ul role="tree">
                {boneHierarchy.map((bone) => (
                  <BoneTreeNode
                    key={bone.id}
                    node={bone}
                    depth={0}
                    command={treeCommand}
                    selectedBoneId={selectedBoneId}
                    onSelect={(bone) => {
                      setSelectedBoneId(bone.id);
                      selectBoneRef.current(bone.id);
                    }}
                  />
                ))}
              </ul>
            </div>
          </aside>
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
              <p className="import-rule">
                Exact names only. Root-parent transforms are imported only when a
                unique, identically named target node exists. Unmatched bones remain
                in their reference pose.
              </p>

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
                  <div className="import-stats">
                    <div>
                      <strong>
                        {animationImport.matchedBones.length +
                          animationImport.matchedRootNodes.length}
                      </strong>
                      <span>Exact matches</span>
                    </div>
                    <div>
                      <strong>
                        {animationImport.unmatchedBones.length +
                          animationImport.unmatchedRootNodes.length}
                      </strong>
                      <span>Ignored / reference pose</span>
                    </div>
                  </div>
                  <div className="import-bone-columns">
                    <div>
                      <h3>Will animate</h3>
                      <ul>
                        {animationImport.matchedBones.map((name) => (
                          <li key={name} className="is-matched">{name}</li>
                        ))}
                        {animationImport.matchedRootNodes.map((name) => (
                          <li key={`root-${name}`} className="is-matched is-root-transform">
                            {name} · root transform
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <h3>Will be ignored</h3>
                      <ul>
                        {animationImport.unmatchedBones.map((name) => (
                          <li key={name} className="is-unmatched">{name}</li>
                        ))}
                        {animationImport.unmatchedRootNodes.map((name) => (
                          <li key={`root-${name}`} className="is-unmatched is-root-transform">
                            {name} · root transform
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
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
