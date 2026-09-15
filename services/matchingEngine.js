/**
 * Matching Engine
 * Processes orders from the Redis queue and matches buys with sells.
 *
 * Run as a separate process: node services/matchingEngine.js
 *
 * In production this should be a separate microservice, ideally
 * rewritten in Go or Rust for maximum throughput. This Node.js
 * version handles ~500-1000 orders/second which is fine for launch.
 *
 * Architecture:
 *   1. Pop order from Redis `order_queue`
 *   2. Try to match against resting orders in the book
 *   3. Create trade records for each fill
 *   4. Update order statuses and wallet balances
 *   5. Publish trade/order events via WebSocket
 *   6. Persist updated OHLCV candles
 */
'use strict';
require('dotenv').config();

const { initDB, query, getClient } = require('../models/db');
const { initRedis, redis }         = require('./redis');
const { initWS, publishTrade, publishOrderBook, publishKline, publishTicker } = require('./websocket');
const { notifyUser }               = require('./notifications');
const { sendEmail }                = require('./email');
const { logger }                   = require('./logger');

// ── IN-MEMORY ORDER BOOK ──────────────────────
// For a high-throughput exchange, keep the order book in memory
// and write fills to DB asynchronously.
// Structure: { BTCUSDT: { bids: Map<price, [{orderId,qty,...}]>, asks: Map<...> } }
const orderBooks = {};

function getBook(symbol) {
  if (!orderBooks[symbol]) {
    orderBooks[symbol] = {
      bids: new Map(), // price (desc) → [{orderId, userId, qty, remainingQty, time}]
      asks: new Map(), // price (asc)  → [{orderId, userId, qty, remainingQty, time}]
    };
  }
  return orderBooks[symbol];
}

function getBestBid(symbol) {
  const book = getBook(symbol);
  if (!book.bids.size) return null;
  return Math.max(...book.bids.keys());
}

function getBestAsk(symbol) {
  const book = getBook(symbol);
  if (!book.asks.size) return null;
  return Math.min(...book.asks.keys());
}

// ── LOAD OPEN ORDERS INTO MEMORY ON STARTUP ───
async function loadOpenOrders() {
  const result = await query(
    "SELECT id, user_id, symbol, side, type, price, quantity, remaining_qty FROM orders WHERE status IN ('open','partially_filled') AND type = 'limit'"
  );
  for (const order of result.rows) {
    addToBook(order);
  }
  logger.info(`Loaded ${result.rows.length} open orders into memory`);
}

function addToBook(order) {
  const book  = getBook(order.symbol);
  const side  = order.side === 'buy' ? 'bids' : 'asks';
  const px    = parseFloat(order.price);
  if (!book[side].has(px)) book[side].set(px, []);
  book[side].get(px).push({
    orderId:      order.id,
    userId:       order.user_id,
    qty:          parseFloat(order.quantity),
    remainingQty: parseFloat(order.remaining_qty || order.quantity),
    time:         order.created_at || Date.now(),
  });
}

function removeFromBook(symbol, side, price, orderId) {
  const book = getBook(symbol);
  const key  = side === 'buy' ? 'bids' : 'asks';
  const list = book[key].get(price);
  if (!list) return;
  const idx = list.findIndex(o => o.orderId === orderId);
  if (idx !== -1) list.splice(idx, 1);
  if (!list.length) book[key].delete(price);
}

// ── MAIN MATCHING LOOP ────────────────────────
async function processOrderQueue() {
  while (true) {
    try {
      // Blocking pop with 1s timeout
      const raw = await redis.blpop('order_queue', 1);
      if (!raw) continue;
      const job = JSON.parse(raw[1]);
      await processOrder(job);
    } catch (err) {
      logger.error('Matching engine error:', err.message);
      await sleep(100);
    }
  }
}

