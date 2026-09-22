import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'API_');
  const apiPort = env.API_PORT || '8787';

  return {
    plugins: [react()],
    server: {
      // PORT setzt die Claude-App beim Start (autoPort). Der API-Server liest bewusst
      // API_PORT, sonst greifen beide Prozesse nach demselben Port.
      port: Number(process.env.PORT) || 5173,
      proxy: {
        '/api': `http://localhost:${apiPort}`,
      },
    },
  };
});
