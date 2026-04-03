import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const sidecarScript = path.resolve(__dirname, '../../packages/sidecar/dist/index.js')

export default defineConfig({
  plugins: [vue(), UnoCSS()],
  clearScreen: false,
  define: {
    __SIDECAR_SCRIPT__: JSON.stringify(sidecarScript),
  },
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
})
