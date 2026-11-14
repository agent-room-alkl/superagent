import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // One .env at the repository root serves both the server and the page (only VITE_* names reach the browser).
  envDir: '../..',
  // /auth/config tells the page whether to sign in with Entra or use the dev identity; without it the page cannot start.
  server: { proxy: { '/api': 'http://localhost:8080', '/auth': 'http://localhost:8080', '/healthz': 'http://localhost:8080' } },
});
