/* =============================================
   Arbicap — SHARED APP JS
   Production-ready shared utilities, auth,
   WebSocket manager, price feeds, notifications
   ============================================= */

// ── APP CONFIG ────────────────────────────────
const APP = {
  name:       'Arbicap',
  tagline:    'Trade smarter. Move faster.',
  domain:     'arbicap.vercel.app',
  supportEmail: 'support@arbicap.vercel.app',

  // ── BACKEND ENDPOINTS ───────────────────────
  // Use your Railway app URL here. For local dev, this falls back to localhost:4000.
  // You can also override it at runtime with window.__APP_CONFIG__.apiBase or localStorage.
  apiBase: (() => {
    const override = window.__APP_CONFIG__?.apiBase || localStorage.getItem('broker_api_base');
    if (override) return override;
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') return 'http://localhost:4000/api';
    return 'https://arbicap-production.up.railway.app/api';
  })(),
  wsBase:   'wss://ws.arbicap.vercel.app',

// ── PUBLIC DATA SOURCE (use until your own backend is ready) ──
  // Binance public API — no auth needed for market data
  binanceRest: 'https://api.binance.com/api/v3',
  binanceWS:   'wss://stream.binance.com:9443/ws',

  // ── FEES ────────────────────────────────────
  makerFee: 0.001,   // 0.1%
  takerFee: 0.001,   // 0.1%
  p2pFee:   0,       // P2P is free

  // ── LIMITS ──────────────────────────────────
  minWithdraw: { BTC: 0.0001, ETH: 0.001, USDT: 10 },
  maxWithdrawUnverified: 0,
  maxWithdrawLevel2: 10000,
  maxWithdrawLevel3: 100000,
};

// ── AUTH ──────────────────────────────────────
// Stores session token in localStorage.
// Replace with your backend JWT auth flow.
function normalizeUser(user = {}) {
  const safeUser = user && typeof user === 'object' ? user : {};
  const firstName = safeUser.firstName || safeUser.first_name || '';
  const lastName = safeUser.lastName || safeUser.last_name || '';
  const email = safeUser.email || '';

  return {
    ...safeUser,
    firstName,
    lastName,
    first_name: safeUser.first_name || firstName,
    last_name: safeUser.last_name || lastName,
    email,
    phone: safeUser.phone || '',
    country: safeUser.country || '',
    language: safeUser.language || 'English',
    kycLevel: safeUser.kycLevel ?? safeUser.kyc_level ?? 0,
    twoFaEnabled: safeUser.twoFaEnabled ?? safeUser.two_fa_enabled ?? false,
  };
}

const Auth = {
  isLoggedIn: () => !!localStorage.getItem('broker_token'),
  token:      () => localStorage.getItem('broker_token'),
  user:       () => {
    try {
      const raw = localStorage.getItem('broker_user');
      return normalizeUser(raw ? JSON.parse(raw) : {});
    } catch {
      return {};
    }
  },
  login: (token, user) => {
    const normalized = normalizeUser(user);
    localStorage.setItem('broker_token', token);
    localStorage.setItem('broker_user', JSON.stringify(normalized));
    sessionStorage.setItem('broker_token', token);
    sessionStorage.setItem('broker_user', JSON.stringify(normalized));
  },
  clearAccountState: () => {
    const keys = [
      'broker_token',
      'broker_user',
      'broker_2fa_verified',
      'watchlist',
      'portfolio_state',
      'wallet_state',
      'wallet_history',
      'open_orders',
      'recent_activity',
      'p2p_orders',
      'orders_state',
      'transactions'
    ];
    keys.forEach(key => localStorage.removeItem(key));
    localStorage.setItem('watchlist', JSON.stringify([]));
  },
  logout: () => {
    Auth.clearAccountState();
    window.location.href = 'login.html';
  },
  kycLevel: () => {
    const u = Auth.user();
    return u.kycLevel || 0;
  },
  require: (redirectTo) => {
    if (!Auth.isLoggedIn()) {
      window.location.href = `login.html?next=${encodeURIComponent(redirectTo || window.location.href)}`;
      return false;
    }
    return true;
  },
};

