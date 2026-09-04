import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "../..");
const outDir = join(here, ".tmp-auto-loop-analysis");
rmSync(outDir, { recursive: true, force: true });
await build({
  root: projectRoot,
  configFile: false,
  logLevel: "error",
  build: {
    lib: {
      entry: join(here, "auto_loop_analysis_test.ts"),
      formats: ["es"],
      fileName: () => "bundle.mjs",
    },
    outDir,
    emptyOutDir: true,
    minify: false,
  },
});
await import(`${pathToFileURL(join(outDir, "bundle.mjs")).href}?v=${Date.now()}`);
