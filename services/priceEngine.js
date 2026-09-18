/**
 * Price Engine
 * Subscribes to Binance WebSocket streams and:
 *   1. Broadcasts price updates to connected clients via our own WS
 *   2. Updates OHLCV in the database
 *   3. Updates the Redis price cache
 *
 * When your matching engine is live, replace Binance streams
 * with your own internal trade events from the order book.
 */
'use strict';
const WebSocket  = require('ws');
const { redis }  = require('./redis');
const { query }  = require('../models/db');
const { publishTicker, publishKline, publishTrade, publishOrderBook } = require('./websocket');
const { logger } = require('./logger');

const SYMBOLS = ['btcusdt','ethusdt','bnbusdt','solusdt','xrpusdt','adausdt','dogeusdt','maticusdt','avaxusdt','dotusdt','linkusdt','ltcusdt'];
const INTERVALS = ['1m','5m','15m','1h','4h','1d'];

// Track ONE live connection per stream key, not an ever-growing list.
// Fixes the memory leak: previously every reconnect pushed a new socket
// into wsConnections without ever removing the dead one, so the array
// (and every buffer/listener attached to each dead socket) grew forever.
const activeConnections = new Map(); // key -> { ws, retries }

const MAX_BACKOFF_MS = 60000;
const BASE_BACKOFF_MS = 3000;

function backoffDelay(retries) {
  const delay = Math.min(BASE_BACKOFF_MS * 2 ** retries, MAX_BACKOFF_MS);
  // add jitter so many streams don't all retry in lockstep
  return delay + Math.floor(Math.random() * 1000);
}

function startPriceEngine() {
  connectStream('miniTicker', buildMiniTickerUrl(), handleMiniTickerMessage);
  connectStream('trade', buildTradeUrl(), handleTradeMessage);
  connectStream('kline_1h', buildKlineUrl('1h'), (raw) => handleKlineMessage(raw, '1h'));
  logger.info('Price engine connecting to market data streams...');
}

function buildMiniTickerUrl() {
  const streams = SYMBOLS.map(s => `${s}@miniTicker`).join('/');
  return `wss://stream.binance.com:9443/stream?streams=${streams}`;
}
function buildTradeUrl() {
  const streams = SYMBOLS.map(s => `${s}@trade`).join('/');
  return `wss://stream.binance.com:9443/stream?streams=${streams}`;
}
function buildKlineUrl(interval) {
  const streams = SYMBOLS.map(s => `${s}@kline_${interval}`).join('/');
  return `wss://stream.binance.com:9443/stream?streams=${streams}`;
}

// ── GENERIC CONNECTION MANAGER ─────────────────
// One function handles connect + cleanup + backoff for every stream,
// so the leak/backoff fix only has to live in one place.
function connectStream(key, url, onMessage) {
  const ws = new WebSocket(url);
  const state = activeConnections.get(key) || { ws: null, retries: 0 };
  state.ws = ws;
  activeConnections.set(key, state);

  ws.on('message', onMessage);

  // Catches HTTP-level rejections (e.g. Binance returning 451 for a
  // blocked region/IP) BEFORE the WS handshake completes. Previously
  // these were invisible — they don't fire 'error' with a useful
  // message, so the real cause never showed up in logs.
  ws.on('unexpected-response', (req, res) => {
    logger.error(`${key} WS rejected by server: HTTP ${res.statusCode} ${res.statusMessage}`);
    ws.terminate();
  });

  ws.on('error', (e) => {
    logger.error(`${key} WS error:`, e && e.message ? e.message : e, e && e.code ? `(code: ${e.code})` : '');
  });

  ws.on('close', (code, reason) => {
    // Remove listeners explicitly so the dead socket has nothing
    // still referencing it and can be garbage collected.
    ws.removeAllListeners();

    const current = activeConnections.get(key);
    const retries = current ? current.retries + 1 : 1;
    const delay = backoffDelay(retries);

    logger.warn(`${key} stream closed (code ${code}${reason ? `, reason: ${reason}` : ''}) — reconnecting in ${Math.round(delay / 1000)}s (attempt ${retries})`);

    activeConnections.set(key, { ws: null, retries });
    setTimeout(() => connectStream(key, url, onMessage), delay);
  });
}

// ── MESSAGE HANDLERS ───────────────────────────
async function handleMiniTickerMessage(raw) {
  try {
    const { data: d } = JSON.parse(raw);
    if (!d || !d.s) return;

    const sym   = d.s;
    const price = parseFloat(d.c);
    const ch24  = parseFloat(d.P);
    const vol   = parseFloat(d.v);

    await redis.hset('prices', sym, JSON.stringify({ price, ch24, vol, ts: Date.now() }));

    publishTicker(sym, {
      price, ch24,
      high: parseFloat(d.h),
      low:  parseFloat(d.l),
      vol,
      volQuote: parseFloat(d.q),
    });
  } catch { /* ignore parse errors */ }
}

async function handleTradeMessage(raw) {
  try {
    const { data: t } = JSON.parse(raw);
    if (!t || !t.s) return;
    publishTrade(t.s, {
      price:   parseFloat(t.p),
      qty:     parseFloat(t.q),
      isBuyer: !t.m,
      time:    t.T,
      tradeId: t.t,
    });
  } catch { /* ignore */ }
}

async function handleKlineMessage(raw, interval) {
  try {
    const { data: msg } = JSON.parse(raw);
    if (!msg || !msg.k) return;
    const k = msg.k;
    const candle = {
      time:   Math.floor(k.t / 1000),
      open:   parseFloat(k.o),
      high:   parseFloat(k.h),
      low:    parseFloat(k.l),
      close:  parseFloat(k.c),
      volume: parseFloat(k.v),
      trades: k.n,
      closed: k.x,
    };

    publishKline(k.s, interval, candle);

    if (k.x) {
      await query(`
        INSERT INTO ohlcv (symbol, interval, open_time, open, high, low, close, volume, trades)
        VALUES ($1,$2,to_timestamp($3),$4,$5,$6,$7,$8,$9)
        ON CONFLICT (symbol, interval, open_time) DO UPDATE
        SET open=$4, high=$5, low=$6, close=$7, volume=$8, trades=$9
      `, [k.s, interval, Math.floor(k.t/1000), candle.open, candle.high, candle.low, candle.close, candle.volume, candle.trades]);
    }
  } catch { /* ignore */ }
}

module.exports = { startPriceEngine };
