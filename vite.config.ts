/**
 * @file vite.config.ts
 * @description Vite build configuration (React + TypeScript).
 *
 * Standard config since the de-platforming: the client app lives under
 * `client/` (vite root), builds into `dist/client` (where the Nest server
 * serves the SPA from), and dev proxies /api to the NestJS backend on :3000.
 * The router basename reads `import.meta.env.BASE_URL` (vite `base`, "/").
 */
import path from 'path';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, __dirname, ''), ...process.env };
  return {
    root: 'client',
    envDir: __dirname,
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'client/src'),
        '@shared': path.resolve(__dirname, 'shared'),
      },
    },
    build: {
      outDir: '../dist/client',
      emptyOutDir: true,
    },
    server: {
      host: '127.0.0.1',
      port: Number(env.CLIENT_DEV_PORT || 8080),
      strictPort: true,
      proxy: {
        '/api': {
          target: `http://127.0.0.1:${env.SERVER_PORT || 3000}`,
          changeOrigin: false,
        },
      },
    },
  };
});
