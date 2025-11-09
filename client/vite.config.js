import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    outDir: 'dist', // ✅ keep this
  },
  root: '.', // ✅ root should be project folder
  publicDir: 'public', // ✅ optional, default is "public"
})
