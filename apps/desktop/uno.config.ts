import { defineConfig, presetUno, presetIcons } from 'unocss'
import presetTypography from '@unocss/preset-typography'

export default defineConfig({
  presets: [presetUno(), presetIcons(), presetTypography()],
})
