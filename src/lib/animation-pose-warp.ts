import * as THREE from "three";

export type PoseWarpAnchor = "start" | "end";

export type PoseWarpOptions = {
  anchor: PoseWarpAnchor;
  targetTime: number;
  warpStartTime: number;
  warpEndTime: number;
  shouldWarpTrack?: (track: THREE.KeyframeTrack) => boolean;
};

export type PoseWarpReport = {
  anchor: PoseWarpAnchor;
  targetTime: number;
  warpStartTime: number;
  warpEndTime: number;
  warpedPositionTracks: number;
  warpedQuaternionTracks: number;
  missingTargetTracks: number;
  skippedTracks: number;
};

function clampTime(time: number, duration: number) {
  return THREE.MathUtils.clamp(Number.isFinite(time) ? time : 0, 0, Math.max(0, duration));
}

function smootherStep01(value: number) {
  const t = THREE.MathUtils.clamp(value, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function correctionWeight(
  time: number,
  startTime: number,
  endTime: number,
  anchor: PoseWarpAnchor,
) {
  const forwardWeight = time <= startTime
    ? 0
    : time >= endTime
      ? 1
      : smootherStep01((time - startTime) / Math.max(1e-6, endTime - startTime));
  return anchor === "start" ? 1 - forwardWeight : forwardWeight;
}

function vectorAt(values: ArrayLike<number>, index: number) {
  const offset = index * 3;
  return new THREE.Vector3(
    Number(values[offset]),
    Number(values[offset + 1]),
    Number(values[offset + 2]),
  );
}

function quaternionAt(values: ArrayLike<number>, index: number) {
  const offset = index * 4;
  return new THREE.Quaternion(
    Number(values[offset]),
    Number(values[offset + 1]),
    Number(values[offset + 2]),
    Number(values[offset + 3]),
  ).normalize();
}

function sampleVectorTrack(track: THREE.VectorKeyframeTrack, time: number) {
  const count = track.times.length;
  if (count === 0 || track.values.length < 3) return new THREE.Vector3();
  if (count === 1 || time <= Number(track.times[0])) return vectorAt(track.values, 0);
  if (time >= Number(track.times[count - 1])) return vectorAt(track.values, count - 1);

  let upper = 1;
  while (upper < count && Number(track.times[upper]) < time) upper += 1;
  const lower = Math.max(0, upper - 1);
  const t0 = Number(track.times[lower]);
  const t1 = Number(track.times[upper]);
  const alpha = THREE.MathUtils.clamp((time - t0) / Math.max(1e-6, t1 - t0), 0, 1);
  return vectorAt(track.values, lower).lerp(vectorAt(track.values, upper), alpha);
}

function sampleQuaternionTrack(track: THREE.QuaternionKeyframeTrack, time: number) {
  const count = track.times.length;
  if (count === 0 || track.values.length < 4) return new THREE.Quaternion();
  if (count === 1 || time <= Number(track.times[0])) return quaternionAt(track.values, 0);
  if (time >= Number(track.times[count - 1])) return quaternionAt(track.values, count - 1);

  let upper = 1;
  while (upper < count && Number(track.times[upper]) < time) upper += 1;
  const lower = Math.max(0, upper - 1);
  const t0 = Number(track.times[lower]);
  const t1 = Number(track.times[upper]);
  const alpha = THREE.MathUtils.clamp((time - t0) / Math.max(1e-6, t1 - t0), 0, 1);
  return quaternionAt(track.values, lower)
    .slerp(quaternionAt(track.values, upper), alpha)
    .normalize();
}

function normalizeShortestQuaternion(quaternion: THREE.Quaternion) {
  if (quaternion.w < 0) {
    quaternion.x *= -1;
    quaternion.y *= -1;
    quaternion.z *= -1;
    quaternion.w *= -1;
  }
  return quaternion.normalize();
}

export function warpAnimationToPose(
  source: THREE.AnimationClip,
  targetPoseClip: THREE.AnimationClip,
  options: PoseWarpOptions,
): { clip: THREE.AnimationClip; report: PoseWarpReport } {
  const duration = Math.max(0, source.duration);
  const startTime = clampTime(options.warpStartTime, duration);
  const endTime = clampTime(options.warpEndTime, duration);
  if (endTime <= startTime) {
    throw new Error("Pose Warp end time must be greater than start time.");
  }

  const anchor = options.anchor ?? "end";
  const sourceAnchorTime = anchor === "start" ? startTime : endTime;
  const targetTime = clampTime(options.targetTime, Math.max(0, targetPoseClip.duration));
  const targetTracks = new Map(targetPoseClip.tracks.map((track) => [track.name, track]));
  const clip = source.clone();
  const report: PoseWarpReport = {
    anchor,
    targetTime,
    warpStartTime: startTime,
    warpEndTime: endTime,
    warpedPositionTracks: 0,
    warpedQuaternionTracks: 0,
    missingTargetTracks: 0,
    skippedTracks: 0,
  };

  clip.tracks.forEach((track) => {
    if (options.shouldWarpTrack && !options.shouldWarpTrack(track)) {
      report.skippedTracks += 1;
      return;
    }

    const targetTrack = targetTracks.get(track.name);
    if (!targetTrack) {
      report.missingTargetTracks += 1;
      return;
    }

    if (
      track instanceof THREE.VectorKeyframeTrack
      && targetTrack instanceof THREE.VectorKeyframeTrack
      && track.name.endsWith(".position")
      && targetTrack.name.endsWith(".position")
      && track.values.length === track.times.length * 3
    ) {
      const sourceAnchor = sampleVectorTrack(track, sourceAnchorTime);
      const targetPose = sampleVectorTrack(targetTrack, targetTime);
      const delta = targetPose.sub(sourceAnchor);
      const corrected = new Float32Array(track.values.length);
      for (let i = 0; i < track.times.length; i += 1) {
        const weight = correctionWeight(Number(track.times[i]), startTime, endTime, anchor);
        const value = vectorAt(track.values, i).addScaledVector(delta, weight);
        const offset = i * 3;
        corrected[offset] = value.x;
        corrected[offset + 1] = value.y;
        corrected[offset + 2] = value.z;
      }
      track.values = corrected;
      report.warpedPositionTracks += 1;
      return;
    }

    if (
      track instanceof THREE.QuaternionKeyframeTrack
      && targetTrack instanceof THREE.QuaternionKeyframeTrack
      && track.name.endsWith(".quaternion")
      && targetTrack.name.endsWith(".quaternion")
      && track.values.length === track.times.length * 4
    ) {
      const sourceAnchor = sampleQuaternionTrack(track, sourceAnchorTime);
      const targetPose = sampleQuaternionTrack(targetTrack, targetTime);
      const delta = normalizeShortestQuaternion(
        sourceAnchor.clone().invert().multiply(targetPose),
      );
      const identity = new THREE.Quaternion();
      const corrected = new Float32Array(track.values.length);
      for (let i = 0; i < track.times.length; i += 1) {
        const weight = correctionWeight(Number(track.times[i]), startTime, endTime, anchor);
        const correction = identity.clone().slerp(delta, weight).normalize();
        const value = quaternionAt(track.values, i).multiply(correction).normalize();
        const offset = i * 4;
        corrected[offset] = value.x;
        corrected[offset + 1] = value.y;
        corrected[offset + 2] = value.z;
        corrected[offset + 3] = value.w;
      }
      track.values = corrected;
      report.warpedQuaternionTracks += 1;
      return;
    }

    report.skippedTracks += 1;
  });

  clip.name = source.name ? source.name + " (Pose Warped)" : "Pose Warped";
  clip.resetDuration();
  return { clip, report };
}
