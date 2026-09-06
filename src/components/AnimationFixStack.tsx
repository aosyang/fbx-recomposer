import { useEffect, useState } from "react";
import type { AnimationLoopFixMode } from "../lib/animation-loop-fix";
import type { AnimationLoopRootPolicy } from "../lib/animation-loop-analysis";
import type { RootMotionExtractionMode, RootMotionYawMode } from "../lib/animation-root-motion";
import type { MotionDecompositionBaseMode } from "../lib/animation-motion-decomposition";
import "./AnimationFixStack.css";

export type MotionOperationKind = "rootMotion" | "decomposition" | "poseWarp" | "loopFix" | "footStabilizer";

export type MotionStackConfig = {
  rootMotion: {
    enabled: boolean;
    mode: RootMotionExtractionMode;
    velocitySmoothingWindow: number;
    velocityTolerance: number;
    extractX: boolean;
    extractZ: boolean;
    extractYaw: boolean;
    yawMode: RootMotionYawMode;
    yawToleranceDegrees: number;
  };
  decomposition: {
    enabled: boolean;
    baseMode: MotionDecompositionBaseMode;
    lowGain: number;
    midGain: number;
    fineGain: number;
  };
  poseWarp: {
    enabled: boolean;
    anchor: "start" | "end";
    method: "blend" | "rebase";
    targetName: string;
    targetTime: number;
    warpStartTime: number;
    warpEndTime: number;
  };
  loopFix: {
    enabled: boolean;
    mode: AnimationLoopFixMode;
    rootPolicy: AnimationLoopRootPolicy;
  };
  footStabilizer: {
    enabled: boolean;
    movementThreshold: number;
    heightThreshold: number;
    warpAirborneMotion: boolean;
    initialAnchorPosition: number;
    intermediateAnchorPosition: number;
    finalAnchorPosition: number;
  };
};

type MotionStackProps = {
  disabled: boolean;
  selected: MotionOperationKind;
  config: MotionStackConfig;
  onSelectedChange: (kind: MotionOperationKind) => void;
  onRootMotionEnabledChange: (enabled: boolean) => void;
  onDecompositionEnabledChange: (enabled: boolean) => void;
  onDecompositionBaseModeChange: (mode: MotionDecompositionBaseMode) => void;
  onDecompositionLowGainChange: (value: number) => void;
  onDecompositionMidGainChange: (value: number) => void;
  onDecompositionFineGainChange: (value: number) => void;
  onPoseWarpEnabledChange: (enabled: boolean) => void;
  onPoseWarpAnchorChange: (anchor: MotionStackConfig["poseWarp"]["anchor"]) => void;
  onPoseWarpMethodChange: (method: MotionStackConfig["poseWarp"]["method"]) => void;
  onPoseWarpTargetFileChange: (file: File | null) => void;
  onPoseWarpTargetTimeChange: (value: number) => void;
  onPoseWarpStartTimeChange: (value: number) => void;
  onPoseWarpEndTimeChange: (value: number) => void;
  onLoopFixEnabledChange: (enabled: boolean) => void;
  onFootStabilizerEnabledChange: (enabled: boolean) => void;
  onFootStabilizerWarpAirborneMotionChange: (enabled: boolean) => void;
  onFootStabilizerMovementThresholdChange: (value: number) => void;
  onFootStabilizerHeightThresholdChange: (value: number) => void;
  onFootStabilizerInitialAnchorPositionChange: (value: number) => void;
  onFootStabilizerIntermediateAnchorPositionChange: (value: number) => void;
  onFootStabilizerFinalAnchorPositionChange: (value: number) => void;
  onRootMotionModeChange: (mode: RootMotionExtractionMode) => void;
  onRootMotionSmoothingWindowChange: (value: number) => void;
  onRootMotionVelocityToleranceChange: (value: number) => void;
  onRootMotionExtractXChange: (enabled: boolean) => void;
  onRootMotionExtractZChange: (enabled: boolean) => void;
  onRootMotionExtractYawChange: (enabled: boolean) => void;
  onRootMotionYawModeChange: (mode: RootMotionYawMode) => void;
  onRootMotionYawToleranceChange: (value: number) => void;
  onLoopModeChange: (mode: AnimationLoopFixMode) => void;
  onLoopRootPolicyChange: (policy: AnimationLoopRootPolicy) => void;
};

