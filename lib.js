'use strict';
const crypto = require('crypto');

const HOUR = 3600e3;

/* The server is the only source of truth for prices. The client never sends an amount. */
const CATALOG = {
  boost_24h:   { type: 'ent',    kind: 'boost',   ngn: 500,   ms: 24 * HOUR, label: 'Gold Rush boost' },
  cash_s:      { type: 'credit',                   ngn: 300,                  label: 'Cash pack' },
  no_ads:      { type: 'ent',    kind: 'noAds',   ngn: 1500,                 label: 'Ad-free' },
  founder:     { type: 'ent',    kind: 'founder', ngn: 5000,                 label: 'Founder status' },
  /* Auto-renewing brand plans. Paystack charges the card again at the end of each period until the brand cancels. */
  brand_monthly: { type: 'sub', format: 'banner', usd: 500,  interval: 'monthly',  ms: 30 * 24 * HOUR,  label: 'Brand promotion, monthly plan' },
  brand_yearly:  { type: 'sub', format: 'banner', usd: 5000, interval: 'annually', ms: 365 * 24 * HOUR, label: 'Brand promotion, yearly plan' }
};

/* Price in the smallest unit (kobo or cents) and its currency. NGN items use ngn, dollar items use usd. */
function priceOf(item) {
  if (item.usd) return { minor: item.usd * 100, currency: 'USD', major: item.usd };
  return { minor: item.ngn * 100, currency: 'NGN', major: item.ngn };
}

const ROOMS = ['global', 'trade', 'help'];

/* ----- tokens: id.signature, no passwords, no cookies ----- */
function signToken(id, secret) {
  const p = Buffer.from(String(id)).toString('base64url');
  const s = crypto.createHmac('sha256', secret).update(p).digest('base64url');
  return p + '.' + s;
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function verifyToken(token, secret) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const expect = crypto.createHmac('sha256', secret).update(parts[0]).digest('base64url');
  if (!safeEqual(parts[1], expect)) return null;
  try { return Buffer.from(parts[0], 'base64url').toString(); } catch (e) { return null; }
}

/* ----- text hygiene ----- */
const stripCtl = s => String(s).replace(/[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E]/g, ' ');
function validName(n) { return typeof n === 'string' && /^[A-Za-z0-9_]{3,16}$/.test(n); }
function validEmail(e) { return typeof e === 'string' && e.length <= 120 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e); }
function cleanChat(t) {
  if (typeof t !== 'string') return '';
  t = stripCtl(t).replace(/\s+/g, ' ').trim().slice(0, 200);
  return t.replace(/(https?:\/\/|www\.)\S+/gi, '[link removed]');
}
function cleanField(t, max) {
  if (typeof t !== 'string') return '';
  return stripCtl(t).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function validBrand(b) {
  if (!b || typeof b !== 'object') return { ok: false, error: 'Brand details are missing' };
  const brand = cleanField(b.brand, 40), tagline = cleanField(b.tagline, 80);
  const contact = typeof b.contact === 'string' ? b.contact.trim() : '';
  if (brand.length < 2) return { ok: false, error: 'Brand name needs at least 2 characters' };
  if (tagline.length < 5) return { ok: false, error: 'Tagline needs at least 5 characters' };
  if (!validEmail(contact)) return { ok: false, error: 'Enter a valid contact email' };
  let u;
  try { u = new URL(String(b.url || '').trim()); } catch (e) { return { ok: false, error: 'Enter a full link starting with https://' }; }
  if (u.protocol !== 'https:' || u.href.length > 200) return { ok: false, error: 'Links must start with https://' };
  if (!u.hostname.includes('.') || /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname) || u.hostname === 'localhost' || u.username || u.password)
    return { ok: false, error: 'Use your brand website address, not an IP or local address' };
  return { ok: true, value: { brand, tagline, url: u.href, contact } };
}

/* ----- Paystack ----- */
function paystackSigOk(rawBody, signature, secret) {
  if (!secret || !signature || !Buffer.isBuffer(rawBody)) return false;
  const h = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
  return safeEqual(h, signature);
}
const newRef = () => 'NMT_' + crypto.randomBytes(9).toString('hex');

/* ----- small fixed-window rate limiter ----- */
class RateLimit {
  constructor(max, windowMs) { this.max = max; this.win = windowMs; this.m = new Map(); }
  hit(key) {
    const now = Date.now();
    let e = this.m.get(key);
    if (!e || now > e.reset) { e = { n: 0, reset: now + this.win }; this.m.set(key, e); }
    e.n++;
    return e.n <= this.max;
  }
  sweep() { const now = Date.now(); for (const [k, e] of this.m) if (now > e.reset) this.m.delete(k); }
}

module.exports = { CATALOG, priceOf, ROOMS, signToken, verifyToken, safeEqual, validName, validEmail, cleanChat, cleanField, validBrand, paystackSigOk, newRef, RateLimit };
