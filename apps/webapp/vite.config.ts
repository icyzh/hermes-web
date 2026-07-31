import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import fs from 'fs'

// The web app reuses the desktop renderer source verbatim: `@` aliases into
// ../desktop/src so upstream merges stay conflict-free, and all web-specific
// behavior lives in src/polyfill + the stub aliases below.
const DESKTOP_SRC = path.resolve(__dirname, '../desktop/src')

const real = (p: string): string | null => {
  try {
    return fs.realpathSync(p)
  } catch {
    return null
  }
}

const fsAllow = [
  ...new Set(
    [
      path.resolve(__dirname, '../..'),
      real(path.resolve(__dirname, 'node_modules')),
      real(path.resolve(__dirname, '../../node_modules'))
    ].filter((p): p is string => p !== null)
  )
]

// Dev-only render/state churn counters — same aliasing trick as the desktop
// build (see apps/desktop/vite.config.ts): statically imported above
// react-dom, aliased to a no-op for production builds.
const debugEntry = (command: string, env: Record<string, string>) =>
  command === 'serve' || env.VITE_PERF_PROBE === '1'
    ? path.resolve(DESKTOP_SRC, 'debug/dev-only.ts')
    : path.resolve(DESKTOP_SRC, 'debug/dev-only.noop.ts')

// The emoji picker (frimousse) fetches `<emojibaseUrl>/<locale>/data.json` at
// runtime; serve the bundled emojibase-data package at a stable local path
// (middleware in dev, emitted assets in the build) so the app works offline.
const emojibaseDir =
  real(path.resolve(__dirname, 'node_modules/emojibase-data')) ??
  real(path.resolve(__dirname, '../../node_modules/emojibase-data'))

const EMOJIBASE_PATH = /^[a-z-]+\/(data|messages|shortcodes\/emojibase)\.json$/

const emojibaseAssets = () => ({
  name: 'hermes:emojibase-assets',
  configureServer(server: {
    middlewares: { use: (route: string, handler: (req: any, res: any, next: () => void) => void) => void }
  }) {
    server.middlewares.use('/emojibase', (req, res, next) => {
      const rel = (req.url ?? '').split('?')[0].replace(/^\/+/, '')
      if (!emojibaseDir || !EMOJIBASE_PATH.test(rel)) return next()
      fs.readFile(path.join(emojibaseDir, rel), (err: unknown, buf: Buffer) => {
        if (err) return next()
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        res.end(buf)
      })
    })
  },
  generateBundle(this: { emitFile: (asset: { type: 'asset'; fileName: string; source: Uint8Array }) => void }) {
    if (!emojibaseDir) return
    for (const rel of ['en/data.json', 'en/messages.json', 'en/shortcodes/emojibase.json']) {
      this.emitFile({
        type: 'asset',
        fileName: `emojibase/${rel}`,
        source: fs.readFileSync(path.join(emojibaseDir, rel))
      })
    }
  }
})

// Swap the desktop entry's `./styles.css` import for our wrapper (which
// re-imports it plus `@source` directives) — Tailwind v4's automatic source
// detection is cwd-relative and misses ../desktop/src from this workspace.
const webStyles = () => {
  const desktopMain = path.join(DESKTOP_SRC, 'main.tsx')
  const desktopStyles = path.join(DESKTOP_SRC, 'styles.css')
  const wrapper = path.resolve(__dirname, 'src/styles-web.css')

  return {
    name: 'hermes:web-styles',
    enforce: 'pre' as const,
    resolveId(source: string, importer: string | undefined) {
      if (source === './styles.css' && importer === desktopMain) {
        return wrapper
      }

      // The wrapper itself imports the real desktop stylesheet; let that (and
      // every other resolution) fall through untouched.
      if (source.endsWith('desktop/src/styles.css') && importer === wrapper) {
        return desktopStyles
      }

      return null
    }
  }
}

