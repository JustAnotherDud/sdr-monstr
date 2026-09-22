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
// that trades 08:00–22:00 CET, same shape as the LS Exchange book Trade
// Republic shows you. Twelve Data only has the NASDAQ print in USD, which is
// frozen outside 15:30–22:00 CET — that gap, not the FX, is what makes the
// number drift away from TR during a European morning.
const ISIN = "US61174X1090";
const TRADEGATE_URL = `https://www.tradegatebsx.com/refresh.php?isin=${ISIN}`;

const TWELVEDATA_API_KEY = Deno.env.get("TWELVEDATA_API_KEY") ?? "";

// A market-maker spread on a liquid US large cap is a few tenths of a
// percent. Anything wider means the book is empty or broken, so fall through
// rather than quote it.
const MAX_SPREAD = 0.02;

async function tradegate() {
  const res = await fetch(TRADEGATE_URL, {
    headers: { "User-Agent": "sdr-monstr/1.0" },
  });
  if (!res.ok) throw new Error(`tradegate HTTP ${res.status}`);
  const j = await res.json();

  const bid = Number(j?.bid);
  const ask = Number(j?.ask);
  const last = Number(j?.last);
  const close = Number(j?.close);
  if (!bid || !ask || bid <= 0 || ask < bid) throw new Error(`tradegate quote unusable: ${JSON.stringify(j)}`);
  if ((ask - bid) / bid > MAX_SPREAD) throw new Error(`tradegate spread ${bid}/${ask} too wide`);

  // TR values a holding off the bid — that's what you'd actually get out.
  return { eur: bid, bid, ask, last: last || null, previous_close: close || null };
}

async function nasdaqTimesFx() {
  if (!TWELVEDATA_API_KEY) throw new Error("no TWELVEDATA_API_KEY set");
  const [quoteRes, fxRes] = await Promise.all([
    fetch(`https://api.twelvedata.com/quote?symbol=MNST&apikey=${TWELVEDATA_API_KEY}`),
    fetch(`https://api.twelvedata.com/exchange_rate?symbol=USD/EUR&apikey=${TWELVEDATA_API_KEY}`),
  ]);
  if (!quoteRes.ok) throw new Error(`twelvedata quote HTTP ${quoteRes.status}`);
  if (!fxRes.ok) throw new Error(`twelvedata fx HTTP ${fxRes.status}`);

  const q = await quoteRes.json();
  const fx = await fxRes.json();
  const usd = parseFloat(q?.close);
  const rate = parseFloat(fx?.rate);
  if (!usd || Number.isNaN(usd)) throw new Error(`no price from twelvedata: ${JSON.stringify(q)}`);
  if (!rate || Number.isNaN(rate)) throw new Error(`no fx from twelvedata: ${JSON.stringify(fx)}`);

  return {
    eur: usd * rate,
    usd,
    rate,
    // seconds since the print Twelve Data is quoting, so a frozen feed is
    // visible instead of silently passing for live
    quote_age_s: q?.timestamp ? Math.round(Date.now() / 1000 - Number(q.timestamp)) : null,
    market_open: q?.is_market_open ?? null,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const errors: string[] = [];

  // Tradegate first: it is already in EUR, it is free, and it tracks the venue
  // the broker quotes. Twelve Data is only touched when that fails, which also
  // keeps the free 800-calls-a-day budget untouched on a normal load.
  try {
    return jsonResponse({ ...(await tradegate()), source: "tradegate", currency: "EUR" });
  } catch (err) {
    errors.push(String(err));
  }

  try {
    return jsonResponse({ ...(await nasdaqTimesFx()), source: "nasdaq_fx", currency: "EUR", notes: errors });
  } catch (err) {
    errors.push(String(err));
  }

  return jsonResponse({ error: errors.join("; ") }, 502);
});
