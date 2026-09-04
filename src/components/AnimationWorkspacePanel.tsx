import AnimationDiagnosticsPanel from "./AnimationDiagnosticsPanel";
import MotionStack, { type MotionStackConfig, type MotionOperationKind } from "./AnimationFixStack";
import type { AnimationContactLoopAnalysis } from "../lib/animation-contact-loop-fix";
import type { RootMotionAnalysis } from "../lib/animation-root-motion";
import type { AnimationLoopAnalysis } from "../lib/animation-loop-analysis";
import type { MotionDecompositionReport } from "../lib/animation-motion-decomposition";

type AnimationWorkspacePanelProps = {
  hasAnimation: boolean;
  selectedOperation: MotionOperationKind;
  config: MotionStackConfig;
  rootMotionAnalysis: RootMotionAnalysis | null;
  appliedRootMotionAnalysis: RootMotionAnalysis | null;
  loopAnalysis: AnimationLoopAnalysis | null;
  appliedLoopAnalysis: AnimationLoopAnalysis | null;
  contactAnalysis: AnimationContactLoopAnalysis | null;
  decompositionReport: MotionDecompositionReport | null;
  onSelectedOperationChange: (kind: MotionOperationKind) => void;
  onRootMotionEnabledChange: (enabled: boolean) => void;
  onDecompositionEnabledChange: (enabled: boolean) => void;
  onDecompositionBaseModeChange: (mode: MotionStackConfig["decomposition"]["baseMode"]) => void;
  onDecompositionLowGainChange: (value: number) => void;
  onDecompositionMidGainChange: (value: number) => void;
  onDecompositionFineGainChange: (value: number) => void;
  onLoopFixEnabledChange: (enabled: boolean) => void;
  onRootMotionModeChange: (mode: MotionStackConfig["rootMotion"]["mode"]) => void;
  onRootMotionSmoothingWindowChange: (value: number) => void;
  onRootMotionVelocityToleranceChange: (value: number) => void;
  onRootMotionExtractYawChange: (enabled: boolean) => void;
  onRootMotionYawModeChange: (mode: MotionStackConfig["rootMotion"]["yawMode"]) => void;
  onRootMotionYawToleranceChange: (value: number) => void;
  onLoopModeChange: (mode: MotionStackConfig["loopFix"]["mode"]) => void;
  onLoopRootPolicyChange: (policy: MotionStackConfig["loopFix"]["rootPolicy"]) => void;
};

export default function AnimationWorkspacePanel({
  hasAnimation,
  selectedOperation,
  config,
  rootMotionAnalysis,
  appliedRootMotionAnalysis,
  loopAnalysis,
  appliedLoopAnalysis,
  contactAnalysis,
  decompositionReport,
  onSelectedOperationChange,
  onRootMotionEnabledChange,
  onDecompositionEnabledChange,
  onDecompositionBaseModeChange,
  onDecompositionLowGainChange,
  onDecompositionMidGainChange,
  onDecompositionFineGainChange,
  onLoopFixEnabledChange,
  onRootMotionModeChange,
  onRootMotionSmoothingWindowChange,
  onRootMotionVelocityToleranceChange,
  onRootMotionExtractYawChange,
  onRootMotionYawModeChange,
  onRootMotionYawToleranceChange,
  onLoopModeChange,
  onLoopRootPolicyChange,
}: AnimationWorkspacePanelProps) {
  return (
    <section className="animation-workspace-panel" aria-label="Motion processing workspace">
      <div className="animation-workspace-stack">
        <MotionStack
          disabled={!hasAnimation}
          selected={selectedOperation}
          config={config}
          onSelectedChange={onSelectedOperationChange}
          onRootMotionEnabledChange={onRootMotionEnabledChange}
          onDecompositionEnabledChange={onDecompositionEnabledChange}
          onDecompositionBaseModeChange={onDecompositionBaseModeChange}
          onDecompositionLowGainChange={onDecompositionLowGainChange}
          onDecompositionMidGainChange={onDecompositionMidGainChange}
          onDecompositionFineGainChange={onDecompositionFineGainChange}
          onLoopFixEnabledChange={onLoopFixEnabledChange}
          onRootMotionModeChange={onRootMotionModeChange}
          onRootMotionSmoothingWindowChange={onRootMotionSmoothingWindowChange}
          onRootMotionVelocityToleranceChange={onRootMotionVelocityToleranceChange}
          onRootMotionExtractYawChange={onRootMotionExtractYawChange}
          onRootMotionYawModeChange={onRootMotionYawModeChange}
          onRootMotionYawToleranceChange={onRootMotionYawToleranceChange}
          onLoopModeChange={onLoopModeChange}
          onLoopRootPolicyChange={onLoopRootPolicyChange}
        />
      </div>

      <AnimationDiagnosticsPanel
        hasAnimation={hasAnimation}
        selectedOperation={selectedOperation}
        rootMotionAnalysis={rootMotionAnalysis}
        appliedRootMotionAnalysis={appliedRootMotionAnalysis}
        loopAnalysis={loopAnalysis}
        appliedLoopAnalysis={appliedLoopAnalysis}
        contactAnalysis={contactAnalysis}
        decompositionReport={decompositionReport}
      />
    </section>
  );
}
