/**
 * Price Engine
 * Polls CoinGecko's free public REST API (no key, no monthly credit cap —
 * just a per-minute rate limit) and:
 *   1. Broadcasts price updates to connected clients via our own WS
 *   2. Builds 1h OHLCV candles in-memory from the polled ticks and
 *      persists closed candles to the database
 *   3. Updates the Redis price cache
 *
 * NOTE: CoinGecko's free tier has no live trade-tape or WebSocket kline
 * stream, so:
 *   - There is no per-trade feed anymore (publishTrade is not called).
 *     Re-enable this once your own matching engine produces real trades.
 *   - Candles are built ourselves from periodic price snapshots rather
 *     than fetched pre-made, so they're an approximation, not a true
 *     tick-accurate OHLC. Good enough until you have your own feed.
 *
 * When your matching engine is live, replace this file's polling with
 * your own internal trade events from the order book.
 */
'use strict';
const { redis }  = require('./redis');
const { query }  = require('../models/db');
const { publishTicker, publishKline } = require('./websocket');
const { logger } = require('./logger');

// Binance-style symbol -> CoinGecko asset id
const SYMBOL_TO_GECKO_ID = {
  btcusdt:   'bitcoin',
  ethusdt:   'ethereum',
  bnbusdt:   'binancecoin',
  solusdt:   'solana',
  xrpusdt:   'ripple',
  adausdt:   'cardano',
  dogeusdt:  'dogecoin',
  maticusdt: 'matic-network',
  avaxusdt:  'avalanche-2',
  dotusdt:   'polkadot',
  linkusdt:  'chainlink',
  ltcusdt:   'litecoin',
};
const GECKO_IDS = Object.values(SYMBOL_TO_GECKO_ID);
const ID_TO_SYMBOL = Object.fromEntries(
  Object.entries(SYMBOL_TO_GECKO_ID).map(([sym, id]) => [id, sym.toUpperCase()])
);

const POLL_INTERVAL_MS = 10000; // 10s — 6 calls/min for one batched request, well under CoinGecko's free rate limit
const CANDLE_INTERVAL_MS = 60 * 60 * 1000; // 1h candles, built from ticks
const COINGECKO_URL = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${GECKO_IDS.join(',')}&price_change_percentage=24h`;

// In-memory candle-in-progress per symbol
const activeCandles = new Map(); // symbol -> { openTime, open, high, low, close, volume, trades }

let pollTimer = null;
let consecutiveErrors = 0;
const MAX_BACKOFF_MS = 60000;

function startPriceEngine() {
  poll();
  logger.info(`Price engine polling CoinGecko every ${POLL_INTERVAL_MS / 1000}s for: ${GECKO_IDS.join(', ')}`);
}

async function poll() {
  try {
    const res = await fetch(COINGECKO_URL);

    if (res.status === 429) {
      consecutiveErrors++;
      const delay = Math.min(POLL_INTERVAL_MS * 2 ** consecutiveErrors, MAX_BACKOFF_MS);
      logger.warn(`CoinGecko rate limited (429) — backing off ${Math.round(delay / 1000)}s`);
      pollTimer = setTimeout(poll, delay);
      return;
    }

    if (!res.ok) {
      throw new Error(`CoinGecko responded ${res.status}`);
    }

    const data = await res.json();
    consecutiveErrors = 0;

    for (const coin of data) {
      const sym = ID_TO_SYMBOL[coin.id];
      if (!sym) continue;

      const price = coin.current_price;
      const ch24  = coin.price_change_percentage_24h ?? 0;
      const vol   = coin.total_volume ?? 0;

      // Redis price cache
      await redis.hset('prices', sym, JSON.stringify({ price, ch24, vol, ts: Date.now() }));

      // Broadcast to connected clients
      publishTicker(sym, {
        price,
        ch24,
        high: coin.high_24h,
        low:  coin.low_24h,
        vol,
        volQuote: vol,
      });

      updateCandle(sym, price, vol);
    }
  } catch (err) {
    consecutiveErrors++;
    const delay = Math.min(POLL_INTERVAL_MS * 2 ** consecutiveErrors, MAX_BACKOFF_MS);
    logger.error('CoinGecko poll failed:', err.message, `— retrying in ${Math.round(delay / 1000)}s`);
    pollTimer = setTimeout(poll, delay);
    return;
  }

  pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
}

// ── IN-MEMORY CANDLE BUILDER ───────────────────
// Aggregates polled price ticks into 1h OHLCV candles since CoinGecko's
// free tier doesn't provide a live kline stream.
function updateCandle(sym, price, vol) {
  const now = Date.now();
  const bucketStart = Math.floor(now / CANDLE_INTERVAL_MS) * CANDLE_INTERVAL_MS;
  const existing = activeCandles.get(sym);

  if (!existing || existing.openTime !== bucketStart) {
    // Close and persist the previous candle, if any
    if (existing) {
      finalizeCandle(sym, existing);
    }
    activeCandles.set(sym, {
      openTime: bucketStart,
      open: price,
      high: price,
      low:  price,
      close: price,
      volume: vol,
      trades: 1,
    });
    // Publish the just-opened candle immediately so clients see it start
    publishKline(sym, '1h', candleToPayload(activeCandles.get(sym), false));
    return;
  }

  existing.high  = Math.max(existing.high, price);
  existing.low   = Math.min(existing.low, price);
  existing.close = price;
  existing.volume = vol; // CoinGecko's 24h volume is cumulative, not per-tick, so we just track the latest value
  existing.trades += 1;

  publishKline(sym, '1h', candleToPayload(existing, false));
}

function candleToPayload(c, closed) {
  return {
    time:   Math.floor(c.openTime / 1000),
    open:   c.open,
    high:   c.high,
    low:    c.low,
    close:  c.close,
    volume: c.volume,
    trades: c.trades,
    closed,
  };
}

async function finalizeCandle(sym, c) {
  publishKline(sym, '1h', candleToPayload(c, true));
  try {
    await query(`
      INSERT INTO ohlcv (symbol, interval, open_time, open, high, low, close, volume, trades)
      VALUES ($1,$2,to_timestamp($3),$4,$5,$6,$7,$8,$9)
      ON CONFLICT (symbol, interval, open_time) DO UPDATE
      SET open=$4, high=$5, low=$6, close=$7, volume=$8, trades=$9
    `, [sym, '1h', Math.floor(c.openTime / 1000), c.open, c.high, c.low, c.close, c.volume, c.trades]);
  } catch (err) {
    logger.error(`Failed to persist candle for ${sym}:`, err.message);
  }
}

module.exports = { startPriceEngine };
