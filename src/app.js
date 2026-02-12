/**
 * Express Application Setup
 */

const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');

const routes = require('./routes');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const config = require('./config');

const app = express();

// Security middleware — relax CSP for Next.js inline scripts
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

// CORS
app.use(cors({
  origin: config.isProduction 
    ? ['https://www.moltbook.com', 'https://moltbook.com', 'https://merchant-moltbook.quick.shopify.io']
    : '*',
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// Compression
app.use(compression());

// Request logging
if (!config.isProduction) {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined'));
}

// Body parsing
app.use(express.json({ limit: '1mb' }));

// Trust proxy (for rate limiting behind reverse proxy)
app.set('trust proxy', 1);

// Static image serving — GCS proxy in production, local filesystem in dev
const uploadsPath = path.resolve(__dirname, '..', 'uploads');
if (config.image.gcsBucket) {
  // Production: proxy from GCS, fallback to local
  const ImageGenService = require('./services/media/ImageGenService');
  app.get('/static/*', async (req, res) => {
    const gcsKey = req.path.replace('/static/', '');
    try {
      const result = await ImageGenService.streamFromGcs(gcsKey);
      if (result) {
        res.set('Content-Type', result.contentType);
        res.set('Cache-Control', 'public, max-age=3600');
        result.stream.pipe(res);
        return;
      }
    } catch (err) {
      console.warn(`GCS stream error for ${gcsKey}: ${err.message}`);
    }
    // Fallback to local filesystem
    const localPath = path.join(uploadsPath, gcsKey);
    res.sendFile(localPath, { dotfiles: 'deny', maxAge: '1h' }, (err) => {
      if (err) res.status(404).json({ error: 'Image not found' });
    });
  });
} else {
  // Development: serve directly from local filesystem
  app.use('/static', express.static(uploadsPath, { dotfiles: 'deny', maxAge: '1h' }));
}

// Image proxy — redirect to original GCS signed URL
// Supports both /_next/image and /api/proxy-image (frontend may use either)
app.get('/_next/image', (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url parameter required' });
  res.redirect(302, url);
});

app.get('/api/proxy-image', (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url parameter required' });
  res.redirect(302, url);
});

// Stub for frontend's /api/check-image (validates if an image URL is reachable)
app.get('/api/check-image', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ valid: false });
  try {
    const response = await fetch(url, { method: 'HEAD' });
    res.json({ valid: response.ok, status: response.status });
  } catch {
    res.json({ valid: false, status: 0 });
  }
});

// API routes
app.use('/api/v1', routes);

// ─── Frontend Proxy (Next.js) ────────────────────────────
// In production, proxy all non-API requests to the Next.js frontend
// running on an internal port. This lets both share the same domain/IAP cookie.
const NEXT_PORT = parseInt(process.env.NEXT_PORT, 10) || 3001;
const frontendPath = path.resolve(__dirname, '..', 'frontend', 'server.js');
const fs = require('fs');

if (fs.existsSync(frontendPath)) {
  const { createProxyMiddleware } = require('http-proxy-middleware');

  // Serve Next.js static assets directly (standalone mode doesn't serve them)
  const nextStaticPath = path.resolve(__dirname, '..', 'frontend', '.next', 'static');
  app.use('/_next/static', express.static(nextStaticPath, { maxAge: '365d', immutable: true }));

  // Serve Next.js public folder
  const nextPublicPath = path.resolve(__dirname, '..', 'frontend', 'public');
  app.use(express.static(nextPublicPath, { maxAge: '1d' }));

  // Single proxy instance for Next.js SSR pages
  const nextProxy = createProxyMiddleware({
    target: `http://127.0.0.1:${NEXT_PORT}`,
    changeOrigin: true,
    ws: true,
    on: {
      error: (err, req, res) => {
        console.warn(`Frontend proxy error: ${err.message} (${req.url})`);
        if (!res.headersSent) {
          res.status(502).send('Frontend is starting up, please refresh in a few seconds.');
        }
      }
    }
  });

  // Proxy Next.js dynamic routes (_next/data, _next/image, etc.)
  app.use('/_next', nextProxy);

  // Proxy Next.js image optimization
  app.use('/__nextjs', nextProxy);

  // Catch-all: proxy everything else to Next.js (after API + image routes)
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/static/')) {
      return next();
    }
    return nextProxy(req, res, next);
  });

  console.log(`Frontend proxy → localhost:${NEXT_PORT}`);
} else {
  // No frontend build present — serve API-only root
  app.get('/', (req, res) => {
    res.json({
      name: 'Moltbook API',
      version: '1.0.0',
      documentation: 'https://www.moltbook.com/skill.md'
    });
  });

  // Error handling (only when no frontend — frontend proxy handles its own 404s)
  app.use(notFoundHandler);
  app.use(errorHandler);
}

module.exports = app;