async function processOrder(job) {
  const { orderId, userId, symbol, side, type, price, quantity, timeInForce } = job;
  logger.debug(`Processing order ${orderId}: ${symbol} ${side} ${type} qty=${quantity} px=${price}`);

  if (type === 'market') {
    await matchMarketOrder(orderId, userId, symbol, side, quantity);
  } else if (type === 'limit') {
    await matchLimitOrder(orderId, userId, symbol, side, parseFloat(price), parseFloat(quantity), timeInForce);
  } else if (type === 'stop_limit') {
    // Stop orders sit in a separate queue; trigger when market reaches stop price
    await addStopOrder(job);
  }

  // Publish updated order book snapshot after processing
  publishOrderBookSnapshot(symbol);
}

// ── LIMIT ORDER MATCHING ───────────────────────
async function matchLimitOrder(orderId, userId, symbol, side, price, quantity, timeInForce) {
  const book         = getBook(symbol);
  let remainingQty   = quantity;
  const fills        = [];

  if (side === 'buy') {
    // Match against asks (lowest ask first)
    const askPrices = [...book.asks.keys()].sort((a, b) => a - b);
    for (const askPx of askPrices) {
      if (askPx > price) break;          // No more matchable asks
      if (remainingQty <= 0) break;
      remainingQty = await fillAgainstLevel(symbol, book.asks, askPx, orderId, userId, 'buy', remainingQty, fills);
    }
  } else {
    // Match against bids (highest bid first)
    const bidPrices = [...book.bids.keys()].sort((a, b) => b - a);
    for (const bidPx of bidPrices) {
      if (bidPx < price) break;
      if (remainingQty <= 0) break;
      remainingQty = await fillAgainstLevel(symbol, book.bids, bidPx, orderId, userId, 'sell', remainingQty, fills);
    }
  }

  // Persist fills to DB
  if (fills.length) {
    await persistFills(fills, symbol);
  }

  if (remainingQty > 0) {
    // Handle IOC/FOK — cancel remainder
    if (timeInForce === 'IOC' || timeInForce === 'FOK') {
      await cancelRemainder(orderId, userId, symbol, side, price, remainingQty);
      return;
    }
    // GTC — add remainder to order book
    addToBook({ id: orderId, user_id: userId, symbol, side, price, quantity, remaining_qty: remainingQty });
    await query("UPDATE orders SET status='open' WHERE id=$1", [orderId]);
  } else {
    await query("UPDATE orders SET status='filled', filled_at=NOW() WHERE id=$1", [orderId]);
  }
}

async function fillAgainstLevel(symbol, sideMap, px, takerOrderId, takerUserId, takerSide, remainingQty, fills) {
  const queue = sideMap.get(px);
  if (!queue) return remainingQty;

  while (queue.length && remainingQty > 0) {
    const maker = queue[0];
    const fillQty = Math.min(remainingQty, maker.remainingQty);
    fills.push({
      symbol,
      takerOrderId, takerUserId, takerSide,
      makerOrderId: maker.orderId,
      makerUserId:  maker.userId,
      price:        px,
      qty:          fillQty,
    });

    maker.remainingQty -= fillQty;
    remainingQty       -= fillQty;

    if (maker.remainingQty <= 1e-10) {
      queue.shift(); // Remove fully filled maker
    }
  }

  if (!queue.length) sideMap.delete(px);
  return remainingQty;
}

// ── MARKET ORDER MATCHING ─────────────────────
async function matchMarketOrder(orderId, userId, symbol, side, quantity) {
  const book = getBook(symbol);
  let remaining = quantity;
  const fills   = [];

  if (side === 'buy') {
    const askPrices = [...book.asks.keys()].sort((a, b) => a - b);
    for (const px of askPrices) {
      if (remaining <= 0) break;
      remaining = await fillAgainstLevel(symbol, book.asks, px, orderId, userId, 'buy', remaining, fills);
    }
  } else {
    const bidPrices = [...book.bids.keys()].sort((a, b) => b - a);
    for (const px of bidPrices) {
      if (remaining <= 0) break;
      remaining = await fillAgainstLevel(symbol, book.bids, px, orderId, userId, 'sell', remaining, fills);
    }
  }

  if (fills.length) await persistFills(fills, symbol);

  const status = remaining <= 0 ? 'filled' : remaining < quantity ? 'partially_filled' : 'cancelled';
  await query(`UPDATE orders SET status=$1, filled_at=${status==='filled'?'NOW()':'NULL'} WHERE id=$2`, [status, orderId]);
}

