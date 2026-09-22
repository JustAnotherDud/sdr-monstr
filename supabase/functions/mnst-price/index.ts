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

// Monster Beverage. Tradegate quotes it in EUR on a German market-maker venue
// that trades 08:00-22:00 CET, same shape as the LS Exchange book Trade
// Republic shows you. A NASDAQ print in USD is frozen outside 15:30-22:00
// CET - that gap, not the FX, is what makes the number drift away from TR
// during a European morning.
const ISIN = "US61174X1090";
const TRADEGATE_URL = `https://www.tradegatebsx.com/refresh.php?isin=${ISIN}`;

// Every source here is keyless on purpose: nothing to store, nothing to leak,
// nothing to rotate.
const YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart";

// A market-maker spread on a liquid US large cap is a few tenths of a
// percent. Anything wider means the book is empty or broken, so fall through
// rather than quote it.
const MAX_SPREAD = 0.02;

async function tradegate() {
  const res = await fetch(TRADEGATE_URL, { headers: { "User-Agent": "sdr-monstr/1.0" } });
  if (!res.ok) throw new Error(`tradegate HTTP ${res.status}`);
  const j = await res.json();

  const bid = Number(j?.bid);
  const ask = Number(j?.ask);
  if (!bid || !ask || bid <= 0 || ask < bid) throw new Error(`tradegate quote unusable: ${JSON.stringify(j)}`);
  if ((ask - bid) / bid > MAX_SPREAD) throw new Error(`tradegate spread ${bid}/${ask} too wide`);

  // TR values a holding off the bid - that's what you'd actually get out.
  return { eur: bid, bid, ask, last: Number(j?.last) || null, previous_close: Number(j?.close) || null };
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

// Last resort, and the least like what TR shows: yesterday's NASDAQ close
// converted at spot, for as long as the US market is shut.
async function nasdaqTimesFx() {
  const [us, fx] = await Promise.all([yahooQuote("MNST"), yahooQuote("EURUSD=X")]);
  if (!fx.price) throw new Error("no EURUSD rate");
  return { eur: us.price / fx.price, usd: us.price, eurusd: fx.price, quoted_at: us.at };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const notes: string[] = [];
  const chain: [string, () => Promise<Record<string, unknown>>][] = [
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
