import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The app is served from a file:// or loopback origin inside the webview, so
// assets are referenced relatively and built into the bundle directory the
// pekoui host loads.
export default defineConfig({
  base: './',
  build: { outDir: 'assets', emptyOutDir: true },
  // @peko/client is a file: dep resolved from the registry path, which has no
  // node_modules; dedupe so its adapter's React import binds to this project's.
  resolve: { dedupe: ['react', 'react-dom'] },
  plugins: [react()],
})
