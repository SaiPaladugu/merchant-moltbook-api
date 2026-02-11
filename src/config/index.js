/**
 * Application configuration
 */

require('dotenv').config();

const config = {
  // Server
  port: parseInt(process.env.PORT, 10) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',
  
  // Database
  database: {
    url: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
  },
  
  // Redis (optional)
  redis: {
    url: process.env.REDIS_URL
  },
  
  // Security
  jwtSecret: process.env.JWT_SECRET || 'development-secret-change-in-production',
  
  // Rate Limits (relaxed in development for testing)
  rateLimits: {
    requests: { max: process.env.NODE_ENV === 'production' ? 100 : 1000, window: 60 },
    posts: { max: process.env.NODE_ENV === 'production' ? 1 : 100, window: 1800 },
    comments: { max: process.env.NODE_ENV === 'production' ? 50 : 500, window: 3600 }
  },
  
  // Moltbook specific
  moltbook: {
    tokenPrefix: 'moltbook_',
    claimPrefix: 'moltbook_claim_',
    baseUrl: process.env.BASE_URL || 'https://www.moltbook.com'
  },
  
  // Pagination defaults
  pagination: {
    defaultLimit: 25,
    maxLimit: 100
  },

  // Image generation
  image: {
    provider: process.env.IMAGE_PROVIDER || 'openai',
    apiKey: process.env.IMAGE_API_KEY,
    apiKeys: (process.env.IMAGE_API_KEYS || process.env.IMAGE_API_KEY || '').split(',').map(k => k.trim()).filter(Boolean),
    baseUrl: process.env.IMAGE_BASE_URL || undefined,
    model: process.env.IMAGE_MODEL || 'dall-e-3',
    size: process.env.IMAGE_SIZE || '1024x1024',
    outputDir: process.env.IMAGE_OUTPUT_DIR || './uploads',
    maxFileSizeMb: 5,
    maxImagesPerProduct: 5
  },

  // LLM text inference (agent runtime)
  llm: {
    provider: process.env.LLM_PROVIDER || 'openai',
    apiKey: process.env.LLM_API_KEY,
    apiKeys: (process.env.LLM_API_KEYS || process.env.LLM_API_KEY || '').split(',').map(k => k.trim()).filter(Boolean),
    baseUrl: process.env.LLM_BASE_URL || undefined,
    model: process.env.LLM_MODEL || 'gpt-4o'
  },

  // Agent runtime worker
  worker: {
    tickMs: parseInt(process.env.TICK_MS, 10) || 5000,
    runSeed: parseInt(process.env.RUN_SEED, 10) || 42
  },

  // Operator control
  operatorKey: process.env.OPERATOR_KEY || 'change-this-in-production',

  // Anti-trivial gating thresholds
  gating: {
    minQuestionLen: parseInt(process.env.MIN_QUESTION_LEN || '20', 10),
    minOfferPriceCents: parseInt(process.env.MIN_OFFER_PRICE_CENTS || '1', 10),
    minOfferMessageLen: parseInt(process.env.MIN_OFFER_MESSAGE_LEN || '10', 10),
    minLookingForConstraints: parseInt(process.env.MIN_LOOKING_FOR_CONSTRAINTS || '2', 10)
  }
};

// Validate required config
function validateConfig() {
  const required = [];
  
  if (config.isProduction) {
    required.push('DATABASE_URL', 'JWT_SECRET');
  }
  
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

validateConfig();

module.exports = config;
