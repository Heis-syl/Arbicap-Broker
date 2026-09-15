/**
 * [YOUR EXCHANGE NAME] — SVG Icon Library
 * Simple abstract line-art icons, no emojis.
 * Style: clean strokes, geometric, Bybit-inspired.
 *
 * Usage:
 *   icon('wallet')       → returns SVG string
 *   Icon.inject()        → replaces all [data-icon="wallet"] elements
 *   <span data-icon="deposit"></span>  → auto-replaced on DOMContentLoaded
 */

const ICONS = {

  // ── NAVIGATION ────────────────────────────────
  dashboard: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <rect x="2" y="2" width="7" height="7" rx="1"/>
    <rect x="11" y="2" width="7" height="7" rx="1"/>
    <rect x="2" y="11" width="7" height="7" rx="1"/>
    <rect x="11" y="11" width="7" height="7" rx="1"/>
  </svg>`,

  trade: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="2,14 7,9 11,12 18,5"/>
    <polyline points="14,5 18,5 18,9"/>
  </svg>`,

  markets: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <rect x="2" y="12" width="3" height="6"/>
    <rect x="7" y="8" width="3" height="10"/>
    <rect x="12" y="4" width="3" height="14"/>
    <rect x="17" y="9" width="1" height="9"/>
  </svg>`,

  p2p: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="5" cy="10" r="3"/>
    <circle cx="15" cy="10" r="3"/>
    <line x1="8" y1="10" x2="12" y2="10"/>
    <polyline points="10,8 12,10 10,12"/>
  </svg>`,

  wallet: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <rect x="2" y="5" width="16" height="12" rx="1.5"/>
    <path d="M2 8h16"/>
    <circle cx="14.5" cy="13" r="1.5" fill="currentColor" stroke="none"/>
  </svg>`,

  profile: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="10" cy="7" r="3.5"/>
    <path d="M3 18c0-3.87 3.13-7 7-7s7 3.13 7 7"/>
  </svg>`,

  security: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M10 2L3 5v5c0 4.42 3.03 8.56 7 9.93C14.97 18.56 18 14.42 18 10V5L10 2z"/>
    <polyline points="7,10 9,12 13,8"/>
  </svg>`,

  settings: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="10" cy="10" r="2.5"/>
    <path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.22 4.22l1.42 1.42M14.36 14.36l1.42 1.42M4.22 15.78l1.42-1.42M14.36 5.64l1.42-1.42"/>
  </svg>`,

  notifications: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M10 2a6 6 0 00-6 6v3l-1.5 2.5h15L16 11V8a6 6 0 00-6-6z"/>
    <path d="M8 16.5a2 2 0 004 0"/>
  </svg>`,

  logout: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M7 3H4a1 1 0 00-1 1v12a1 1 0 001 1h3"/>
    <polyline points="13,7 17,10 13,13"/>
    <line x1="6" y1="10" x2="17" y2="10"/>
  </svg>`,

  // ── WALLET ACTIONS ────────────────────────────
  deposit: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <line x1="10" y1="3" x2="10" y2="13"/>
    <polyline points="6,9 10,13 14,9"/>
    <rect x="3" y="15" width="14" height="2" rx="1"/>
  </svg>`,

  withdraw: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <line x1="10" y1="13" x2="10" y2="3"/>
    <polyline points="6,7 10,3 14,7"/>
    <rect x="3" y="15" width="14" height="2" rx="1"/>
  </svg>`,

  transfer: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="4,7 8,3 12,7"/>
    <line x1="8" y1="3" x2="8" y2="12"/>
    <polyline points="8,17 12,13 16,17"/>
    <line x1="12" y1="13" x2="12" y2="8"/>
  </svg>`,

  history: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="10" cy="10" r="7.5"/>
    <polyline points="10,5.5 10,10 13,12"/>
  </svg>`,

  // ── KYC ───────────────────────────────────────
  kyc: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <rect x="2" y="4" width="16" height="12" rx="1.5"/>
    <circle cx="7" cy="9.5" r="2"/>
    <line x1="11" y1="8" x2="16" y2="8"/>
    <line x1="11" y1="11" x2="15" y2="11"/>
  </svg>`,

  id_card: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <rect x="1.5" y="4.5" width="17" height="11" rx="1.5"/>
    <circle cx="6.5" cy="10" r="2"/>
    <line x1="10.5" y1="8.5" x2="16.5" y2="8.5"/>
    <line x1="10.5" y1="11.5" x2="14.5" y2="11.5"/>
    <line x1="3" y1="14" x2="10" y2="14"/>
  </svg>`,

  selfie: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M7 3H4a1 1 0 00-1 1v2"/>
    <path d="M13 3h3a1 1 0 011 1v2"/>
    <path d="M3 14v2a1 1 0 001 1h2"/>
    <path d="M17 14v2a1 1 0 01-1 1h-2"/>
    <circle cx="10" cy="10" r="3"/>
    <circle cx="10" cy="10" r="1" fill="currentColor" stroke="none"/>
  </svg>`,

  document: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M5 2h7l4 4v12a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z"/>
    <polyline points="12,2 12,6 16,6"/>
    <line x1="7" y1="10" x2="13" y2="10"/>
    <line x1="7" y1="13" x2="11" y2="13"/>
  </svg>`,

  address_proof: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M10 2C7.24 2 5 4.24 5 7c0 4 5 10 5 10s5-6 5-10c0-2.76-2.24-5-5-5z"/>
    <circle cx="10" cy="7" r="1.5"/>
  </svg>`,

  // ── STATUS / FEEDBACK ─────────────────────────
  check: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="3,10 8,15 17,5"/>
  </svg>`,

  close: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <line x1="4" y1="4" x2="16" y2="16"/>
    <line x1="16" y1="4" x2="4" y2="16"/>
  </svg>`,

  warning: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M10 2L1 18h18L10 2z"/>
    <line x1="10" y1="9" x2="10" y2="13"/>
    <circle cx="10" cy="15.5" r="0.75" fill="currentColor" stroke="none"/>
  </svg>`,

  info: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="10" cy="10" r="8"/>
    <line x1="10" y1="9" x2="10" y2="14"/>
    <circle cx="10" cy="6.5" r="0.75" fill="currentColor" stroke="none"/>
  </svg>`,

  lock: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <rect x="4" y="9" width="12" height="9" rx="1.5"/>
    <path d="M7 9V6.5a3 3 0 016 0V9"/>
    <circle cx="10" cy="13.5" r="1.5" fill="currentColor" stroke="none"/>
  </svg>`,

  unlock: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <rect x="4" y="9" width="12" height="9" rx="1.5"/>
    <path d="M7 9V6.5a3 3 0 016 0"/>
    <circle cx="10" cy="13.5" r="1.5" fill="currentColor" stroke="none"/>
  </svg>`,

  shield: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M10 2L3 5v5c0 4.42 3.03 8.56 7 9.93C14.97 18.56 18 14.42 18 10V5L10 2z"/>
  </svg>`,

  key: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="7.5" cy="8.5" r="4"/>
    <line x1="11" y1="12" x2="18" y2="12"/>
    <line x1="15" y1="12" x2="15" y2="15"/>
    <line x1="18" y1="12" x2="18" y2="14"/>
  </svg>`,

  copy: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <rect x="7" y="7" width="10" height="11" rx="1"/>
    <path d="M13 7V4a1 1 0 00-1-1H4a1 1 0 00-1 1v9a1 1 0 001 1h3"/>
  </svg>`,

  refresh: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4 10a6 6 0 1010.93-3.43"/>
    <polyline points="14,3 15,7 11,7"/>
  </svg>`,

  search: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="8.5" cy="8.5" r="5.5"/>
    <line x1="13" y1="13" x2="17.5" y2="17.5"/>
  </svg>`,

  filter: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <line x1="2" y1="5" x2="18" y2="5"/>
    <line x1="5" y1="10" x2="15" y2="10"/>
    <line x1="8" y1="15" x2="12" y2="15"/>
  </svg>`,

  arrow_up: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <line x1="10" y1="16" x2="10" y2="4"/>
    <polyline points="5,9 10,4 15,9"/>
  </svg>`,

  arrow_down: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <line x1="10" y1="4" x2="10" y2="16"/>
    <polyline points="5,11 10,16 15,11"/>
  </svg>`,

  arrow_right: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <line x1="4" y1="10" x2="16" y2="10"/>
    <polyline points="11,5 16,10 11,15"/>
  </svg>`,

  external: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M9 3H4a1 1 0 00-1 1v12a1 1 0 001 1h12a1 1 0 001-1v-5"/>
    <polyline points="13,3 17,3 17,7"/>
    <line x1="10" y1="10" x2="17" y2="3"/>
  </svg>`,

  menu: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
    <line x1="3" y1="6" x2="17" y2="6"/>
    <line x1="3" y1="10" x2="17" y2="10"/>
    <line x1="3" y1="14" x2="17" y2="14"/>
  </svg>`,

  // ── FINANCE / TRADING ─────────────────────────
  chart_candle: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
    <line x1="4" y1="3" x2="4" y2="17"/>
    <rect x="2.5" y="7" width="3" height="6" rx="0.5"/>
    <line x1="10" y1="2" x2="10" y2="18"/>
    <rect x="8.5" y="5" width="3" height="8" rx="0.5" fill="currentColor" stroke="currentColor"/>
    <line x1="16" y1="5" x2="16" y2="16"/>
    <rect x="14.5" y="8" width="3" height="5" rx="0.5"/>
  </svg>`,

  order_book: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
    <line x1="3" y1="5" x2="11" y2="5"/>
    <line x1="3" y1="8" x2="14" y2="8"/>
    <line x1="3" y1="11" x2="9" y2="11"/>
    <line x1="10" y1="12" x2="17" y2="12"/>
    <line x1="10" y1="15" x2="15" y2="15"/>
    <line x1="10" y1="18" x2="13" y2="18"/>
    <line x1="9.5" y1="3" x2="9.5" y2="18" stroke-dasharray="2 1"/>
  </svg>`,

  swap: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="3,7 6,4 9,7"/>
    <line x1="6" y1="4" x2="6" y2="14"/>
    <polyline points="11,13 14,16 17,13"/>
    <line x1="14" y1="16" x2="14" y2="6"/>
  </svg>`,

  coin: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
    <circle cx="10" cy="10" r="7.5"/>
    <path d="M10 6v8M8 7.5c0 0 .5-1 2-1s2.5 1 2.5 2c0 1.5-2.5 2-2.5 3s1 2 2.5 2 2-1 2-1"/>
  </svg>`,

  gift: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <rect x="2" y="8" width="16" height="10" rx="1"/>
    <rect x="2" y="5" width="16" height="3" rx="1"/>
    <line x1="10" y1="5" x2="10" y2="18"/>
    <path d="M10 5C10 5 8 2 6 4s1 1 4 1"/>
    <path d="M10 5C10 5 12 2 14 4s-1 1-4 1"/>
  </svg>`,

  support: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="10" cy="10" r="8"/>
    <circle cx="10" cy="10" r="3"/>
    <line x1="3.58" y1="3.58" x2="7.17" y2="7.17"/>
    <line x1="12.83" y1="12.83" x2="16.42" y2="16.42"/>
    <line x1="16.42" y1="3.58" x2="12.83" y2="7.17"/>
    <line x1="7.17" y1="12.83" x2="3.58" y2="16.42"/>
  </svg>`,

  api: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="6,9 2,12 6,15"/>
    <polyline points="14,9 18,12 14,15"/>
    <line x1="11" y1="7" x2="9" y2="17"/>
  </svg>`,

  bell: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M10 2.5a5.5 5.5 0 00-5.5 5.5v2.5L3 13h14l-1.5-2.5V8A5.5 5.5 0 0010 2.5z"/>
    <path d="M8.5 16a1.5 1.5 0 003 0"/>
  </svg>`,

  star: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <polygon points="10,2 12.4,7.5 18.5,8 14,12 15.6,18 10,15 4.4,18 6,12 1.5,8 7.6,7.5"/>
  </svg>`,

  eye: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M2 10C4 6 6.5 4 10 4s6 2 8 6c-2 4-4.5 6-8 6s-6-2-8-6z"/>
    <circle cx="10" cy="10" r="2"/>
  </svg>`,

  eye_off: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <line x1="2" y1="2" x2="18" y2="18"/>
    <path d="M9 4.2A7.8 7.8 0 0110 4c3.5 0 6 2 8 6-.6 1.2-1.3 2.2-2.1 3M5 5.5A14 14 0 002 10c2 4 4.5 6 8 6a8 8 0 004.5-1.4"/>
    <circle cx="10" cy="10" r="2" stroke-dasharray="4 2"/>
  </svg>`,

  maintenance: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="10" cy="10" r="3"/>
    <path d="M17 10a7 7 0 10-7 7"/>
    <line x1="14" y1="14" x2="18.5" y2="18.5"/>
    <line x1="16" y1="14" x2="18.5" y2="16.5"/>
  </svg>`,

  admin: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <rect x="2" y="3" width="16" height="13" rx="1.5"/>
    <line x1="6" y1="18" x2="14" y2="18"/>
    <line x1="10" y1="16" x2="10" y2="18"/>
    <line x1="5" y1="8" x2="15" y2="8"/>
    <line x1="5" y1="11" x2="11" y2="11"/>
  </svg>`,

  user: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="10" cy="7" r="3.5"/>
    <path d="M3 18c0-3.87 3.13-7 7-7s7 3.13 7 7"/>
  </svg>`,

  users: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="7.5" cy="7" r="3"/>
    <path d="M1.5 17c0-3.31 2.69-6 6-6"/>
    <circle cx="14" cy="7" r="3"/>
    <path d="M8 17c0-3.31 2.69-6 6-6s6 2.69 6 6"/>
  </svg>`,

  bank: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <polygon points="10,2 18,7 2,7"/>
    <rect x="4" y="7" width="2" height="8"/>
    <rect x="9" y="7" width="2" height="8"/>
    <rect x="14" y="7" width="2" height="8"/>
    <rect x="2" y="15" width="16" height="2"/>
  </svg>`,

  qr: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <rect x="2" y="2" width="7" height="7" rx="0.5"/>
    <rect x="4" y="4" width="3" height="3"/>
    <rect x="11" y="2" width="7" height="7" rx="0.5"/>
    <rect x="13" y="4" width="3" height="3"/>
    <rect x="2" y="11" width="7" height="7" rx="0.5"/>
    <rect x="4" y="13" width="3" height="3"/>
    <line x1="11" y1="11" x2="11" y2="14"/>
    <line x1="14" y1="11" x2="18" y2="11"/>
    <line x1="18" y1="11" x2="18" y2="14"/>
    <line x1="14" y1="14" x2="14" y2="18"/>
    <line x1="18" y1="16" x2="18" y2="18"/>
    <line x1="14" y1="18" x2="18" y2="18"/>
  </svg>`,
};

// ── ICON FUNCTION ─────────────────────────────
function icon(name, size = 16, cls = '') {
  const svg = ICONS[name];
  if (!svg) return '';
  return svg.replace('<svg ', `<svg width="${size}" height="${size}" class="icon${cls?' '+cls:''}" `);
}

// ── AUTO-INJECT ───────────────────────────────
// Replaces all <span data-icon="name"></span> elements
function injectIcons() {
  document.querySelectorAll('[data-icon]').forEach(el => {
    const name  = el.dataset.icon;
    const size  = parseInt(el.dataset.size || '16');
    const cls   = el.dataset.cls || '';
    const svg   = icon(name, size, cls);
    if (svg) el.outerHTML = svg;
  });
}

// ── SIDEBAR ICON MAP ──────────────────────────
const SIDEBAR_ICONS = {
  'Dashboard':  'dashboard',
  'Markets':    'markets',
  'Trade':      'trade',
  'Spot Trade': 'trade',
  'P2P':        'p2p',
  'Wallet':     'wallet',
  'Deposit':    'deposit',
  'Withdraw':   'withdraw',
  'History':    'history',
  'Profile':    'profile',
  'KYC':        'kyc',
  'Security':   'security',
  'API Keys':   'api',
  'Referrals':  'gift',
  'Help':       'support',
  'Sign Out':   'logout',
};

document.addEventListener('DOMContentLoaded', injectIcons);
