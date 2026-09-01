import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Detour's dashboard is a static SPA served by dashboardServer.ts
// (src/dashboard/staticServer.ts) from a `web-dist/` directory at the
// package root — see that file's comment for why the path is two
// directories up in both the dev (src/) and built (dist/) layouts.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: '../web-dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      // Lets `npm run dev` (Vite's dev server) proxy WebSocket traffic to a
      // `detour start` instance running on the default dashboard port, so
      // the UI can be iterated on with live data without a production build.
      '/ws': {
        target: 'ws://localhost:4040',
        ws: true,
      },
    },
  },
});
