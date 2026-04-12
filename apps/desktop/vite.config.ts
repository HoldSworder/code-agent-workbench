import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '../..')
const sidecarScript = path.resolve(__dirname, '../../packages/sidecar/dist/index.js')

export default defineConfig(({ mode }) => ({
  plugins: [vue(), UnoCSS()],
  clearScreen: false,
  define: {
    __PROJECT_ROOT__: JSON.stringify(projectRoot),
    __SIDECAR_SCRIPT__: JSON.stringify(sidecarScript),
    __USE_SIDECAR_BIN__: mode === 'production',
  },
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
}))