// ── PERSIST FILLS TO DATABASE ─────────────────
async function persistFills(fills, symbol) {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    for (const fill of fills) {
      const { takerOrderId, takerUserId, takerSide, makerOrderId, makerUserId, price, qty } = fill;
      const quoteQty   = price * qty;
      const [baseSym, quoteSym] = parseSymbol(symbol);

      // Get fee schedules
      const makerFee   = 0.001; // TODO: look up from fee_schedules based on vip_level
      const takerFee   = 0.001;
      const makerFeeAmt= qty * makerFee;
      const takerFeeAmt= qty * takerFee;

      const buyUserId  = takerSide === 'buy' ? takerUserId : makerUserId;
      const sellUserId = takerSide === 'sell'? takerUserId : makerUserId;
      const buyFee     = takerSide === 'buy' ? takerFeeAmt : makerFeeAmt;
      const sellFee    = takerSide === 'sell'? takerFeeAmt : makerFeeAmt;

      // Record trade
      await client.query(`
        INSERT INTO trades (symbol, buy_order_id, sell_order_id, buy_user_id, sell_user_id, price, quantity, quote_quantity, buyer_fee, seller_fee, fee_asset, is_buyer_maker)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      `, [symbol, takerSide==='buy'?takerOrderId:makerOrderId, takerSide==='sell'?takerOrderId:makerOrderId,
          buyUserId, sellUserId, price, qty, quoteQty, buyFee, sellFee, quoteSym, takerSide==='sell']);

      // Update taker order
      await client.query(`
        UPDATE orders SET
          filled_qty      = filled_qty + $1,
          remaining_qty   = GREATEST(0, remaining_qty - $1),
          avg_fill_price  = (cumulative_quote + $2) / (filled_qty + $1),
          cumulative_quote= cumulative_quote + $2,
          fee             = fee + $3,
          fee_asset       = $4,
          status          = CASE WHEN remaining_qty - $1 <= 0 THEN 'filled' ELSE 'partially_filled' END,
          filled_at       = CASE WHEN remaining_qty - $1 <= 0 THEN NOW() ELSE NULL END
        WHERE id = $5
      `, [qty, quoteQty, takerFeeAmt, quoteSym, takerOrderId]);

      // Update maker order
      await client.query(`
        UPDATE orders SET
          filled_qty      = filled_qty + $1,
          remaining_qty   = GREATEST(0, remaining_qty - $1),
          avg_fill_price  = (cumulative_quote + $2) / (filled_qty + $1),
          cumulative_quote= cumulative_quote + $2,
          fee             = fee + $3,
          status          = CASE WHEN remaining_qty - $1 <= 0 THEN 'filled' ELSE 'partially_filled' END,
          filled_at       = CASE WHEN remaining_qty - $1 <= 0 THEN NOW() ELSE NULL END
        WHERE id = $4
      `, [qty, quoteQty, makerFeeAmt, makerOrderId]);

      // Update wallets — buyer gets base, seller gets quote (minus fees)
      // Buyer: receives baseSym, quote was already locked
      await client.query(`
        INSERT INTO wallets (user_id, symbol, total_balance, locked_balance)
        VALUES ($1,$2,$3,0)
        ON CONFLICT (user_id, symbol) DO UPDATE SET total_balance = wallets.total_balance + $3
      `, [buyUserId, baseSym, qty - buyFee]);

      // Buyer: release locked quote
      await client.query(`
        UPDATE wallets SET
          total_balance  = total_balance  - $1,
          locked_balance = GREATEST(0, locked_balance - $1)
        WHERE user_id=$2 AND symbol=$3
      `, [quoteQty, buyUserId, quoteSym]);

      // Seller: receives quote
      await client.query(`
        INSERT INTO wallets (user_id, symbol, total_balance, locked_balance)
        VALUES ($1,$2,$3,0)
        ON CONFLICT (user_id, symbol) DO UPDATE SET total_balance = wallets.total_balance + $3
      `, [sellUserId, quoteSym, quoteQty - sellFee * price]);

      // Seller: release locked base
      await client.query(`
        UPDATE wallets SET
          total_balance  = total_balance  - $1,
          locked_balance = GREATEST(0, locked_balance - $1)
        WHERE user_id=$2 AND symbol=$3
      `, [qty, sellUserId, baseSym]);

      // Update OHLCV (1m candle)
      const now = new Date();
      const openTime = new Date(Math.floor(now.getTime() / 60000) * 60000);
      await client.query(`
        INSERT INTO ohlcv (symbol, interval, open_time, open, high, low, close, volume, trades)
        VALUES ($1,'1m',$2,$3,$3,$3,$3,$4,1)
        ON CONFLICT (symbol, interval, open_time) DO UPDATE SET
          high   = GREATEST(ohlcv.high, $3),
          low    = LEAST(ohlcv.low, $3),
          close  = $3,
          volume = ohlcv.volume + $4,
          trades = ohlcv.trades + 1
      `, [symbol, openTime, price, qty]);

      // Publish trade to WS
      publishTrade(symbol, { price, qty, quoteQty, isBuyer: true, time: Date.now() });

      // Push fill notifications to both users
      await notifyUser(buyUserId,  'order', `Buy order filled: ${qty} ${baseSym} @ $${price}`);
      await notifyUser(sellUserId, 'order', `Sell order filled: ${qty} ${baseSym} @ $${price}`);

      // Pay referral commission
      await payReferralCommission(client, buyUserId,  takerSide==='buy'?takerOrderId:makerOrderId, symbol, quoteSym, takerSide==='buy'?takerFeeAmt:makerFeeAmt);
      await payReferralCommission(client, sellUserId, takerSide==='sell'?takerOrderId:makerOrderId, symbol, quoteSym, takerSide==='sell'?takerFeeAmt:makerFeeAmt);
    }

    await client.query('COMMIT');
    logger.debug(`Persisted ${fills.length} fill(s) for ${symbol}`);
  } catch (err) {
    await client.query('ROLLBACK').catch(()=>{});
    logger.error('persistFills error:', err.message);
  } finally {
    client.release();
  }
}

