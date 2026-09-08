import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { lanSignalingPlugin } from "./vite-plugin-lan-signaling";

export default defineConfig({
  base: "./",
  plugins: [react(), lanSignalingPlugin()],
  server: {
    host: true,
  },
});
