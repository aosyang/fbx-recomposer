import { useRef, useState } from "react";
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
  onPoseWarpEnabledChange: (enabled: boolean) => void;
  onPoseWarpAnchorChange: (anchor: MotionStackConfig["poseWarp"]["anchor"]) => void;
  onPoseWarpTargetFileChange: (file: File | null) => void;
  onPoseWarpTargetTimeChange: (value: number) => void;
  onPoseWarpStartTimeChange: (value: number) => void;
  onPoseWarpEndTimeChange: (value: number) => void;
  onLoopFixEnabledChange: (enabled: boolean) => void;
  onRootMotionModeChange: (mode: MotionStackConfig["rootMotion"]["mode"]) => void;
  onRootMotionSmoothingWindowChange: (value: number) => void;
  onRootMotionVelocityToleranceChange: (value: number) => void;
  onRootMotionExtractXChange: (enabled: boolean) => void;
  onRootMotionExtractZChange: (enabled: boolean) => void;
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
  onPoseWarpEnabledChange,
  onPoseWarpAnchorChange,
  onPoseWarpTargetFileChange,
  onPoseWarpTargetTimeChange,
  onPoseWarpStartTimeChange,
  onPoseWarpEndTimeChange,
  onLoopFixEnabledChange,
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
}: AnimationWorkspacePanelProps) {
  const [mobilePane, setMobilePane] = useState<"modifiers" | "analysis">("modifiers");
  const [modifierStackHeight, setModifierStackHeight] = useState<number | null>(null);
  const panelResizeRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const analysisAvailable = selectedOperation === "rootMotion" || selectedOperation === "loopFix";

  const startPanelResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const stack = event.currentTarget.previousElementSibling;
    if (!(stack instanceof HTMLElement)) return;

    panelResizeRef.current = {
      startY: event.clientY,
      startHeight: stack.getBoundingClientRect().height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.classList.add("is-active");
    event.preventDefault();
  };

  const resizePanel = (event: React.PointerEvent<HTMLDivElement>) => {
    const resize = panelResizeRef.current;
    const panel = event.currentTarget.parentElement;
    if (!resize || !panel) return;

    const panelHeight = panel.getBoundingClientRect().height;
    const minStackHeight = 160;
    const minAnalysisHeight = 140;
    const separatorHeight = 6;
    const maxStackHeight = Math.max(
      minStackHeight,
      panelHeight - minAnalysisHeight - separatorHeight - 20,
    );
    const nextHeight = resize.startHeight + event.clientY - resize.startY;
    setModifierStackHeight(
      Math.round(Math.min(maxStackHeight, Math.max(minStackHeight, nextHeight))),
    );
  };

  const stopPanelResize = (event: React.PointerEvent<HTMLDivElement>) => {
    panelResizeRef.current = null;
    event.currentTarget.classList.remove("is-active");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <section
      className={`animation-workspace-panel is-mobile-${mobilePane}`}
      aria-label="Motion processing workspace"
      style={
        modifierStackHeight !== null
          ? ({
              "--animation-stack-height": `${modifierStackHeight}px`,
            } as React.CSSProperties)
          : undefined
      }
    >
      <div className="animation-mobile-pane-switcher" role="group" aria-label="Animation workspace panel">
        <button
          type="button"
          className={mobilePane === "modifiers" ? "is-active" : ""}
          aria-pressed={mobilePane === "modifiers"}
          onClick={() => setMobilePane("modifiers")}
        >
          Modifiers
        </button>
        <button
          type="button"
          className={mobilePane === "analysis" ? "is-active" : ""}
          aria-pressed={mobilePane === "analysis"}
          disabled={!analysisAvailable}
          onClick={() => setMobilePane("analysis")}
        >
          Analysis
        </button>
      </div>

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
          onPoseWarpEnabledChange={onPoseWarpEnabledChange}
          onPoseWarpAnchorChange={onPoseWarpAnchorChange}
          onPoseWarpTargetFileChange={onPoseWarpTargetFileChange}
          onPoseWarpTargetTimeChange={onPoseWarpTargetTimeChange}
          onPoseWarpStartTimeChange={onPoseWarpStartTimeChange}
          onPoseWarpEndTimeChange={onPoseWarpEndTimeChange}
          onLoopFixEnabledChange={onLoopFixEnabledChange}
          onRootMotionModeChange={onRootMotionModeChange}
          onRootMotionSmoothingWindowChange={onRootMotionSmoothingWindowChange}
          onRootMotionVelocityToleranceChange={onRootMotionVelocityToleranceChange}
          onRootMotionExtractXChange={onRootMotionExtractXChange}
          onRootMotionExtractZChange={onRootMotionExtractZChange}
          onRootMotionExtractYawChange={onRootMotionExtractYawChange}
          onRootMotionYawModeChange={onRootMotionYawModeChange}
          onRootMotionYawToleranceChange={onRootMotionYawToleranceChange}
          onLoopModeChange={onLoopModeChange}
          onLoopRootPolicyChange={onLoopRootPolicyChange}
        />
      </div>

      <div
        className="animation-workspace-inner-resizer"
        role="separator"
        aria-label="Resize modifier and analysis panels"
        aria-orientation="horizontal"
        aria-valuemin={160}
        aria-valuenow={modifierStackHeight ?? undefined}
        tabIndex={0}
        onPointerDown={startPanelResize}
        onPointerMove={resizePanel}
        onPointerUp={stopPanelResize}
        onPointerCancel={stopPanelResize}
        onLostPointerCapture={(event) => {
          panelResizeRef.current = null;
          event.currentTarget.classList.remove("is-active");
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
          const panelHeight =
            event.currentTarget.parentElement?.getBoundingClientRect().height ?? 600;
          const minStackHeight = 160;
          const maxStackHeight = Math.max(160, panelHeight - 166);
          const currentHeight =
            event.currentTarget.previousElementSibling instanceof HTMLElement
              ? event.currentTarget.previousElementSibling.getBoundingClientRect().height
              : modifierStackHeight ?? minStackHeight;
          const delta = event.key === "ArrowUp" ? -24 : 24;
          setModifierStackHeight(
            Math.round(
              Math.min(
                maxStackHeight,
                Math.max(minStackHeight, currentHeight + delta),
              ),
            ),
          );
          event.preventDefault();
        }}
      />

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
