import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '../..')

export default defineConfig({
  plugins: [vue(), UnoCSS()],
  clearScreen: false,
  define: {
    __PROJECT_ROOT__: JSON.stringify(projectRoot),
  },
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
})
