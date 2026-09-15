'use strict';
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
