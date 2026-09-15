/**
 * Custody Service — Company Wallet Model
 *
 * HOW DEPOSITS WORK HERE:
 * Every user sees the SAME company wallet address per coin.
 * When a user deposits, they send to the company address.
 * You manually verify the transaction in the admin panel and
 * approve it → the user's dashboard balance is credited.
 *
 * Your company wallet addresses go in COMPANY_WALLETS below.
 * Replace each placeholder with your real address.
 *
 * WITHDRAWALS:
 * Withdrawals are DISABLED until you enable them.
 * The UI shows the withdrawal tab normally, but submitting
 * returns a "coming soon" message. Set WITHDRAWALS_LIVE=true
 * in your .env when ready to go live.
 */
'use strict';
const { query }  = require('../models/db');
const { logger } = require('./logger');

// ══════════════════════════════════════════════
// YOUR COMPANY WALLET ADDRESSES
// Replace each value with your real wallet address.
// These are shown to ALL users as their deposit address.
// ══════════════════════════════════════════════
const COMPANY_WALLETS = {
  // Bitcoin
  BTC_bitcoin:         process.env.WALLET_BTC         || '[YOUR_BTC_WALLET_ADDRESS]',

  // Ethereum & ERC-20 tokens (same address for all EVM tokens)
  ETH_ethereum:        process.env.WALLET_ETH         || '[YOUR_ETH_ERC20_WALLET_ADDRESS]',
  USDT_ethereum:       process.env.WALLET_ETH         || '[YOUR_ETH_ERC20_WALLET_ADDRESS]',
  USDC_ethereum:       process.env.WALLET_ETH         || '[YOUR_ETH_ERC20_WALLET_ADDRESS]',

  // BNB Chain (BEP-20 — same address as ETH if using MetaMask/same key)
  BNB_bsc:             process.env.WALLET_BNB         || '[YOUR_BNB_BSC_WALLET_ADDRESS]',
  USDT_bsc:            process.env.WALLET_BNB         || '[YOUR_BNB_BSC_WALLET_ADDRESS]',

  // Tron (TRC-20 USDT — different address format)
  USDT_tron:           process.env.WALLET_TRX         || '[YOUR_TRX_TRON_WALLET_ADDRESS]',

  // Solana
  SOL_solana:          process.env.WALLET_SOL         || '[YOUR_SOL_WALLET_ADDRESS]',

  // XRP — also needs a memo/destination tag
  XRP_xrp:             process.env.WALLET_XRP         || '[YOUR_XRP_WALLET_ADDRESS]',

  // Litecoin
  LTC_litecoin:        process.env.WALLET_LTC         || '[YOUR_LTC_WALLET_ADDRESS]',

  // Dogecoin
  DOGE_dogecoin:       process.env.WALLET_DOGE        || '[YOUR_DOGE_WALLET_ADDRESS]',

  // Cardano
  ADA_cardano:         process.env.WALLET_ADA         || '[YOUR_ADA_WALLET_ADDRESS]',

  // Polygon (MATIC)
  MATIC_polygon:       process.env.WALLET_ETH         || '[YOUR_ETH_ERC20_WALLET_ADDRESS]',

  // Avalanche
  AVAX_avalanche:      process.env.WALLET_AVAX        || '[YOUR_AVAX_WALLET_ADDRESS]',
};

// Memos required for certain coins (users must include these in their transfer)
const COMPANY_MEMOS = {
  XRP_xrp: process.env.WALLET_XRP_MEMO || '[YOUR_XRP_DESTINATION_TAG]',
};

// Minimum deposit amounts per coin
const MIN_DEPOSIT = {
  BTC: 0.0001, ETH: 0.001, USDT: 5, USDC: 5,
  BNB: 0.01,   SOL: 0.01,  XRP: 1,  LTC: 0.01,
  DOGE: 1,     ADA: 1,     MATIC: 1, AVAX: 0.01,
};

// Confirmations required before admin can approve
const CONFIRMATIONS_REQUIRED = {
  BTC: 2, ETH: 12, USDT: 12, BNB: 12, SOL: 1,
  XRP: 1, LTC: 6,  DOGE: 6,  ADA: 15, MATIC: 12, AVAX: 12,
};

// ── GET DEPOSIT ADDRESS ────────────────────────
// Returns the company wallet address for the given coin/network.
// Every user gets the same address — you identify their deposit
// by matching the tx hash in the admin panel.
async function getOrCreateDepositAddress(userId, symbol, network) {
  const key  = `${symbol}_${network}`;
  const addr = COMPANY_WALLETS[key];

  if (!addr || addr.startsWith('[YOUR_')) {
    logger.warn(`Company wallet not configured for ${key}. Set WALLET_${symbol} in .env`);
    throw new Error(`Deposits for ${symbol} on ${network} are not yet configured. Please contact support.`);
  }

  const memo = COMPANY_MEMOS[key] || null;

  // Save a record so the admin can see which user this deposit belongs to
  // The tx_ref column links the deposit to the user when you approve it
  await query(`
    INSERT INTO deposit_addresses (user_id, symbol, network, address)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (user_id, symbol, network) DO NOTHING
  `, [userId, symbol, network, addr]);

  return {
    address: addr,
    memo,
    minDeposit: MIN_DEPOSIT[symbol] || 0,
    confirmations: CONFIRMATIONS_REQUIRED[symbol] || 2,
    note: `Send only ${symbol} on the ${network} network to this address. ${memo ? `Include memo/tag: ${memo}` : ''}`,
  };
}

// ── BROADCAST WITHDRAWAL ──────────────────────
// WITHDRAWALS ARE DISABLED — returns an error until WITHDRAWALS_LIVE=true
async function broadcastWithdrawal({ txId, symbol, network, toAddress, amount }) {
  const live = process.env.WITHDRAWALS_LIVE === 'true';
  if (!live) {
    throw new Error('WITHDRAWALS_DISABLED');
  }
  // ── PLUG IN YOUR CUSTODY PROVIDER HERE WHEN READY ──
  // e.g. Fireblocks, BitGo, or manual signing
  throw new Error('Withdrawal broadcasting not yet configured. Set up your custody provider.');
}

module.exports = {
  getOrCreateDepositAddress,
  broadcastWithdrawal,
  COMPANY_WALLETS,
  MIN_DEPOSIT,
  CONFIRMATIONS_REQUIRED,
};
