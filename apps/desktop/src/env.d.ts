/// <reference types="vite/client" />

declare const __PROJECT_ROOT__: string
declare const __SIDECAR_SCRIPT__: string
declare const __USE_SIDECAR_BIN__: boolean
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}