type NumericParameterInputProps = {
  value: number;
  onCommit: (value: number) => void;
  disabled?: boolean;
  min?: number;
  max?: number;
  step?: number;
};

function NumericParameterInput({
  value,
  onCommit,
  disabled = false,
  min,
  max,
  step,
}: NumericParameterInputProps) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === "") {
      setDraft(String(value));
      return;
    }

    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }

    const clamped = Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? Number.NEGATIVE_INFINITY, parsed));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };

  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      value={draft}
      disabled={disabled}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          setDraft(String(value));
        }
      }}
    />
  );
}

function OperationCard({
  title,
  summary,
  enabled,
  selected,
  disabled,
  onSelect,
  onEnabledChange,
}: {
  title: string;
  summary: string;
  enabled: boolean;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
  onEnabledChange: (enabled: boolean) => void;
}) {
  return (
    <div
      className={`animation-fix-stack-card${selected ? " is-selected" : ""}${enabled ? "" : " is-disabled"}`}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="animation-fix-stack-card-copy">
        <strong>{title}</strong>
        <span>{summary}</span>
      </div>
      <label className="animation-fix-stack-toggle" onClick={(event) => event.stopPropagation()}>
        <input
          type="checkbox"
          checked={enabled}
          disabled={disabled}
          onChange={(event) => onEnabledChange(event.target.checked)}
        />
        <span>{enabled ? "On" : "Off"}</span>
      </label>
    </div>
  );
}

