# Naija Mining Tycoon server

The game runs in each player's browser, so the server only does four jobs: player accounts, Paystack payments, brand ad campaigns and chat. This is what lets many players play at once without slowing each other down.

## What you need

- A Paystack account with your business verified for live payments (paystack.com)
- A host for the server (Render, Railway, Fly.io or a VPS) with Node 18 or newer
- A Postgres database (most hosts offer one)
- A place to host the game page (GitHub Pages, Vercel, Netlify)

## Set it up

1. Put the `server` folder in its own GitHub repo and create a web service on your host.
   Build command: `npm install`. Start command: `npm start`.
2. Create a Postgres database and copy its connection string into `DATABASE_URL`.
3. Add the other settings from `.env.example` to the host's environment settings.
   Start with a Paystack **test** secret key (`sk_test_...`) and switch to the live key when you are happy.
4. In the Paystack dashboard, open Settings, then API Keys & Webhooks, and set the webhook URL to
   `https://YOUR-SERVER/api/paystack/webhook`.
5. Open `naija-mining-tycoon.html`, find the line `const CFG={API:'' ...` near the top of the script, and set
   `API:'https://YOUR-SERVER'`. Host the page, then set `ALLOWED_ORIGIN` on the server to the page's address.
6. Test with Paystack's test cards before going live. Check that a test payment shows up in the player's account,
   and that a brand ad appears in `/admin/campaigns` waiting for review.

## Brand plans: monthly or yearly, auto-renewing, cancel any time

Brands choose a plan in the Shop tab:

- **Monthly:** $500, renews every month
- **Yearly:** $5,000, renews every year (two months free, which is my suggested price)

To change a price, edit `brand_monthly` or `brand_yearly` in `lib.js` and the matching list in the game page. The server creates the Paystack plan itself the first time someone subscribes, so you do not make plans in the dashboard.

How it works:

1. The brand pays the first charge by card. Paystack then charges the same card again each period.
2. Each paid period adds time to the ad. If a renewal fails, the ad stops when the paid time runs out.
3. **Cancel plan** in the game stops future charges. The ad keeps running until the end of the period already paid for.
4. **Update card** opens Paystack's page where the brand can change its card.
5. If you reject an ad in review, the server also cancels its plan so the brand is not charged again. Refund the first charge from the Paystack dashboard.

Things to know:

- Paystack only auto-renews card payments, so plan checkouts allow cards only.
- Dollar payments need USD switched on for your Paystack business. Ask Paystack support, then confirm with a test subscription.
- Test and live keys have separate plans. The server keeps them apart, so switching keys needs no clean-up.
- Renewals use the brand's email. If one email owns several plans of the same type, renewals attach to the plan due soonest.
- Paystack sends renewal, cancel and failed-payment events to the same webhook URL you already set. Nothing else to configure.
- I could not run this against Paystack from here. Test a full cycle with test cards before going live: subscribe, cancel, and check the Paystack dashboard shows the plan as cancelled. Paystack's test mode lets you check renewals, but check its docs for how to trigger one.

## How money flows

- The game page never sends a price. It sends an item id, and the server looks up the price in `lib.js`.
- The server asks Paystack to start the payment, the player pays in Paystack's secure window, and the server
  confirms the payment with Paystack before granting anything. Both the webhook and the verify call lead to
  one function that pays out once per order, so a repeated message never double-grants.
- To change prices or add items, edit `CATALOG` in `lib.js` and the matching list in the game page (the page list is only for display).

## Reviewing brand ads

Brand ads wait for your approval (`AUTO_APPROVE=false`). Use your `ADMIN_KEY`:

```
curl -H "X-Admin-Key: YOUR_KEY" https://YOUR-SERVER/admin/campaigns
curl -X POST -H "X-Admin-Key: YOUR_KEY" https://YOUR-SERVER/admin/campaigns/12/approve
curl -X POST -H "X-Admin-Key: YOUR_KEY" https://YOUR-SERVER/admin/campaigns/12/reject
```

Rejecting does not refund by itself. Refund from the Paystack dashboard using the reference the reject call returns.
Publish simple ad rules for brands (no adult, gambling or misleading content, https links only) and a refund policy.

Chat reports and bans:

```
curl -H "X-Admin-Key: YOUR_KEY" https://YOUR-SERVER/admin/reports
curl -X POST -H "X-Admin-Key: YOUR_KEY" -H "Content-Type: application/json" -d '{"name":"SomePlayer"}' https://YOUR-SERVER/admin/ban
```

## Growing to many players

- Chat rooms split into copies of 500 players (`ROOM_CAP`), so a message only reaches the players in the same copy.
- Add more copies of the server behind your host's load balancer and set `REDIS_URL` so all copies share chat.
- Put a CDN (Cloudflare's free plan works) in front of the server. `/api/ads` is cached for a minute, so most ad requests never touch your server.
- Ad views and clicks are batched by the game and written to the database in bulk every 30 seconds.
- Before launch, load test with a tool like Artillery or k6 using many WebSocket connections, and watch memory and database connections.

## Things to know

- Accounts use a secret account key stored in the player's browser. Players can copy it from the Chat tab to move devices. Add Google or phone login later if you want recovery without the key.
- Game progress is saved on the player's device, not on the server, so a determined player can edit their own save. Chat, payments and ads are protected on the server, but there is no server-checked leaderboard yet.
- You collect names, emails and payment references. Nigeria's data protection law applies, so publish a privacy notice and keep only what you need.
- Paystack fees come out of each payment.
- Google AdSense does not allow ads inside every kind of game page. Check its policies, or keep selling direct brand slots as built here.
