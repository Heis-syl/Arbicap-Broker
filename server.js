/**
 * Arbicap — Main Server
 * Express REST API + WebSocket Server
 */
'use strict';
require('dotenv').config();

const express     = require('express');
const http        = require('http');
const cors        = require('cors');
const helmet      = require('helmet');
const compression = require('compression');
const morgan      = require('morgan');
const rateLimit   = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');

const { logger }          = require('./services/logger');
const { initDB }          = require('./models/db');
const { initRedis }       = require('./services/redis');
const { initWS }          = require('./services/websocket');
const { startPriceEngine }= require('./services/priceEngine');
const { startDepositMonitor } = require('./services/depositMonitor');

// Routes
const authRouter    = require('./routes/auth');
const walletRouter  = require('./routes/wallet');
const ordersRouter  = require('./routes/orders');
const p2pRouter     = require('./routes/p2p');
const webhooksRouter= require('./routes/webhooks');
const { marketsRouter, tradesRouter, usersRouter, adminRouter, kycRouter } = require('./routes/markets');

const app    = express();
app.set('trust proxy', 1);
const server = http.createServer(app);

// ── MIDDLEWARE ────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'https://arbicap.vercel.app',
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Request-ID','X-API-Key'],
}));
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(morgan('combined', { stream: { write: (msg) => logger.info(msg.trim()) } }));

// ── RATE LIMITING ─────────────────────────────
const globalLimiter = rateLimit({ windowMs: 15*60*1000, max: 300, standardHeaders: true, legacyHeaders: false });
const authLimiter   = rateLimit({ windowMs: 15*60*1000, max: 20,  message: { error: 'Too many auth attempts.' } });
const orderLimiter  = rateLimit({ windowMs: 1000,        max: 10,  message: { error: 'Order rate limit exceeded.' } });

app.use('/api/',        globalLimiter);
app.use('/api/auth/',   authLimiter);
app.use('/api/orders/', orderLimiter);

// ── REQUEST ID ────────────────────────────────
app.use((req, res, next) => {
  req.id = uuidv4();
  res.setHeader('X-Request-ID', req.id);
  next();
});

// ── ROUTES ────────────────────────────────────
app.use('/api/auth',     authRouter);
app.use('/api/users',    usersRouter);
app.use('/api/kyc',      kycRouter);
app.use('/api/markets',  marketsRouter);
app.use('/api/orders',   ordersRouter);
app.use('/api/trades',   tradesRouter);
app.use('/api/wallet',   walletRouter);
app.use('/api/p2p',      p2pRouter);
app.use('/api/admin',    adminRouter);
app.use('/webhooks',     webhooksRouter);

// ── HEALTH CHECK ──────────────────────────────
app.get('/health', async (req, res) => {
  const { checkDB }    = require('./models/db');
  const { checkRedis } = require('./services/redis');
  const [dbOk, redisOk] = await Promise.all([checkDB(), checkRedis()]);
  res.status(dbOk ? 200 : 503).json({
    status: dbOk && redisOk ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    services: { database: dbOk ? 'ok' : 'error', redis: redisOk ? 'ok' : 'error' },
  });
});

// ── 404 ───────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Route not found', path: req.path }));

// ── GLOBAL ERROR HANDLER ─────────────────────
app.use((err, req, res, next) => {
  console.error('FULL ERROR:', err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: err.message || 'Internal server error' });
});

// ── STARTUP ───────────────────────────────────
async function start() {
  try {
    await initDB();    logger.info('✅ Database connected');
    await initRedis(); logger.info('✅ Redis connected');
    initWS(server);   logger.info('✅ WebSocket server ready at /ws');
    startPriceEngine();     logger.info('✅ Price engine started');
    startDepositMonitor();  logger.info('✅ Deposit monitor started');

    const PORT = process.env.PORT || 4000;
    server.listen(PORT, () => logger.info(`🚀 Arbicap API running on port ${PORT}`));
  } catch (err) {
    logger.error('❌ Startup failed:', err.message);
    process.exit(1);
  }
}

process.on('SIGTERM', () => {
  logger.info('SIGTERM — shutting down');
  server.close(() => process.exit(0));
});

start();
