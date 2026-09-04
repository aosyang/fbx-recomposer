import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');
const workspace = resolve(here, '../../../..');
const [sourceArg, referenceArg, outputArg, rootMode = 'close'] = process.argv.slice(2);
if (!sourceArg || !referenceArg) {
  console.error('usage: node loop_regression_runner.mjs SOURCE_FBX REFERENCE_FBX [OUTPUT_FBX] [close|preserve]');
  process.exit(2);
}
const sourcePath = join(workspace, sourceArg);
const pythonReferencePath = join(workspace, referenceArg);
const outDir = join(here, 'out', 'loop_regression');
const buildDir = join(here, '.tmp-loop-regression');
const webOutputPath = outputArg
  ? join(workspace, outputArg)
  : join(outDir, 'loop_repaired_output.fbx');
if (rootMode !== 'close' && rootMode !== 'preserve') throw new Error(`invalid rootMode: ${rootMode}`);

mkdirSync(outDir, { recursive: true });
rmSync(buildDir, { recursive: true, force: true });
await build({
  root: projectRoot,
  configFile: false,
  logLevel: 'error',
  build: {
    lib: {
      entry: join(here, 'loop_regression_entry.ts'),
      formats: ['es'],
      fileName: () => 'bundle.mjs',
    },
    outDir: buildDir,
    emptyOutDir: true,
    minify: false,
    rollupOptions: { external: [] },
  },
});

const bundle = await import(`${pathToFileURL(join(buildDir, 'bundle.mjs')).href}?v=${Date.now()}`);
const { readBinaryFbx, writeBinaryFbx, repairBinaryFbxAnimationLoop } = bundle;

function childArray(node, name) {
  const child = node.children.find((item) => item.name === name);
  const prop = child?.properties?.[0];
  if (!prop || typeof prop.readArray !== 'function') return [];
  return Array.from(prop.readArray());
}

function extractCurves(doc) {
  return doc.findNodes('AnimationCurve').map((curve, index) => ({
    index,
    times: childArray(curve, 'KeyTime'),
    values: childArray(curve, 'KeyValueFloat').map(Number),
  })).filter((curve) => curve.times.length === curve.values.length && curve.values.length >= 2);
}

function changedIndices(before, after, epsilon = 1e-7) {
  const changed = [];
  const count = Math.min(before.length, after.length);
  for (let i = 0; i < count; i += 1) {
    const a = before[i].values;
    const b = after[i].values;
    if (a.length !== b.length || a.some((value, j) => Math.abs(value - b[j]) > epsilon)) changed.push(i);
  }
  return changed;
}

function normalizedTimes(times) {
  if (times.length < 2) return [];
  const first = BigInt(times[0]);
  const last = BigInt(times[times.length - 1]);
  const span = last - first;
  if (span === 0n) return [];
  return times.map((value) => Number(BigInt(value) - first) / Number(span));
}

function quadraticDerivatives(x0, y0, x1, y1, x2, y2, x) {
  const d0 = (x0 - x1) * (x0 - x2);
  const d1 = (x1 - x0) * (x1 - x2);
  const d2 = (x2 - x0) * (x2 - x1);
  if (Math.abs(d0) < 1e-12 || Math.abs(d1) < 1e-12 || Math.abs(d2) < 1e-12) return null;
  const first = y0 * (2 * x - x1 - x2) / d0 + y1 * (2 * x - x0 - x2) / d1 + y2 * (2 * x - x0 - x1) / d2;
  const second = 2 * (y0 / d0 + y1 / d1 + y2 / d2);
  return { first, second };
}

function metricForCurve(curve) {
  const { values } = curve;
  const u = normalizedTimes(curve.times);
  if (u.length !== values.length || values.length < 2) return null;
  const endpointGap = Math.abs(values[0] - values[values.length - 1]);
  let velocityGap = null;
  let accelerationGap = null;
  if (values.length >= 3) {
    const start = quadraticDerivatives(u[0], values[0], u[1], values[1], u[2], values[2], u[0]);
    const n = values.length;
    const end = quadraticDerivatives(u[n - 3], values[n - 3], u[n - 2], values[n - 2], u[n - 1], values[n - 1], u[n - 1]);
    if (start && end) {
      velocityGap = Math.abs(start.first - end.first);
      accelerationGap = Math.abs(start.second - end.second);
    }
  }
  let spacingRatio = 1;
  if (u.length >= 3) {
    const spacings = [];
    for (let i = 1; i < u.length; i += 1) {
      const dt = u[i] - u[i - 1];
      if (dt > 1e-12) spacings.push(dt);
    }
    if (spacings.length) spacingRatio = Math.max(...spacings) / Math.min(...spacings);
  }
  return { endpointGap, velocityGap, accelerationGap, spacingRatio };
}

