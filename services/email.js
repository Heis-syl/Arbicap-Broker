/**
 * Email Service — Resend
 * Set RESEND_API_KEY and FROM_EMAIL in .env
 */
'use strict';
const { Resend } = require('resend');
const { logger } = require('./logger');

const resend      = new Resend(process.env.RESEND_API_KEY);
const APP_NAME    = 'Arbicap';
const FROM_EMAIL  = process.env.FROM_EMAIL   || 'onboarding@resend.dev';
const FRONTEND_URL= process.env.FRONTEND_URL || 'https://arbicap.vercel.app';

// ── HTML EMAIL TEMPLATES ──────────────────────
const baseLayout = (content) => `
<!DOCTYPE html>
<html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
  body{margin:0;padding:0;background:#0D0F14;font-family:'Inter',Arial,sans-serif;color:#E8ECF4;}
  .wrap{max-width:560px;margin:0 auto;padding:32px 16px;}
  .card{background:#13161E;border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:32px;}
  .logo{font-size:1.2rem;font-weight:700;color:#fff;margin-bottom:28px;display:flex;align-items:center;gap:8px;}
  .logo-mark{width:28px;height:28px;border-radius:6px;background:linear-gradient(135deg,#2D6AFF,#00C2CB);display:inline-flex;align-items:center;justify-content:center;font-size:0.75rem;font-weight:900;color:white;letter-spacing:-1px;}
  h2{font-size:1.3rem;font-weight:700;margin:0 0 8px;}
  p{font-size:0.9rem;color:#8A94A6;line-height:1.7;margin:0 0 16px;}
  .btn{display:inline-block;padding:12px 28px;background:#2D6AFF;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:0.9rem;margin:16px 0;}
  .code{background:#1F2333;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:14px 20px;font-family:monospace;font-size:1.1rem;font-weight:700;letter-spacing:0.1em;color:#E8ECF4;text-align:center;margin:16px 0;}
  .divider{border:none;border-top:1px solid rgba(255,255,255,0.07);margin:24px 0;}
  .footer{font-size:0.75rem;color:#4E5668;text-align:center;margin-top:24px;line-height:1.6;}
  .warning{background:rgba(255,165,35,0.1);border:1px solid rgba(255,165,35,0.3);border-radius:8px;padding:12px 16px;font-size:0.82rem;color:#F5A623;margin:16px 0;}
</style></head>
<body><div class="wrap">
<div class="card">
  <div class="logo"><span style="font-weight:700;color:#2D6AFF;">A</span><span style="color:#00C2CB;">C</span>${APP_NAME}</div>
  ${content}
</div>
<div class="footer">
  &copy; ${new Date().getFullYear()} ${APP_NAME} &nbsp;&middot;&nbsp;
  <a href="${FRONTEND_URL}" style="color:#2D6AFF;">Visit Exchange</a><br/>
  This email was sent from ${FROM_EMAIL}. Do not reply to this email.<br/>
  If you did not request this, you can safely ignore it.
</div>
</div></body></html>`;