// ── REFERRAL COMMISSION ───────────────────────
async function payReferralCommission(client, userId, orderId, symbol, feeAsset, feeAmount) {
  const refRes = await client.query('SELECT referred_by FROM users WHERE id=$1', [userId]);
  const referrerId = refRes.rows[0]?.referred_by;
  if (!referrerId) return;

  const commission = feeAmount * 0.20; // 20% of trading fee
  if (commission <= 0) return;

  await client.query(`
    INSERT INTO referral_earnings (referrer_id, referee_id, fee_asset, commission_amt, paid_at)
    VALUES ($1,$2,$3,$4,NOW())
  `, [referrerId, userId, feeAsset, commission]);

  // Credit commission to referrer's wallet
  await client.query(`
    INSERT INTO wallets (user_id, symbol, total_balance, locked_balance)
    VALUES ($1,$2,$3,0)
    ON CONFLICT (user_id, symbol) DO UPDATE SET total_balance = wallets.total_balance + $3
  `, [referrerId, feeAsset, commission]);
}

// ── CANCEL ORDER REMAINDER ────────────────────
async function cancelRemainder(orderId, userId, symbol, side, price, remainingQty) {
  removeFromBook(symbol, side, price, orderId);
  const lockAsset = side === 'buy' ? parseSymbol(symbol)[1] : parseSymbol(symbol)[0];
  const unlockAmt = side === 'buy' ? price * remainingQty : remainingQty;
  await query('UPDATE wallets SET locked_balance = GREATEST(0, locked_balance - $1) WHERE user_id=$2 AND symbol=$3', [unlockAmt, userId, lockAsset]);
  await query("UPDATE orders SET status='cancelled', cancelled_at=NOW() WHERE id=$1", [orderId]);
}

