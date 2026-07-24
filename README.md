# FBX Viewer

A browser-based tool for viewing, inspecting, and playing FBX models and animations.

FBX Viewer runs entirely in the browser and can be deployed to any static hosting service. Files are processed locally and are never uploaded to a server.

Built with [Vite](https://vite.dev/), [React](https://react.dev/), and [Three.js](https://threejs.org/).

## Features

* Load FBX files using drag and drop
* Import animation clips from additional FBX files
* Preview, scrub, and control animations on a timeline
* Inspect the model's bone hierarchy
* Toggle viewport helpers and display options
* Switch between original materials and solid-color rendering
* Load morph targets using an optimized parsing path

## Getting Started

### Install dependencies

```bash
npm install
```

### Start the development server

```bash
npm run dev
```

## Production Build

```bash
npm run build
```

The static site files are generated in the `dist/` directory and can be deployed to any static hosting service.