function percentile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q));
  return sorted[index];
}

function summarize(curves, indices = null) {
  const chosen = indices ? indices.map((i) => curves[i]).filter(Boolean) : curves;
  const metrics = chosen.map(metricForCurve).filter(Boolean);
  const summarizeOne = (key) => {
    const values = metrics.map((m) => m[key]).filter((v) => Number.isFinite(v));
    return { count: values.length, mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null, p95: percentile(values, 0.95), max: values.length ? Math.max(...values) : null };
  };
  return {
    curveCount: chosen.length,
    endpointGap: summarizeOne('endpointGap'),
    velocityGap: summarizeOne('velocityGap'),
    accelerationGap: summarizeOne('accelerationGap'),
    spacingRatio: summarizeOne('spacingRatio'),
  };
}

const sourceBytes = new Uint8Array(readFileSync(sourcePath));
const preserveDoc = readBinaryFbx(sourceBytes);
const preserveReport = repairBinaryFbxAnimationLoop(preserveDoc, { rootMode: 'preserve' });
const sourceDoc = readBinaryFbx(sourceBytes);
const beforeCurves = extractCurves(sourceDoc);
const report = repairBinaryFbxAnimationLoop(sourceDoc, { rootMode });
const webBytes = new Uint8Array(writeBinaryFbx(sourceDoc));
writeFileSync(webOutputPath, webBytes);
const rereadDoc = readBinaryFbx(webBytes);
const afterCurves = extractCurves(rereadDoc);
const changed = changedIndices(beforeCurves, afterCurves);

const pythonDoc = readBinaryFbx(new Uint8Array(readFileSync(pythonReferencePath)));
const pythonCurves = extractCurves(pythonDoc);

const result = {
  source: sourcePath,
  webOutput: webOutputPath,
  pythonReference: pythonReferencePath,
  sourceBytes: sourceBytes.length,
  webBytes: webBytes.length,
  animationCurveCountBefore: beforeCurves.length,
  animationCurveCountAfter: afterCurves.length,
  changedCurveCount: changed.length,
  rootMode,
  repairReport: report,
  preserveRootReport: preserveReport,
  sourceAllCurves: summarize(beforeCurves),
  webChangedCurvesBefore: summarize(beforeCurves, changed),
  webChangedCurvesAfter: summarize(afterCurves, changed),
  webAllCurvesAfter: summarize(afterCurves),
  pythonReferenceAllCurves: summarize(pythonCurves),
};

const gates = {
  structurePreserved: beforeCurves.length > 0 && beforeCurves.length === afterCurves.length,
  changedCurvesPresent: changed.length > 0,
  repairedCurvesReported: (report.repairedTranslationCurves ?? 0) + (report.repairedRotationCurves ?? 0) > 0,
  preserveRootModeSkipsRoot: (preserveReport.skippedRootCurves ?? 0) > 0,
  changedEndpointClosed: (result.webChangedCurvesAfter.endpointGap.max ?? Infinity) <= 1e-6,
  changedVelocityNotWorse: (result.webChangedCurvesAfter.velocityGap.mean ?? Infinity) <= (result.webChangedCurvesBefore.velocityGap.mean ?? -Infinity) + 1e-6,
  changedAccelerationNotWorse: (result.webChangedCurvesAfter.accelerationGap.mean ?? Infinity) <= (result.webChangedCurvesBefore.accelerationGap.mean ?? -Infinity) + 1e-6,
};
result.gates = gates;
console.log(JSON.stringify(result, null, 2));
const failedGates = Object.entries(gates).filter(([, passed]) => !passed).map(([name]) => name);
if (failedGates.length) {
  console.error(`loop regression gates failed: ${failedGates.join(', ')}`);
  process.exit(2);
}
