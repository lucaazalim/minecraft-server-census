import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const webRoot = path.resolve(import.meta.dirname, 'src/web');

export default defineConfig({
  // The dashboard lives in src/web (index.html, public/, sources); build output and cache stay at the repo root.
  root: webRoot,
  cacheDir: path.resolve(import.meta.dirname, 'node_modules/.vite'),
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': webRoot } },
  // In dev the SPA is served by Vite and /api is proxied to the Node process; in prod the Node process serves dist/web.
  server: { port: 5173, proxy: { '/api': 'http://localhost:8080' } },
  build: { outDir: path.resolve(import.meta.dirname, 'dist/web'), emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 1200 },
});
