import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * Ports come from the repository root's `.env`, so one file moves all three and
 * a machine already running something on 5173 does not need a code change.
 *
 * `loadEnv` with an empty prefix reads every key, not just `VITE_` ones. That is
 * safe here because nothing from it reaches the bundle — these values are used
 * by the dev server itself.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, resolve(__dirname, '..'), '');
  const apiPort = env.API_PORT || '3010';

  return {
    plugins: [react()],
    server: {
      port: Number(env.WEB_PORT || 5183),
      // Fail loudly rather than silently moving to the next free port: a dev
      // server on an address you were not told about looks like a broken build.
      strictPort: true,
      proxy: {
        '/api': {
          target: env.API_URL || `http://localhost:${apiPort}`,
          changeOrigin: true,
        },
      },
    },
  };
});
