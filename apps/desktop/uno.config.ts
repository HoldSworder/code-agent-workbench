import { defineConfig, presetUno, presetIcons } from 'unocss'
import presetTypography from '@unocss/preset-typography'

export default defineConfig({
  presets: [presetUno(), presetIcons(), presetTypography()],
  preflights: [
    {
      getCSS: () => `
        * {
          scrollbar-width: thin;
          scrollbar-color: rgba(0,0,0,.15) transparent;
        }
        ::-webkit-scrollbar {
          width: 6px;
          height: 6px;
        }
        ::-webkit-scrollbar-track {
          background: transparent;
        }
        ::-webkit-scrollbar-thumb {
          background: rgba(0,0,0,.15);
          border-radius: 3px;
        }
        ::-webkit-scrollbar-thumb:hover {
          background: rgba(0,0,0,.25);
        }
        @media (prefers-color-scheme: dark) {
          * {
            scrollbar-color: rgba(255,255,255,.15) transparent;
          }
          ::-webkit-scrollbar-thumb {
            background: rgba(255,255,255,.15);
          }
          ::-webkit-scrollbar-thumb:hover {
            background: rgba(255,255,255,.25);
          }
        }
      `,
    },
  ],
})