// ── API CLIENT ────────────────────────────────
// Wraps fetch with auth headers, error handling, and retry.
// All calls go through your own backend (APP.apiBase).
const API = {
  _headers: () => ({
    'Content-Type': 'application/json',
    ...(Auth.isLoggedIn() ? { 'Authorization': `Bearer ${Auth.token()}` } : {}),
  }),

  get: async (path, params) => {
    const url = new URL(APP.apiBase + path);
    if (params) Object.entries(params).forEach(([k,v]) => url.searchParams.set(k,v));
    const res = await fetch(url, { headers: API._headers() });
    if (!res.ok) throw await res.json();
    return res.json();
  },

  post: async (path, body) => {
    const res = await fetch(APP.apiBase + path, {
      method: 'POST', headers: API._headers(), body: JSON.stringify(body),
    });
    if (!res.ok) throw await res.json();
    return res.json();
  },

  delete: async (path) => {
    const res = await fetch(APP.apiBase + path, { method: 'DELETE', headers: API._headers() });
    if (!res.ok) throw await res.json();
    return res.json();
  },

  // Convenience: fetch from Binance public REST (no auth)
  binance: async (path, params) => {
    const url = new URL(APP.binanceRest + path);
    if (params) Object.entries(params).forEach(([k,v]) => url.searchParams.set(k,v));
    const res = await fetch(url);
    if (!res.ok) throw new Error('Binance API error');
    return res.json();
  },
};

// ── WEBSOCKET MANAGER ─────────────────────────
// Manages a single persistent WebSocket with auto-reconnect.
// Use for your own backend WS (order fills, account updates, etc.)
class WSManager {
  constructor(url, options = {}) {
    this.url = url;
    this.onMessage  = options.onMessage  || (() => {});
    this.onOpen     = options.onOpen     || (() => {});
    this.onClose    = options.onClose    || (() => {});
    this.maxRetries = options.maxRetries || 10;
    this.retryDelay = options.retryDelay || 3000;
    this.retries    = 0;
    this.ws         = null;
    this.pingTimer  = null;
    this.dead       = false;
  }

  connect() {
    if (this.dead) return;
    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => {
      this.retries = 0;
      this._startPing();
      this.onOpen();
    };
    this.ws.onmessage = (e) => {
      try { this.onMessage(JSON.parse(e.data)); } catch {}
    };
    this.ws.onclose = () => {
      this._stopPing();
      this.onClose();
      if (!this.dead && this.retries < this.maxRetries) {
        this.retries++;
        setTimeout(() => this.connect(), this.retryDelay * Math.min(this.retries, 5));
      }
    };
    this.ws.onerror = () => this.ws.close();
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(typeof data === 'string' ? data : JSON.stringify(data));
    }
  }

  close() {
    this.dead = true;
    this._stopPing();
    if (this.ws) this.ws.close();
  }

  _startPing() {
    this.pingTimer = setInterval(() => this.send({ type: 'ping' }), 25000);
  }
  _stopPing() {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }
}

// ── PRICE CACHE ───────────────────────────────
// Shared in-memory price cache updated by any page that receives prices.
const PriceCache = {
  _data: {},
  set: (sym, price, change) => { PriceCache._data[sym] = { price, change, ts: Date.now() }; },
  get: (sym) => PriceCache._data[sym] || null,
  all: () => PriceCache._data,
};

// ── MOCK PRICES (fallback when WS unavailable) ─
const MOCK_PRICES = {
  'BTCUSDT':  { price: 67432.50, ch: 2.34 },
  'ETHUSDT':  { price: 3521.80,  ch: -0.87 },
  'BNBUSDT':  { price: 598.40,   ch: 1.12 },
  'SOLUSDT':  { price: 182.60,   ch: 4.55 },
  'XRPUSDT':  { price: 0.6120,   ch: -1.22 },
  'ADAUSDT':  { price: 0.4830,   ch: 0.65 },
  'DOGEUSDT': { price: 0.1620,   ch: 3.10 },
};

