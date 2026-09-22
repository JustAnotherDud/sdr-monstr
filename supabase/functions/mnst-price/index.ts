import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// Monster Beverage. Trade Republic routes to LS Exchange and shows its quote,
// so LS is the source to beat - and the number LS itself publishes is the
// midpoint of its own book, which is why its charts ask for quotetype=mid.
// Watch a TR screen for ten seconds and you see it flicker across the spread;
// the mid is the centre of that flicker.
const ISIN = "US61174X1090";
const LS_INSTRUMENT = 92064;
const LS_URL = `https://www.ls-tc.de/_rpc/json/instrument/chart/dataForInstrument`
  + `?container=c&instrumentId=${LS_INSTRUMENT}&marketId=1&quotetype=mid&series=intraday&localeId=2`;
const TRADEGATE_URL = `https://www.tradegatebsx.com/refresh.php?isin=${ISIN}`;
const YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart";

// Every source here is keyless on purpose: nothing to store, nothing to leak,
// nothing to rotate.
const UA = { "User-Agent": "sdr-monstr/1.0" };

// A market-maker spread on a liquid US large cap is a few tenths of a
// percent. Anything wider means the book is empty or broken, so fall through
// rather than quote it.
const MAX_SPREAD = 0.02;

// LS's own venue, at one-minute resolution. The live tick rides a websocket
// we cannot use from here, so we take the last bar instead - a minute old at
// worst, against a broker screen nobody reads to the second.
async function lsExchange() {
  const res = await fetch(LS_URL, { headers: UA });
  if (!res.ok) throw new Error(`ls HTTP ${res.status}`);
  const bars = (await res.json())?.series?.intraday?.data;
  if (!Array.isArray(bars) || bars.length === 0) throw new Error("ls returned no intraday bars");

  const [ts, mid] = bars[bars.length - 1];
  if (!Number(mid)) throw new Error(`ls last bar unusable: ${JSON.stringify(bars[bars.length - 1])}`);

  // NB: LS stamps these bars with Berlin wall-clock dressed up as epoch ms.
  // It is passed through for display only and nothing here branches on it.
  return { eur: Number(mid), bar_ts_berlin: ts };
}

// Same kind of venue, same hours, different market maker. Close enough to
// stand in when LS is down.
async function tradegate() {
  const res = await fetch(TRADEGATE_URL, { headers: UA });
  if (!res.ok) throw new Error(`tradegate HTTP ${res.status}`);
  const j = await res.json();

  const bid = Number(j?.bid);
  const ask = Number(j?.ask);
  if (!bid || !ask || bid <= 0 || ask < bid) throw new Error(`tradegate quote unusable: ${JSON.stringify(j)}`);
  if ((ask - bid) / bid > MAX_SPREAD) throw new Error(`tradegate spread ${bid}/${ask} too wide`);

  return { eur: (bid + ask) / 2, bid, ask, last: Number(j?.last) || null, previous_close: Number(j?.close) || null };
}

async function yahooQuote(symbol: string) {
  const res = await fetch(`${YAHOO}/${symbol}?interval=1m&range=1d`, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) throw new Error(`yahoo ${symbol} HTTP ${res.status}`);
  const meta = (await res.json())?.chart?.result?.[0]?.meta;
  const price = Number(meta?.regularMarketPrice);
  if (!price) throw new Error(`yahoo ${symbol} gave no price`);
  return { price, at: Number(meta?.regularMarketTime) || null, currency: meta?.currency };
}

// Stuttgart lists Monster in EUR and keeps German venue hours, so it drifts
// from TR far less than a converted NASDAQ close does.
async function stuttgart() {
  const q = await yahooQuote("MOB.SG");
  if (q.currency !== "EUR") throw new Error(`MOB.SG came back in ${q.currency}`);
  return { eur: q.price, quoted_at: q.at };
}

// Last resort, and the least like what TR shows: the NASDAQ print converted
// at spot, frozen at yesterday's close for as long as the US market is shut.
async function nasdaqTimesFx() {
  const [us, fx] = await Promise.all([yahooQuote("MNST"), yahooQuote("EURUSD=X")]);
  if (!fx.price) throw new Error("no EURUSD rate");
  return { eur: us.price / fx.price, usd: us.price, eurusd: fx.price, quoted_at: us.at };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const notes: string[] = [];
  const chain: [string, () => Promise<Record<string, unknown>>][] = [
    ["ls", lsExchange],
    ["tradegate", tradegate],
    ["stuttgart", stuttgart],
    ["nasdaq_fx", nasdaqTimesFx],
  ];

  for (const [source, fn] of chain) {
    try {
      const quote = await fn();
      return jsonResponse({ ...quote, source, currency: "EUR", notes: notes.length ? notes : undefined });
    } catch (err) {
      notes.push(String(err));
    }
  }

  return jsonResponse({ error: notes.join("; ") }, 502);
});
