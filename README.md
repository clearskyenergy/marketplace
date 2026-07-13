# ClearSky-OMEGA · Distribution Marketplace

A three-role materials procurement + fulfillment portal that sits alongside your
Financing Partners Portal. **Developers** submit material requests (BOM export +
PDF plan set + optional data file, modeled on the Rexel Job Information Sheet),
pick a distributor, and browse/shop per-distributor catalogs via a cart.
**Distributors** receive projects, price them, send payment-link invoices, and
manage shipping + a product catalog. **Admins** (you) onboard distributors.

## Files

| File | Purpose |
|---|---|
| `index.html` | Shell + full ClearSky CSS design system. Loads Firebase compat SDK, `firebase-config.js`, `app.js`. |
| `app.js` | All logic (ES5, ~2,060 lines, `node --check` clean). |
| `firestore.rules` | **Full merged ruleset** — preserves OMEGA `/projects`, `fin_*`, allowlist, admin/tools/meta/toolData, and adds `mkt_*`. |
| `firebase-config.js` | Config template — drop in the `clearsky-portal` web apiKey + appId. |

## Deploy (per your tenant-portal recipe)

1. **New GitHub repo** under `clearskyenergy/` (e.g. `clearsky-marketplace`), auto-deploying to Vercel at a subdomain like `marketplace.csebuilders.com` or `distribution.csebuilders.com`.
2. Add the four files above. Fill in `firebase-config.js` with the `clearsky-portal` **web API key** and **appId** (same project you already use; `projectId: clearsky-portal`, `messagingSenderId: 742134484347`).
3. **Enable Firebase Storage** on `clearsky-portal` if not already — BOM/PDF/data uploads go to `mkt_projects/{pid}/...`. (Storage has its own rules; lock reads/writes to signed-in users targeting the project's own path.)
4. **Deploy the merged `firestore.rules`.** ⚠️ Deploying replaces the *entire* database's rules, so use THIS file (it keeps all your existing OMEGA + financing rules). Diff it against your live rules before pushing if you've changed them recently.
5. First login with a `@csebuilders.com` / `@clearsky-usa.com` email → you're auto-granted **admin**. Open **Admin → Onboard distributor** (e.g. name "Rexel Energy Solutions", id `rexel-energy`), then use the allowlist box to add the distributor rep's email bound to that id.
6. The rep registers (or Googles in) with that email → they land as a **distributor** bound to `rexel-energy`, and can build their catalog. Any other email self-registers as a **developer**.

## Data model (`mkt_*` in shared clearsky-portal Firestore)

- `mkt_profiles/{uid}` — role (developer|distributor|admin), distributorId
- `mkt_distributors/{distId}` — name, slug, active, apiEnabled, apiUrl → `/catalog/{productId}`
- `mkt_projects/{projectId}` — Rexel intake fields, cartItems[], docs{bom,pdf,data}, status
  - `/quote/current`, `/invoice/current`, `/messages/{msgId}`

Lifecycle: **submitted → accepted → quoted → invoiced → paid → fulfilled** (or declined).

## Invoicing (Stripe-ready)

Invoices currently use a **pasted external payment link** (Stripe / Square / QuickBooks).
The `mkt_projects/{id}/invoice/current` doc reserves `stripeSessionId` and
`stripePaymentIntent` (null placeholders). To go full-Stripe later, add an
`api/stripe.js` Vercel serverless function (same pattern as your `api/monday.js`):
it creates a Checkout Session server-side (secret key stays server-side) and a
webhook flips `paid: true` via the Firebase Admin SDK, which bypasses the client
rules. No schema change needed on the client.

## Distributor availability API

Each distributor record stores an optional `apiUrl`. Wire live stock sync later
through a serverless proxy (again like `api/monday.js`) that pulls availability
and writes `stockStatus` / `stockQty` onto the catalog products.

## House-style constraints honored

ES5 only (no arrow/template/let/const/optional-chaining/async-await), `["catch"]`
/`["delete"]` bracket notation, Firebase compat v8 from gstatic CDN, single-file
HTML + separate `app.js`, no build step, `node --check` verified.
