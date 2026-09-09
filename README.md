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

Send an opened character/animation (including Tools modifier settings) or an FBX from disk between two browsers on the **same local network**.

- Both devices open the same public web app (for example GitHub Pages). **No local Vite/Node/Python server is required for pairing.**
- Create/show a short **pairing code** (+ code QR). The other device scans or enters the code to connect.
- After pairing, FBX files transfer directly between devices.

Offline dual-QR pairing is temporarily disabled while scan reliability is improved.

Optional build-time config:

- `VITE_LAN_SIGNALING_MODE=peerjs` (default) or `worker` (reserved for a future self-hosted endpoint)
- `VITE_PEERJS_HOST` / `VITE_PEERJS_PORT` / `VITE_PEERJS_PATH` / `VITE_PEERJS_KEY` to point at your own PeerServer later

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
