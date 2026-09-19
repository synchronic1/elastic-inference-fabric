import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  define: {
    'process.env.COPILOTKIT_TELEMETRY_DISABLED': JSON.stringify('true'),
    'process.env.DO_NOT_TRACK': JSON.stringify('true'),
  },
  plugins: [react()],
  server: { proxy: {
    '/api': 'http://127.0.0.1:8787', '/v1': 'http://127.0.0.1:8787',
    '/.well-known': 'http://127.0.0.1:8787', '/openapi.json': 'http://127.0.0.1:8787',
    '/llms.txt': 'http://127.0.0.1:8787',
  } },
});
