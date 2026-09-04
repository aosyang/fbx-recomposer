import type { AnimationLoopAnalysis } from "../lib/animation-loop-analysis";
import type { AnimationContactLoopAnalysis } from "../lib/animation-contact-loop-fix";
import type { RootMotionAnalysis, RootMotionAnalysisSample } from "../lib/animation-root-motion";
import type { MotionOperationKind } from "./AnimationFixStack";
import type { MotionDecompositionReport } from "../lib/animation-motion-decomposition";


type Props = {
  hasAnimation: boolean;
  selectedOperation: MotionOperationKind;
  rootMotionAnalysis: RootMotionAnalysis | null;
  appliedRootMotionAnalysis: RootMotionAnalysis | null;
  loopAnalysis: AnimationLoopAnalysis | null;
  appliedLoopAnalysis: AnimationLoopAnalysis | null;
  contactAnalysis: AnimationContactLoopAnalysis | null;
  decompositionReport: MotionDecompositionReport | null;
};

type SeriesKey = "characterX" | "characterZ" | "rootX" | "rootZ";

function compactSamples(samples: RootMotionAnalysisSample[], maxPoints = 180) {
  if (samples.length <= maxPoints) return samples;
  const stride = Math.ceil((samples.length - 1) / (maxPoints - 1));
  const compacted = samples.filter((_, index) => index % stride === 0);
  const last = samples[samples.length - 1];
  if (compacted[compacted.length - 1] !== last) compacted.push(last);
  return compacted;
}

function RootMotionComparisonChart({
  baseline,
  applied,
}: {
  baseline: RootMotionAnalysis;
  applied: RootMotionAnalysis | null;
}) {
  const width = 560;
  const height = 190;
  const left = 42;
  const right = 10;
  const top = 12;
  const bottom = 26;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const baselinePoints = compactSamples(baseline.samples);
  const appliedPoints = applied ? compactSamples(applied.samples) : [];
  const values = [
    ...baselinePoints.flatMap((sample) => [sample.characterX, sample.characterZ]),
    ...appliedPoints.flatMap((sample) => [sample.rootX, sample.rootZ]),
    0,
  ];
  let minValue = Math.min(...values);
  let maxValue = Math.max(...values);
  if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) {
    minValue = -1;
    maxValue = 1;
  }
  if (Math.abs(maxValue - minValue) < 1e-5) {
    const center = (maxValue + minValue) * 0.5;
    minValue = center - 0.5;
    maxValue = center + 0.5;
  }
  const padding = (maxValue - minValue) * 0.08;
  minValue -= padding;
  maxValue += padding;

  const duration = baseline.duration;
  const px = (time: number) => left + (duration > 0 ? (time / duration) * plotWidth : 0);
  const py = (value: number) => top + ((maxValue - value) / (maxValue - minValue)) * plotHeight;
  const polyline = (points: RootMotionAnalysisSample[], key: SeriesKey) =>
    points.map((sample) => `${px(sample.time).toFixed(2)},${py(sample[key]).toFixed(2)}`).join(" ");
  const zeroY = py(0);

  return (
    <div className="root-motion-chart-card">
      <div className="root-motion-chart-heading">
        <strong>Position</strong>
        <div className="root-motion-chart-legend">
          <span className="estimated axis-x">Est X</span>
          <span className="estimated axis-z">Est Z</span>
          {applied && (
            <>
              <span className="fixed axis-x">Fixed X</span>
              <span className="fixed axis-z">Fixed Z</span>
            </>
          )}
        </div>
      </div>
      <svg
        className="root-motion-chart"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Estimated character position compared with fixed root motion"
      >
        <line className="chart-grid-line" x1={left} y1={top} x2={left} y2={height - bottom} />
        <line className="chart-grid-line" x1={left} y1={height - bottom} x2={width - right} y2={height - bottom} />
        {zeroY >= top && zeroY <= height - bottom && (
          <line className="chart-zero-line" x1={left} y1={zeroY} x2={width - right} y2={zeroY} />
        )}
        <polyline className="root-motion-series estimated axis-x" points={polyline(baselinePoints, "characterX")} />
        <polyline className="root-motion-series estimated axis-z" points={polyline(baselinePoints, "characterZ")} />
        {applied && (
          <>
            <polyline className="root-motion-series fixed axis-x" points={polyline(appliedPoints, "rootX")} />
            <polyline className="root-motion-series fixed axis-z" points={polyline(appliedPoints, "rootZ")} />
          </>
        )}
        <text className="chart-axis-label" x={left} y={height - 7}>0s</text>
        <text className="chart-axis-label" x={width - right} y={height - 7} textAnchor="end">{duration.toFixed(2)}s</text>
        <text className="chart-value-label" x={left - 6} y={top + 4} textAnchor="end">{maxValue.toFixed(2)}</text>
        <text className="chart-value-label" x={left - 6} y={height - bottom} textAnchor="end">{minValue.toFixed(2)}</text>
      </svg>
    </div>
  );
}

