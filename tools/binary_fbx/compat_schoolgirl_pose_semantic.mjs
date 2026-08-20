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

function getTrackTargetName(trackName) {
  try {
    const parsed = THREE.PropertyBinding.parseTrackName(trackName);
    if (/^bones?$/i.test(parsed.objectName || '') && parsed.objectIndex) return parsed.objectIndex;
    return parsed.nodeName || null;
  } catch { return null; }
}

function isTransformTrack(track) {
  try {
    return ['position', 'quaternion', 'rotation', 'scale'].includes(THREE.PropertyBinding.parseTrackName(track.name).propertyName);
  } catch { return false; }
}

function cloneTrack(track, target) {
  const parsed = THREE.PropertyBinding.parseTrackName(track.name);
  if (!parsed.propertyName) return null;
  const suffix = parsed.propertyIndex ? `[${parsed.propertyIndex}]` : '';
  const out = track.clone();
  out.name = `${target.uuid}.${parsed.propertyName}${suffix}`;
  return out;
}

function analyzeBones(root) {
  const canonical = new Map();
  const allByNameLast = new Map();
  let total = 0;
  let sameNameProxyCount = 0;
  root.traverse((child) => {
    if (!(child instanceof THREE.Bone) || !child.name) return;
    total += 1;
    allByNameLast.set(child.name, child);
    const proxy = child.parent instanceof THREE.Bone && child.parent.name === child.name;
    if (proxy) {
      sameNameProxyCount += 1;
      return;
    }
    const existing = canonical.get(child.name);
    if (existing && existing !== child) throw new Error(`duplicate canonical bone ${child.name}`);
    canonical.set(child.name, child);
  });
  return { total, sameNameProxyCount, canonical, allByNameLast };
}

function retarget(sourceRoot, targetRoot, sourceClip, useCanonical) {
  const sourceNames = new Set();
  sourceRoot.traverse((child) => { if (child instanceof THREE.Bone && child.name) sourceNames.add(child.name); });
  const analysis = analyzeBones(targetRoot);
  const targetMap = useCanonical ? analysis.canonical : analysis.allByNameLast;
  const tracks = [];
  for (const track of sourceClip.tracks) {
    const name = getTrackTargetName(track.name);
    if (!name || !sourceNames.has(name) || !isTransformTrack(track)) continue;
    const target = targetMap.get(name);
    if (!target) continue;
    const cloned = cloneTrack(track, target);
    if (cloned) tracks.push(cloned);
  }
  return { clip: new THREE.AnimationClip(sourceClip.name, sourceClip.duration, tracks), analysis };
}

function quatErrorDeg(a, b) {
  const d = Math.min(1, Math.abs(a.dot(b)));
  return THREE.MathUtils.radToDeg(2 * Math.acos(d));
}

function comparePose(sourceRoot, targetRoot) {
  const s = analyzeBones(sourceRoot).canonical;
  const t = analyzeBones(targetRoot).canonical;
  let matched = 0;
  let maxLocalPosition = 0;
  let maxLocalRotationDeg = 0;
  let maxLocalScale = 0;
  let maxWorldPosition = 0;
  let maxWorldRotationDeg = 0;
  let worstLocalPositionBone = '';
  let worstLocalRotationBone = '';
  let worstWorldPositionBone = '';
  const sq = new THREE.Quaternion();
  const tq = new THREE.Quaternion();
  const sp = new THREE.Vector3();
  const tp = new THREE.Vector3();
  for (const [name, sb] of s) {
    const tb = t.get(name);
    if (!tb) continue;
    matched += 1;
    const pd = sb.position.distanceTo(tb.position);
    if (pd > maxLocalPosition) { maxLocalPosition = pd; worstLocalPositionBone = name; }
    const rd = quatErrorDeg(sb.quaternion, tb.quaternion);
    if (rd > maxLocalRotationDeg) { maxLocalRotationDeg = rd; worstLocalRotationBone = name; }
    const sd = Math.max(Math.abs(sb.scale.x - tb.scale.x), Math.abs(sb.scale.y - tb.scale.y), Math.abs(sb.scale.z - tb.scale.z));
    maxLocalScale = Math.max(maxLocalScale, sd);
    sb.getWorldPosition(sp); tb.getWorldPosition(tp);
    const wpd = sp.distanceTo(tp);
    if (wpd > maxWorldPosition) { maxWorldPosition = wpd; worstWorldPositionBone = name; }
    sb.getWorldQuaternion(sq); tb.getWorldQuaternion(tq);
    maxWorldRotationDeg = Math.max(maxWorldRotationDeg, quatErrorDeg(sq, tq));
  }
  return { matched, maxLocalPosition, maxLocalRotationDeg, maxLocalScale, maxWorldPosition, maxWorldRotationDeg, worstLocalPositionBone, worstLocalRotationBone, worstWorldPositionBone };
}

