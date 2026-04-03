import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'path';
import { rename, mkdir } from 'fs/promises';

function movePopupHtml(): Plugin {
  return {
    name: 'move-popup-html',
    closeBundle: async () => {
      try {
        await mkdir(resolve(__dirname, 'dist/popup'), { recursive: true });
        await rename(
          resolve(__dirname, 'dist/src/popup/index.html'),
          resolve(__dirname, 'dist/popup/index.html'),
        );
        // Clean up empty dirs
        const { rm } = await import('fs/promises');
        await rm(resolve(__dirname, 'dist/src'), { recursive: true, force: true });
      } catch {
        // Already moved or doesn't exist
      }
    },
  };
}

export default defineConfig(({ mode }) => ({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  plugins: [movePopupHtml()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: mode === 'development' ? 'inline' : false,
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'src/background/index.ts'),
        popup: resolve(__dirname, 'src/popup/index.html'),
      },
      output: {
        entryFileNames: '[name]/index.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
}));
