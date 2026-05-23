/* eslint-disable import/no-extraneous-dependencies */
/// <reference types="vitest"/>
import react from '@vitejs/plugin-react-swc';
import { defineConfig } from 'vite';
import dotenv from 'dotenv';

dotenv.config({ path: `${__dirname}/.env.local` });
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  test: {
    setupFiles: ['dotenv/config'],
    mockReset: true,
    testTimeout: 10000,
  },
  server: {
    fs: {
      allow: ['..'],
    },
    proxy: {
      '/api': {
        target: process.env.VITE_API_URL ?? 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
});