function runMode(meshPath, animPath, canonical) {
  const target = loadFbx(meshPath);
  const source = loadFbx(animPath);
  const sourceClip = source.animations[0];
  if (!sourceClip) throw new Error(`no clip in ${animPath}`);
  const sourceMixer = new THREE.AnimationMixer(source);
  sourceMixer.clipAction(sourceClip).play();
  const { clip, analysis } = retarget(source, target, sourceClip, canonical);
  const targetMixer = new THREE.AnimationMixer(target);
  targetMixer.clipAction(clip).play();
  const times = sourceClip.duration > 0 ? [0, .25, .5, .75, .999].map((f) => sourceClip.duration * f) : [0];
  const samples = [];
  for (const time of times) {
    sourceMixer.setTime(time);
    targetMixer.setTime(time);
    source.updateMatrixWorld(true);
    target.updateMatrixWorld(true);
    samples.push({ time, ...comparePose(source, target) });
  }
  const maxOf = (key) => Math.max(...samples.map((s) => s[key]));
  return {
    targetBoneTotal: analysis.total,
    targetCanonicalBones: analysis.canonical.size,
    targetSameNameProxyBones: analysis.sameNameProxyCount,
    retargetTrackCount: clip.tracks.length,
    maxLocalPosition: maxOf('maxLocalPosition'),
    maxLocalRotationDeg: maxOf('maxLocalRotationDeg'),
    maxLocalScale: maxOf('maxLocalScale'),
    maxWorldPosition: maxOf('maxWorldPosition'),
    maxWorldRotationDeg: maxOf('maxWorldRotationDeg'),
    samples,
  };
}

const [meshPath, animDir] = process.argv.slice(2);
if (!meshPath || !animDir) process.exit(2);
const files = fs.readdirSync(animDir).filter((n) => n.endsWith('_final_anim.fbx')).sort();
const results = [];
for (const file of files) {
  const animPath = path.join(animDir, file);
  results.push({ file, oldMode: runMode(meshPath, animPath, false), canonicalMode: runMode(meshPath, animPath, true) });
}
const max = (mode, key) => Math.max(...results.map((r) => r[mode][key]));
console.log(JSON.stringify({
  summary: {
    animationCount: results.length,
    targetBoneTotal: results[0]?.canonicalMode.targetBoneTotal ?? 0,
    targetCanonicalBones: results[0]?.canonicalMode.targetCanonicalBones ?? 0,
    targetSameNameProxyBones: results[0]?.canonicalMode.targetSameNameProxyBones ?? 0,
    oldMaxLocalPosition: max('oldMode', 'maxLocalPosition'),
    canonicalMaxLocalPosition: max('canonicalMode', 'maxLocalPosition'),
    oldMaxLocalRotationDeg: max('oldMode', 'maxLocalRotationDeg'),
    canonicalMaxLocalRotationDeg: max('canonicalMode', 'maxLocalRotationDeg'),
    oldMaxWorldPosition: max('oldMode', 'maxWorldPosition'),
    canonicalMaxWorldPosition: max('canonicalMode', 'maxWorldPosition'),
    oldMaxWorldRotationDeg: max('oldMode', 'maxWorldRotationDeg'),
    canonicalMaxWorldRotationDeg: max('canonicalMode', 'maxWorldRotationDeg'),
  },
  results,
}, null, 2));
