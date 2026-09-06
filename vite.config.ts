import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'
import { createDeferredAssets } from '../home-teacher-common/build/deferredAssets.mjs'

import { execSync } from 'child_process'

// Gitハッシュの取得
const commitHash = execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim()

// 起動中のクライアントが公開済みの最新版を確認するためのメタデータ。
// ハッシュ付きアセットとは別名にして、常に同じURLから取得する。
const versionMetadataPlugin = () => ({
  name: 'emit-version-metadata',
  generateBundle() {
    this.emitFile({
      type: 'asset',
      fileName: 'version.json',
      source: JSON.stringify({ commit: commitHash })
    })
  }
})

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const deferredAssets = createDeferredAssets()
  // 環境変数を読み込む
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const isDiscuss = mode === 'discuss'
  const basePath = env.VITE_APP_BASE || (process.env.NODE_ENV === 'production'
    ? (isDiscuss ? '/TutoTuto/discuss/' : '/TutoTuto/')
    : '/')
  const appName = env.VITE_APP_NAME || 'TutoTuto'
  const themeColor = env.VITE_THEME_COLOR || '#3498db'

  console.log(`📦 Building ${appName} (mode: ${mode}, hash: ${commitHash})`)

  // モード別のアイコンディレクトリ
  const iconSource = isDiscuss ? 'public/icons/discuss' : 'public/icons/kids'

  return {
    base: basePath,
    define: {
      'import.meta.env.VITE_APP_COMMIT_HASH': JSON.stringify(commitHash),
      'import.meta.env.VITE_INDEXED_DB_NAME': JSON.stringify('TutoTutoDB')
    },
    resolve: {
      alias: {
        '@thousands-of-ties/drawing-common': path.resolve(__dirname, '../drawing-common/src'),
        '@home-teacher/common': path.resolve(__dirname, '../home-teacher-common/src')
      },
      dedupe: ['i18next', 'react-i18next', 'react', 'react-dom']
    },
    plugins: [
      deferredAssets.plugin,
      react(),
      viteStaticCopy({
        targets: [
          {
            src: 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs',
            dest: '',
            rename: 'pdf.worker.min.js'
          },
          // モード別にアイコンをコピー
          {
            src: `${iconSource}/favicon.png`,
            dest: '',
            rename: 'favicon.ico'
          },
          {
            src: `${iconSource}/logo.png`,
            dest: ''
          },
          {
            src: `${iconSource}/app.png`,
            dest: ''
          }
        ]
      }),
      VitePWA({
        registerType: 'prompt',
        includeAssets: ['logo.png', 'app.png'],

        manifest: false,
        workbox: {
          manifestTransforms: [deferredAssets.manifestTransform],
          cleanupOutdatedCaches: true,
          skipWaiting: false,
          clientsClaim: false,
          navigateFallbackDenylist: [/manage\.html/], // <--- manage.htmlをフォールバックから除外
          // version.json はネットワークから最新版を確認するため、precacheしない。
          globIgnores: ['**/opencv*.js', '**/version.json'],
          globPatterns: ['**/*.{js,css,html,png,svg,woff,woff2}'],
          maximumFileSizeToCacheInBytes: 15 * 1024 * 1024,
          runtimeCaching: [
            {
              urlPattern: ({ url, sameOrigin }) => sameOrigin && /\/assets\/[^/]+\.(?:js|css)$/.test(url.pathname),
              handler: 'CacheFirst',
              options: {
                cacheName: `${appName}-on-demand-assets-v1`,
                cacheableResponse: { statuses: [200] },
                expiration: { maxEntries: 64, maxAgeSeconds: 90 * 24 * 60 * 60 }
              }
            },
            {
              urlPattern: /manage\.html/, // <--- manage.htmlは常に最新を確認
              handler: 'NetworkFirst',
              options: {
                cacheName: 'manage-html-cache'
              }
            },
            {
              urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'google-fonts-cache',
                expiration: {
                  maxEntries: 10,
                  maxAgeSeconds: 60 * 60 * 24 * 365 // 1 year
                },
                cacheableResponse: {
                  statuses: [0, 200]
                }
              }
            },
            {
              urlPattern: /\.(?:png|jpg|jpeg|svg|gif|webp)$/,
              handler: 'CacheFirst',
              options: {
                cacheName: 'images-cache',
                expiration: {
                  maxEntries: 100,
                  maxAgeSeconds: 60 * 60 * 24 * 30 // 30 days
                }
              }
            }
          ]
        }
      }),
      versionMetadataPlugin()
    ],
    server: {
      port: 3000,
      fs: {
        // PDFsフォルダへのアクセスを許可
        allow: ['..']
      }
    },
    optimizeDeps: {
      include: ['pdfjs-dist'],
    },
    assetsInclude: ['**/*.pdf'],
    build: {
      chunkSizeWarningLimit: 1000,
      minify: 'terser',
      terserOptions: {
        compress: {
          drop_console: process.env.NODE_ENV === 'production',
          drop_debugger: true
        }
      },
      rollupOptions: {
        output: {
          manualChunks: {
            'react-vendor': ['react', 'react-dom'],
            'fabric-vendor': ['fabric'],
            'pdfjs-vendor': ['pdfjs-dist']
          },
          entryFileNames: 'assets/[name]-[hash].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]'
        }
      }
    }
  }
})
