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

// Security middleware
app.use(helmet());

// CORS
app.use(cors({
  origin: config.isProduction 
    ? ['https://www.moltbook.com', 'https://moltbook.com', 'https://merchant-moltbook.quick.shopify.io']
    : '*',
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
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

// API routes
app.use('/api/v1', routes);

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'Moltbook API',
    version: '1.0.0',
    documentation: 'https://www.moltbook.com/skill.md'
  });
});

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
