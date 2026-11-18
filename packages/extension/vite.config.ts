import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

// Extension pages load from chrome-extension://<id>/, so asset paths must be relative.
export default defineConfig({
  base: "./",
  plugins: [tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome111",
    // Chrome 111+ supports <link rel="modulepreload">; the polyfill would only add a fetch() to the bundle.
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: { devtools: "devtools.html", panel: "panel.html", inspector: "inspector.html", popup: "popup.html" },
    },
  },
});
