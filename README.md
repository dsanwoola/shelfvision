# ShelfVision — AI Kiosk Inventory Counts for ERPNext 15

Point a phone at a kiosk shelf, pan across it once (live or as a recorded video), and get a
per-item count pushed into ERPNext as a draft **Stock Reconciliation** — the Stock-module
doctype ERPNext 15 uses for physical inventory counts and POS warehouse reconciliation.

Everything runs **on-device** in the browser (TensorFlow.js): no cloud AI, no per-frame API
costs, works offline after the first load, and shelf footage never leaves the phone.

## How it works

1. **Train** — pick an item (synced from ERPNext or typed in), hold one unit in front of the
   camera and capture 8–15 samples from different angles. The largest detected object in the
   frame is auto-cropped and embedded with MobileNet v2; embeddings are stored in IndexedDB
   and classified with a cosine-similarity k-NN — no server-side training step.
2. **Audit** — staff select the kiosk warehouse and either scan live or upload a recorded
   video of the shelf. Each sampled frame goes through COCO-SSD object localisation, every
   box is identified by the trained classifier, and an IoU tracker follows each physical unit
   across frames so a slow pan counts every unit exactly once. Unrecognised objects are
   tallied separately so nothing is silently missed.
3. **Review & reconcile** — edit quantities, see the variance against live ERPNext bin
   levels (Δ column), then push. The app creates a **draft** Stock Reconciliation via the
   REST API so a supervisor reviews and submits it inside ERPNext before the ledger moves.
   CSV export and local audit history are also available.

> **Integration status:** verified end-to-end against a live ERPNext 15 (v15 Docker images,
> site `frontend`) on 2026-07-07 — connection/auth, item & warehouse sync, live variance
> against Bin, and a pushed count that created draft `MAT-RECO-2026-00001`; after supervisor
> submit, warehouse Bin quantities matched the app's counts exactly.

## Running it

Static app — serve the folder over HTTP (camera needs `localhost` or HTTPS):

```
npx serve -l 4173 .
```

Or use the bundled dev server that also **proxies `/api/*` to ERPNext on the same origin**
(no CORS setup needed — in the app Settings, use this server's own URL as the Site URL):

```
python dev-proxy.py 4180 https://erp.mycompany.com
```

Then open http://localhost:4173. For kiosk phones, deploy to any static host with HTTPS
(Cloudflare Pages / GitHub Pages) and "Add to Home Screen" — it's an installable PWA and the
service worker caches the app **and the AI models** for offline use after the first run.

Self-test of the counting/classification logic: open `index.html?selftest=1` and check the
console for `SELFTEST PASS`.

## ERPNext 15 setup

1. Create an API user with **Stock Manager** role; generate key/secret under
   *User → Settings → API Access*.
2. If the app is not served from the ERPNext domain, allow CORS on the site:
   `bench --site yoursite set-config allow_cors "https://your-app-origin"` (or `"*"` for testing).
3. In the app's **Settings** tab: enter Site URL, API key/secret → *Test connection*
   (auto-fills Company) → *Sync items & warehouses*.
4. Per audit, pick the kiosk's warehouse; pushed counts arrive as draft
   `Stock Reconciliation` documents (Stock → Stock Reconciliation) with an audit remark.

API endpoints used: `frappe.auth.get_logged_user` (test), `Item`, `Warehouse`, `Company`,
`Bin` (variance), `Account`, `Stock Reconciliation` (POST draft).

First count of an item with no stock history is an *opening entry* in ERPNext — the app
detects that rejection and automatically retries with the company's **Temporary Opening**
account as the difference account. Brand-new items still need a valuation rate entered in
ERPNext before the draft can be submitted (deliberate: supervisors control valuation).

> The API secret is kept in the browser's localStorage — use a dedicated least-privilege
> API user, not an administrator account.

## Files

- `index.html`, `css/style.css` — mobile-first PWA shell (Audit / Train / History / Settings)
- `js/ai.js` — TF.js pipeline: MobileNet embeddings, k-NN classifier, COCO-SSD localisation
- `js/tracker.js` — cross-frame IoU tracker with vote-weighted labels (pure logic, tested)
- `js/app.js` — views, live scan loop, video-file analysis, review table
- `js/erpnext.js` — ERPNext 15 REST client (token auth)
- `js/db.js` — IndexedDB (catalog, training samples, audit history) + backup export/import
- `js/selftest.js` — logic self-tests (`?selftest=1`)
- `sw.js`, `manifest.json`, `icon.svg` — offline/PWA layer
- `dev-proxy.py` — optional dev server with same-origin `/api` proxy to ERPNext (no CORS)

## Local test instance

A disposable ERPNext 15 test instance (used to verify this integration) runs in WSL Ubuntu
via Docker (`/opt/erpnext/pwd.yml`, images pinned to `frappe/erpnext:v15`):

```
wsl -d Ubuntu -u root -- docker compose -f /opt/erpnext/pwd.yml -p erpnext up -d
```

Site `frontend` on http://localhost:8080 — web login `Administrator` / `admin`,
API token `shelfvision:shelfvision-secret-2026`, company **Deen Kiosks Ltd**, warehouse
**Kiosk 1 - DKL**, four `KIOSK-*` test items. Note: WSL shuts down idle distros, which
stops the containers — rerun the command above (or keep a WSL shell open) to bring it back.

## Counting tips

- Pan **slowly, one pass**, holding the phone ~40–60 cm from the shelf.
- Train each product with 8–15 samples including the angle it sits at on the shelf.
- Raise *Match strictness* in Settings if lookalike products get confused; lower it if
  trained items show as "unrecognised".
- Items stacked behind each other can only be counted if visible — count deep rows with
  one pass per row, or adjust in the review screen.
