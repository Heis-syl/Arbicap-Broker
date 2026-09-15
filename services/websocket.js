/**
 * WebSocket Server
 * Handles real-time data delivery to connected clients:
 * - Order book updates
 * - Trade stream
 * - Candlestick updates (OHLCV)
 * - Account / order fill notifications (authenticated)
 * - P2P chat messages
 */
'use strict';
const WebSocket = require('ws');
const jwt       = require('jsonwebtoken');
const { logger } = require('./logger');

let wss;
// Map: channel name → Set of WebSocket clients
const channels = new Map();
// Map: userId → Set of WebSocket clients
const userSockets = new Map();

function initWS(server) {
  wss = new WebSocket.Server({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.subscriptions = new Set();
    ws.userId = null;

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        handleMessage(ws, msg);
      } catch { /* ignore malformed messages */ }
    });

    ws.on('close', () => {
      // Clean up subscriptions
      ws.subscriptions.forEach(ch => {
        const set = channels.get(ch);
        if (set) { set.delete(ws); if (!set.size) channels.delete(ch); }
      });
      if (ws.userId) {
        const set = userSockets.get(ws.userId);
        if (set) { set.delete(ws); if (!set.size) userSockets.delete(ws.userId); }
      }
    });

    ws.on('error', (err) => logger.warn('WS client error:', err.message));

    // Send connection ack
    send(ws, { type: 'connected', serverTime: Date.now() });
  });

  // Heartbeat ping every 30s — drop dead connections
  const heartbeat = setInterval(() => {
    wss.clients.forEach(ws => {
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => clearInterval(heartbeat));
  logger.info('WebSocket server started at /ws');
}

// ── MESSAGE HANDLER ───────────────────────────
async function handleMessage(ws, msg) {
  switch (msg.type) {

    case 'auth': {
      // Authenticate the WS connection with JWT
      try {
        const payload = jwt.verify(msg.token, process.env.JWT_SECRET);
        ws.userId = payload.sub;
        if (!userSockets.has(ws.userId)) userSockets.set(ws.userId, new Set());
        userSockets.get(ws.userId).add(ws);
        // Auto-subscribe to personal channel
        subscribe(ws, `user:${ws.userId}`);
        send(ws, { type: 'auth_success', userId: ws.userId });
      } catch {
        send(ws, { type: 'auth_error', message: 'Invalid or expired token.' });
      }
      break;
    }

    case 'subscribe': {
      // Public channels: orderbook@BTCUSDT, trades@BTCUSDT, kline@BTCUSDT@1h, ticker@BTCUSDT
      // Private channels: user:<userId> (requires auth)
      const chans = Array.isArray(msg.channels) ? msg.channels : [msg.channel];
      chans.forEach(ch => {
        if (ch.startsWith('user:') && ch !== `user:${ws.userId}`) return; // can't sub to other users
        subscribe(ws, ch);
      });
      send(ws, { type: 'subscribed', channels: [...ws.subscriptions] });
      break;
    }

    case 'unsubscribe': {
      const chans = Array.isArray(msg.channels) ? msg.channels : [msg.channel];
      chans.forEach(ch => {
        ws.subscriptions.delete(ch);
        const set = channels.get(ch);
        if (set) set.delete(ws);
      });
      send(ws, { type: 'unsubscribed', channels: chans });
      break;
    }

    case 'ping':
      send(ws, { type: 'pong', ts: Date.now() });
      break;
  }
}

function subscribe(ws, channel) {
  ws.subscriptions.add(channel);
  if (!channels.has(channel)) channels.set(channel, new Set());
  channels.get(channel).add(ws);
}

// ── PUBLISH TO CHANNEL ────────────────────────
function publish(channel, data) {
  const set = channels.get(channel);
  if (!set || !set.size) return;
  const payload = JSON.stringify(data);
  set.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  });
}

// Publish to user's private channel
async function publishToWS(channel, data) {
  publish(channel, data);
}

// Publish order book update for a symbol
function publishOrderBook(symbol, asks, bids) {
  publish(`orderbook@${symbol}`, { type: 'orderbook', symbol, asks, bids, ts: Date.now() });
}

// Publish a trade
function publishTrade(symbol, trade) {
  publish(`trades@${symbol}`, { type: 'trade', symbol, ...trade, ts: Date.now() });
}

// Publish kline update
function publishKline(symbol, interval, candle) {
  publish(`kline@${symbol}@${interval}`, { type: 'kline', symbol, interval, candle, ts: Date.now() });
}

// Publish ticker update
function publishTicker(symbol, ticker) {
  publish(`ticker@${symbol}`, { type: 'ticker', symbol, ...ticker, ts: Date.now() });
  publish('allTickers', { type: 'ticker', symbol, ...ticker, ts: Date.now() });
}

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

module.exports = { initWS, publish, publishToWS, publishOrderBook, publishTrade, publishKline, publishTicker };
