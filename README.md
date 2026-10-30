# SDR → MNST

One-screen PWA that turns deposit-return bottles into Monster Beverage
(`MNST`) stock.

In Portugal a returned bottle is worth €0.10. The app logs each batch, adds
up the cash and, once there is at least €1, records a stock buy. A progress
bar tracks a 14-day cycle anchored on the date of the last buy. Single user,
one Supabase project, no build step.

## Whole euros

You buy in whole euros, so a buy always floors the total. "Mark As Invested"
calls the `mark_invested` function, which runs in one transaction: it locks
`bottle_log`, sums the pending rows in cents, floors, stamps the rows, writes
the `investments` row and writes the leftover cents back as a `carry` row
(`created_at` equal to the buy time, `carry_from` pointing at the buy). The
client never sends the total, so a stale screen cannot buy the wrong amount.
If the total is below €1 (or negative) the function raises and nothing
changes.

A negative total (an expense bigger than the pot) is not blocked: it stays
pending and rolls into the next cycle. The buy button stays off until the
total is at least €1.

## Sources

Picked with the buttons in "Add Bottles":

| Source | Meaning |
|---|---|
| `profit` | found on the street or in a bin, or the machine over-counted |
| `deposit` | your own bottles, or returned for someone else |

Written by the app or by hand, not picked:

| Source | Meaning |
|---|---|
| `carry` | leftover cents of a buy, shown as "Carried Over" |
| `seed_profit`, `seed_deposit` | the opening balance (€61.00), split €36.10 and €24.90 by the profit to deposit ratio of the first weeks |
| `expense` | a cost, from "Add Expense" |

An `expense` has a description (`note`), a quantity and a negative `value`,
and shows as "3× Rolos Impressora" and "−€5.80". It subtracts from the
pending total but is not a bottle: it stays out of every bottle count and out
of `qty * 0.10`.

## Editing

Every bottle row has edit and delete. Edit changes quantity, source (profit or
deposit), date and time, the description of an expense, or the amount of a
carry or seed row. `value` is rebuilt in whole cents, `invested_at` is never
touched, and a trigger keeps `logged_date` equal to the Europe/Lisbon day of
`created_at`.

Every buy can be edited (date, time, price per share, shares; the amount is
fixed). A date change moves the stamp on that buy's rows and the `created_at`
of its carry, and must stay between the neighbouring buys
(`edit_investment`). "Fill Details" is the same form for a buy with no price
or shares. "Undo Buy" exists for the newest buy only
(`undo_last_investment`): its rows go back to pending and its carry row is
deleted. The carry is found through `carry_from`, a foreign key, because
`created_at` is not exact on old carries.

Delete asks first, in a modal. Deleting a carry says the cents are lost.

## Data model (Supabase)

- **`bottle_log`**: `qty`, `source`, `value` (`numeric(12,2)`, euros), 
  `unit_value` (informational, `value / qty`), `note` (description of an
  expense), `carry_from` (the buy a `carry` row came from), `logged_date`,
  `created_at`, `invested_at`. `invested_at` is null until a buy; a buy
  stamps all pending rows with the same time. Checks: `source` is one of the
  six above; `value < 0` only for `expense`; a `profit` or `deposit` row is
  exactly `qty * 0.10`.
- **`investments`**: `invested_at` (unique), `amount` (whole euros),
  `share_price` and `shares` (both optional), `note` (unused), `created_at`.
  RLS lets the owner select, insert, update and delete.
- **Functions** (`security invoker`, so RLS applies): `mark_invested`,
  `edit_investment`, `undo_last_investment`. The SQL is in
  `supabase/migrations/`.

All sums in the app run in integer cents.

## Tabs

Hash routing (`#/home`, `#/history`, `#/stats`, `#/portfolio`), a fixed tab
bar at the bottom, no build, charts are inline SVG. All data loads once
(paged by 1000, the PostgREST cap) and every tab draws from it.

- **Home**: the pot, the cycle, add bottles, the buy, the latest log. When the
  pot is under €1 and the last 14 days have a positive pace (profit, deposit
  and expense rows), it says "At The Current Pace You Reach €1 In X Days".
- **History**: every `bottle_log` row, pending first, then grouped by buy
  (date and amount in the header). Filter by source, 50 rows per page, edit
  and delete on every row, "Export CSV" for the rows the filter matches
  (all pages). A note that starts with `=`, `+`, `-` or `@` gets a leading
  apostrophe in the file, so a spreadsheet does not run it.
- **Stats**: all-time totals by source; real profit (`profit` +
  `seed_profit` - expenses, with deposit, seed deposit and carry listed
  apart); bottles per week for 12 weeks; best day and average per day (days
  since the first bottle); the pot over time (a rise per row, a drop per buy).
  Bottle counts only use `profit` and `deposit`.
- **Portfolio**: a table of lots with gain against today's price, average
  cost against price today, invested against value, and a 12 month
  projection. The projection repeats the pace of the last 8 weeks of buys at
  a constant price: an extrapolation, labelled as one. MNST pays no
  dividends, so value moves with the price alone.

Delta and average cost (Home and Portfolio) use only the buys that have
shares: a buy with no shares has no cost basis. If any exist, a line says "1
Buy Without Shares, Stats Exclude It". "Invested" still counts every buy.

## Running it

Static site: `index.html`, `sw.js`, `manifest.json` and `icons/`. Serve the
folder from any static host (GitHub Pages, or `python -m http.server`).

On first load it asks for the Supabase project URL, an anon or publishable
key, and the owner's email and password (Supabase Auth,
`signInWithPassword`). URL and key go to `localStorage` only after they give a
valid session. RLS on `bottle_log` and `investments` admits only that user, so
the key alone reads nothing. The session persists and auto-refreshes; without
one the app stays on the sign-in screen. **Logout** in the header signs out;
**Conn** also clears the saved connection.

## Offline and updates

`sw.js` precaches the shell with `cache: 'reload'`, so a deploy never
precaches the previous HTML from the HTTP cache. Navigations are
network-first with the cached shell as fallback.

`supabase-js` is imported from `esm.sh` at an exact version
(`@supabase/supabase-js@2.118.0`). Every file under an exact version is
immutable, so the service worker serves `esm.sh` cache-first from its own
cache (`sdr-monstr-runtime-v1`), which survives shell version bumps. To
upgrade supabase-js, change the pin in `index.html`; the new URL is fetched
and cached on first use. Offline works from the second visit, because the
first load runs before the worker controls the page. The Google Fonts
stylesheet is stale-while-revalidate; offline the app falls back to system
fonts. Supabase calls are never cached, so offline the app opens but shows
"Connection Error".

Bump `CACHE` in `sw.js` on every change to the shell.

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

Vanilla JS, Supabase JS (ESM from `esm.sh`, pinned), and a service worker. No
framework, no bundler. UI text is Title Case.

## Known debt

- **No auto-refresh.** The price loads with `loadAndRender()` (on load and
  after add, edit, delete or buy) behind a two-minute cache. An open tab
  never updates it.
- **Tabs do not refetch.** Switching tab redraws from the data of the last
  load, so a change made on another device shows only after the next action
  here or a reload.
- **Buy dates are not tied to row dates.** A row's `created_at` can be edited
  to after the buy that holds it. Nothing checks it; membership of a buy is
  `invested_at`, not the date.