// ── TICKER BANNER ─────────────────────────────
// Builds the scrolling ticker from price data.
// Fetches live 24hr ticker from Binance if available.
async function buildTicker() {
  const track = document.getElementById('ticker-track');
  if (!track) return;

  const SYMBOLS = ['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','ADAUSDT','DOGEUSDT'];
  let prices = { ...MOCK_PRICES };

  try {
    const data = await API.binance('/ticker/24hr', {
      symbols: JSON.stringify(SYMBOLS),
    });
    data.forEach(d => {
      prices[d.symbol] = { price: parseFloat(d.lastPrice), ch: parseFloat(d.priceChangePercent) };
      PriceCache.set(d.symbol, parseFloat(d.lastPrice), parseFloat(d.priceChangePercent));
    });
  } catch { /* use mock data */ }

  const NAMES = { BTCUSDT:'BTC',ETHUSDT:'ETH',BNBUSDT:'BNB',SOLUSDT:'SOL',XRPUSDT:'XRP',ADAUSDT:'ADA',DOGEUSDT:'DOGE' };
  const html = SYMBOLS.map(sym => {
    const d = prices[sym];
    const up = d.ch >= 0;
    const p = d.price > 100 ? '$'+d.price.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : '$'+d.price.toFixed(4);
    return `<div class="ticker-item">
      <span class="ticker-pair">${NAMES[sym]}/USDT</span>
      <span class="ticker-price mono">${p}</span>
      <span class="ticker-change ${up?'text-green':'text-red'}">${up?'+':''}${d.ch.toFixed(2)}%</span>
    </div>`;
  }).join('');
  track.innerHTML = html + html; // duplicate for seamless loop
}

// ── FORMATTING HELPERS ────────────────────────
function fmtPrice(price, sym) {
  if (!price) return '—';
  if (price >= 1000)  return '$' + price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (price >= 1)     return '$' + price.toFixed(4);
  if (price >= 0.01)  return '$' + price.toFixed(5);
  return '$' + price.toFixed(8);
}

function fmtNumber(n) {
  if (n >= 1e12) return (n/1e12).toFixed(2) + 'T';
  if (n >= 1e9)  return (n/1e9).toFixed(2) + 'B';
  if (n >= 1e6)  return (n/1e6).toFixed(2) + 'M';
  if (n >= 1e3)  return (n/1e3).toFixed(2) + 'K';
  return n.toFixed(2);
}

function fmtDate(ts) {
  return new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtElapsed(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  return `${Math.floor(s/3600)}h ago`;
}

// ── MODAL ─────────────────────────────────────
function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('open');
}
function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('open');
}
document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-overlay')) e.target.classList.remove('open');
  if (e.target.classList.contains('modal-close'))   e.target.closest('.modal-overlay')?.classList.remove('open');
});

// ── TOAST NOTIFICATIONS ───────────────────────
function showToast(message, type = 'info', duration = 3500) {
  let c = document.getElementById('_toast_c');
  if (!c) {
    c = document.createElement('div');
    c.id = '_toast_c';
    c.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none;';
    document.body.appendChild(c);
  }
  const cols  = { info:'#2D6AFF', success:'#00C896', error:'#FF4560', warning:'#F5A623' };
  const icons = { info:'i', success:'+', error:'x', warning:'!' };
  const t = document.createElement('div');
  t.style.cssText = `
    background:#1A1E28;border:1px solid rgba(255,255,255,0.1);
    border-left:3px solid ${cols[type]};border-radius:8px;
    padding:10px 14px;font-size:0.83rem;color:#E8ECF4;
    display:flex;align-items:center;gap:10px;
    box-shadow:0 4px 20px rgba(0,0,0,0.5);
    animation:_tin .2s ease;max-width:340px;pointer-events:all;
    font-family:'Inter',sans-serif;line-height:1.5;
  `;
  t.innerHTML = `<span style="color:${cols[type]};font-weight:700;flex-shrink:0;">${icons[type]}</span><span>${message}</span>`;
  c.appendChild(t);
  setTimeout(() => { t.style.transition='0.25s'; t.style.opacity='0'; t.style.transform='translateX(16px)'; setTimeout(()=>t.remove(),260); }, duration);
}

// ── CLIPBOARD ────────────────────────────────
function copyToClipboard(text, label = 'Copied') {
  navigator.clipboard.writeText(text).then(() => showToast(`${label} copied to clipboard`, 'success'));
}

// ── TAB SWITCHER ─────────────────────────────
function initTabs() {
  document.querySelectorAll('.tabs').forEach(tabs => {
    tabs.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const target = tab.dataset.target;
        tabs.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        if (target) {
          document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
          const panel = document.getElementById(target);
          if (panel) panel.classList.remove('hidden');
        }
      });
    });
  });
}

// ── NAV ACTIVE STATE ─────────────────────────
function setActiveNav() {
  const page = window.location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav-links a, .sidebar-link').forEach(a => {
    if (a.getAttribute('href') === page) a.classList.add('active');
  });
}