export default defineConfig(({ command }) => ({
  // Absolute base (unlike the desktop's './'): the dashboard's mount_spa()
  // rewrites absolute `/assets/...` URLs for reverse-proxy path prefixes
  // (X-Forwarded-Prefix), so the build must emit absolute asset URLs.
  base: '/',
  publicDir: path.resolve(__dirname, '../desktop/public'),
  plugins: [webStyles(), react(), tailwindcss(), emojibaseAssets()],
  define: {
    // Renderer-source branches: `import.meta.env.HERMES_WEB` is true only in
    // this build, letting shared source gate desktop-only UI with dead-code
    // elimination. The desktop build leaves it undefined (falsy).
    'import.meta.env.HERMES_WEB': 'true'
  },
  css: {
    // Hermetic PostCSS: Tailwind is handled by @tailwindcss/vite (see the
    // desktop config for the full rationale).
    postcss: { plugins: [] }
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 25000,
    rolldownOptions: {
      output: {
        advancedChunks: {
          groups: [
            { name: 'vendor-react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            {
              name: 'vendor-md',
              test: /node_modules[\\/](property-information|hast-util-[^\\/]+|mdast-util-[^\\/]+|micromark[^\\/]*|unist-util-[^\\/]+|vfile[^\\/]*|unified|stringify-entities|space-separated-tokens|comma-separated-tokens|zwitch|html-void-elements|devlop|style-to-js|style-to-object|clsx)[\\/]/
            },
            {
              name: 'vendor-util',
              test: /node_modules[\\/](lodash-es|es-toolkit|uuid|dayjs|d3-array|d3-color|d3-force|d3-interpolate|d3-time[^\\/]*|dompurify|stylis)[\\/]/
            },
            {
              name: 'mermaid',
              test: /node_modules[\\/](mermaid|cytoscape|dagre|khroma|elkjs|d3|d3-[^\\/]+|@mermaid-js)[\\/]/
            },
            {
              name: 'shiki',
              test: /node_modules[\\/](shiki|@shikijs|react-shiki|@streamdown[\\/]code|oniguruma-to-es|oniguruma-parser|regex(-[^\\/]+)?)[\\/]/
            },
            { name: 'katex', test: /node_modules[\\/]katex[\\/]/ }
          ]
        }
      }
    }
  },
  resolve: {
    alias: {
      '@/debug/dev-only': debugEntry(command, process.env as Record<string, string>),
      '@': DESKTOP_SRC,
      '@hermes/plugin-sdk': path.resolve(DESKTOP_SRC, 'sdk/index.ts'),
      '@hermes/shared/billing': path.resolve(__dirname, '../shared/src/billing-types.ts'),
      '@hermes/shared': path.resolve(__dirname, '../shared/src'),
      react: path.resolve(__dirname, '../../node_modules/react'),
      'react-dom': path.resolve(__dirname, '../../node_modules/react-dom'),
      'react/jsx-dev-runtime': path.resolve(__dirname, '../../node_modules/react/jsx-dev-runtime.js'),
      'react/jsx-runtime': path.resolve(__dirname, '../../node_modules/react/jsx-runtime.js')
    },
    dedupe: ['react', 'react-dom']
  },
  server: {
    host: '127.0.0.1',
    port: 5175,
    strictPort: true,
    fs: {
      allow: fsAllow
    },
    // Dev flow: run `hermes dashboard` (127.0.0.1:9119) for the backend and
    // let Vite serve HMR. REST + every WebSocket (/api/ws, /api/pty,
    // /api/audio/speak-stream, /api/terminal) proxy through same-origin.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:9119',
        changeOrigin: false,
        ws: true
      },
      '/login': {
        target: 'http://127.0.0.1:9119',
        changeOrigin: false
      },
      '/auth': {
        target: 'http://127.0.0.1:9119',
        changeOrigin: false
      }
    }
  },
  preview: {
    host: '127.0.0.1',
    port: 4175
  }
}))
