import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In dev (`npm run dev`, port 5173) API calls are proxied to the broker so the
// browser sees one origin, exactly as in production where the broker serves the build.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
});
