import type { MotionStackConfig } from "../components/AnimationFixStack";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw new Error(`motionStack.${key} must be a boolean`);
  return value;
}

function expectNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`motionStack.${key} must be a finite number`);
  }
  return value;
}

function expectString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`motionStack.${key} must be a string`);
  return value;
}

function expectEnum<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T {
  const value = expectString(record, key);
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`motionStack.${key} is unsupported`);
  }
  return value as T;
}

/** Validate a peer-provided Tools modifier payload. */
export function parseLanMotionStack(value: unknown): MotionStackConfig | undefined {
  if (value == null) return undefined;
  if (!isRecord(value)) throw new Error("motionStack must be an object");

  const rootMotion = value.rootMotion;
  const decomposition = value.decomposition;
  const poseWarp = value.poseWarp;
  const loopFix = value.loopFix;
  const footStabilizer = value.footStabilizer;
  if (
    !isRecord(rootMotion) ||
    !isRecord(decomposition) ||
    !isRecord(poseWarp) ||
    !isRecord(loopFix) ||
    !isRecord(footStabilizer)
  ) {
    throw new Error("motionStack is missing required sections");
  }

  return {
    rootMotion: {
      enabled: expectBoolean(rootMotion, "enabled"),
      mode: expectEnum(rootMotion, "mode", ["linear", "velocity-guided"] as const),
      velocitySmoothingWindow: expectNumber(rootMotion, "velocitySmoothingWindow"),
      velocityTolerance: expectNumber(rootMotion, "velocityTolerance"),
      extractX: expectBoolean(rootMotion, "extractX"),
      extractZ: expectBoolean(rootMotion, "extractZ"),
      extractYaw: expectBoolean(rootMotion, "extractYaw"),
      yawMode: expectEnum(rootMotion, "yawMode", ["rdp", "linear"] as const),
      yawToleranceDegrees: expectNumber(rootMotion, "yawToleranceDegrees"),
    },
    decomposition: {
      enabled: expectBoolean(decomposition, "enabled"),
      baseMode: expectEnum(decomposition, "baseMode", ["preserve", "static"] as const),
      lowGain: expectNumber(decomposition, "lowGain"),
      midGain: expectNumber(decomposition, "midGain"),
      fineGain: expectNumber(decomposition, "fineGain"),
    },
    poseWarp: {
      enabled: expectBoolean(poseWarp, "enabled"),
      anchor: expectEnum(poseWarp, "anchor", ["start", "end"] as const),
      method: expectEnum(poseWarp, "method", ["blend", "rebase"] as const),
      targetName: expectString(poseWarp, "targetName"),
      targetTime: expectNumber(poseWarp, "targetTime"),
      warpStartTime: expectNumber(poseWarp, "warpStartTime"),
      warpEndTime: expectNumber(poseWarp, "warpEndTime"),
    },
    loopFix: {
      enabled: expectBoolean(loopFix, "enabled"),
      mode: expectEnum(loopFix, "mode", ["cyclic", "inertial"] as const),
      rootPolicy: expectEnum(loopFix, "rootPolicy", ["auto", "preserve", "close"] as const),
    },
    footStabilizer: {
      enabled: expectBoolean(footStabilizer, "enabled"),
      movementThreshold: expectNumber(footStabilizer, "movementThreshold"),
      heightThreshold: expectNumber(footStabilizer, "heightThreshold"),
      warpAirborneMotion: expectBoolean(footStabilizer, "warpAirborneMotion"),
      initialAnchorPosition: expectNumber(footStabilizer, "initialAnchorPosition"),
      intermediateAnchorPosition: expectNumber(footStabilizer, "intermediateAnchorPosition"),
      finalAnchorPosition: expectNumber(footStabilizer, "finalAnchorPosition"),
    },
  };
}

/**
 * Pose Warp needs a local target FBX that is not part of the FBX payload.
 * Keep timing/method settings, but require the receiver to re-load the target.
 */
export function sanitizeLanMotionStackForReceive(config: MotionStackConfig): MotionStackConfig {
  return {
    ...config,
    poseWarp: {
      ...config.poseWarp,
      enabled: false,
      targetName: "",
    },
  };
}
