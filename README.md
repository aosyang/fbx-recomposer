# FBX Viewer

A small, fully static FBX viewer built with Vite, React, and Three.js. Files are
parsed locally in the browser and are never uploaded.

## Development

```bash
npm install
npm run dev
```

## Production build

```bash
npm run build
```

The static site is generated in `dist/` and can be hosted on GitHub Pages.

## GitHub Pages

Push this repository to GitHub, open **Settings → Pages**, and set the source to
**GitHub Actions**. The included workflow deploys the site on each push to
`main`.
