# FBX Recomposer

A browser-based tool for repairing, retargeting, and exporting FBX character animation.

**Try it online:** https://aosyang.github.io/fbx-recomposer/

Your FBX files stay on your device. All processing happens locally in the browser.

## Features

### Animation Workshop

Process animation with a modifier-based workflow and preview the result directly on the character.

- **Root Motion Extraction** — extract character movement into root motion.
- **Motion Decomposition** — separate motion into adjustable components.
- **Loop Repair** — detect and repair discontinuities at animation loop boundaries.

### Animation Retargeting

Import animation from another FBX and retarget compatible motion onto the loaded character.

### FBX Export

Export processed results as:

- Character-only FBX
- Animation-only FBX
- Character + animation FBX

Animation changes are written back into the exported FBX.

## Run Locally

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```
