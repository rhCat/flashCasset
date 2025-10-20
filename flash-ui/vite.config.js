import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,          // allow LAN access if you want
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:7861', // FastAPI
        changeOrigin: true,
        // if FastAPI is on another host/IP on your LAN:
        // target: 'http://192.168.1.205:7861'
      },
    },
  },
})