function RootMotionYawComparisonChart({
  baseline,
  applied,
}: {
  baseline: RootMotionAnalysis;
  applied: RootMotionAnalysis | null;
}) {
  const width = 560;
  const height = 190;
  const left = 42;
  const right = 10;
  const top = 12;
  const bottom = 26;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const baselinePoints = compactSamples(baseline.samples);
  const appliedPoints = applied ? compactSamples(applied.samples) : [];
  const values = [
    ...baselinePoints.map((sample) => sample.characterYaw),
    ...appliedPoints.map((sample) => sample.rootYaw),
    0,
  ];
  let minValue = Math.min(...values);
  let maxValue = Math.max(...values);
  if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) {
    minValue = -45;
    maxValue = 45;
  }
  if (Math.abs(maxValue - minValue) < 1e-4) {
    const center = (maxValue + minValue) * 0.5;
    minValue = center - 5;
    maxValue = center + 5;
  }
  const padding = Math.max(1, (maxValue - minValue) * 0.08);
  minValue -= padding;
  maxValue += padding;

  const duration = baseline.duration;
  const px = (time: number) => left + (duration > 0 ? (time / duration) * plotWidth : 0);
  const py = (value: number) => top + ((maxValue - value) / (maxValue - minValue)) * plotHeight;
  const polyline = (points: RootMotionAnalysisSample[], key: "characterYaw" | "rootYaw") =>
    points.map((sample) => `${px(sample.time).toFixed(2)},${py(sample[key]).toFixed(2)}`).join(" ");
  const zeroY = py(0);

  return (
    <div className="root-motion-chart-card">
      <div className="root-motion-chart-heading">
        <strong>Yaw</strong>
        <div className="root-motion-chart-legend">
          <span className="estimated axis-yaw">Est Yaw</span>
          {applied && <span className="fixed axis-yaw">Fixed Yaw</span>}
        </div>
      </div>
      <svg className="root-motion-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Estimated character yaw compared with fixed root yaw">
        <line className="chart-grid-line" x1={left} y1={top} x2={left} y2={height - bottom} />
        <line className="chart-grid-line" x1={left} y1={height - bottom} x2={width - right} y2={height - bottom} />
        {zeroY >= top && zeroY <= height - bottom && (
          <line className="chart-zero-line" x1={left} y1={zeroY} x2={width - right} y2={zeroY} />
        )}
        <polyline className="root-motion-series estimated axis-yaw" points={polyline(baselinePoints, "characterYaw")} />
        {applied && <polyline className="root-motion-series fixed axis-yaw" points={polyline(appliedPoints, "rootYaw")} />}
        <text className="chart-axis-label" x={left} y={height - 7}>0s</text>
        <text className="chart-axis-label" x={width - right} y={height - 7} textAnchor="end">{duration.toFixed(2)}s</text>
        <text className="chart-value-label" x={left - 6} y={top + 4} textAnchor="end">{maxValue.toFixed(1)}°</text>
        <text className="chart-value-label" x={left - 6} y={height - bottom} textAnchor="end">{minValue.toFixed(1)}°</text>
      </svg>
    </div>
  );
}

function RootMotionDiagnostics({
  analysis,
  appliedAnalysis,
}: {
  analysis: RootMotionAnalysis;
  appliedAnalysis: RootMotionAnalysis | null;
}) {
  return (
    <div className="root-motion-analysis">
      <div className="root-motion-analysis-summary">
        <span>{analysis.hipsName} to {analysis.rootName}</span>
        <span>{analysis.duration.toFixed(2)} s - {analysis.samples.length} samples</span>
      </div>
      <RootMotionComparisonChart baseline={analysis} applied={appliedAnalysis} />
      <RootMotionYawComparisonChart baseline={analysis} applied={appliedAnalysis} />
    </div>
  );
}

export default function AnimationDiagnosticsPanel({
  hasAnimation,
  selectedOperation,
  rootMotionAnalysis,
  appliedRootMotionAnalysis,
  loopAnalysis,
  appliedLoopAnalysis,
  contactAnalysis,
}: Props) {
  if (selectedOperation === "decomposition") return null;

  return (
    <section className="animation-workspace-diagnostics" aria-label="Animation analysis">
      <div className="animation-diagnostics-heading">
        <h3>Analysis</h3>
        <span>{selectedOperation === "rootMotion" ? "Root Motion" : "Loop Fix"}</span>
      </div>
      {!hasAnimation ? (
        <div className="animation-tools-empty">Load an animation to analyze it.</div>
      ) : selectedOperation === "rootMotion" ? (
        rootMotionAnalysis ? <RootMotionDiagnostics analysis={rootMotionAnalysis} appliedAnalysis={appliedRootMotionAnalysis} /> : (
          <div className="animation-tools-empty">No animated Hips/Root position data available.</div>
        )
      ) : loopAnalysis ? (
        <dl className="animation-analysis">
          <div><dt>Root</dt><dd>{loopAnalysis.rootBoneNames.join(", ") || "None"}</dd></div>
          <div><dt>Recommended</dt><dd>{loopAnalysis.rootMode === "preserve" ? "Preserve" : "Close"}</dd></div>
          <div><dt>Root Δv</dt><dd>{loopAnalysis.rootVelocityMismatch == null ? "—" : `${loopAnalysis.rootVelocityMismatch.toFixed(3)}${appliedLoopAnalysis?.rootVelocityMismatch != null ? ` → ${appliedLoopAnalysis.rootVelocityMismatch.toFixed(3)}` : ""}`}</dd></div>
          <div><dt>Endpoint hold</dt><dd className={loopAnalysis.artificialEndpointDetected ? "is-detected" : undefined}>{loopAnalysis.artificialEndpointDetected ? "Detected" : "None"}</dd></div>
          <div><dt>Stance contact</dt><dd className={contactAnalysis?.detected ? "is-detected" : undefined}>{contactAnalysis?.detected ? `${contactAnalysis.confidence} confidence` : "None"}</dd></div>
        </dl>
      ) : (
        <div className="animation-tools-empty">Loop analysis is unavailable.</div>
      )}
    </section>
  );
}
