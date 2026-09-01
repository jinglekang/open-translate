import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), moveExtensionPages()],
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src'),
    },
  },
  build: {
    minify: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        popup: resolve(import.meta.dirname, 'src/popup/index.html'),
        options: resolve(import.meta.dirname, 'src/options/index.html'),
        background: resolve(import.meta.dirname, 'src/background/index.ts'),
        pageRuntime: resolve(import.meta.dirname, 'src/page/runtime.ts'),
      },
      output: {
        entryFileNames: (chunkInfo) =>
          chunkInfo.name === 'background'
            ? 'service-worker.js'
            : chunkInfo.name === 'pageRuntime'
              ? 'page-runtime.js'
              : 'assets/[name]-[hash].js',
      },
    },
  },
})

function moveExtensionPages(): Plugin {
  const pages = ['popup', 'options']

  return {
    name: 'move-extension-pages',
    closeBundle() {
      for (const page of pages) {
        const source = resolve(import.meta.dirname, `dist/src/${page}/index.html`)
        const targetDir = resolve(import.meta.dirname, `dist/${page}`)
        const target = resolve(targetDir, 'index.html')

        if (!existsSync(source)) {
          continue
        }

        mkdirSync(targetDir, { recursive: true })
        renameSync(source, target)
      }

      rmSync(resolve(import.meta.dirname, 'dist/src'), { recursive: true, force: true })
    },
  }
}
