import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { resolve } from "node:path";

// En dev, Vite sirve el cliente con HMR y deriva el WebSocket al servidor de juego (:8080).
export default defineConfig({
  plugins: [
    svelte(),
    {
      // en producción el servidor sirve /pad; en dev lo reescribimos a la página del control
      name: "pad-rewrite",
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url && /^\/pad(\?|$)/.test(req.url)) req.url = req.url.replace(/^\/pad/, "/pad.html");
          next();
        });
      },
    },
  ],
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      "/ws": { target: "ws://localhost:8090", ws: true },
      "/health": "http://localhost:8090",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
    sourcemap: true,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        pad: resolve(__dirname, "pad.html"),
      },
      output: {
        manualChunks: {
          pixi: ["pixi.js", "pixi-filters"],
          supabase: ["@supabase/supabase-js"],
        },
      },
    },
  },
});