export default function MotionStack({
  disabled,
  selected,
  config,
  onSelectedChange,
  onRootMotionEnabledChange,
  onDecompositionEnabledChange,
  onDecompositionBaseModeChange,
  onDecompositionLowGainChange,
  onDecompositionMidGainChange,
  onDecompositionFineGainChange,
  onPoseWarpEnabledChange,
  onPoseWarpAnchorChange,
  onPoseWarpMethodChange,
  onPoseWarpTargetFileChange,
  onPoseWarpTargetTimeChange,
  onPoseWarpStartTimeChange,
  onPoseWarpEndTimeChange,
  onLoopFixEnabledChange,
  onFootStabilizerEnabledChange,
  onFootStabilizerWarpAirborneMotionChange,
  onFootStabilizerMovementThresholdChange,
  onFootStabilizerHeightThresholdChange,
  onFootStabilizerInitialAnchorPositionChange,
  onFootStabilizerIntermediateAnchorPositionChange,
  onFootStabilizerFinalAnchorPositionChange,
  onRootMotionModeChange,
  onRootMotionSmoothingWindowChange,
  onRootMotionVelocityToleranceChange,
  onRootMotionExtractXChange,
  onRootMotionExtractZChange,
  onRootMotionExtractYawChange,
  onRootMotionYawModeChange,
  onRootMotionYawToleranceChange,
  onLoopModeChange,
  onLoopRootPolicyChange,
}: MotionStackProps) {
  const poseWarpDuration = Math.max(
    0,
    config.poseWarp.warpEndTime - config.poseWarp.warpStartTime,
  );
  const setPoseWarpDuration = (duration: number) => {
    const clamped = Math.max(0, duration);
    if (config.poseWarp.anchor === "start") {
      onPoseWarpStartTimeChange(0);
      onPoseWarpEndTimeChange(clamped);
    } else {
      onPoseWarpStartTimeChange(Math.max(0, config.poseWarp.warpEndTime - clamped));
    }
  };

  return (
    <div className="animation-fix-stack-shell">
      <div className="animation-fix-stack-title-row">
        <div>
          <strong>Modifier Stack</strong>
        </div>
      </div>

      <div className="animation-fix-stack-list">
        <div className="animation-fix-stack-item">
          <OperationCard
            title="1. Root Motion Extraction"
            summary={config.rootMotion.mode === "velocity-guided" ? "Velocity Guided" : "Linear"}
            enabled={config.rootMotion.enabled}
            selected={selected === "rootMotion"}
            disabled={disabled}
            onSelect={() => onSelectedChange("rootMotion")}
            onEnabledChange={onRootMotionEnabledChange}
          />
          {selected === "rootMotion" && (
            <div className="animation-fix-inline-config root-motion-inline-config">
              <div className="root-motion-axis-row">
                <span className="root-motion-config-channel">Position</span>
                <label className="root-motion-axis-toggle"><span>X</span><input type="checkbox" checked={config.rootMotion.extractX} disabled={disabled || !config.rootMotion.enabled} onChange={(event) => onRootMotionExtractXChange(event.target.checked)} /></label>
                <label className="root-motion-axis-toggle"><span>Z</span><input type="checkbox" checked={config.rootMotion.extractZ} disabled={disabled || !config.rootMotion.enabled} onChange={(event) => onRootMotionExtractZChange(event.target.checked)} /></label>
              </div>
              <div className="root-motion-config-row root-motion-position-settings">
                <label><span>Method</span><select value={config.rootMotion.mode} disabled={disabled || !config.rootMotion.enabled} onChange={(event) => onRootMotionModeChange(event.target.value as RootMotionExtractionMode)}><option value="velocity-guided">Velocity Guided</option><option value="linear">Linear</option></select></label>
                {config.rootMotion.mode === "velocity-guided" && <>
                  <label><span>Smoothing</span><NumericParameterInput min={1} step={2} value={config.rootMotion.velocitySmoothingWindow} disabled={disabled || !config.rootMotion.enabled} onCommit={onRootMotionSmoothingWindowChange} /></label>
                  <label><span>Tolerance</span><NumericParameterInput min={0.01} step={0.05} value={config.rootMotion.velocityTolerance} disabled={disabled || !config.rootMotion.enabled} onCommit={onRootMotionVelocityToleranceChange} /></label>
                </>}
              </div>
              <div className="root-motion-config-row">
                <label className="root-motion-config-channel root-motion-yaw-toggle"><span>Yaw</span><input type="checkbox" checked={config.rootMotion.extractYaw} disabled={disabled || !config.rootMotion.enabled} onChange={(event) => onRootMotionExtractYawChange(event.target.checked)} /></label>
                {config.rootMotion.extractYaw && <>
                  <label><span>Method</span><select value={config.rootMotion.yawMode} disabled={disabled || !config.rootMotion.enabled} onChange={(event) => onRootMotionYawModeChange(event.target.value as RootMotionYawMode)}><option value="rdp">RDP</option><option value="linear">Linear</option></select></label>
                  {config.rootMotion.yawMode === "rdp" && <label><span>Tolerance °</span><NumericParameterInput min={0.01} step={0.25} value={config.rootMotion.yawToleranceDegrees} disabled={disabled || !config.rootMotion.enabled} onCommit={onRootMotionYawToleranceChange} /></label>}
                </>}
              </div>
            </div>
          )}
        </div>
        <div className="animation-fix-stack-item">
          <OperationCard
            title="2. Motion Decomposition"
            summary={`${config.decomposition.baseMode === "static" ? "Static Base" : "Preserve Base"} · 3 detail bands`}
            enabled={config.decomposition.enabled}
            selected={selected === "decomposition"}
            disabled={disabled}
            onSelect={() => onSelectedChange("decomposition")}
            onEnabledChange={onDecompositionEnabledChange}
          />
          {selected === "decomposition" && (
            <div className="animation-fix-inline-config decomposition-inline-config">
              <label className="decomposition-base-control"><span>Base</span><select value={config.decomposition.baseMode} disabled={disabled || !config.decomposition.enabled} onChange={(event) => onDecompositionBaseModeChange(event.target.value as MotionDecompositionBaseMode)}><option value="preserve">Preserve</option><option value="static">Static Pose</option></select></label>
              <div className="decomposition-gain-sliders">
                <label className="decomposition-gain-slider">
                  <span>Low gain</span>
                  <input type="range" min={0} max={2} step={0.1} value={config.decomposition.lowGain} disabled={disabled || !config.decomposition.enabled} onChange={(event) => onDecompositionLowGainChange(Number(event.target.value))} />
                  <output>{config.decomposition.lowGain.toFixed(1)}</output>
                </label>
                <label className="decomposition-gain-slider">
                  <span>Mid gain</span>
                  <input type="range" min={0} max={2} step={0.1} value={config.decomposition.midGain} disabled={disabled || !config.decomposition.enabled} onChange={(event) => onDecompositionMidGainChange(Number(event.target.value))} />
                  <output>{config.decomposition.midGain.toFixed(1)}</output>
                </label>
                <label className="decomposition-gain-slider">
                  <span>Fine gain</span>
                  <input type="range" min={0} max={2} step={0.1} value={config.decomposition.fineGain} disabled={disabled || !config.decomposition.enabled} onChange={(event) => onDecompositionFineGainChange(Number(event.target.value))} />
                  <output>{config.decomposition.fineGain.toFixed(1)}</output>
                </label>
              </div>
            </div>
          )}
        </div>
        <div className="animation-fix-stack-item">
          <OperationCard
            title="3. Pose Warp"
            summary={config.poseWarp.targetName || "Choose target pose FBX"}
            enabled={config.poseWarp.enabled}
            selected={selected === "poseWarp"}
            disabled={disabled}
            onSelect={() => onSelectedChange("poseWarp")}
            onEnabledChange={onPoseWarpEnabledChange}
          />
          {selected === "poseWarp" && (
            <div className="animation-fix-inline-config pose-warp-inline-config">
              <div className="pose-warp-primary">
                <div className="pose-warp-field">
                  <span className="pose-warp-field-label">Match</span>
                  <div className="pose-warp-segmented" role="group" aria-label="Pose warp goal">
                    <button
                      type="button"
                      className={config.poseWarp.anchor === "start" ? "is-active" : ""}
                      disabled={disabled || !config.poseWarp.enabled}
                      onClick={() => onPoseWarpAnchorChange("start")}
                    >
                      Start
                    </button>
                    <button
                      type="button"
                      className={config.poseWarp.anchor === "end" ? "is-active" : ""}
                      disabled={disabled || !config.poseWarp.enabled}
                      onClick={() => onPoseWarpAnchorChange("end")}
                    >
                      End
                    </button>
                  </div>
                </div>

                <div className="pose-warp-field">
                  <span className="pose-warp-field-label">Method</span>
                  <div className="pose-warp-segmented" role="group" aria-label="Pose warp method">
                    <button
                      type="button"
                      className={config.poseWarp.method === "blend" ? "is-active" : ""}
                      disabled={disabled || !config.poseWarp.enabled}
                      onClick={() => onPoseWarpMethodChange("blend")}
                    >
                      Pose Blend
                    </button>
                    <button
                      type="button"
                      className={config.poseWarp.method === "rebase" ? "is-active" : ""}
                      disabled={disabled || !config.poseWarp.enabled}
                      onClick={() => onPoseWarpMethodChange("rebase")}
                    >
                      Motion Rebase
                    </button>
                  </div>
                </div>

                <div className="pose-warp-field">
                  <span className="pose-warp-field-label">Target Pose</span>
                  <label className="pose-warp-file-picker">
                    <input
                      type="file"
                      accept=".fbx"
                      disabled={disabled}
                      onChange={(event) => onPoseWarpTargetFileChange(event.target.files?.[0] ?? null)}
                    />
                    <span className="pose-warp-file-name">
                      {config.poseWarp.targetName || "Choose Pose FBX…"}
                    </span>
                    <span className="pose-warp-file-action">
                      {config.poseWarp.targetName ? "Change" : "Choose"}
                    </span>
                  </label>
                </div>

                <div className="pose-warp-field">
                  <span className="pose-warp-field-label">
                    {config.poseWarp.anchor === "start" ? "Blend Back" : "Blend Into Target"}
                  </span>
                  <div className="pose-warp-duration">
                    <NumericParameterInput
                      min={0.001}
                      step={0.033}
                      value={poseWarpDuration}
                      disabled={disabled || !config.poseWarp.enabled}
                      onCommit={setPoseWarpDuration}
                    />
                    <span>s</span>
                  </div>
                </div>

                <div className="pose-warp-flow" aria-label="Pose warp direction">
                  <span>{config.poseWarp.anchor === "start" ? "Target Pose" : "Original Motion"}</span>
                  <span className="pose-warp-flow-arrow">→</span>
                  <span>{config.poseWarp.anchor === "start" ? "Original Motion" : "Target Pose"}</span>
                </div>
              </div>

              <details className="pose-warp-advanced">
                <summary>Advanced</summary>
                <div className="pose-warp-advanced-body">
                  <label>
                    <span>Target time</span>
                    <NumericParameterInput
                      min={0}
                      step={0.033}
                      value={config.poseWarp.targetTime}
                      disabled={disabled || !config.poseWarp.enabled}
                      onCommit={onPoseWarpTargetTimeChange}
                    />
                  </label>
                  <div className="pose-warp-region">
                    <span>Warp region</span>
                    <NumericParameterInput
                      min={0}
                      step={0.033}
                      value={Number(config.poseWarp.warpStartTime.toFixed(3))}
                      disabled={disabled || !config.poseWarp.enabled}
                      onCommit={onPoseWarpStartTimeChange}
                    />
                    <span className="pose-warp-region-arrow">→</span>
                    <NumericParameterInput
                      min={0}
                      step={0.033}
                      value={Number(config.poseWarp.warpEndTime.toFixed(3))}
                      disabled={disabled || !config.poseWarp.enabled}
                      onCommit={onPoseWarpEndTimeChange}
                    />
                  </div>
                  <div className="pose-warp-status">
                    <span>Root Motion</span>
                    <strong>Preserved</strong>
                  </div>
                </div>
              </details>
            </div>
          )}
        </div>
        <div className="animation-fix-stack-item">
          <OperationCard
            title="4. Loop Repair"
            summary={`${config.loopFix.mode === "cyclic" ? "Cyclic" : "Inertial"} · ${config.loopFix.rootPolicy === "auto" ? "Auto root" : config.loopFix.rootPolicy === "close" ? "Close root" : "Preserve root"}`}
            enabled={config.loopFix.enabled}
            selected={selected === "loopFix"}
            disabled={disabled}
            onSelect={() => onSelectedChange("loopFix")}
            onEnabledChange={onLoopFixEnabledChange}
          />
          {selected === "loopFix" && (
            <div className="animation-fix-inline-config loop-fix-inline-config">
              <label><span>Mode</span><select value={config.loopFix.mode} disabled={disabled || !config.loopFix.enabled} onChange={(event) => onLoopModeChange(event.target.value as AnimationLoopFixMode)}><option value="cyclic">Cyclic</option><option value="inertial">Inertial</option></select></label>
              <label><span>Root</span><select value={config.loopFix.rootPolicy} disabled={disabled || !config.loopFix.enabled} onChange={(event) => onLoopRootPolicyChange(event.target.value as AnimationLoopRootPolicy)}><option value="auto">Auto</option><option value="close">Close</option><option value="preserve">Preserve</option></select></label>
            </div>
          )}
        </div>
        <div className="animation-fix-stack-item">
          <OperationCard
            title="5. Foot Stabilizer"
            summary="Auto contact · stabilize planted feet"
            enabled={config.footStabilizer.enabled}
            selected={selected === "footStabilizer"}
            disabled={disabled}
            onSelect={() => onSelectedChange("footStabilizer")}
            onEnabledChange={onFootStabilizerEnabledChange}
          />
          {selected === "footStabilizer" && (
            <div className="animation-fix-inline-config foot-stabilizer-inline-config">
              <label className="foot-stabilizer-row">
                <span>Movement threshold</span>
                <div className="foot-stabilizer-value">
                  <NumericParameterInput
                    min={0}
                    step={0.01}
                    value={config.footStabilizer.movementThreshold}
                    disabled={disabled || !config.footStabilizer.enabled}
                    onCommit={onFootStabilizerMovementThresholdChange}
                  />
                  <small>height/s</small>
                </div>
              </label>
              <label className="foot-stabilizer-row">
                <span>Ground height</span>
                <div className="foot-stabilizer-value">
                  <NumericParameterInput
                    min={0}
                    step={0.005}
                    value={config.footStabilizer.heightThreshold}
                    disabled={disabled || !config.footStabilizer.enabled}
                    onCommit={onFootStabilizerHeightThresholdChange}
                  />
                  <small>height</small>
                </div>
              </label>
              <label className="foot-stabilizer-row">
                <span>Initial contact anchor</span>
                <div className="foot-stabilizer-value">
                  <NumericParameterInput
                    min={0}
                    max={1}
                    step={0.05}
                    value={config.footStabilizer.initialAnchorPosition}
                    disabled={disabled || !config.footStabilizer.enabled}
                    onCommit={onFootStabilizerInitialAnchorPositionChange}
                  />
                  <small>phase</small>
                </div>
              </label>
              <label className="foot-stabilizer-row">
                <span>Middle contact anchor</span>
                <div className="foot-stabilizer-value">
                  <NumericParameterInput
                    min={0}
                    max={1}
                    step={0.05}
                    value={config.footStabilizer.intermediateAnchorPosition}
                    disabled={disabled || !config.footStabilizer.enabled}
                    onCommit={onFootStabilizerIntermediateAnchorPositionChange}
                  />
                  <small>phase</small>
                </div>
              </label>
              <label className="foot-stabilizer-row">
                <span>Final contact anchor</span>
                <div className="foot-stabilizer-value">
                  <NumericParameterInput
                    min={0}
                    max={1}
                    step={0.05}
                    value={config.footStabilizer.finalAnchorPosition}
                    disabled={disabled || !config.footStabilizer.enabled}
                    onCommit={onFootStabilizerFinalAnchorPositionChange}
                  />
                  <small>phase</small>
                </div>
              </label>
              <label className="foot-stabilizer-row">
                <span>Warp airborne motion</span>
                <div className="foot-stabilizer-toggle">
                  <input
                    type="checkbox"
                    checked={config.footStabilizer.warpAirborneMotion}
                    disabled={disabled || !config.footStabilizer.enabled}
                    onChange={(event) => onFootStabilizerWarpAirborneMotionChange(event.target.checked)}
                  />
                  <strong>Between contacts</strong>
                </div>
              </label>
              <div className="foot-stabilizer-row">
                <span>Viewport debug</span>
                <strong>Faint = input path · bright = stabilized</strong>
              </div>
              <div className="foot-stabilizer-row">
                <span>Root Motion</span>
                <strong>Preserved</strong>
              </div>
            </div>
          )}
        </div>
      </div>

    </div>
  );
}
