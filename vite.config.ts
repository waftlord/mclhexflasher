import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [
    react(),
    {
      name: 'distribution-notices',
      generateBundle() {
        for (const fileName of ['LICENSE', 'LICENSES/MCL.txt', 'THIRD_PARTY_NOTICES.md']) {
          this.emitFile({ type: 'asset', fileName, source: readFileSync(new URL(fileName, import.meta.url), 'utf8') });
        }
      },
    },
  ],
  build: {
    license: { fileName: 'third-party-licenses.md' },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
});
