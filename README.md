# SDR → MNST

A one-screen PWA for turning deposit-return bottles into Monster Beverage
(`MNST`) stock.

In Portugal a returned bottle is worth €0.10. This logs each batch of bottles,
stacks the cash, and — once there's at least a whole euro — records it as a
stock buy. Weekly target is shown on a ruler (€10/week). Single user, one
Supabase project behind it, no build step.

## Why whole euros (the one real design decision)

You can only buy stock in whole currency units, so an investment always
**floors to the euro**. The leftover cents don't vanish and don't get rounded
away: on "Mark as invested", `floor(total)` is written to the `investments`
table, and `total − floor(total)` is written straight back into `bottle_log`
as a row with `source: 'carry'` and that exact value.

That carry row:

- **seeds next week's pot** — it's already counted in the running total on the
  next load;
- **does not count as a bottle** — the "N bottles" counter and the weekly
  ruler both exclude `source` `carry` (and `seed`), so a €0.40 carry-over
  never looks like 4 bottles collected or inflates the week's progress.

So the running total is always honest about fractional amounts, and every
euro that goes in is a euro you could actually have invested.

## Sources

Each batch is tagged, and the split line separates them:

| Source | Shown as | Meaning |
|---|---|---|
| `found` | profit | picked up from the street / a bin |
| `scam` | scam | machine trickery (over-counted a return) |
| `own_deposit` | reclaimed | returning bottles that were already yours |
| `others` | others | recycled on someone else's behalf |

`seed` (opening balance) and `carry` (see above) are internal — they show on
the history tape but never in the bottle count or the ruler.

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

## Stack

Vanilla JS, Supabase JS (ESM from `esm.sh`), a service worker (network-first
for navigations so a deploy is picked up immediately, cache-first for the
static shell). No framework, no bundler.
