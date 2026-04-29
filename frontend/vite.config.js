import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import inferencePlugin from './vite-plugin-inference.mjs';

export default defineConfig({
  plugins: [react(), inferencePlugin()],
  server: {
    host: '127.0.0.1',
  },
});
