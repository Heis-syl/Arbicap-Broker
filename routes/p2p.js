/**
 * P2P Routes
 * P2P is BROWSABLE but not executable until P2P_LIVE=true in .env
 * GET requests (browsing ads, viewing orders) work normally.
 * POST/action requests silently return a coming-soon response.
 */
'use strict';
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { query, getClient } = require('../models/db');
const { authenticate, requireKYC } = require('../middleware/auth');

// ── P2P ACTION GATE ───────────────────────────
// Applied to all write/action routes only.
// Returns a clean response that looks like a soft error, not a broken feature.
function p2pGate(req, res, next) {
  const live = process.env.P2P_LIVE === 'true';
  if (!live) {
    return res.status(503).json({
      error: 'P2P trading is not available at this time.',
      message: 'We are finalising our P2P marketplace. Please check back soon.',
      status: 'coming_soon',
    });
  }
  next();
}
const { notifyUser }  = require('../services/notifications');
const { sendEmail }   = require('../services/email');
const { publishToWS } = require('../services/websocket');
const { auditLog }    = require('../services/audit');
const { logger }      = require('../services/logger');

router.use(authenticate);

// ── LIST ADS ──────────────────────────────────
router.get('/ads', async (req, res, next) => {
  try {
    const { type, symbol, fiat, payment, limit = 20, offset = 0 } = req.query;
    const conditions = ["a.status = 'active'", "a.remaining_amount > 0", "a.user_id != $1"];
    const params     = [req.user.id];
    let i = 2;
    if (type)    { conditions.push(`a.type = $${i++}`);          params.push(type); }
    if (symbol)  { conditions.push(`a.symbol = $${i++}`);        params.push(symbol.toUpperCase()); }
    if (fiat)    { conditions.push(`a.fiat_currency = $${i++}`); params.push(fiat.toUpperCase()); }
    if (payment) { conditions.push(`$${i++} = ANY(a.payment_methods)`); params.push(payment); }
    params.push(parseInt(limit), parseInt(offset));

    const result = await query(`
      SELECT a.id, a.type, a.symbol, a.fiat_currency, a.price, a.min_limit, a.max_limit,
             a.remaining_amount, a.payment_methods, a.trade_terms, a.window_minutes,
             a.trade_count, a.completion_rate,
             u.first_name || ' ' || LEFT(u.last_name,1) || '.' as trader_name,
             u.kyc_level,
             (SELECT COUNT(*) FROM p2p_orders po WHERE po.seller_id = u.id AND po.status = 'completed') as completed_trades
      FROM p2p_ads a
      JOIN users u ON u.id = a.user_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY a.type = 'sell' DESC, a.price ASC
      LIMIT $${i} OFFSET $${i+1}
    `, params);

    const total = await query(`SELECT COUNT(*) FROM p2p_ads a WHERE ${conditions.slice(0,-0).join(' AND ')}`, params.slice(0,-2));
    res.json({ ads: result.rows, total: parseInt(total.rows[0].count) });
  } catch (err) { next(err); }
});

// ── CREATE AD ─────────────────────────────────
router.post('/ads', p2pGate, requireKYC(2), async (req, res, next) => {
  try {
    const { type, symbol, fiatCurrency, price, minLimit, maxLimit, totalAmount, paymentMethods, tradeTerms, autoReply, windowMinutes } = req.body;
    if (!type || !symbol || !fiatCurrency || !price || !minLimit || !maxLimit || !totalAmount || !paymentMethods?.length) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }
    if (parseFloat(minLimit) >= parseFloat(maxLimit)) {
      return res.status(400).json({ error: 'minLimit must be less than maxLimit.' });
    }

    // For sell ads: lock the crypto in the ad escrow
    if (type === 'sell') {
      const walletRes = await query('SELECT total_balance, locked_balance FROM wallets WHERE user_id=$1 AND symbol=$2', [req.user.id, symbol.toUpperCase()]);
      const wallet = walletRes.rows[0];
      const available = wallet ? (parseFloat(wallet.total_balance) - parseFloat(wallet.locked_balance)) : 0;
      if (available < parseFloat(totalAmount)) {
        return res.status(400).json({ error: `Insufficient ${symbol} balance to fund this ad.` });
      }
      await query('UPDATE wallets SET locked_balance = locked_balance + $1 WHERE user_id = $2 AND symbol = $3', [totalAmount, req.user.id, symbol.toUpperCase()]);
    }

    const result = await query(`
      INSERT INTO p2p_ads (user_id, type, symbol, fiat_currency, price, min_limit, max_limit, total_amount, remaining_amount, payment_methods, trade_terms, auto_reply, window_minutes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11,$12)
      RETURNING *
    `, [req.user.id, type, symbol.toUpperCase(), fiatCurrency.toUpperCase(), price, minLimit, maxLimit, totalAmount, paymentMethods, tradeTerms || null, autoReply || null, windowMinutes || 15]);

    res.status(201).json({ ad: result.rows[0] });
  } catch (err) { next(err); }
});

