import { useEffect, useState, type ReactNode } from "react";
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

type ModifierOptionRowProps = {
  label: string;
  children: ReactNode;
  unit?: ReactNode;
  as?: "label" | "div";
  className?: string;
  controlClassName?: string;
};

function ModifierOptionRow({
  label,
  children,
  unit,
  as = "label",
  className = "",
  controlClassName = "",
}: ModifierOptionRowProps) {
  const rowClassName = `modifier-option-row${unit === undefined ? "" : " has-unit"}${className ? ` ${className}` : ""}`;
  const controlClass = `modifier-option-control${controlClassName ? ` ${controlClassName}` : ""}`;
  const control = as === "label"
    ? <span className={controlClass}>{children}</span>
    : <div className={controlClass}>{children}</div>;
  const content = <>
    <span className="modifier-option-label">{label}</span>
    {control}
    {unit !== undefined && <span className="modifier-option-unit">{unit}</span>}
  </>;

  return as === "div"
    ? <div className={rowClassName}>{content}</div>
    : <label className={rowClassName}>{content}</label>;
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
              <ModifierOptionRow label="Position" as="div" controlClassName="modifier-option-inline">
                <label className="root-motion-axis-toggle"><span>X</span><input type="checkbox" checked={config.rootMotion.extractX} disabled={disabled || !config.rootMotion.enabled} onChange={(event) => onRootMotionExtractXChange(event.target.checked)} /></label>
                <label className="root-motion-axis-toggle"><span>Z</span><input type="checkbox" checked={config.rootMotion.extractZ} disabled={disabled || !config.rootMotion.enabled} onChange={(event) => onRootMotionExtractZChange(event.target.checked)} /></label>
              </ModifierOptionRow>
              <div className="root-motion-config-row root-motion-position-settings">
                <ModifierOptionRow label="Method"><select value={config.rootMotion.mode} disabled={disabled || !config.rootMotion.enabled} onChange={(event) => onRootMotionModeChange(event.target.value as RootMotionExtractionMode)}><option value="velocity-guided">Velocity Guided</option><option value="linear">Linear</option></select></ModifierOptionRow>
                {config.rootMotion.mode === "velocity-guided" && <>
                  <ModifierOptionRow label="Smoothing"><NumericParameterInput min={1} step={2} value={config.rootMotion.velocitySmoothingWindow} disabled={disabled || !config.rootMotion.enabled} onCommit={onRootMotionSmoothingWindowChange} /></ModifierOptionRow>
                  <ModifierOptionRow label="Tolerance"><NumericParameterInput min={0.01} step={0.05} value={config.rootMotion.velocityTolerance} disabled={disabled || !config.rootMotion.enabled} onCommit={onRootMotionVelocityToleranceChange} /></ModifierOptionRow>
                </>}
              </div>
              <div className="root-motion-config-row">
                <ModifierOptionRow label="Yaw" as="div" controlClassName="modifier-option-inline">
                  <input aria-label="Yaw" type="checkbox" checked={config.rootMotion.extractYaw} disabled={disabled || !config.rootMotion.enabled} onChange={(event) => onRootMotionExtractYawChange(event.target.checked)} />
                </ModifierOptionRow>
                {config.rootMotion.extractYaw && <>
                  <ModifierOptionRow label="Yaw method"><select value={config.rootMotion.yawMode} disabled={disabled || !config.rootMotion.enabled} onChange={(event) => onRootMotionYawModeChange(event.target.value as RootMotionYawMode)}><option value="rdp">RDP</option><option value="linear">Linear</option></select></ModifierOptionRow>
                  {config.rootMotion.yawMode === "rdp" && <ModifierOptionRow label="Yaw tolerance" unit="°"><NumericParameterInput min={0.01} step={0.25} value={config.rootMotion.yawToleranceDegrees} disabled={disabled || !config.rootMotion.enabled} onCommit={onRootMotionYawToleranceChange} /></ModifierOptionRow>}
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
              <ModifierOptionRow label="Base"><select value={config.decomposition.baseMode} disabled={disabled || !config.decomposition.enabled} onChange={(event) => onDecompositionBaseModeChange(event.target.value as MotionDecompositionBaseMode)}><option value="preserve">Preserve</option><option value="static">Static Pose</option></select></ModifierOptionRow>
              <div className="decomposition-gain-sliders">
                <ModifierOptionRow label="Low gain" unit={<output>{config.decomposition.lowGain.toFixed(1)}</output>}>
                  <input type="range" min={0} max={2} step={0.1} value={config.decomposition.lowGain} disabled={disabled || !config.decomposition.enabled} onChange={(event) => onDecompositionLowGainChange(Number(event.target.value))} />
                </ModifierOptionRow>
                <ModifierOptionRow label="Mid gain" unit={<output>{config.decomposition.midGain.toFixed(1)}</output>}>
                  <input type="range" min={0} max={2} step={0.1} value={config.decomposition.midGain} disabled={disabled || !config.decomposition.enabled} onChange={(event) => onDecompositionMidGainChange(Number(event.target.value))} />
                </ModifierOptionRow>
                <ModifierOptionRow label="Fine gain" unit={<output>{config.decomposition.fineGain.toFixed(1)}</output>}>
                  <input type="range" min={0} max={2} step={0.1} value={config.decomposition.fineGain} disabled={disabled || !config.decomposition.enabled} onChange={(event) => onDecompositionFineGainChange(Number(event.target.value))} />
                </ModifierOptionRow>
              </div>
            </div>
          )}
        </div>
        <div className="animation-fix-stack-item">
          <OperationCard
            title="3. Pose Warp"
            summary={config.poseWarp.targetName || "Select a target pose"}
            enabled={config.poseWarp.enabled}
            selected={selected === "poseWarp"}
            disabled={disabled}
            onSelect={() => onSelectedChange("poseWarp")}
            onEnabledChange={onPoseWarpEnabledChange}
          />
          {selected === "poseWarp" && (
            <div className="animation-fix-inline-config pose-warp-inline-config">
              <div className="pose-warp-primary">
                <ModifierOptionRow label="Apply pose at">
                  <select
                    value={config.poseWarp.anchor}
                    disabled={disabled || !config.poseWarp.enabled}
                    onChange={(event) =>
                      onPoseWarpAnchorChange(event.target.value as MotionStackConfig["poseWarp"]["anchor"])
                    }
                  >
                    <option value="start">Clip start</option>
                    <option value="end">Clip end</option>
                  </select>
                </ModifierOptionRow>

                <ModifierOptionRow label="Method">
                  <select
                    value={config.poseWarp.method}
                    disabled={disabled || !config.poseWarp.enabled}
                    onChange={(event) =>
                      onPoseWarpMethodChange(event.target.value as MotionStackConfig["poseWarp"]["method"])
                    }
                  >
                    <option value="blend">Pose Crossfade</option>
                    <option value="rebase">Motion Rebase</option>
                  </select>
                </ModifierOptionRow>

                <ModifierOptionRow label="Target Pose" as="div">
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
                </ModifierOptionRow>

                <ModifierOptionRow label="Blend duration" as="div">
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
                </ModifierOptionRow>

                <div className="pose-warp-flow" aria-label="Pose warp direction">
                  <span>{config.poseWarp.anchor === "start" ? "Target Pose" : "Original Motion"}</span>
                  <span className="pose-warp-flow-arrow">→</span>
                  <span>{config.poseWarp.anchor === "start" ? "Original Motion" : "Target Pose"}</span>
                </div>
              </div>

              <details className="pose-warp-advanced">
                <summary>Advanced</summary>
                <div className="pose-warp-advanced-body">
                  <ModifierOptionRow label="Target time">
                    <NumericParameterInput
                      min={0}
                      step={0.033}
                      value={config.poseWarp.targetTime}
                      disabled={disabled || !config.poseWarp.enabled}
                      onCommit={onPoseWarpTargetTimeChange}
                    />
                  </ModifierOptionRow>
                  <ModifierOptionRow label="Warp region" as="div">
                    <div className="pose-warp-region-control">
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
                  </ModifierOptionRow>
                  <ModifierOptionRow label="Root Motion" as="div">
                    <strong className="modifier-option-status">Preserved</strong>
                  </ModifierOptionRow>
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
              <ModifierOptionRow label="Mode"><select value={config.loopFix.mode} disabled={disabled || !config.loopFix.enabled} onChange={(event) => onLoopModeChange(event.target.value as AnimationLoopFixMode)}><option value="cyclic">Cyclic</option><option value="inertial">Inertial</option></select></ModifierOptionRow>
              <ModifierOptionRow label="Root"><select value={config.loopFix.rootPolicy} disabled={disabled || !config.loopFix.enabled} onChange={(event) => onLoopRootPolicyChange(event.target.value as AnimationLoopRootPolicy)}><option value="auto">Auto</option><option value="close">Close</option><option value="preserve">Preserve</option></select></ModifierOptionRow>
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
              <ModifierOptionRow label="Movement threshold" unit="height/s"><NumericParameterInput min={0} step={0.01} value={config.footStabilizer.movementThreshold} disabled={disabled || !config.footStabilizer.enabled} onCommit={onFootStabilizerMovementThresholdChange} /></ModifierOptionRow>
              <ModifierOptionRow label="Ground height" unit="height"><NumericParameterInput min={0} step={0.005} value={config.footStabilizer.heightThreshold} disabled={disabled || !config.footStabilizer.enabled} onCommit={onFootStabilizerHeightThresholdChange} /></ModifierOptionRow>
              <ModifierOptionRow label="Initial contact anchor" unit="phase"><NumericParameterInput min={0} max={1} step={0.05} value={config.footStabilizer.initialAnchorPosition} disabled={disabled || !config.footStabilizer.enabled} onCommit={onFootStabilizerInitialAnchorPositionChange} /></ModifierOptionRow>
              <ModifierOptionRow label="Middle contact anchor" unit="phase"><NumericParameterInput min={0} max={1} step={0.05} value={config.footStabilizer.intermediateAnchorPosition} disabled={disabled || !config.footStabilizer.enabled} onCommit={onFootStabilizerIntermediateAnchorPositionChange} /></ModifierOptionRow>
              <ModifierOptionRow label="Final contact anchor" unit="phase"><NumericParameterInput min={0} max={1} step={0.05} value={config.footStabilizer.finalAnchorPosition} disabled={disabled || !config.footStabilizer.enabled} onCommit={onFootStabilizerFinalAnchorPositionChange} /></ModifierOptionRow>
              <ModifierOptionRow label="Warp airborne motion" as="div" controlClassName="modifier-option-inline">
                <input aria-label="Warp airborne motion" type="checkbox" checked={config.footStabilizer.warpAirborneMotion} disabled={disabled || !config.footStabilizer.enabled} onChange={(event) => onFootStabilizerWarpAirborneMotionChange(event.target.checked)} />
                <strong className="modifier-option-status">Between contacts</strong>
              </ModifierOptionRow>
              <ModifierOptionRow label="Viewport debug" as="div"><strong className="modifier-option-status">Faint = input path · bright = stabilized</strong></ModifierOptionRow>
              <ModifierOptionRow label="Root Motion" as="div"><strong className="modifier-option-status">Preserved</strong></ModifierOptionRow>
            </div>
          )}
        </div>
      </div>

    </div>
  );
}
