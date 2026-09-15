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

let wsConnections = [];

function startPriceEngine() {
  connectMiniTicker();
  connectTradeStreams();
  connectKlineStreams('1h'); // default interval; expand as needed
  logger.info('Price engine connecting to market data streams...');
}

// ── MINI TICKER — all symbols price feed ──────
function connectMiniTicker() {
  const streams = SYMBOLS.map(s => `${s}@miniTicker`).join('/');
  const ws = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);

  ws.on('message', async (raw) => {
    try {
      const { data: d } = JSON.parse(raw);
      if (!d || !d.s) return;

      const sym   = d.s;
      const price = parseFloat(d.c);
      const ch24  = parseFloat(d.P);
      const vol   = parseFloat(d.v);

      // Update Redis price cache
      await redis.hset('prices', sym, JSON.stringify({ price, ch24, vol, ts: Date.now() }));

      // Publish to connected WS clients
      publishTicker(sym, {
        price, ch24,
        high: parseFloat(d.h),
        low:  parseFloat(d.l),
        vol,
        volQuote: parseFloat(d.q),
      });
    } catch { /* ignore parse errors */ }
  });

  ws.on('close', () => {
    logger.warn('Mini ticker stream closed — reconnecting in 3s');
    setTimeout(connectMiniTicker, 3000);
  });
  ws.on('error', (e) => logger.error('Mini ticker WS error:', e.message));
  wsConnections.push(ws);
}

// ── TRADE STREAMS — recent trades per symbol ──
function connectTradeStreams() {
  const streams = SYMBOLS.map(s => `${s}@trade`).join('/');
  const ws = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);

  ws.on('message', async (raw) => {
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
  });

  ws.on('close', () => { setTimeout(connectTradeStreams, 3000); });
  ws.on('error', (e) => logger.error('Trade stream WS error:', e.message));
  wsConnections.push(ws);
}

// ── KLINE STREAMS — candlestick data ──────────
function connectKlineStreams(interval) {
  const streams = SYMBOLS.map(s => `${s}@kline_${interval}`).join('/');
  const ws = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);

  ws.on('message', async (raw) => {
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
        closed: k.x, // true when candle is closed/final
      };

      publishKline(k.s, interval, candle);

      // Persist closed candles to DB
      if (k.x) {
        await query(`
          INSERT INTO ohlcv (symbol, interval, open_time, open, high, low, close, volume, trades)
          VALUES ($1,$2,to_timestamp($3),$4,$5,$6,$7,$8,$9)
          ON CONFLICT (symbol, interval, open_time) DO UPDATE
          SET open=$4, high=$5, low=$6, close=$7, volume=$8, trades=$9
        `, [k.s, interval, Math.floor(k.t/1000), candle.open, candle.high, candle.low, candle.close, candle.volume, candle.trades]);
      }
    } catch { /* ignore */ }
  });

  ws.on('close', () => { setTimeout(() => connectKlineStreams(interval), 3000); });
  ws.on('error', (e) => logger.error('Kline WS error:', e.message));
  wsConnections.push(ws);
}

module.exports = { startPriceEngine };
