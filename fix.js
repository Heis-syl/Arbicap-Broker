/**
 * Run this once: node fix.js
 * Creates the correct folder structure and all missing service files.
 */
const fs   = require('fs');
const path = require('path');

// ── CREATE FOLDERS ────────────────────────────
['services','routes','middleware','models'].forEach(d => {
  if (!fs.existsSync(d)) { fs.mkdirSync(d, { recursive: true }); console.log(`Created folder: ${d}`); }
});

// ── MOVE FILES INTO CORRECT FOLDERS ──────────
const moves = [
  // routes
  ['auth.js',           'routes/auth.js'],
  ['wallet.js',         'routes/wallet.js'],
  ['orders.js',         'routes/orders.js'],
  ['p2p.js',            'routes/p2p.js'],
  ['markets.js',        'routes/markets.js'],
  ['webhooks.js',       'routes/webhooks.js'],
  // services
  ['depositMonitor.js', 'services/depositMonitor.js'],
  ['custody.js',        'services/custody.js'],
  ['matchingEngine.js', 'services/matchingEngine.js'],
  ['priceEngine.js',    'services/priceEngine.js'],
  ['websocket.js',      'services/websocket.js'],
  ['email.js',          'services/email.js'],
  // models
  ['db.js',             'models/db.js'],
];

moves.forEach(([src, dest]) => {
  if (fs.existsSync(src) && !fs.existsSync(dest)) {
    fs.renameSync(src, dest);
    console.log(`Moved: ${src} → ${dest}`);
  } else if (fs.existsSync(dest)) {
    console.log(`Already in place: ${dest}`);
  } else {
    console.log(`Not found (skipping): ${src}`);
  }
});

// ── CREATE MISSING SERVICE FILES ─────────────

// services/logger.js
if (!fs.existsSync('services/logger.js')) {
  fs.writeFileSync('services/logger.js', `'use strict';
const winston = require('winston');
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: process.env.NODE_ENV === 'production'
    ? winston.format.combine(winston.format.timestamp(), winston.format.json())
    : winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'HH:mm:ss' }),
        winston.format.printf(({ level, message, timestamp }) => \`\${timestamp} \${level}: \${message}\`)
      ),
  transports: [new winston.transports.Console()],
});
module.exports = { logger };
`);
  console.log('Created: services/logger.js');
}

// services/redis.js — stub that won't crash if Redis isn't running
if (!fs.existsSync('services/redis.js')) {
  fs.writeFileSync('services/redis.js', `'use strict';
// Redis is optional for local dev — safely stubbed out here.
// Set REDIS_URL in .env and uncomment initRedis() in server.js when ready.
let redis = null;
async function initRedis() {
  const Redis = require('ioredis');
  redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    enableOfflineQueue: false,
  });
  redis.on('error', (e) => {});
  try { await redis.connect(); } catch(e) {}
}
async function checkRedis() {
  try { if (redis) { await redis.ping(); return true; } return false; }
  catch { return false; }
}
// Safe stub — returns null for all ops if Redis not connected
const handler = { get(_, prop) {
  return async (...args) => { try { return redis ? await redis[prop](...args) : null; } catch { return null; } };
}};
module.exports = { initRedis, checkRedis, redis: new Proxy({}, handler) };
`);
  console.log('Created: services/redis.js');
}

// services/notifications.js
if (!fs.existsSync('services/notifications.js')) {
  fs.writeFileSync('services/notifications.js', `'use strict';
const { logger } = require('./logger');
async function notifyUser(userId, type, title, data = {}) {
  logger.info(\`Notification → user:\${userId} [\${type}] \${title}\`);
}
module.exports = { notifyUser };
`);
  console.log('Created: services/notifications.js');
}

// services/audit.js
if (!fs.existsSync('services/audit.js')) {
  fs.writeFileSync('services/audit.js', `'use strict';
const { logger } = require('./logger');
async function auditLog(entry) {
  logger.info(\`Audit: \${JSON.stringify(entry)}\`);
}
module.exports = { auditLog };
`);
  console.log('Created: services/audit.js');
}

// middleware/auth.js — if not already moved
if (!fs.existsSync('middleware/auth.js')) {
  fs.writeFileSync('middleware/auth.js', `'use strict';
const jwt = require('jsonwebtoken');
function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer '))
    return res.status(401).json({ error: 'No token provided.' });
  try {
    req.user = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token.' });
  }
}
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
  next();
}
function requireKYC(level) {
  return (req, res, next) => {
    if ((req.user?.kycLevel || 0) < level)
      return res.status(403).json({ error: \`KYC Level \${level} required.\` });
    next();
  };
}
module.exports = { authenticate, requireAdmin, requireKYC };
`);
  console.log('Created: middleware/auth.js');
}

// models/migrate.js — keep in models folder
if (!fs.existsSync('models/migrate.js') && fs.existsSync('models/db.js')) {
  fs.writeFileSync('models/migrate.js', `'use strict';
require('dotenv').config();
const { migrate } = require('./db');
migrate()
  .then(() => { console.log('Migration complete'); process.exit(0); })
  .catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
`);
  console.log('Created: models/migrate.js');
}

console.log('\nDone. Now run: node server.js');
