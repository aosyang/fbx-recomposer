# FBX Recomposer

A browser-based tool for repairing, retargeting, and exporting FBX character animation.

**Try it online:** https://aosyang.github.io/fbx-recomposer/

Your FBX files stay on your device. All processing happens locally in the browser.

## Features

### Tools

Process animation with a modifier-based workflow and preview the result directly on the character.

- **Root Motion Extraction**: extract character movement into root motion.
- **Motion Decomposition**: separate motion into adjustable components.
- **Pose Warp**: blend or rebase toward a target pose over a time range.
- **Loop Repair**: detect and repair discontinuities at animation loop boundaries.
- **Foot Stabilizer**: reduce foot sliding with contact-aware stabilization.

### Animation Retargeting

Import animation from another FBX and retarget compatible motion onto the loaded character.

### LAN Transfer

Send an FBX between browsers on the same local network via pairing code or QR, without uploading to the cloud.

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
