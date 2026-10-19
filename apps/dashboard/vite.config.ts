import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  envDir: '../..',
  plugins: [react()],
  server: { port: 5174, proxy: { '/v1': { target: process.env.ORBITT_API_PROXY ?? 'http://localhost:3000', changeOrigin: true } } },
});
