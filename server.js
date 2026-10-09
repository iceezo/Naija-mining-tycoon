'use strict';
/*
  Naija Mining Tycoon server.
  The game itself runs in each player's browser, so this server only handles:
  accounts, Paystack payments, brand ad campaigns, and player chat.
  That keeps the load small and lets you add more copies of this server when you grow.
*/
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Pool } = require('pg');
const L = require('./lib');

const env = process.env;
const PORT = +env.PORT || 3000;
const TOKEN_SECRET = env.TOKEN_SECRET;
const PAYSTACK_SECRET = env.PAYSTACK_SECRET;
const ADMIN_KEY = env.ADMIN_KEY;
const ORIGIN = env.ALLOWED_ORIGIN || '*';
const AUTO_APPROVE = env.AUTO_APPROVE === 'true';
const ROOM_CAP = +env.ROOM_CAP || 500;       // players per chat room copy on one server
const MAX_CONN_IP = +env.MAX_CONN_IP || 20;

if (!TOKEN_SECRET || TOKEN_SECRET.length < 24) { console.error('Set TOKEN_SECRET to 24 or more random characters.'); process.exit(1); }
if (!env.DATABASE_URL) { console.error('Set DATABASE_URL to your Postgres connection string.'); process.exit(1); }
if (!PAYSTACK_SECRET) console.warn('PAYSTACK_SECRET is not set. Payments are switched off.');

