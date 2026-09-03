import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [{ find: '@', replacement: path.resolve(__dirname, 'src') }],
  },
  server: {
    port: Number(process.env.PORT) || 5173,
    proxy: {
      // Frontend calls that use relative `/api/...` (e.g. /api/vault/session)
      // would otherwise hit the Vite origin and 404. Forward them to the
      // backend so one origin works in dev. Absolute http://localhost:5001
      // calls are unaffected.
      '/api': {
        target: 'http://localhost:5001',
        changeOrigin: true,
        secure: false,
      },
    },
  },
})