// ── INJECT APP NAME ───────────────────────────
function injectAppName() {
  document.querySelectorAll('[data-app-name]').forEach(el => el.textContent = APP.name);
}

// ── PROTECT PAGE (call on dashboard/wallet/profile pages) ──
function requireAuth() {
  if (!Auth.isLoggedIn()) {
    window.location.href = `login.html?next=${encodeURIComponent(window.location.href)}`;
  }
}

// ── KYC LEVEL GATE ────────────────────────────
function requireKYC(minLevel, action) {
  const level = Auth.kycLevel();
  if (level < minLevel) {
    showToast(`KYC Level ${minLevel} required to ${action}. Please verify your identity.`, 'warning');
    setTimeout(() => window.location.href = 'profile.html#kyc', 1800);
    return false;
  }
  return true;
}

// ── WITHDRAWAL LIMIT CHECK ────────────────────
function checkWithdrawLimit(amountUSD) {
  const level = Auth.kycLevel();
  if (level === 0) { showToast('Complete KYC to make withdrawals', 'error'); return false; }
  const limit = level >= 3 ? APP.maxWithdrawLevel3 : APP.maxWithdrawLevel2;
  if (amountUSD > limit) {
    showToast(`Exceeds your daily limit of $${limit.toLocaleString()}. Upgrade KYC for higher limits.`, 'error');
    return false;
  }
  return true;
}

// ── PRICE SIMULATION (fallback for pages without WS) ──
function startPriceSimulation(callback) {
  const prices = { ...MOCK_PRICES };
  const timer = setInterval(() => {
    Object.keys(prices).forEach(sym => {
      const jitter = (Math.random() - 0.5) * 0.002;
      prices[sym].price = parseFloat((prices[sym].price * (1 + jitter)).toFixed(prices[sym].price > 1 ? 2 : 6));
    });
    if (callback) callback(prices);
  }, 1500);
  return { prices, stop: () => clearInterval(timer) };
}

// ── CURRENCY / COIN FORMATTERS ────────────────
const COIN_ICONS = {
  BTC:  { cls: 'coin-btc',     label: '₿' },
  ETH:  { cls: 'coin-eth',     label: 'Ξ' },
  USDT: { cls: 'coin-usdt',    label: '₮' },
  BNB:  { cls: 'coin-bnb',     label: 'B' },
  SOL:  { cls: 'coin-sol',     label: 'S' },
  XRP:  { cls: 'coin-xrp',     label: 'X' },
  ADA:  { cls: 'coin-ada',     label: 'A' },
  DOGE: { cls: 'coin-doge',    label: 'D' },
};
function coinIcon(sym, size = 28) {
  const c = COIN_ICONS[sym] || { cls: 'coin-default', label: sym[0] };
  return `<div class="coin-icon ${c.cls}" style="width:${size}px;height:${size}px;font-size:${size*0.4}px;">${c.label}</div>`;
}

// ── EVENT BUS (simple pub/sub for cross-component comms) ──
const EventBus = {
  _handlers: {},
  on:   (evt, fn) => { (EventBus._handlers[evt] = EventBus._handlers[evt]||[]).push(fn); },
  off:  (evt, fn) => { EventBus._handlers[evt] = (EventBus._handlers[evt]||[]).filter(f=>f!==fn); },
  emit: (evt, data) => { (EventBus._handlers[evt]||[]).forEach(fn=>fn(data)); },
};

// ── 2FA VALIDATION (client-side format check) ──
function validate2FACode(code) {
  return /^\d{6}$/.test(code.trim());
}

// ── EMAIL VALIDATION ──────────────────────────
function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

// ── PASSWORD STRENGTH ─────────────────────────
function passwordStrength(pwd) {
  let score = 0;
  if (pwd.length >= 8) score++;
  if (pwd.length >= 12) score++;
  if (/[A-Z]/.test(pwd)) score++;
  if (/[0-9]/.test(pwd)) score++;
  if (/[^A-Za-z0-9]/.test(pwd)) score++;
  const labels = ['Too short', 'Weak', 'Fair', 'Good', 'Strong', 'Very Strong'];
  const cls    = ['', 'filled-weak', 'filled-weak', 'filled-medium', 'filled-strong', 'filled-strong'];
  return { score: Math.min(score, 5), label: labels[score], cls: cls[score] };
}

