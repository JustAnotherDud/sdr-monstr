# SDR → MNST

A one-screen PWA for turning deposit-return bottles into Monster Beverage
(`MNST`) stock.

In Portugal a returned bottle is worth €0.10. This logs each batch of bottles,
stacks the cash, and — once there's at least a whole euro — records it as a
stock buy. A progress bar tracks a 14-day cycle, anchored to the date of the
last investment. Single user, one Supabase project behind it, no build step.

## Why whole euros (the one real design decision)

You can only buy stock in whole currency units, so an investment always
**floors to the euro**. The leftover cents don't vanish and don't get rounded
away: on "Mark as invested", `floor(total)` is written to the `investments`
table, and `total − floor(total)` is written straight back into `bottle_log`
as a row with `source: 'carry'` and that exact value.

That carry row:

- **seeds next cycle's pot** — it's already counted in the running total on
  the next load;
- **is tagged `source: 'carry'`**, not `profit`/`deposit`, so it still shows
  on the bottle log but is clearly not an actual batch of bottles (see
  Sources).

So the running total is always honest about fractional amounts, and every
euro that goes in is a euro you could actually have invested.

## Sources

Each batch is tagged with one of two sources, picked with the buttons in
"Add bottles":

| Source | Meaning |
|---|---|
| `profit` | found on the street / a bin, or machine trickery (over-counted a return) |
| `deposit` | reclaiming bottles that were already yours, or on someone else's behalf |

`seed` (opening balance) and `carry` (see above) are internal — they show on
the bottle log, tagged separately from an actual batch of bottles.

## Data model (Supabase)

Two tables:

- **`bottle_log`** — `qty`, `source`, `value`, `unit_value`, `logged_date`,
  `created_at`, `invested_at` (null until a batch is marked invested; all
  pending rows get the same `invested_at` timestamp when you invest).
- **`investments`** — `invested_at`, `amount` (the whole-euro part),
  `share_price` and `shares` (both optional — fill them in if you know the
  fill price).

## Running it

It's a static site — `index.html` + `sw.js` + `manifest.json` + icons, nothing
to build. Serve the folder from any static host (GitHub Pages, or
`python -m http.server` locally) and open it.

On first load it asks for the **Supabase project URL** and an **anon /
publishable key**. Those are kept in `localStorage` only — never in the code.
The key needs read/write on `bottle_log` and `investments`; scope the
project's RLS to that. Use the **conn** button in the header to change or
clear the saved connection.

## The price it shows you

The "price now" stat has to agree with what the broker screen says, or the
gain/loss below it is theatre. Trade Republic quotes Monster on LS Exchange,
in EUR, 07:30–23:00 CET. A NASDAQ price in USD converted at spot does *not*
agree with that: NASDAQ only trades 15:30–22:00 CET, so all European morning
the converted number is stuck on yesterday's close while the broker moves.

So `supabase/functions/mnst-price/index.ts` asks Tradegate instead — a German
market-maker venue on the same hours as LS, already in EUR — and returns its
**bid**, which is what a holding is worth to you and what TR values yours at.
Checked against a live TR screen at 12:01 CEST: TR 38.260, Tradegate bid
38.245, mid 38.398, NASDAQ close x FX 38.375. The bid wins by an order of
magnitude.

NASDAQ x FX (Twelve Data) stays as the fallback for when Tradegate is
unreachable; the app labels it in red when that happens, because it is
yesterday's number until the US opens. That path needs `TWELVEDATA_API_KEY`
set as a Supabase secret — it is deliberately not in this repo.

## Stack

Vanilla JS, Supabase JS (ESM from `esm.sh`), a service worker (network-first
for navigations so a deploy is picked up immediately, cache-first for the
static shell). No framework, no bundler.

### Known debt: the update lag

The service worker precaches the shell (`./`, `./index.html`) with a plain
fetch, which can be served from the browser HTTP cache. GitHub Pages sends
HTML with `Cache-Control: max-age=600`, so right after a deploy a returning
user can keep seeing the previous version for up to ~10 minutes (plus one
reload) before the SW cache refills. It's short and self-healing, so it's left
as-is; the fix is to precache with `cache: 'reload'` (`c.addAll(SHELL.map(u =>
new Request(u, { cache: 'reload' })))` in `sw.js`).
