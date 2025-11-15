import { defineConfig } from 'vite'

export default defineConfig({
  base: './',                 
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        index: 'index.html',  
        game:  'home.html'    
      }
    }
  }
})