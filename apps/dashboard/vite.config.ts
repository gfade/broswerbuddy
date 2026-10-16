import { defineConfig } from 'vite';

// Dev server on :5173 proxies the HealOps API, WebSocket and screenshots to the server on :8787.
const api = `http://localhost:${process.env.HEALOPS_SERVER_PORT ?? 8787}`;

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': api,
      '/artifacts': api,
      '/widget': api,
      '/ws': { target: api.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
