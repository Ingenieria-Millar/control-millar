import { defineConfig } from 'vite';

/**
 * Configuración de Vite para el cliente.
 * En desarrollo, /api se redirige al backend Express (server/) en el puerto 4000.
 * En producción, el propio backend sirve el contenido de /dist (ver server/src/app.js).
 */
export default defineConfig({
  root: '.',
  publicDir: 'public',
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          // pdf-lib y pdfjs-dist son pesados y solo se usan en las páginas de
          // firma/paquete de ingreso: aislarlas evita que el bundle inicial
          // (dashboard, trabajadores, etc.) cargue ~1MB de PDF que no necesita.
          'pdf-vendor': ['pdf-lib', 'pdfjs-dist'],
        },
      },
    },
  },
});