// ── PLACE P2P ORDER ───────────────────────────
router.post('/orders', p2pGate, requireKYC(1), async (req, res, next) => {
  const client = await getClient();
  try {
    const { adId, cryptoAmount, paymentMethod } = req.body;
    if (!adId || !cryptoAmount) return res.status(400).json({ error: 'adId and cryptoAmount required.' });

    await client.query('BEGIN');
    const adRes = await client.query('SELECT * FROM p2p_ads WHERE id=$1 AND status=$2 FOR UPDATE', [adId, 'active']);
    if (!adRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Ad not found or no longer active.' });
    }
    const ad = adRes.rows[0];
    if (ad.user_id === req.user.id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'You cannot trade with your own ad.' });
    }

    const qty      = parseFloat(cryptoAmount);
    const fiatAmt  = qty * parseFloat(ad.price);

    if (fiatAmt < parseFloat(ad.min_limit) || fiatAmt > parseFloat(ad.max_limit)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Amount must be between ${ad.min_limit} and ${ad.max_limit} ${ad.fiat_currency}.` });
    }
    if (qty > parseFloat(ad.remaining_amount)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient crypto available in this ad.' });
    }

    const buyerId  = ad.type === 'sell' ? req.user.id : ad.user_id;
    const sellerId = ad.type === 'sell' ? ad.user_id   : req.user.id;
    const expiresAt = new Date(Date.now() + ad.window_minutes * 60 * 1000);

    const orderRes = await client.query(`
      INSERT INTO p2p_orders (ad_id, buyer_id, seller_id, symbol, fiat_currency, crypto_amount, fiat_amount, price, payment_method, escrow_amount, expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *
    `, [adId, buyerId, sellerId, ad.symbol, ad.fiat_currency, qty, fiatAmt, ad.price, paymentMethod || ad.payment_methods[0], qty, expiresAt]);

    const order = orderRes.rows[0];

    // Deduct from ad remaining amount
    await client.query('UPDATE p2p_ads SET remaining_amount = remaining_amount - $1 WHERE id=$2', [qty, adId]);

    // Lock seller's crypto in escrow
    await client.query('UPDATE wallets SET locked_balance = locked_balance + $1 WHERE user_id=$2 AND symbol=$3', [qty, sellerId, ad.symbol]);

    await client.query('COMMIT');

    // Auto-reply message if set
    if (ad.auto_reply) {
      await query('INSERT INTO p2p_messages (order_id, sender_id, message) VALUES ($1,$2,$3)', [order.id, sellerId, ad.auto_reply]);
    }

    await notifyUser(sellerId, 'p2p', `New P2P order for ${qty} ${ad.symbol}`, { link: `/p2p-order.html?id=${order.id}` });
    await notifyUser(buyerId,  'p2p', `P2P order placed for ${qty} ${ad.symbol}`, { link: `/p2p-order.html?id=${order.id}` });

    const userRes = await query('SELECT email, first_name FROM users WHERE id = ANY($1)', [[buyerId, sellerId]]);
    for (const u of userRes.rows) {
      await sendEmail({ to: u.email, subject: `P2P Order Started — ${qty} ${ad.symbol}`, template: 'p2p-order-placed',
        data: { name: u.first_name, type: u.id === buyerId ? 'buy' : 'sell', amount: qty, symbol: ad.symbol, price: ad.price, orderId: order.id } });
    }

    res.status(201).json({ order });
  } catch (err) {
    await client.query('ROLLBACK').catch(()=>{});
    next(err);
  } finally { client.release(); }
});

// ── MARK AS PAID ──────────────────────────────
router.post('/orders/:id/pay', p2pGate, async (req, res, next) => {
  try {
    const result = await query("SELECT * FROM p2p_orders WHERE id=$1 AND buyer_id=$2 AND status='pending'", [req.params.id, req.user.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Order not found or cannot be marked as paid.' });
    await query("UPDATE p2p_orders SET status='paid', paid_at=NOW() WHERE id=$1", [req.params.id]);
    await notifyUser(result.rows[0].seller_id, 'p2p', 'Buyer has marked payment as sent', { link: `/p2p-order.html?id=${req.params.id}` });
    res.json({ message: 'Order marked as paid. Waiting for seller to confirm.' });
  } catch (err) { next(err); }
});

// ── RELEASE CRYPTO FROM ESCROW ────────────────
router.post('/orders/:id/release', p2pGate, async (req, res, next) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await client.query("SELECT * FROM p2p_orders WHERE id=$1 AND seller_id=$2 AND status IN ('paid','disputed') FOR UPDATE", [req.params.id, req.user.id]);
    if (!result.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found or not in paid status.' });
    }
    const order = result.rows[0];

    // Credit crypto to buyer
    await client.query(`
      INSERT INTO wallets (user_id, symbol, total_balance, locked_balance)
      VALUES ($1,$2,$3,0)
      ON CONFLICT (user_id, symbol) DO UPDATE SET total_balance = wallets.total_balance + $3
    `, [order.buyer_id, order.symbol, order.escrow_amount]);

    // Deduct from seller wallet (unlock + deduct)
    await client.query(`
      UPDATE wallets SET
        total_balance  = total_balance  - $1,
        locked_balance = GREATEST(0, locked_balance - $1)
      WHERE user_id=$2 AND symbol=$3
    `, [order.escrow_amount, order.seller_id, order.symbol]);

    // Mark order completed
    await client.query("UPDATE p2p_orders SET status='completed', released_at=NOW() WHERE id=$1", [order.id]);

    // Update ad trade count
    await client.query('UPDATE p2p_ads SET trade_count = trade_count + 1 WHERE id=$1', [order.ad_id]);

    await client.query('COMMIT');

    await notifyUser(order.buyer_id, 'p2p', `${order.escrow_amount} ${order.symbol} released to your wallet ✅`);
    await auditLog({ userId: req.user.id, action: 'p2p_escrow_released', entityId: order.id });

    res.json({ message: 'Crypto released to buyer. Trade complete!' });
  } catch (err) {
    await client.query('ROLLBACK').catch(()=>{});
    next(err);
  } finally { client.release(); }
});

// ── OPEN DISPUTE ──────────────────────────────
router.post('/orders/:id/dispute', p2pGate, async (req, res, next) => {
  try {
    const { reason, description } = req.body;
    const orderRes = await query("SELECT * FROM p2p_orders WHERE id=$1 AND (buyer_id=$2 OR seller_id=$2) AND status='paid'", [req.params.id, req.user.id]);
    if (!orderRes.rows.length) return res.status(404).json({ error: 'Order not found or not in paid status.' });

    const order = orderRes.rows[0];
    await query("UPDATE p2p_orders SET status='disputed' WHERE id=$1", [order.id]);
    await query('INSERT INTO disputes (order_id, opened_by, reason, description) VALUES ($1,$2,$3,$4)', [order.id, req.user.id, reason, description]);

    const otherId = req.user.id === order.buyer_id ? order.seller_id : order.buyer_id;
    await notifyUser(otherId, 'p2p', 'A dispute has been opened on your P2P order. Our team will review within 24 hours.');
    await auditLog({ userId: req.user.id, action: 'p2p_dispute_opened', entityId: order.id });

    res.json({ message: 'Dispute opened. Our support team will review within 24 hours.' });
  } catch (err) { next(err); }
});

// ── P2P CHAT ──────────────────────────────────
router.get('/orders/:id/messages', async (req, res, next) => {
  try {
    const orderCheck = await query('SELECT id FROM p2p_orders WHERE id=$1 AND (buyer_id=$2 OR seller_id=$2)', [req.params.id, req.user.id]);
    if (!orderCheck.rows.length) return res.status(403).json({ error: 'Access denied.' });
    const msgs = await query(`
      SELECT m.id, m.message, m.image_url, m.created_at,
             u.first_name || ' ' || LEFT(u.last_name,1) || '.' as sender_name,
             m.sender_id = $1 as is_me
      FROM p2p_messages m JOIN users u ON u.id = m.sender_id
      WHERE m.order_id = $2 ORDER BY m.created_at ASC
    `, [req.user.id, req.params.id]);

    // Mark as read
    await query('UPDATE p2p_messages SET read_at = NOW() WHERE order_id=$1 AND sender_id != $2 AND read_at IS NULL', [req.params.id, req.user.id]);
    res.json({ messages: msgs.rows });
  } catch (err) { next(err); }
});

router.post('/orders/:id/messages', p2pGate, async (req, res, next) => {
  try {
    const { message } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'Message cannot be empty.' });

    const orderCheck = await query('SELECT buyer_id, seller_id FROM p2p_orders WHERE id=$1 AND (buyer_id=$2 OR seller_id=$2)', [req.params.id, req.user.id]);
    if (!orderCheck.rows.length) return res.status(403).json({ error: 'Access denied.' });
    const order = orderCheck.rows[0];

    const result = await query(
      'INSERT INTO p2p_messages (order_id, sender_id, message) VALUES ($1,$2,$3) RETURNING id, message, created_at',
      [req.params.id, req.user.id, message.trim()]
    );
    const msg = result.rows[0];

    // Push via WebSocket to both parties
    const otherId = req.user.id === order.buyer_id ? order.seller_id : order.buyer_id;
    await publishToWS(`user:${otherId}`, { type: 'p2p_message', orderId: req.params.id, message: msg });
    await notifyUser(otherId, 'p2p', 'New message in P2P order', { link: `/p2p-order.html?id=${req.params.id}` });

    res.status(201).json(msg);
  } catch (err) { next(err); }
});

module.exports = router;