// ── CANCEL ORDER FROM BOOK (external cancel) ──
async function processCancelQueue() {
  while (true) {
    try {
      const raw = await redis.blpop('cancel_queue', 1);
      if (!raw) continue;
      const { orderId } = JSON.parse(raw[1]);
      // Remove from in-memory book
      for (const [symbol, book] of Object.entries(orderBooks)) {
        for (const [px, list] of book.bids) {
          const idx = list.findIndex(o => o.orderId === orderId);
          if (idx !== -1) { list.splice(idx,1); if (!list.length) book.bids.delete(px); break; }
        }
        for (const [px, list] of book.asks) {
          const idx = list.findIndex(o => o.orderId === orderId);
          if (idx !== -1) { list.splice(idx,1); if (!list.length) book.asks.delete(px); break; }
        }
      }
    } catch (err) {
      logger.error('Cancel queue error:', err.message);
      await sleep(100);
    }
  }
}

// ── PUBLISH ORDER BOOK SNAPSHOT ───────────────
function publishOrderBookSnapshot(symbol) {
  const book = getBook(symbol);
  const asks = [...book.asks.entries()]
    .sort((a,b) => a[0]-b[0])
    .slice(0,20)
    .map(([px, list]) => [px.toFixed(8), list.reduce((s,o) => s+o.remainingQty, 0).toFixed(8)]);
  const bids = [...book.bids.entries()]
    .sort((a,b) => b[0]-a[0])
    .slice(0,20)
    .map(([px, list]) => [px.toFixed(8), list.reduce((s,o) => s+o.remainingQty, 0).toFixed(8)]);
  publishOrderBook(symbol, asks, bids);
}

// ── STOP ORDER HANDLER ────────────────────────
// Stores stop orders in Redis; triggers when market price crosses stop price
async function addStopOrder(job) {
  await redis.zadd(`stop_orders:${job.symbol}:${job.side}`, job.stopPrice, JSON.stringify(job));
  logger.debug(`Stop order added: ${job.orderId} trigger=${job.stopPrice}`);
}

async function checkStopOrders(symbol, currentPrice) {
  // Check buy stops (trigger when price >= stopPrice)
  const buyStops = await redis.zrangebyscore(`stop_orders:${symbol}:buy`, '-inf', currentPrice);
  for (const raw of buyStops) {
    const job = JSON.parse(raw);
    await redis.zrem(`stop_orders:${symbol}:buy`, raw);
    await matchLimitOrder(job.orderId, job.userId, symbol, 'buy', job.price, job.quantity, job.timeInForce || 'GTC');
  }
  // Check sell stops (trigger when price <= stopPrice)
  const sellStops = await redis.zrangebyscore(`stop_orders:${symbol}:sell`, currentPrice, '+inf');
  for (const raw of sellStops) {
    const job = JSON.parse(raw);
    await redis.zrem(`stop_orders:${symbol}:sell`, raw);
    await matchLimitOrder(job.orderId, job.userId, symbol, 'sell', job.price, job.quantity, job.timeInForce || 'GTC');
  }
}

// ── HELPERS ───────────────────────────────────
function parseSymbol(symbol) {
  // BTCUSDT → ['BTC', 'USDT']
  if (symbol.endsWith('USDT')) return [symbol.slice(0,-4), 'USDT'];
  if (symbol.endsWith('BTC'))  return [symbol.slice(0,-3), 'BTC'];
  if (symbol.endsWith('ETH'))  return [symbol.slice(0,-3), 'ETH'];
  return [symbol.slice(0,-4), symbol.slice(-4)];
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── START ─────────────────────────────────────
async function start() {
  await initDB();
  await initRedis();

  // We don't need the full WS server here — just the publish functions
  // The WS server runs in the main process (server.js)
  // For the matching engine as a separate process, use Redis Pub/Sub to forward events

  await loadOpenOrders();
  logger.info('🔄 Matching engine started — processing order queue');

  // Run both queues concurrently
  await Promise.all([
    processOrderQueue(),
    processCancelQueue(),
  ]);
}

// If run directly as a standalone process
if (require.main === module) {
  start().catch((err) => {
    logger.error('Matching engine fatal error:', err.message);
    process.exit(1);
  });
}

module.exports = { processOrder, getBook, getBestBid, getBestAsk };
