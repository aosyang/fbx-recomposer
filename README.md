# FBX Recomposer

FBX Recomposer is a browser-based character-animation workbench for viewing, processing, retargeting, repairing, recomposing, and exporting FBX animation.

The application runs entirely in the browser and can be deployed as a static site. FBX files are processed locally and are not uploaded to a server.

Built with Vite, React, and Three.js.

## Workspaces

The UI is organized into two workspaces:

- **Viewer** — inspect models, preview animation, scrub the timeline, inspect bones, and use the existing FBX viewing/export tools.
- **Animation Workshop** — apply animation-processing modifiers, tune their parameters, inspect diagnostics, and preview the processed result before export.

This keeps normal viewing simple while giving animation cleanup and transformation work a dedicated workspace.

## Animation Workshop

Animation Workshop uses a **Modifier Stack**. Modifiers can be enabled independently and configured in sequence.

### Root Motion Extraction

Extract locomotion from the character animation while preserving an in-place animation result.

Current controls include:

- Position extraction using **Velocity Guided** or **Linear** modes.
- Velocity smoothing and tolerance controls for velocity-guided extraction.
- Optional yaw extraction.
- Yaw extraction using **RDP** or **Linear** modes.
- Yaw tolerance controls for RDP extraction.
- Root-motion diagnostics that distinguish detected and applied motion.

### Motion Decomposition

Decompose animation into motion-frequency bands so broad body movement and finer detail can be adjusted independently.

Current controls include:

- **Preserve** or **Static Pose** base modes.
- Independent **Low**, **Mid**, and **Fine** gain controls.
- Decomposition diagnostics for the processed animation.

### Loop Repair

Repair animation loop boundaries while accounting for whether root motion should be preserved or closed.

Current controls include:

- **Cyclic** loop repair.
- **Inertial** loop repair.
- Root policy: **Auto**, **Close**, or **Preserve**.
- Automatic analysis for root-motion trajectories and artificial end-of-clip holds.
- Loop/contact diagnostics for evaluating the resulting transition.

Automatic loop analysis can discover arbitrary skeleton roots, preserve coherent moving roots, detect broad artificial endpoint holds, and close stationary roots when appropriate.

## Viewing and Inspection

- Load FBX files with drag and drop.
- Preview skinned characters and animation clips in a Three.js viewport.
- Play, pause, scrub, loop, and control animation playback from a timeline.
- Inspect the model bone hierarchy.
- Toggle viewport helpers and display options.
- Switch between original materials and solid-color rendering.
- Load morph targets through an optimized parsing path.
- Preview animation-processing results without requiring a server round trip.

## External Animation and Retargeting

- Import animation clips from additional FBX files.
- Bind imported animation to the currently loaded character at runtime.
- Match skeleton bones through canonical / visible bone names rather than relying only on raw object identity.
- Keep animation-retargeting logic separate from the main UI layer.

## Browser-Side FBX Processing

FBX Recomposer includes a semantic FBX-processing layer that operates directly on binary FBX data in the browser.

Current capabilities include:

- Parse and serialize binary FBX.
- Read and rewrite FBX object IDs and connection relationships.
- Inspect skeleton models and map source bones to target bones.
- Understand FBX animation stacks, layers, curve nodes, and curves.
- Clone and remap animation graph objects while avoiding object-ID collisions.
- Rewrite animation curve data and save modified FBX data back to disk.
- Persist loop-repair changes into exported binary FBX data.
- Support root-motion extraction, motion decomposition, and loop-analysis logic independently from the rendering layer.

## Export Modes

- Save the current FBX document.
- Export character-only FBX data.
- Export animation-only FBX data.
- Export a merged character + animation FBX.
- Preserve and remap required skeleton and animation-graph connections during merged export.

## Validation and Regression Coverage

The project uses representative character-animation fixtures rather than relying only on visual inspection.

Regression coverage includes:

- Binary FBX read/write round trips.
- Autodesk FBX SDK reload and semantic skeleton / pose checks.
- Three.js / FastFBXLoader reload checks.
- Canonical-bone animation binding checks.
- Character-only, animation-only, and merged-export regressions.
- Multi-animation regression coverage for the SchoolGirl character assets.
- Automatic loop-analysis regression coverage for moving and stationary roots.
- Production TypeScript/Vite builds.

## Technical Structure

Rendering and FBX document manipulation are intentionally separated:

- FastFBXLoader / Three.js — runtime loading, rendering, and animation preview.
- src/components/AnimationWorkspacePanel.tsx — Animation Workshop composition.
- src/components/AnimationFixStack.tsx — modifier stack and modifier parameters.
- src/lib/animation-root-motion.ts — root-motion analysis and extraction.
- src/lib/animation-motion-decomposition.ts — animation decomposition.
- src/lib/animation-loop-analysis.ts — loop/root analysis.
- src/lib/animation-loop-fix.ts — runtime loop repair.
- src/lib/fbx-animation-loop-fix.ts — FBX-level loop repair.
- src/lib/binary-fbx/ — low-level binary FBX parsing and serialization.
- src/lib/fbx-document/ — semantic object, connection, skeleton, and animation operations.
- src/lib/fbx-export.ts — export orchestration and export-specific policy.
- src/lib/animation-retarget.ts — runtime animation-retargeting helpers.

This separation keeps the viewer UI from owning low-level FBX object-graph logic and allows processing features to remain reusable.

## Typical Workflow

1. Load a character FBX in **Viewer** and inspect the model and animation.
2. Switch to **Animation Workshop**.
3. Enable and configure modifiers in the **Modifier Stack**.
4. Review the processing diagnostics and preview the result.
5. Return to export tools and save the processed FBX in the required form.

## Development Directions

The project is now centered on animation processing rather than generic viewer expansion. Useful next steps include:

- Expand modifier-stack operations while keeping each processor independent and composable.
- Improve skeleton compatibility diagnostics before retargeting or merging.
- Add richer animation-curve and root-motion visualization.
- Expand automated export validation across Autodesk FBX SDK, Three.js, and Godot import paths.
- Add batch-oriented workflows for checking or processing multiple animation FBX files.
- Keep general viewport features minimal unless they directly support animation or FBX-pipeline debugging.

## Getting Started

Install dependencies:

    npm install

Start the development server:

    npm run dev

## Production Build

    npm run build

The static site files are generated in the dist/ directory and can be deployed to any static hosting service.