const db = new Pool({
  connectionString: env.DATABASE_URL,
  max: +env.PG_POOL || 10,
  ssl: env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS players(id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT, created_at BIGINT NOT NULL, banned BOOLEAN NOT NULL DEFAULT FALSE);
CREATE UNIQUE INDEX IF NOT EXISTS players_name_ci ON players(LOWER(name));
CREATE TABLE IF NOT EXISTS ent(player_id TEXT PRIMARY KEY, boost_until BIGINT NOT NULL DEFAULT 0, no_ads BOOLEAN NOT NULL DEFAULT FALSE, founder BOOLEAN NOT NULL DEFAULT FALSE);
CREATE TABLE IF NOT EXISTS credits(player_id TEXT NOT NULL, sku TEXT NOT NULL, n INT NOT NULL DEFAULT 0, PRIMARY KEY(player_id, sku));
CREATE TABLE IF NOT EXISTS orders(ref TEXT PRIMARY KEY, player_id TEXT NOT NULL, sku TEXT NOT NULL, amount_kobo BIGINT NOT NULL, status TEXT NOT NULL, meta JSONB, created_at BIGINT NOT NULL, paid_at BIGINT);
CREATE INDEX IF NOT EXISTS orders_player ON orders(player_id);
CREATE TABLE IF NOT EXISTS campaigns(id SERIAL PRIMARY KEY, order_ref TEXT UNIQUE, player_id TEXT, format TEXT NOT NULL, brand TEXT NOT NULL, tagline TEXT NOT NULL, url TEXT NOT NULL, contact TEXT, status TEXT NOT NULL, duration_ms BIGINT NOT NULL, starts_at BIGINT, ends_at BIGINT, imps BIGINT NOT NULL DEFAULT 0, clicks BIGINT NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS campaigns_live ON campaigns(status, format);
CREATE TABLE IF NOT EXISTS plans(sku TEXT NOT NULL, mode TEXT NOT NULL, amount BIGINT NOT NULL, code TEXT NOT NULL, PRIMARY KEY(sku, mode, amount));
CREATE INDEX IF NOT EXISTS plans_code ON plans(code);
CREATE TABLE IF NOT EXISTS subs(code TEXT PRIMARY KEY, player_id TEXT NOT NULL, sku TEXT NOT NULL, order_ref TEXT NOT NULL, email_token TEXT, customer_code TEXT, status TEXT NOT NULL, created_at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS subs_player ON subs(player_id);
CREATE INDEX IF NOT EXISTS subs_cust ON subs(customer_code, sku);
CREATE TABLE IF NOT EXISTS reports(id SERIAL PRIMARY KEY, reporter TEXT, target TEXT, ch TEXT, text TEXT, ts BIGINT);
`;

/* ---------- player lookup with a short cache so chat and API do not hammer the database ---------- */
const pcache = new Map();
async function getPlayer(id) {
  const c = pcache.get(id);
  if (c && c.exp > Date.now()) return c.p;
  const r = await db.query(
    'SELECT p.id, p.name, p.banned, COALESCE(e.founder,false) AS founder FROM players p LEFT JOIN ent e ON e.player_id=p.id WHERE p.id=$1', [id]);
  const p = r.rows[0] || null;
  pcache.set(id, { p, exp: Date.now() + 60000 });
  return p;
}

/* ---------- rate limits ---------- */
const rlRegister = new L.RateLimit(5, 3600e3);
const rlPay = new L.RateLimit(10, 3600e3);
const rlEvents = new L.RateLimit(30, 60e3);
const rlAdmin = new L.RateLimit(60, 60e3);

/* ---------- http ---------- */
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Key',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Vary': 'Origin'
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (req, res) => res.json({ ok: true, sockets: wss ? wss.clients.size : 0 }));

/* Paystack webhook. It needs the raw body to check the signature, so it comes before express.json(). */
app.post('/api/paystack/webhook', express.raw({ type: '*/*', limit: '200kb' }), async (req, res) => {
  if (!L.paystackSigOk(req.body, req.headers['x-paystack-signature'], PAYSTACK_SECRET)) return res.sendStatus(401);
  try {
    await handleEvent(JSON.parse(req.body.toString('utf8')));
    res.sendStatus(200);
  } catch (e) { console.error('webhook failed', e); res.sendStatus(500); }  // 500 makes Paystack retry
});

app.use(express.json({ limit: '4kb' }));

async function auth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const id = L.verifyToken(h.startsWith('Bearer ') ? h.slice(7) : '', TOKEN_SECRET);
    if (!id) return res.status(401).json({ error: 'Invalid account key' });
    const p = await getPlayer(id);
    if (!p) return res.status(401).json({ error: 'Account not found' });
    if (p.banned) return res.status(403).json({ error: 'Account suspended' });
    req.player = p;
    next();
  } catch (e) { next(e); }
}
function adminOnly(req, res, next) {
  if (!ADMIN_KEY || !rlAdmin.hit(req.ip) || !L.safeEqual(req.headers['x-admin-key'] || '', ADMIN_KEY)) return res.sendStatus(401);
  next();
}

app.post('/api/register', async (req, res, next) => {
  try {
    if (!rlRegister.hit(req.ip)) return res.status(429).json({ error: 'Too many new accounts from this network. Try later.' });
    const name = req.body && req.body.name;
    if (!L.validName(name)) return res.status(400).json({ error: 'Use 3 to 16 letters, numbers or underscores' });
    const id = crypto.randomUUID();
    try {
      await db.query('INSERT INTO players(id,name,created_at) VALUES($1,$2,$3)', [id, name, Date.now()]);
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'That name is taken. Try another.' });
      throw e;
    }
    await db.query('INSERT INTO ent(player_id) VALUES($1) ON CONFLICT DO NOTHING', [id]);
    res.json({ token: L.signToken(id, TOKEN_SECRET), name });
  } catch (e) { next(e); }
});

app.get('/api/me', auth, async (req, res, next) => {
  try {
    const e = (await db.query('SELECT boost_until, no_ads, founder FROM ent WHERE player_id=$1', [req.player.id])).rows[0] || {};
    const c = await db.query('SELECT sku, n FROM credits WHERE player_id=$1 AND n>0', [req.player.id]);
    const credits = {}; c.rows.forEach(r => { credits[r.sku] = r.n; });
    const sr = await db.query('SELECT s.code, s.sku, s.status, c.brand, c.status AS ad_status, c.ends_at FROM subs s LEFT JOIN campaigns c ON c.order_ref=s.order_ref WHERE s.player_id=$1 ORDER BY s.created_at DESC LIMIT 10', [req.player.id]);
    const subs = sr.rows.map(r => ({ code: r.code, sku: r.sku, status: r.status, brand: r.brand, adStatus: r.ad_status, endsAt: r.ends_at ? Number(r.ends_at) : 0 }));
    res.json({ name: req.player.name, ent: { boostUntil: Number(e.boost_until || 0), noAds: !!e.no_ads, founder: !!e.founder }, credits, subs });
  } catch (e) { next(e); }
});

/* ---------- payments ---------- */
app.post('/api/pay/init', auth, async (req, res, next) => {
  try {
    if (!PAYSTACK_SECRET) return res.status(503).json({ error: 'Payments are not set up yet' });
    if (!rlPay.hit(req.player.id)) return res.status(429).json({ error: 'Too many payment attempts. Try again later.' });
    const { sku, email, brand } = req.body || {};
    const item = L.CATALOG[sku];
    if (!item) return res.status(400).json({ error: 'Unknown item' });
    if (!L.validEmail(email)) return res.status(400).json({ error: 'Enter a valid email' });
    let meta = {};
    if (item.type === 'brand' || item.type === 'sub') {
      const v = L.validBrand(brand);
      if (!v.ok) return res.status(400).json({ error: v.error });
      meta = v.value;
    }
    const ref = L.newRef(), price = L.priceOf(item), kobo = price.minor;
    let plan = null;
    if (item.type === 'sub') {
      try { plan = await planCode(sku); } catch (e) { console.error('plan', e.message); return res.status(502).json({ error: 'Could not set up the plan with Paystack. Check that USD is enabled on your account.' }); }
    }
    await db.query('INSERT INTO orders(ref,player_id,sku,amount_kobo,status,meta,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [ref, req.player.id, sku, kobo, 'pending', JSON.stringify(meta), Date.now()]);
    await db.query('UPDATE players SET email=$2 WHERE id=$1', [req.player.id, email]);
    const r = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + PAYSTACK_SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, amount: kobo, currency: price.currency, reference: ref, metadata: { sku, player: req.player.id }, ...(plan ? { plan, channels: ['card'] } : {}) })
    });
    const j = await r.json().catch(() => ({}));
    if (!j.status || !j.data) return res.status(502).json({ error: 'Paystack could not start the payment' });
    res.json({ reference: ref, access_code: j.data.access_code, authorization_url: j.data.authorization_url });
  } catch (e) { next(e); }
});

app.get('/api/pay/verify/:ref', auth, async (req, res, next) => {
  try {
    const ref = String(req.params.ref).slice(0, 60);
    let o = (await db.query('SELECT * FROM orders WHERE ref=$1 AND player_id=$2', [ref, req.player.id])).rows[0];
    if (!o) return res.status(404).json({ error: 'Order not found' });
    if (o.status !== 'paid' && PAYSTACK_SECRET) {
      const r = await fetch('https://api.paystack.co/transaction/verify/' + encodeURIComponent(ref), { headers: { Authorization: 'Bearer ' + PAYSTACK_SECRET } });
      const j = await r.json().catch(() => ({}));
      await settle(ref, j.data);
      o = (await db.query('SELECT * FROM orders WHERE ref=$1', [ref])).rows[0];
    }
    const item = L.CATALOG[o.sku];
    res.json({ status: o.status === 'paid' ? 'paid' : 'pending', type: item && item.type });
  } catch (e) { next(e); }
});

/* Both the webhook and the verify call end up here. It only ever pays out once per order. */
async function settle(ref, data) {
  const o = (await db.query('SELECT * FROM orders WHERE ref=$1', [ref])).rows[0];
  if (!o || o.status === 'paid') return;
  const item = L.CATALOG[o.sku];
  if (!item || !data || data.status !== 'success' || Number(data.amount) !== Number(o.amount_kobo) || data.currency !== L.priceOf(item).currency) return;
  await fulfill(o);
}
async function fulfill(o) {
  const c = await db.connect();
  let announce = false;
  try {
    await c.query('BEGIN');
    const u = await c.query("UPDATE orders SET status='paid', paid_at=$2 WHERE ref=$1 AND status='pending' RETURNING ref", [o.ref, Date.now()]);
    if (!u.rows.length) { await c.query('ROLLBACK'); return; }
    const item = L.CATALOG[o.sku], now = Date.now(), pid = o.player_id;
    await c.query('INSERT INTO ent(player_id) VALUES($1) ON CONFLICT DO NOTHING', [pid]);
    if (item.type === 'ent') {
      if (item.kind === 'boost') await c.query('UPDATE ent SET boost_until=GREATEST(boost_until,$2)+$3 WHERE player_id=$1', [pid, now, item.ms]);
      else if (item.kind === 'noAds') await c.query('UPDATE ent SET no_ads=TRUE WHERE player_id=$1', [pid]);
      else if (item.kind === 'founder') await c.query('UPDATE ent SET founder=TRUE WHERE player_id=$1', [pid]);
    } else if (item.type === 'credit') {
      await c.query('INSERT INTO credits(player_id,sku,n) VALUES($1,$2,1) ON CONFLICT(player_id,sku) DO UPDATE SET n=credits.n+1', [pid, o.sku]);
    } else if (item.type === 'brand' || item.type === 'sub') {
      const m = o.meta || {};
      await c.query(
        'INSERT INTO campaigns(order_ref,player_id,format,brand,tagline,url,contact,status,duration_ms,starts_at,ends_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [o.ref, pid, item.format, m.brand, m.tagline, m.url, m.contact, AUTO_APPROVE ? 'live' : 'pending', item.ms,
          AUTO_APPROVE ? now : null, AUTO_APPROVE ? now + item.ms : null]);
      announce = AUTO_APPROVE && item.format === 'shout';
    }
    await c.query('COMMIT');
    pcache.delete(pid); adsCache.exp = 0;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { c.release(); }
  if (announce) announceShouts().catch(() => {});
}

app.post('/api/redeem', auth, async (req, res, next) => {
  try {
    const sku = req.body && req.body.sku;
    if (sku !== 'cash_s') return res.status(400).json({ error: 'Nothing to redeem' });
    const r = await db.query('UPDATE credits SET n=n-1 WHERE player_id=$1 AND sku=$2 AND n>0 RETURNING n', [req.player.id, sku]);
    if (!r.rows.length) return res.status(409).json({ error: 'No cash packs left' });
    res.json({ ok: true, left: r.rows[0].n });
  } catch (e) { next(e); }
});

/* ---------- brand plans (auto-renewing subscriptions) ---------- */
const psHeaders = () => ({ Authorization: 'Bearer ' + PAYSTACK_SECRET, 'Content-Type': 'application/json' });
const psMode = () => ((PAYSTACK_SECRET || '').startsWith('sk_live') ? 'live' : 'test');

/* Creates the Paystack plan the first time it is needed, then remembers its code. Test and live keys have separate plans. */
async function planCode(sku) {
  const item = L.CATALOG[sku], price = L.priceOf(item), mode = psMode();
  const find = () => db.query('SELECT code FROM plans WHERE sku=$1 AND mode=$2 AND amount=$3', [sku, mode, price.minor]);
  let q = await find();
  if (q.rows[0]) return q.rows[0].code;
  const r = await fetch('https://api.paystack.co/plan', {
    method: 'POST', headers: psHeaders(),
    body: JSON.stringify({ name: 'Naija Mining Tycoon ' + item.label, interval: item.interval, amount: price.minor, currency: price.currency })
  });
  const j = await r.json().catch(() => ({}));
  if (!j.status || !j.data) throw new Error('Paystack refused to create the plan: ' + (j.message || r.status));
  await db.query('INSERT INTO plans(sku,mode,amount,code) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [sku, mode, price.minor, j.data.plan_code]);
  q = await find();
  return q.rows[0].code;
}

async function handleEvent(ev) {
  const d = (ev && ev.data) || {};
  switch (ev && ev.event) {
    case 'charge.success': {
      if (!d.reference) return;
      const known = (await db.query('SELECT 1 FROM orders WHERE ref=$1', [d.reference])).rows[0];
      if (known) return settle(d.reference, d);                      // the first payment of a purchase
      if (d.plan && d.plan.plan_code) return renew(d);               // an automatic renewal charge
      return;
    }
    case 'subscription.create': return linkSub(d);
    case 'subscription.disable':
    case 'subscription.not_renew': return setSubStatus(d.subscription_code, 'cancelled');
    case 'invoice.payment_failed': return setSubStatus((d.subscription && d.subscription.subscription_code) || d.subscription_code, 'past_due', "status='active'");
  }
}
async function setSubStatus(code, status, onlyIf) {
  if (!code) return;
  await db.query('UPDATE subs SET status=$2 WHERE code=$1' + (onlyIf ? ' AND ' + onlyIf : ''), [code, status]);
}

/* Paystack tells us a subscription exists. Match it to the brand's order by email, plan and time. */
async function linkSub(d) {
  const code = d.subscription_code, token = d.email_token;
  const planCodeIn = d.plan && d.plan.plan_code, email = d.customer && d.customer.email, cust = d.customer && d.customer.customer_code;
  if (!code || !planCodeIn || !email) return;
  if ((await db.query('SELECT 1 FROM subs WHERE code=$1', [code])).rows[0]) return;
  const pl = (await db.query('SELECT sku FROM plans WHERE code=$1', [planCodeIn])).rows[0];
  if (!pl) return;                                                   // not one of our plans
  const o = (await db.query(
    "SELECT o.ref, o.player_id FROM orders o JOIN players p ON p.id=o.player_id " +
    "WHERE LOWER(p.email)=LOWER($1) AND o.sku=$2 AND o.created_at>$3 AND o.status IN ('paid','pending') " +
    "AND NOT EXISTS (SELECT 1 FROM subs s WHERE s.order_ref=o.ref) ORDER BY o.created_at DESC LIMIT 1",
    [email, pl.sku, Date.now() - 864e5])).rows[0];
  if (!o) throw new Error('No order matches subscription ' + code);   // 500 makes Paystack try again later
  await db.query('INSERT INTO subs(code,player_id,sku,order_ref,email_token,customer_code,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING',
    [code, o.player_id, pl.sku, o.ref, token || null, cust || null, 'active', Date.now()]);
}

/* A renewal charge arrived: record it once and push the end date of the ad forward by one period. */
async function renew(d) {
  const pl = (await db.query('SELECT sku FROM plans WHERE code=$1', [d.plan.plan_code])).rows[0];
  if (!pl) return;
  const item = L.CATALOG[pl.sku], price = L.priceOf(item);
  if (Number(d.amount) !== price.minor || d.currency !== price.currency) return;
  const cust = d.customer && d.customer.customer_code;
  const s = (await db.query(
    "SELECT s.* FROM subs s LEFT JOIN campaigns c ON c.order_ref=s.order_ref WHERE s.customer_code=$1 AND s.sku=$2 AND s.status IN ('active','past_due') ORDER BY c.ends_at ASC NULLS LAST LIMIT 1",
    [cust, pl.sku])).rows[0];
  if (!s) throw new Error('Renewal for an unknown subscription');
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const ins = await c.query(
      "INSERT INTO orders(ref,player_id,sku,amount_kobo,status,meta,created_at,paid_at) VALUES($1,$2,$3,$4,'paid',$5,$6,$6) ON CONFLICT DO NOTHING RETURNING ref",
      [d.reference, s.player_id, s.sku, price.minor, JSON.stringify({ renewal_of: s.code }), Date.now()]);
    if (!ins.rows.length) { await c.query('ROLLBACK'); return; }       // already handled
    await c.query("UPDATE campaigns SET ends_at=GREATEST(COALESCE(ends_at,$2),$2)+duration_ms, status='live' WHERE order_ref=$1 AND status IN ('live','ended')", [s.order_ref, Date.now()]);
    await c.query("UPDATE subs SET status='active' WHERE code=$1", [s.code]);
    await c.query('COMMIT');
    adsCache.exp = 0;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { c.release(); }
}

async function cancelAtPaystack(s) {
  let token = s.email_token;
  if (!token) {
    const r = await fetch('https://api.paystack.co/subscription/' + encodeURIComponent(s.code), { headers: psHeaders() });
    const j = await r.json().catch(() => ({}));
    token = j.data && j.data.email_token;
  }
  if (!token) throw new Error('Paystack did not return a cancel token');
  const r = await fetch('https://api.paystack.co/subscription/disable', { method: 'POST', headers: psHeaders(), body: JSON.stringify({ code: s.code, token }) });
  const j = await r.json().catch(() => ({}));
  if (!j.status) throw new Error(j.message || 'Paystack refused to cancel');
  await db.query("UPDATE subs SET status='cancelled' WHERE code=$1", [s.code]);
}
async function ownSub(req) {
  return (await db.query('SELECT * FROM subs WHERE code=$1 AND player_id=$2', [String((req.body && req.body.code) || ''), req.player.id])).rows[0];
}
/* Cancelling stops future charges. The ad keeps running until the period already paid for ends. */
app.post('/api/subs/cancel', auth, async (req, res, next) => {
  try {
    const s = await ownSub(req);
    if (!s) return res.status(404).json({ error: 'Plan not found' });
    if (s.status === 'cancelled') return res.json({ ok: true });
    try { await cancelAtPaystack(s); } catch (e) { console.error('cancel', e.message); return res.status(502).json({ error: 'Paystack could not cancel the plan. Try again shortly.' }); }
    res.json({ ok: true });
  } catch (e) { next(e); }
});
/* A link where the brand can update the card Paystack charges. */
app.post('/api/subs/card', auth, async (req, res, next) => {
  try {
    const s = await ownSub(req);
    if (!s) return res.status(404).json({ error: 'Plan not found' });
    const r = await fetch('https://api.paystack.co/subscription/' + encodeURIComponent(s.code) + '/manage/link', { headers: psHeaders() });
    const j = await r.json().catch(() => ({}));
    if (!j.status || !j.data || !j.data.link) return res.status(502).json({ error: 'Could not get the card page from Paystack' });
    res.json({ link: j.data.link });
  } catch (e) { next(e); }
});

/* ---------- ads ---------- */
const adsCache = { exp: 0, json: '{"ads":[]}' };
async function liveAds() {
  if (adsCache.exp > Date.now()) return adsCache.json;
  const r = await db.query("SELECT id, brand, tagline, url FROM campaigns WHERE status='live' AND format='banner' AND starts_at<=$1 AND ends_at>$1 ORDER BY id", [Date.now()]);
  adsCache.json = JSON.stringify({ ads: r.rows });
  adsCache.exp = Date.now() + 30000;
  return adsCache.json;
}
app.get('/api/ads', async (req, res, next) => {
  try { res.set('Cache-Control', 'public, max-age=60'); res.type('json').send(await liveAds()); } catch (e) { next(e); }
});
/* Players send batched counts about once a minute. Counts are held in memory and flushed in bulk. */
const counters = new Map();
app.post('/api/ads/events', (req, res) => {
  if (!rlEvents.hit(req.ip)) return res.sendStatus(429);
  const b = req.body || {};
  for (const k of ['imps', 'clicks']) {
    const o = b[k];
    if (!o || typeof o !== 'object') continue;
    for (const [id, n] of Object.entries(o).slice(0, 20)) {
      const i = parseInt(id, 10), c = Math.min(50, Math.max(0, parseInt(n, 10) || 0));
      if (!i || !c) continue;
      const e = counters.get(i) || { imps: 0, clicks: 0 };
      e[k] += c; counters.set(i, e);
    }
  }
  res.sendStatus(204);
});
async function flushCounters() {
  if (!counters.size) return;
  const batch = [...counters]; counters.clear();
  for (const [id, e] of batch) {
    try { await db.query('UPDATE campaigns SET imps=imps+$2, clicks=clicks+$3 WHERE id=$1', [id, e.imps, e.clicks]); } catch (err) { console.error('flush', err.message); }
  }
}

/* ---------- admin: review ads, ban players ---------- */
app.get('/admin/campaigns', adminOnly, async (req, res, next) => {
  try {
    const st = ['pending', 'live', 'rejected', 'ended'].includes(req.query.status) ? req.query.status : 'pending';
    const r = await db.query('SELECT * FROM campaigns WHERE status=$1 ORDER BY id DESC LIMIT 100', [st]);
    res.json(r.rows);
  } catch (e) { next(e); }
});
app.post('/admin/campaigns/:id/approve', adminOnly, async (req, res, next) => {
  try {
    const now = Date.now();
    const r = await db.query("UPDATE campaigns SET status='live', starts_at=$2, ends_at=$2+duration_ms WHERE id=$1 AND status='pending' RETURNING format", [+req.params.id, now]);
    if (!r.rows.length) return res.status(404).json({ error: 'No pending campaign with that id' });
    adsCache.exp = 0;
    if (r.rows[0].format === 'shout') announceShouts().catch(() => {});
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.post('/admin/campaigns/:id/reject', adminOnly, async (req, res, next) => {
  try {
    // Refund rejected campaigns from the Paystack dashboard, using the order reference.
    const r = await db.query("UPDATE campaigns SET status='rejected' WHERE id=$1 AND status='pending' RETURNING order_ref", [+req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'No pending campaign with that id' });
    // A rejected plan must not keep charging the brand.
    const sub = (await db.query('SELECT * FROM subs WHERE order_ref=$1', [r.rows[0].order_ref])).rows[0];
    let subCancelled = false;
    if (sub) { try { await cancelAtPaystack(sub); subCancelled = true; } catch (e) { console.error('cancel on reject', e.message); } }
    res.json({ ok: true, refund_reference: r.rows[0].order_ref, subscription_cancelled: subCancelled, subscription_code: sub ? sub.code : null });
  } catch (e) { next(e); }
});
app.get('/admin/reports', adminOnly, async (req, res, next) => {
  try { res.json((await db.query('SELECT * FROM reports ORDER BY id DESC LIMIT 100')).rows); } catch (e) { next(e); }
});
app.post('/admin/ban', adminOnly, async (req, res, next) => {
  try {
    const name = req.body && req.body.name;
    const r = await db.query('UPDATE players SET banned=TRUE WHERE LOWER(name)=LOWER($1) RETURNING id', [String(name || '')]);
    if (!r.rows.length) return res.status(404).json({ error: 'No such player' });
    pcache.clear();
    const set = users.get(String(name).toLowerCase());
    if (set) set.forEach(ws => ws.close(4403, 'Suspended'));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Something went wrong on our side' }); });

/* ---------- chat ---------- */
/*
  Rooms are split into copies of at most ROOM_CAP players ("Global 1", "Global 2", ...).
  A message only goes to the people in the same copy, so 100,000 players never share one firehose.
  With REDIS_URL set, several servers share the same copies through Redis pub/sub.
*/
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 2048, perMessageDeflate: false });
const shards = new Map();     // 'global:1' -> Set of sockets
const history = new Map();    // 'global:1' -> last 50 messages
const users = new Map();      // lowercase name -> Set of sockets
const ipConns = new Map();
let redisPub = null;

function send(ws, o) {
  if (ws.readyState === 1 && ws.bufferedAmount < 1e6) ws.send(typeof o === 'string' ? o : JSON.stringify(o));
}
function assignShard(base) {
  for (let i = 1; ; i++) {
    const s = shards.get(base + ':' + i);
    if (!s || s.size < ROOM_CAP) return base + ':' + i;
  }
}
function leave(ws) {
  const k = ws.meta.key;
  if (!k) return;
  const s = shards.get(k);
  if (s) { s.delete(ws); if (!s.size) shards.delete(k); }
  ws.meta.key = null; ws.meta.base = null;
}
function pushHistory(key, m) {
  let h = history.get(key);
  if (!h) { h = []; history.set(key, h); }
  h.push(m); if (h.length > 50) h.shift();
}
function fan(set, payload) { if (set) for (const ws of set) send(ws, payload); }

function deliver(o) {
  if (o.k === 'msg') {
    pushHistory(o.key, o.m);
    fan(shards.get(o.key), JSON.stringify({ t: 'msg', ch: o.key.split(':')[0], m: o.m }));
  } else if (o.k === 'dm') {
    const payload = JSON.stringify({ t: 'dm', from: o.from, to: o.to, text: o.text, ts: o.ts });
    const sent = new Set();
    for (const n of [o.to, o.from]) {
      const lc = n.toLowerCase();
      if (sent.has(lc)) continue;
      sent.add(lc); fan(users.get(lc), payload);
    }
  } else if (o.k === 'shout') {
    const m = { sys: true, text: o.text, ts: Date.now() };
    for (const [key, set] of shards) {
      if (!key.startsWith('global:')) continue;
      pushHistory(key, m);
      fan(set, JSON.stringify({ t: 'msg', ch: 'global', m }));
    }
  }
}
const bus = { publish(o) { if (redisPub) redisPub.publish('nmt', JSON.stringify(o)); else deliver(o); } };
if (env.REDIS_URL) {
  const Redis = require('ioredis');
  redisPub = new Redis(env.REDIS_URL);
  const sub = new Redis(env.REDIS_URL);
  sub.subscribe('nmt');
  sub.on('message', (ch, msg) => { try { deliver(JSON.parse(msg)); } catch (e) { /* ignore bad data */ } });
}

async function announceShouts() {
  if (redisPub) {  // only one server announces
    const got = await redisPub.set('nmt:shout-lock', '1', 'EX', 540, 'NX');
    if (got !== 'OK') return;
  }
  const r = await db.query("SELECT brand, tagline, url FROM campaigns WHERE status='live' AND format='shout' AND starts_at<=$1 AND ends_at>$1", [Date.now()]);
  r.rows.forEach(c => bus.publish({ k: 'shout', text: `Sponsored: ${c.brand} says ${c.tagline} (${c.url})` }));
}

server.on('upgrade', async (req, socket, head) => {
  try {
    const u = new URL(req.url, 'http://x');
    if (u.pathname !== '/ws') return socket.destroy();
    if (ORIGIN !== '*' && req.headers.origin !== ORIGIN) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy(); }
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    if ((ipConns.get(ip) || 0) >= MAX_CONN_IP) { socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n'); return socket.destroy(); }
    const id = L.verifyToken(u.searchParams.get('token') || '', TOKEN_SECRET);
    const p = id && await getPlayer(id);
    if (!p || p.banned) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
    wss.handleUpgrade(req, socket, head, ws => {
      ws.meta = { id: p.id, name: p.name, founder: !!p.founder, ip, key: null, base: null, last: Date.now(), tokens: 5, alive: true };
      wss.emit('connection', ws, req);
    });
  } catch (e) { socket.destroy(); }
});

wss.on('connection', ws => {
  const m = ws.meta, lc = m.name.toLowerCase();
  ipConns.set(m.ip, (ipConns.get(m.ip) || 0) + 1);
  if (!users.has(lc)) users.set(lc, new Set());
  users.get(lc).add(ws);
  ws.on('pong', () => { ws.meta.alive = true; });
  ws.on('message', raw => onMessage(ws, raw));
  ws.on('error', () => {});
  ws.on('close', () => {
    leave(ws);
    const s = users.get(lc); if (s) { s.delete(ws); if (!s.size) users.delete(lc); }
    const n = (ipConns.get(m.ip) || 1) - 1; if (n <= 0) ipConns.delete(m.ip); else ipConns.set(m.ip, n);
  });
  send(ws, { t: 'online', n: wss.clients.size });
});

function onMessage(ws, raw) {
  let d;
  try { d = JSON.parse(raw.toString()); } catch (e) { return; }
  if (!d || typeof d !== 'object') return;
  const m = ws.meta, now = Date.now();
  m.tokens = Math.min(5, m.tokens + (now - m.last) / 1200); m.last = now;   // about one action per 1.2 seconds
  if (m.tokens < 1) return send(ws, { t: 'err', text: 'Slow down a little.' });
  m.tokens -= 1;

  if (d.t === 'join') {
    if (!L.ROOMS.includes(d.ch)) return;
    leave(ws);
    const key = assignShard(d.ch);
    if (!shards.has(key)) shards.set(key, new Set());
    shards.get(key).add(ws);
    m.key = key; m.base = d.ch;
    send(ws, { t: 'hist', ch: d.ch, shard: +key.split(':')[1], msgs: history.get(key) || [] });
  } else if (d.t === 'say') {
    if (!m.key || d.ch !== m.base) return;
    const text = L.cleanChat(d.text);
    if (!text) return;
    bus.publish({ k: 'msg', key: m.key, m: { id: crypto.randomBytes(4).toString('hex'), name: m.name, text, ts: now, badge: m.founder ? 1 : 0 } });
  } else if (d.t === 'dm') {
    const to = typeof d.to === 'string' ? d.to.trim() : '';
    const text = L.cleanChat(d.text);
    if (!L.validName(to) || !text) return;
    if (!redisPub && !users.has(to.toLowerCase())) return send(ws, { t: 'err', text: `${to} is not online.` });
    bus.publish({ k: 'dm', from: m.name, to, text, ts: now });
  } else if (d.t === 'report') {
    const target = typeof d.name === 'string' ? d.name.trim().slice(0, 16) : '';
    if (!L.validName(target)) return;
    const last = (history.get(m.key) || []).filter(x => x.name && x.name.toLowerCase() === target.toLowerCase()).pop();
    db.query('INSERT INTO reports(reporter,target,ch,text,ts) VALUES($1,$2,$3,$4,$5)', [m.name, target, m.key, last ? last.text : null, now]).catch(() => {});
  }
}

/* ---------- housekeeping ---------- */
setInterval(() => {   // drop dead connections
  for (const ws of wss.clients) {
    if (!ws.meta.alive) { ws.terminate(); continue; }
    ws.meta.alive = false; try { ws.ping(); } catch (e) { /* ignore */ }
  }
}, 30000);
setInterval(() => { const p = JSON.stringify({ t: 'online', n: wss.clients.size }); for (const ws of wss.clients) send(ws, p); }, 20000);
setInterval(() => { rlRegister.sweep(); rlPay.sweep(); rlEvents.sweep(); rlAdmin.sweep(); for (const [k, v] of pcache) if (v.exp < Date.now()) pcache.delete(k); }, 60000);
setInterval(flushCounters, 30000);
setInterval(() => announceShouts().catch(e => console.error('shout', e.message)), 600000);
setInterval(() => db.query("UPDATE campaigns SET status='ended' WHERE status='live' AND ends_at<$1", [Date.now()]).catch(() => {}), 300000);

async function start() {
  await db.query(SCHEMA);
  server.listen(PORT, () => console.log('Naija Mining Tycoon server on port ' + PORT));
}
start().catch(e => { console.error('Failed to start', e); process.exit(1); });

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    console.log('Shutting down');
    await flushCounters().catch(() => {});
    wss.clients.forEach(ws => ws.close(1001, 'Server restarting'));
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
process.on('unhandledRejection', e => console.error('unhandledRejection', e));
