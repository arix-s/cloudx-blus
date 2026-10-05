import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config();

import app from './src/serverApp.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;

// ----------------------------------------------------------------------
// VITE DEV SERVER / PRODUCTION STATIC SERVING
// ----------------------------------------------------------------------
if (process.env.NODE_ENV !== 'production') {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'spa'
  });
  app.use(vite.middlewares);
} else {
  // Serve static assets with aggressive caching (hashed filenames are immutable)
  app.use(express.static(path.resolve(__dirname, 'dist'), {
    maxAge: '1y',
    immutable: true,
    etag: true,
    lastModified: true,
  }));
  app.get('*', (req, res) => {
    // HTML files should not be cached aggressively (they reference hashed assets)
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`CloudX Server is running at http://localhost:${PORT}`);
});
