import { defineConfig, presetUno, presetIcons } from 'unocss'
import presetTypography from '@unocss/preset-typography'

export default defineConfig({
  presets: [
    presetUno({ preflight: false }),
    presetIcons(),
    presetTypography(),
  ],
  preflights: [
    {
      getCSS: () => `
        *, *::before, *::after {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
          border: 0 solid transparent;
          outline: none;
        }
        html {
          -webkit-text-size-adjust: 100%;
          tab-size: 4;
          line-height: 1.5;
        }
        html, body, #app {
          width: 100vw;
          height: 100vh;
          overflow: hidden;
          margin: 0;
          padding: 0;
          font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
          -webkit-font-smoothing: antialiased;
          -moz-osx-font-smoothing: grayscale;
        }
        body { line-height: inherit; }
        hr { height: 0; color: inherit; border-top-width: 1px; }
        h1, h2, h3, h4, h5, h6 { font-size: inherit; font-weight: inherit; }
        a { color: inherit; text-decoration: inherit; }
        b, strong { font-weight: bolder; }
        code, kbd, samp, pre {
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
          font-size: 1em;
        }
        small { font-size: 80%; }
        sub, sup { font-size: 75%; line-height: 0; position: relative; vertical-align: baseline; }
        sub { bottom: -0.25em; }
        sup { top: -0.5em; }
        table { text-indent: 0; border-color: inherit; border-collapse: collapse; }
        button, input, optgroup, select, textarea {
          font-family: inherit;
          font-feature-settings: inherit;
          font-variation-settings: inherit;
          font-size: 100%;
          font-weight: inherit;
          line-height: inherit;
          color: inherit;
          margin: 0;
          padding: 0;
          border: none;
          outline: none;
          background: transparent;
        }
        button, select { text-transform: none; }
        button, [type='button'], [type='reset'], [type='submit'] {
          -webkit-appearance: button;
          cursor: pointer;
        }
        :-moz-focusring { outline: auto; }
        progress { vertical-align: baseline; }
        ::-webkit-inner-spin-button, ::-webkit-outer-spin-button { height: auto; }
        [type='search'] { -webkit-appearance: textfield; outline-offset: -2px; }
        ::-webkit-search-decoration { -webkit-appearance: none; }
        ::-webkit-file-upload-button { -webkit-appearance: button; font: inherit; }
        summary { display: list-item; }
        blockquote, dl, dd, h1, h2, h3, h4, h5, h6, hr, figure, p, pre { margin: 0; }
        fieldset { margin: 0; padding: 0; }
        legend { padding: 0; }
        ol, ul, menu { list-style: none; margin: 0; padding: 0; }
        dialog { padding: 0; }
        textarea { resize: vertical; }
        input::placeholder, textarea::placeholder { opacity: 1; color: #9ca3af; }
        img, svg, video, canvas, audio, iframe, embed, object { display: block; vertical-align: middle; }
        img, video { max-width: 100%; height: auto; }
        [hidden] { display: none; }
        /* Scrollbar */
        * { scrollbar-width: none; }
        *::-webkit-scrollbar { display: none; }
        .scroll-thin { scrollbar-width: thin; scrollbar-color: rgba(0,0,0,.1) transparent; }
        .scroll-thin::-webkit-scrollbar { display: block; width: 4px; height: 4px; }
        .scroll-thin::-webkit-scrollbar-track { background: transparent; }
        .scroll-thin::-webkit-scrollbar-thumb { background: rgba(0,0,0,.1); border-radius: 2px; }
        .scroll-thin::-webkit-scrollbar-thumb:hover { background: rgba(0,0,0,.2); }
        @media (prefers-color-scheme: dark) {
          .scroll-thin { scrollbar-color: rgba(255,255,255,.08) transparent; }
          .scroll-thin::-webkit-scrollbar-thumb { background: rgba(255,255,255,.08); }
          .scroll-thin::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,.15); }
        }
      `,
    },
  ],
})
