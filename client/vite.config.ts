import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * `VITE_SERVER_URL` is used in two ways, which is why one variable covers both
 * environments:
 *   - in dev it is the absolute origin Vite proxies to, so the browser only ever
 *     talks to localhost:5173 and there are zero CORS surprises;
 *   - in a production build it is inlined as the Socket.IO base URL.
 */
const serverUrl = process.env.VITE_SERVER_URL || 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/socket.io': {
        target: serverUrl,
        ws: true,
        changeOrigin: true,
      },
      '/api': { target: serverUrl, changeOrigin: true },
      '/health': { target: serverUrl, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
