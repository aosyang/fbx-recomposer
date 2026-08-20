import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { FBXLoader } from '../../src/loaders/FastFBXLoader.js';

if (!globalThis.window) globalThis.window = globalThis;
if (!globalThis.window.URL) globalThis.window.URL = {};
if (!globalThis.window.URL.createObjectURL) globalThis.window.URL.createObjectURL = () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
if (!globalThis.window.URL.revokeObjectURL) globalThis.window.URL.revokeObjectURL = () => {};
if (!globalThis.document) {
  globalThis.document = {
    createElementNS(_ns, tag) {
      if (tag !== 'img') return {};
      const listeners = new Map();
      return {
        addEventListener(type, cb) { listeners.set(type, cb); },
        removeEventListener(type) { listeners.delete(type); },
        set src(_value) { queueMicrotask(() => listeners.get('load')?.({ type: 'load', target: this })); },
      };
    },
  };
}

function loadFbx(filePath) {
  const bytes = fs.readFileSync(filePath);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const manager = new THREE.LoadingManager();
  manager.setURLModifier(() => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=');
  return new FBXLoader(manager).parse(buffer, path.dirname(filePath) + path.sep);
}

function trackTargetName(trackName) {
  try {
    const parsed = THREE.PropertyBinding.parseTrackName(trackName);
    if (/^bones?$/i.test(parsed.objectName || '') && parsed.objectIndex) return parsed.objectIndex;
    return parsed.nodeName || null;
  } catch { return null; }
}

function isTransformTrack(track) {
  try {
    const p = THREE.PropertyBinding.parseTrackName(track.name).propertyName;
    return ['position', 'quaternion', 'rotation', 'scale'].includes(p);
  } catch { return false; }
}

function cloneTrack(track, target) {
  const parsed = THREE.PropertyBinding.parseTrackName(track.name);
  if (!parsed.propertyName) return null;
  const propertyIndex = parsed.propertyIndex ? `[${parsed.propertyIndex}]` : '';
  const cloned = track.clone();
  cloned.name = `${target.uuid}.${parsed.propertyName}${propertyIndex}`;
  return cloned;
}

function collectOldNameMap(root) {
  const map = new Map();
  root.traverse((child) => {
    if (child instanceof THREE.Bone && child.name) map.set(child.name, child);
  });
  return map;
}

function collectCanonicalBoneMap(root) {
  const map = new Map();
  root.traverse((child) => {
    if (!(child instanceof THREE.Bone) || !child.name) return;
    if (child.parent instanceof THREE.Bone && child.parent.name === child.name) return;
    const existing = map.get(child.name);
    if (existing && existing !== child) throw new Error(`duplicate canonical bone ${child.name}`);
    map.set(child.name, child);
  });
  return map;
}

function buildRetargetedClip(sourceRoot, targetRoot, sourceClip, canonical) {
  const sourceNames = new Set();
  sourceRoot.traverse((o) => { if (o instanceof THREE.Bone && o.name) sourceNames.add(o.name); });
  const targets = canonical ? collectCanonicalBoneMap(targetRoot) : collectOldNameMap(targetRoot);
  const tracks = [];
  for (const track of sourceClip.tracks) {
    const name = trackTargetName(track.name);
    if (!name || !sourceNames.has(name) || !isTransformTrack(track)) continue;
    const target = targets.get(name);
    if (!target) continue;
    const cloned = cloneTrack(track, target);
    if (cloned) tracks.push(cloned);
  }
  return new THREE.AnimationClip(sourceClip.name, sourceClip.duration, tracks);
}

function computeSkinnedBounds(root) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const p = new THREE.Vector3();
  let vertices = 0;
  let meshes = 0;
  root.traverse((obj) => {
    if (!(obj instanceof THREE.SkinnedMesh)) return;
    meshes += 1;
    const pos = obj.geometry.getAttribute('position');
    if (!pos) return;
    for (let i = 0; i < pos.count; i += 1) {
      obj.getVertexPosition(i, p);
      p.applyMatrix4(obj.matrixWorld);
      box.expandByPoint(p);
      vertices += 1;
    }
  });
  const size = box.getSize(new THREE.Vector3());
  return { box, size, diagonal: size.length(), meshes, vertices };
}

function runMode(meshPath, animPath, canonical) {
  const target = loadFbx(meshPath);
  const source = loadFbx(animPath);
  const sourceClip = source.animations[0];
  if (!sourceClip) throw new Error(`no animation in ${animPath}`);
  const rest = computeSkinnedBounds(target);
  const clip = buildRetargetedClip(source, target, sourceClip, canonical);
  const mixer = new THREE.AnimationMixer(target);
  const action = mixer.clipAction(clip);
  action.play();
  const times = sourceClip.duration > 0
    ? [0, .25, .5, .75, .999].map((f) => sourceClip.duration * f)
    : [0];
  const samples = [];
  for (const t of times) {
    mixer.setTime(t);
    target.updateMatrixWorld(true);
    const b = computeSkinnedBounds(target);
    samples.push({
      t,
      size: b.size.toArray(),
      diagonal: b.diagonal,
      ratioToRest: rest.diagonal > 0 ? b.diagonal / rest.diagonal : null,
    });
  }
  return {
    trackCount: clip.tracks.length,
    restSize: rest.size.toArray(),
    restDiagonal: rest.diagonal,
    skinnedMeshCount: rest.meshes,
    vertexCount: rest.vertices,
    maxRatio: Math.max(...samples.map((s) => s.ratioToRest ?? 0)),
    samples,
  };
}

const [meshPath, animDir] = process.argv.slice(2);
if (!meshPath || !animDir) {
  console.error('usage: node compat_schoolgirl_pose.mjs MESH_FBX ANIM_DIR');
  process.exit(2);
}

const files = fs.readdirSync(animDir).filter((n) => n.endsWith('_final_anim.fbx')).sort();
const results = [];
for (const file of files) {
  const animPath = path.join(animDir, file);
  const oldMode = runMode(meshPath, animPath, false);
  const canonicalMode = runMode(meshPath, animPath, true);
  results.push({ file, oldMode, canonicalMode });
}

const summary = {
  animationCount: results.length,
  oldWorstRatio: Math.max(...results.map((r) => r.oldMode.maxRatio)),
  canonicalWorstRatio: Math.max(...results.map((r) => r.canonicalMode.maxRatio)),
  oldExplodedCount: results.filter((r) => r.oldMode.maxRatio > 5).length,
  canonicalExplodedCount: results.filter((r) => r.canonicalMode.maxRatio > 5).length,
};
console.log(JSON.stringify({ summary, results }, null, 2));
