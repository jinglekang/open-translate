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
      '@': resolve(__dirname, 'src'),
    },
  },
  build: {
    minify: false,
    sourcemap: true,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'src/popup/index.html'),
        options: resolve(__dirname, 'src/options/index.html'),
        background: resolve(__dirname, 'src/background/index.ts'),
        pageRuntime: resolve(__dirname, 'src/page/runtime.ts'),
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
        const source = resolve(__dirname, `dist/src/${page}/index.html`)
        const targetDir = resolve(__dirname, `dist/${page}`)
        const target = resolve(targetDir, 'index.html')

        if (!existsSync(source)) {
          continue
        }

        mkdirSync(targetDir, { recursive: true })
        renameSync(source, target)
      }

      rmSync(resolve(__dirname, 'dist/src'), { recursive: true, force: true })
    },
  }
}
