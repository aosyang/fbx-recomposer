import * as THREE from "three";
import { analyzeAnimationLoop } from "../../src/lib/animation-loop-analysis";

function buildSkeleton(rootName: string) {
  const model = new THREE.Group();
  const root = new THREE.Bone();
  root.name = rootName;
  model.add(root);
  let parent = root;
  const bones = [root];
  for (let index = 0; index < 8; index += 1) {
    const bone = new THREE.Bone();
    bone.name = `Bone${index}`;
    bone.position.y = 1;
    parent.add(bone);
    parent = bone;
    bones.push(bone);
  }
  model.updateMatrixWorld(true);
  return { model, root, hips: bones[1] };
}

const moving = buildSkeleton("MotionCarrier");
const times = [0, 1, 2, 3];
const movingClip = new THREE.AnimationClip("moving", 3, [
  new THREE.VectorKeyframeTrack(`${moving.root.name}.position`, times, [
    0, 0, 0,
    1, 0, 0,
    2, 0, 0,
    3, 0, 0,
  ]),
  new THREE.VectorKeyframeTrack(`${moving.hips.name}.position`, times, [
    0, 1, 0,
    0, 1, 0,
    0, 1, 0,
    -1, 1, 0,
  ]),
]);
const movingAnalysis = analyzeAnimationLoop(moving.model, [movingClip]);

const stationary = buildSkeleton("ArbitraryTopBone");
const stationaryClip = new THREE.AnimationClip("stationary", 3, [
  new THREE.VectorKeyframeTrack(`${stationary.root.name}.position`, times, [
    0, 0, 0,
    0, 0, 0,
    0, 0, 0,
    0, 0, 0,
  ]),
]);
const stationaryAnalysis = analyzeAnimationLoop(stationary.model, [stationaryClip]);

const gates = {
  arbitraryRootDiscovered: movingAnalysis.rootBoneNames.includes("MotionCarrier"),
  movingRootPreserved: movingAnalysis.rootMode === "preserve" && movingAnalysis.rootMotionDetected,
  artificialHoldDetected: movingAnalysis.artificialEndpointDetected,
  stationaryRootClosed: stationaryAnalysis.rootMode === "close" && !stationaryAnalysis.rootMotionDetected,
};
console.log(JSON.stringify({ movingAnalysis, stationaryAnalysis, gates }, null, 2));
const failed = Object.entries(gates).filter(([, value]) => !value).map(([key]) => key);
if (failed.length) throw new Error(`auto loop analysis gates failed: ${failed.join(", ")}`);
