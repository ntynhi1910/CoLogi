
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const port = 5173
const codespace = process.env.CODESPACE_NAME

const domain =
  process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN ||
  'app.github.dev'

const publicHost = codespace
  ? `${codespace}-${port}.${domain}`
  : undefined

export default defineConfig({
  plugins: [react()],

  server: {
    host: '0.0.0.0',
    port,
    strictPort: true,

    allowedHosts: publicHost
      ? [publicHost]
      : [],

    hmr: publicHost
      ? {
          protocol: 'wss',
          host: publicHost,
          clientPort: 443,
        }
      : undefined,

    proxy: {
      '/api': {
        target: 'http://127.0.0.1:15173',
        changeOrigin: true,
      },
    },
  },
})