// ── DEBOUNCE ──────────────────────────────────
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ── LOCAL STORAGE HELPERS ─────────────────────
const Store = {
  get: (key, fallback = null) => {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set: (key, val) => { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} },
  del: (key)      => { try { localStorage.removeItem(key); } catch {} },
};

// ── DEPOSIT ADDRESS GENERATION STUB ───────────
// Replace with real call to your custody provider
// (e.g. Fireblocks, BitGo, or your own HD wallet system)
async function getDepositAddress(sym, network) {
  // Real: return await API.get(`/wallet/deposit-address`, { symbol: sym, network });
  const MOCK_ADDRESSES = {
    BTC:  'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
    ETH:  '0x1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b',
    USDT: 'TXbLKwEBRd2replace_with_real_tron_address',
    BNB:  'bnb1z35wusfb8sqh3replace_with_real_bnb_address',
    SOL:  '7LKsVreplace_with_real_sol_address',
  };
  return MOCK_ADDRESSES[sym] || 'Address not available';
}

function toggleSidebar() {
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (!sidebar) return;

  if (window.innerWidth > 900) {
    sidebar.classList.add('sidebar-open');
    if (overlay) overlay.classList.remove('visible');
    return;
  }

  const isOpen = sidebar.classList.toggle('sidebar-open');
  if (overlay) {
    overlay.classList.toggle('visible', isOpen);
    overlay.style.display = isOpen ? 'block' : 'none';
  }
}

// ── INIT ──────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  setActiveNav();
  injectAppName();
  initTabs();
  buildTicker();

  const sidebar = document.querySelector('.sidebar');
  if (sidebar && window.innerWidth > 900) {
    sidebar.classList.add('sidebar-open');
  }

  const overlay = document.getElementById('sidebar-overlay');
  if (overlay) {
    overlay.classList.remove('visible');
    overlay.style.display = 'none';
  }

  // Inject toast keyframe once
  if (!document.getElementById('_toast_style')) {
    const s = document.createElement('style');
    s.id = '_toast_style';
    s.textContent = '@keyframes _tin{from{opacity:0;transform:translateX(16px)}to{opacity:1;transform:none}}';
    document.head.appendChild(s);
  }

  // Show user name in nav if logged in
  if (Auth.isLoggedIn()) {
    const u = Auth.user();
    document.querySelectorAll('[data-user-name]').forEach(el => el.textContent = u.firstName || 'Account');
  }
});

// ── FEATURE GATES (frontend) ──────────────────
// These mirror the backend .env flags.
// When backend is live, these will be driven by an API response.
// For now, set them here manually to match your .env.
const FEATURE_FLAGS = {
  withdrawals: false,  // set true on launch day
  p2p:         false,  // set true when P2P is ready
};

function isFeatureEnabled(feature) {
  return FEATURE_FLAGS[feature] === true;
}

// Soft gate — looks like a real error, not a broken button
function featureComingSoon(feature, e) {
  if (e) e.preventDefault();
  const messages = {
    withdrawals: 'Withdrawals are temporarily unavailable while we complete security upgrades. Your funds are safe.',
    p2p: 'P2P trading is coming soon. We are finalising the marketplace for launch.',
  };
  showToast(messages[feature] || 'This feature is coming soon.', 'info', 4000);
}

// ── DEPOSIT SUBMISSION ────────────────────────
// Submits a deposit tx hash to the backend for auto-crediting.
// No KYC, no minimum, no approval needed.
async function submitDepositToBackend({ symbol, network, txHash, amount }) {
  const token = Auth.token();
  if (!token) { window.location.href = 'login.html'; return null; }

  const res = await fetch(`${APP.apiBase}/wallet/deposit/submit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ symbol, network, txHash, amount }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Deposit submission failed.');
  return data;
}

// ── WITHDRAWAL GATE ───────────────────────────
// Call this on any withdrawal form submit to check if live.
async function submitWithdrawalToBackend(payload) {
  if (!isFeatureEnabled('withdrawals')) {
    featureComingSoon('withdrawals');
    return null;
  }
  const token = Auth.token();
  const res = await fetch(`${APP.apiBase}/wallet/withdraw`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Withdrawal failed.');
  return data;
}

// ── P2P GATE ──────────────────────────────────
function p2pAction(e) {
  if (!isFeatureEnabled('p2p')) {
    featureComingSoon('p2p', e);
    return false;
  }
  return true;
}
