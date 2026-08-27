import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Standalone SPA — no Cloudflare Worker, no Shopify App Bridge. `npm run dev`
// serves the Polaris UI at http://localhost:5173 and reads only local JSON.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    open: true,
  },
});
