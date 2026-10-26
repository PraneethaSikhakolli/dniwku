import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
const apiProxy = { '/api': 'http://backend:8000' };
export default defineConfig({
  plugins: [react()],
  server: { host: '0.0.0.0', proxy: apiProxy },
  preview: { host: '0.0.0.0', proxy: apiProxy },
});
