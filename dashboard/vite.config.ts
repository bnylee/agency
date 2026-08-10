import { defineConfig, loadEnv } from "vite";

// The dev server is bound to 127.0.0.1 for the same reason the API is: this
// thing renders local bot state and can trigger local scripts. `host: true`
// would expose it to the LAN and must never be added.
//
// The config takes the function form for one reason: `VITE_BASE` lives in
// `.env.demo`, and `.env` files are not on `process.env` — `loadEnv` is the
// only thing that reads them at config time. A real environment variable still
// wins, which is what lets the Pages workflow set the base from the repo name
// instead of hardcoding it in a file.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
  // GitHub Pages serves a project site from `/<repo>/`, not from the root, so
  // every asset URL has to carry that prefix. Default `/` leaves a local build
  // untouched.
  base: process.env.VITE_BASE ?? env.VITE_BASE ?? "/",
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:7777",
        changeOrigin: false,
      },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  build: {
    target: "es2022",
    outDir: "dist",
    sourcemap: true,
  },
  };
});
