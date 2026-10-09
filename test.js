'use strict';
const assert = require('assert');
const crypto = require('crypto');
const L = require('./lib');

const secret = 'a'.repeat(32);

// tokens
const t = L.signToken('player-123', secret);
assert.strictEqual(L.verifyToken(t, secret), 'player-123');
assert.strictEqual(L.verifyToken(t, 'b'.repeat(32)), null);
assert.strictEqual(L.verifyToken(t.slice(0, -2) + 'xx', secret), null);
assert.strictEqual(L.verifyToken('garbage', secret), null);
assert.strictEqual(L.verifyToken(null, secret), null);
assert.strictEqual(L.verifyToken('a.b.c', secret), null);

// names and email
assert(L.validName('Isaac_01'));
assert(!L.validName('ab'));
assert(!L.validName('has space'));
assert(!L.validName('<script>'));
assert(L.validEmail('a@b.co'));
assert(!L.validEmail('nope'));

// chat cleaning
assert.strictEqual(L.cleanChat('hello   world'), 'hello world');
assert.strictEqual(L.cleanChat('visit https://spam.example/x now'), 'visit [link removed] now');
assert.strictEqual(L.cleanChat('www.spam.com'), '[link removed]');
assert.strictEqual(L.cleanChat('a\u0000b\u202Ec'), 'a b c');
assert.strictEqual(L.cleanChat('x'.repeat(500)).length, 200);
assert.strictEqual(L.cleanChat(42), '');

// brand validation
const good = { brand: 'Kano Cement', tagline: 'Strong builds start here', url: 'https://kanocement.example.com/promo', contact: 'ads@kanocement.example.com' };
assert(L.validBrand(good).ok);
assert(!L.validBrand({ ...good, url: 'http://insecure.example.com' }).ok);
assert(!L.validBrand({ ...good, url: 'javascript:alert(1)' }).ok);
assert(!L.validBrand({ ...good, url: 'https://127.0.0.1/x' }).ok);
assert(!L.validBrand({ ...good, url: 'https://localhost/x' }).ok);
assert(!L.validBrand({ ...good, url: 'https://user:pw@example.com/' }).ok);
assert(!L.validBrand({ ...good, brand: 'x' }).ok);
assert(!L.validBrand({ ...good, contact: 'bad' }).ok);
assert(!L.validBrand(null).ok);
assert.strictEqual(L.validBrand({ ...good, brand: '<b>Acme</b>' }).value.brand, 'bAcme/b');

// paystack signature
const body = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: 'x' } }));
const sig = crypto.createHmac('sha512', 'sk_test_abc').update(body).digest('hex');
assert(L.paystackSigOk(body, sig, 'sk_test_abc'));
assert(!L.paystackSigOk(body, sig, 'sk_test_other'));
assert(!L.paystackSigOk(body, 'deadbeef', 'sk_test_abc'));
assert(!L.paystackSigOk(body, undefined, 'sk_test_abc'));
assert(!L.paystackSigOk(body.toString(), sig, 'sk_test_abc'));

// catalog sanity: every item has a positive whole-naira price and a known type
for (const [id, it] of Object.entries(L.CATALOG)) {
  const pr = L.priceOf(it);
  assert(Number.isInteger(pr.major) && pr.major > 0 && ['NGN', 'USD'].includes(pr.currency), id + ' price');
  assert(['ent', 'credit', 'brand', 'sub'].includes(it.type), id + ' type');
  if (it.type === 'brand' || it.type === 'sub') assert(it.ms > 0 && ['banner', 'shout'].includes(it.format), id + ' brand');
  if (it.type === 'sub') assert(['monthly', 'annually'].includes(it.interval), id + ' interval');
}

// brand plans: $500 a month or $5,000 a year, both auto-renewing
const bm = L.CATALOG.brand_monthly, by = L.CATALOG.brand_yearly;
assert.deepStrictEqual(L.priceOf(bm), { minor: 50000, currency: 'USD', major: 500 });
assert.deepStrictEqual(L.priceOf(by), { minor: 500000, currency: 'USD', major: 5000 });
assert.strictEqual(bm.type, 'sub'); assert.strictEqual(bm.interval, 'monthly');
assert.strictEqual(by.interval, 'annually');
assert.strictEqual(bm.ms, 30 * 24 * 3600e3);
assert.strictEqual(by.ms, 365 * 24 * 3600e3);
assert(by.usd < bm.usd * 12);
assert.deepStrictEqual(L.priceOf(L.CATALOG.boost_24h), { minor: 50000, currency: 'NGN', major: 500 });

// references are unique
const refs = new Set(Array.from({ length: 1000 }, () => L.newRef()));
assert.strictEqual(refs.size, 1000);

// rate limiter
const rl = new L.RateLimit(3, 1000);
assert(rl.hit('a') && rl.hit('a') && rl.hit('a'));
assert(!rl.hit('a'));
assert(rl.hit('b'));

console.log('All server logic tests passed.');
