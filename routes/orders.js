/**
 * Orders Routes
 * POST   /api/orders          — Place order
 * GET    /api/orders          — Get open orders
 * GET    /api/orders/history  — Order history
 * GET    /api/orders/:id      — Single order
 * DELETE /api/orders/:id      — Cancel order
 * DELETE /api/orders          — Cancel all open orders
 */
'use strict';
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { query, getClient } = require('../models/db');
const { redis }  = require('../services/redis');
const { authenticate, requireKYC } = require('../middleware/auth');
const { notifyUser } = require('../services/notifications');
const { auditLog }   = require('../services/audit');
const { publishToWS } = require('../services/websocket');
const { logger }     = require('../services/logger');

router.use(authenticate);

const VALID_SYMBOLS    = ['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','ADAUSDT','DOGEUSDT','MATICUSDT','AVAXUSDT','DOTUSDT','LINKUSDT','LTCUSDT'];
const VALID_SIDES      = ['buy','sell'];
const VALID_ORDER_TYPES= ['limit','market','stop_limit'];
const VALID_TIF        = ['GTC','IOC','FOK'];

// ── PLACE ORDER ───────────────────────────────
router.post('/', requireKYC(1), async (req, res, next) => {
  const client = await getClient();
  try {
    const {
      symbol, side, type, price, stopPrice, quantity,
      timeInForce = 'GTC', clientOrderId,
    } = req.body;

    // Validate inputs
    if (!symbol || !VALID_SYMBOLS.includes(symbol.toUpperCase())) {
      return res.status(400).json({ error: 'Invalid trading pair.' });
    }
    if (!side || !VALID_SIDES.includes(side.toLowerCase())) {
      return res.status(400).json({ error: 'side must be "buy" or "sell".' });
    }
    if (!type || !VALID_ORDER_TYPES.includes(type.toLowerCase())) {
      return res.status(400).json({ error: `type must be one of: ${VALID_ORDER_TYPES.join(', ')}` });
    }
    if (!quantity || parseFloat(quantity) <= 0) {
      return res.status(400).json({ error: 'Invalid quantity.' });
    }
    if ((type === 'limit' || type === 'stop_limit') && (!price || parseFloat(price) <= 0)) {
      return res.status(400).json({ error: 'price is required for limit/stop orders.' });
    }
    if (!VALID_TIF.includes(timeInForce)) {
      return res.status(400).json({ error: `timeInForce must be one of: ${VALID_TIF.join(', ')}` });
    }

    const sym  = symbol.toUpperCase();
    const s    = side.toLowerCase();
    const t    = type.toLowerCase();
    const qty  = parseFloat(quantity);
    const px   = price ? parseFloat(price) : null;
    const spx  = stopPrice ? parseFloat(stopPrice) : null;

    // Get market pair config
    const pairRes = await query('SELECT * FROM market_pairs WHERE symbol = $1 AND status = $2', [sym, 'active']);
    if (!pairRes.rows.length) return res.status(400).json({ error: 'Market pair not available.' });
    const pair = pairRes.rows[0];

    if (qty < parseFloat(pair.min_qty)) return res.status(400).json({ error: `Min quantity is ${pair.min_qty} ${pair.base_asset}.` });
    if (pair.max_qty && qty > parseFloat(pair.max_qty)) return res.status(400).json({ error: `Max quantity is ${pair.max_qty} ${pair.base_asset}.` });
    if (px && px < parseFloat(pair.min_price)) return res.status(400).json({ error: `Price too low.` });

    // Determine required asset & amount to lock
    const lockAsset = s === 'buy' ? pair.quote_asset : pair.base_asset;
    const lockAmt   = s === 'buy' ? (px || 0) * qty : qty; // for market orders lock full qty on sell side

    // Check balance
    await client.query('BEGIN');
    const walletRes = await client.query(
      'SELECT total_balance, locked_balance FROM wallets WHERE user_id = $1 AND symbol = $2 FOR UPDATE',
      [req.user.id, lockAsset]
    );
    const wallet = walletRes.rows[0];
    if (!wallet) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `No ${lockAsset} wallet found. Please deposit first.` });
    }
    const available = parseFloat(wallet.total_balance) - parseFloat(wallet.locked_balance);
    if (t !== 'market' && available < lockAmt) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Insufficient ${lockAsset} balance.`,
        available: available.toFixed(8),
        required:  lockAmt.toFixed(8),
      });
    }

    // Lock balance for limit/stop orders
    if (t !== 'market') {
      await client.query(
        'UPDATE wallets SET locked_balance = locked_balance + $1 WHERE user_id = $2 AND symbol = $3',
        [lockAmt, req.user.id, lockAsset]
      );
    }

    // Insert order
    const orderRes = await client.query(`
      INSERT INTO orders (
        user_id, client_order_id, symbol, side, type, price, stop_price,
        quantity, remaining_qty, time_in_force, ip_address, source
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11)
      RETURNING *
    `, [
      req.user.id, clientOrderId || null, sym, s, t, px, spx,
      qty, timeInForce, req.ip,
      req.isApiKeyAuth ? 'api' : (req.headers['x-mobile'] ? 'mobile' : 'web'),
    ]);

    await client.query('COMMIT');
    const order = orderRes.rows[0];

    // Push to matching engine via Redis queue
    await redis.rpush('order_queue', JSON.stringify({
      orderId:    order.id,
      userId:     req.user.id,
      symbol:     sym,
      side:       s,
      type:       t,
      price:      px,
      stopPrice:  spx,
      quantity:   qty,
      timeInForce,
    }));

    // Broadcast new order to user's WS feed
    await publishToWS(`user:${req.user.id}`, { type: 'order_placed', order: formatOrder(order) });

    logger.info(`Order placed: ${order.id} ${sym} ${s} ${t} qty=${qty} price=${px}`);
    res.status(201).json({ order: formatOrder(order) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ── GET OPEN ORDERS ───────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { symbol } = req.query;
    const conditions = ["user_id = $1", "status IN ('open','partially_filled')"];
    const params     = [req.user.id];
    if (symbol) { conditions.push(`symbol = $2`); params.push(symbol.toUpperCase()); }
    const result = await query(
      `SELECT * FROM orders WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`,
      params
    );
    res.json({ orders: result.rows.map(formatOrder) });
  } catch (err) { next(err); }
});

// ── ORDER HISTORY ─────────────────────────────
router.get('/history', async (req, res, next) => {
  try {
    const { symbol, side, status, limit = 50, offset = 0 } = req.query;
    const conditions = ['user_id = $1'];
    const params     = [req.user.id];
    let i = 2;
    if (symbol) { conditions.push(`symbol = $${i++}`); params.push(symbol.toUpperCase()); }
    if (side)   { conditions.push(`side = $${i++}`);   params.push(side); }
    if (status) { conditions.push(`status = $${i++}`); params.push(status); }
    else        { conditions.push(`status NOT IN ('open','partially_filled')`); }
    params.push(parseInt(limit), parseInt(offset));
    const result = await query(
      `SELECT * FROM orders WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT $${i} OFFSET $${i+1}`,
      params
    );
    const total = await query(`SELECT COUNT(*) FROM orders WHERE ${conditions.slice(0,-0).join(' AND ')}`, params.slice(0,-2));
    res.json({ orders: result.rows.map(formatOrder), total: parseInt(total.rows[0].count) });
  } catch (err) { next(err); }
});

// ── GET SINGLE ORDER ──────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const result = await query('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Order not found.' });
    res.json({ order: formatOrder(result.rows[0]) });
  } catch (err) { next(err); }
});

// ── CANCEL ORDER ──────────────────────────────
router.delete('/:id', async (req, res, next) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT * FROM orders WHERE id = $1 AND user_id = $2 AND status IN ('open','partially_filled') FOR UPDATE`,
      [req.params.id, req.user.id]
    );
    if (!result.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found or cannot be cancelled.' });
    }
    const order = result.rows[0];

    // Cancel in matching engine via Redis
    await redis.rpush('cancel_queue', JSON.stringify({ orderId: order.id }));

    // Update order status
    await client.query(
      `UPDATE orders SET status = 'cancelled', cancelled_at = NOW() WHERE id = $1`,
      [order.id]
    );

    // Unlock balance
    const sym    = order.symbol;
    const pair   = sym.replace('USDT','');
    const lockAsset = order.side === 'buy' ? 'USDT' : pair;
    const remaining = parseFloat(order.remaining_qty || order.quantity);
    const unlockAmt = order.side === 'buy' ? (parseFloat(order.price) * remaining) : remaining;

    await client.query(
      'UPDATE wallets SET locked_balance = GREATEST(0, locked_balance - $1) WHERE user_id = $2 AND symbol = $3',
      [unlockAmt, req.user.id, lockAsset]
    );

    await client.query('COMMIT');

    await publishToWS(`user:${req.user.id}`, { type: 'order_cancelled', orderId: order.id });
    await notifyUser(req.user.id, 'order', `Order ${order.id.slice(-6)} cancelled`);

    res.json({ message: 'Order cancelled.', orderId: order.id });
  } catch (err) {
    await client.query('ROLLBACK').catch(()=>{});
    next(err);
  } finally { client.release(); }
});

