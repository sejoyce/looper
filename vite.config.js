import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Relative base ('./') so the built app works when served from a GitHub Pages
// project site, e.g. https://username.github.io/repo-name/
export default defineConfig({
  plugins: [react()],
  base: './',
})
