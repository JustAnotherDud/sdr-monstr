# SDR → MNST

One-screen PWA that turns deposit-return bottles into Monster Beverage
(`MNST`) stock.

In Portugal a returned bottle is worth €0.10. The app logs each batch, adds
up the cash and, once there is at least €1, records a stock buy. A progress
bar tracks a 14-day cycle anchored on the date of the last buy. Single user,
one Supabase project, no build step.

## Whole euros

You buy in whole euros, so a buy always floors the total. On "Mark as
invested", `floor(total)` goes to `investments` and the cents left over go
back into `bottle_log` as a row with `source: 'carry'`. That row seeds the
next cycle's total and shows in the log as "carried over".

## Sources

Picked with the buttons in "Add bottles":

| Source | Meaning |
|---|---|
| `profit` | found on the street or in a bin, or the machine over-counted |
| `deposit` | your own bottles, or returned for someone else |

`carry` (see above) and `seed` (opening balance) are written by the app or by
hand, not picked.

## Data model (Supabase)

- **`bottle_log`**: `qty`, `source`, `value`, `unit_value`, `logged_date`,
  `created_at`, `invested_at`. `invested_at` is null until a buy; a buy
  stamps all pending rows with the same time.
- **`investments`**: `invested_at`, `amount` (whole euros), `share_price` and
  `shares` (both optional), `note` (unused), `created_at`.

## Running it

Static site: `index.html`, `sw.js`, `manifest.json` and `icons/`. Serve the
folder from any static host (GitHub Pages, or `python -m http.server`).

On first load it asks for the Supabase project URL, an anon or publishable
key, and the owner's email and password (Supabase Auth,
`signInWithPassword`). URL and key go to `localStorage` only after they give a
valid session. RLS on `bottle_log` and `investments` admits only that user, so
the key alone reads nothing. The session persists and auto-refreshes; without
one the app stays on the sign-in screen. **logout** in the header signs out;
**conn** also clears the saved connection.

## Price

The "price now" stat must match the broker screen, or the gain below it
means nothing. Trade Republic routes to LS Exchange and shows its EUR quote,
07:30 to 23:00 CET. NASDAQ in USD at spot does not match: NASDAQ trades
15:30 to 22:00 CET, so all morning the converted price sits on yesterday's
close.

`supabase/functions/mnst-price/index.ts` reads LS itself:

- **The mid, not the bid.** A TR screen flickers across the spread. LS
  publishes the midpoint of its book as the price (its charts ask for
  `quotetype=mid`).
- **The last one-minute bar.** Live ticks come over a websocket an edge
  function cannot hold open, so it takes the intraday series. At most a
  minute old.

Fallbacks, in order: Tradegate mid, Stuttgart, then NASDAQ in USD at spot.
The app names the fallback in red under the price.

All sources are keyless. The function holds no API key or secret.

## Stack

Vanilla JS, Supabase JS (ESM from `esm.sh`), and a service worker:
network-first for navigations, cache-first for static files. No framework,
no bundler.

## Known debt

- **No auto-refresh.** The price loads with `loadAndRender()` (on load and
  after add, delete or buy) behind a two-minute cache. An open tab never
  updates it.
- **Update lag.** The service worker precaches the shell with a plain fetch,
  which the HTTP cache can serve. GitHub Pages sends HTML with
  `max-age=600`, so after a deploy a returning user may see the old version
  for up to ~10 minutes. Fix: precache with
  `new Request(u, { cache: 'reload' })` in `sw.js`.