// ── CANCEL ALL OPEN ORDERS ────────────────────
router.delete('/', async (req, res, next) => {
  try {
    const { symbol } = req.query;
    const conditions = ["user_id = $1", "status IN ('open','partially_filled')"];
    const params     = [req.user.id];
    if (symbol) { conditions.push('symbol = $2'); params.push(symbol.toUpperCase()); }

    const result = await query(
      `UPDATE orders SET status = 'cancelled', cancelled_at = NOW() WHERE ${conditions.join(' AND ')} RETURNING id, symbol, side, price, remaining_qty`,
      params
    );

    // Unlock all locked balances
    for (const o of result.rows) {
      const pair      = o.symbol.replace('USDT','');
      const lockAsset = o.side === 'buy' ? 'USDT' : pair;
      const remaining = parseFloat(o.remaining_qty || 0);
      const unlockAmt = o.side === 'buy' ? (parseFloat(o.price) * remaining) : remaining;
      if (unlockAmt > 0) {
        await query('UPDATE wallets SET locked_balance = GREATEST(0, locked_balance - $1) WHERE user_id = $2 AND symbol = $3',
          [unlockAmt, req.user.id, lockAsset]);
      }
      await redis.rpush('cancel_queue', JSON.stringify({ orderId: o.id }));
    }

    res.json({ message: `${result.rows.length} order(s) cancelled.`, count: result.rows.length });
  } catch (err) { next(err); }
});

function formatOrder(o) {
  return {
    id:            o.id,
    clientOrderId: o.client_order_id,
    symbol:        o.symbol,
    side:          o.side,
    type:          o.type,
    status:        o.status,
    price:         o.price ? parseFloat(o.price) : null,
    stopPrice:     o.stop_price ? parseFloat(o.stop_price) : null,
    quantity:      parseFloat(o.quantity),
    filledQty:     parseFloat(o.filled_qty || 0),
    remainingQty:  parseFloat(o.remaining_qty || o.quantity),
    avgFillPrice:  o.avg_fill_price ? parseFloat(o.avg_fill_price) : null,
    fee:           parseFloat(o.fee || 0),
    feeAsset:      o.fee_asset,
    timeInForce:   o.time_in_force,
    source:        o.source,
    createdAt:     o.created_at,
    updatedAt:     o.updated_at,
    filledAt:      o.filled_at,
    cancelledAt:   o.cancelled_at,
  };
}

module.exports = router;
