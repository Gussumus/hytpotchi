import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1',
    // Не следим за Rust-частью: target/ огромный и занят компилятором
    watch: { ignored: ['**/src-tauri/**'] },
  },
})
