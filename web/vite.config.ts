import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  base: '/abc2p8/',
  publicDir: resolve(here, 'public'),
  build: {
    outDir: resolve(here, '..', 'dist-web'),
    emptyOutDir: true,
    assetsInlineLimit: 0,
  },
  server: {
    port: 5173,
  },
});
