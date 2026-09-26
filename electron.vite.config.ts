import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const shared = resolve(__dirname, 'src/shared');

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': shared, '@main': resolve(__dirname, 'src/main') },
    },
  },
  preload: {
    // sandbox: true の preload は node_modules を require できないため、依存を外部化しない。
    // preload が import して良いのは electron と src/shared/ipc-channels.ts のみ。
    resolve: {
      alias: { '@shared': shared },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
    },
    resolve: {
      alias: { '@shared': shared, '@renderer': resolve(__dirname, 'src/renderer/src') },
    },
    plugins: [react(), tailwindcss()],
  },
});
