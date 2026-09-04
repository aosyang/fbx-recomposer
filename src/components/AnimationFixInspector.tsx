import type { AnimationLoopFixMode } from "../lib/animation-loop-fix";
import type { AnimationLoopRootPolicy } from "../lib/animation-loop-analysis";
import type { RootMotionExtractionMode } from "../lib/animation-root-motion";
import type { MotionStackConfig, MotionOperationKind } from "./AnimationFixStack";

export default function AnimationFixInspector({
  selected,
  disabled,
  config,
  onRootMotionModeChange,
  onRootMotionSmoothingWindowChange,
  onRootMotionVelocityToleranceChange,
  onLoopModeChange,
  onLoopRootPolicyChange,
}: {
  selected: MotionOperationKind;
  disabled: boolean;
  config: MotionStackConfig;
  onRootMotionModeChange: (mode: RootMotionExtractionMode) => void;
  onRootMotionSmoothingWindowChange: (value: number) => void;
  onRootMotionVelocityToleranceChange: (value: number) => void;
  onLoopModeChange: (mode: AnimationLoopFixMode) => void;
  onLoopRootPolicyChange: (policy: AnimationLoopRootPolicy) => void;
}) {
  const rootDisabled = disabled || !config.rootMotion.enabled;
  const loopDisabled = disabled || !config.loopFix.enabled;
  return (
    <section className="animation-fix-inspector" aria-label="Modifier inspector">
      <div className="animation-fix-inspector-heading">
        <h3>Modifier Inspector</h3>
        <span>{selected === "rootMotion" ? "Root Motion" : "Loop Fix"}</span>
      </div>

      {selected === "rootMotion" ? (
        <div className="animation-fix-inspector-fields">
          <label>
            <span>Method</span>
            <select
              value={config.rootMotion.mode}
              disabled={rootDisabled}
              onChange={(event) => onRootMotionModeChange(event.target.value as RootMotionExtractionMode)}
            >
              <option value="velocity-guided">Velocity Guided</option>
              <option value="linear">Linear</option>
            </select>
          </label>
          {config.rootMotion.mode === "velocity-guided" && (
            <>
              <label>
                <span>Smoothing frames</span>
                <input
                  type="number"
                  min={1}
                  step={2}
                  value={config.rootMotion.velocitySmoothingWindow}
                  disabled={rootDisabled}
                  onChange={(event) => onRootMotionSmoothingWindowChange(Number(event.target.value))}
                />
              </label>
              <label>
                <span>Velocity tolerance</span>
                <input
                  type="number"
                  min={0.01}
                  step={0.05}
                  value={config.rootMotion.velocityTolerance}
                  disabled={rootDisabled}
                  onChange={(event) => onRootMotionVelocityToleranceChange(Number(event.target.value))}
                />
              </label>
            </>
          )}
        </div>
      ) : (
        <div className="animation-fix-inspector-fields">
          <label>
            <span>Mode</span>
            <select
              value={config.loopFix.mode}
              disabled={loopDisabled}
              onChange={(event) => onLoopModeChange(event.target.value as AnimationLoopFixMode)}
            >
              <option value="cyclic">Cyclic</option>
              <option value="inertial">Inertial</option>
            </select>
          </label>
          <label>
            <span>Root policy</span>
            <select
              value={config.loopFix.rootPolicy}
              disabled={loopDisabled}
              onChange={(event) => onLoopRootPolicyChange(event.target.value as AnimationLoopRootPolicy)}
            >
              <option value="auto">Auto</option>
              <option value="close">Close</option>
              <option value="preserve">Preserve</option>
            </select>
          </label>
        </div>
      )}
    </section>
  );
}