const TEMPLATES = {
  'email-verify': ({ name, link }) => baseLayout(`
    <h2>Verify your email address</h2>
    <p>Hi ${name}, welcome to ${APP_NAME}! Please verify your email address to activate your account.</p>
    <a href="${link}" class="btn">Verify Email</a>
    <p>Or copy this link: <span style="color:#2D6AFF;word-break:break-all;">${link}</span></p>
    <p>This link expires in 24 hours.</p>
    <div class="warning">${APP_NAME} will never ask for your password or 2FA codes via email.</div>
  `),

  'password-reset': ({ name, link }) => baseLayout(`
    <h2>Reset your password</h2>
    <p>Hi ${name}, we received a request to reset your ${APP_NAME} account password.</p>
    <a href="${link}" class="btn">Reset Password</a>
    <p>This link expires in 1 hour. If you did not request this, your account is safe — just ignore this email.</p>
    <div class="warning">Never share this link with anyone. ${APP_NAME} staff will never ask for it.</div>
  `),

  'deposit-confirmed': ({ name, amount, symbol }) => baseLayout(`
    <h2>Deposit confirmed</h2>
    <p>Hi ${name}, your deposit has been credited to your account.</p>
    <div class="code">+${amount} ${symbol}</div>
    <p>Your balance has been updated. You can now trade with these funds.</p>
    <a href="${FRONTEND_URL}/dashboard.html" class="btn">Go to Dashboard</a>
  `),

  'withdrawal-request': ({ name, amount, symbol, address }) => baseLayout(`
    <h2>Withdrawal request received</h2>
    <p>Hi ${name}, your withdrawal request has been received and is pending review.</p>
    <div class="code">${amount} ${symbol}</div>
    <p><strong>To address:</strong> <span style="font-family:monospace;font-size:0.82rem;color:#8A94A6;">${address}</span></p>
    <p>Our team will process this within 24 hours.</p>
    <div class="warning">If you did not initiate this withdrawal, contact support immediately.</div>
  `),

  'withdrawal-confirmed': ({ name, amount, symbol, txHash }) => baseLayout(`
    <h2>Withdrawal confirmed</h2>
    <p>Hi ${name}, your withdrawal has been processed.</p>
    <div class="code">${amount} ${symbol}</div>
    ${txHash ? `<p><strong>Tx Hash:</strong> <span style="font-family:monospace;font-size:0.8rem;color:#2D6AFF;">${txHash}</span></p>` : ''}
    <p>The funds should arrive in your external wallet shortly.</p>
  `),

  'kyc-approved': ({ name, level }) => baseLayout(`
    <h2>KYC Verified — Level ${level}</h2>
    <p>Hi ${name}, your identity verification has been approved.</p>
    <p>Your account now has KYC Level ${level} access.</p>
    <a href="${FRONTEND_URL}/dashboard.html" class="btn">Start Trading</a>
  `),

  'kyc-rejected': ({ name, reason }) => baseLayout(`
    <h2>KYC Verification — Action Required</h2>
    <p>Hi ${name}, we were unable to verify your identity at this time.</p>
    <p><strong>Reason:</strong> ${reason || 'Documents could not be verified. Please ensure photos are clear and unobstructed.'}</p>
    <a href="${FRONTEND_URL}/profile.html#kyc" class="btn">Resubmit Documents</a>
  `),

  'security-alert': ({ name, action, ip, device, time }) => baseLayout(`
    <h2>Security Alert</h2>
    <p>Hi ${name}, we detected the following activity on your account:</p>
    <div class="code">${action}</div>
    <p><strong>IP Address:</strong> ${ip}<br/>
    <strong>Device:</strong> ${device}<br/>
    <strong>Time:</strong> ${time}</p>
    <p>If this was you, no action is needed. If you do not recognise this, secure your account immediately.</p>
    <a href="${FRONTEND_URL}/profile.html#security" class="btn" style="background:#FF4560;">Secure My Account</a>
  `),
};

// ── SEND EMAIL ────────────────────────────────
async function sendEmail({ to, subject, template, data, html, text }) {
  try {
    const htmlContent = template && TEMPLATES[template]
      ? TEMPLATES[template](data || {})
      : html || `<p>${text || ''}</p>`;

    if (process.env.RESEND_API_KEY) {
      await resend.emails.send({
        from: `${APP_NAME} <${FROM_EMAIL}>`,
        to,
        subject,
        html: htmlContent,
      });
      logger.info(`Email sent to ${to}: ${subject}`);
    } else {
      logger.info(`[EMAIL — DEV MODE] To: ${to} | Subject: ${subject}`);
    }
  } catch (err) {
    logger.error('Email send error:', err.message);
    // Never throw — email failure should not crash the app
  }
}

module.exports = { sendEmail };
