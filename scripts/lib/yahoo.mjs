// Minimal Yahoo Finance chart-klient (ingen nyckel, inga beroenden).
const UA = 'Mozilla/5.0 (compatible; GallieraTracker/1.0)';
const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];

const isoDay = (unixSec, gmtOffset = 0) => new Date((unixSec + gmtOffset) * 1000).toISOString().slice(0, 10);

async function fetchJson(path, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const host = HOSTS[i % HOSTS.length];
    try {
      const res = await fetch(host + path, { headers: { 'user-agent': UA, accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw lastErr;
}

/**
 * Hämtar dagliga stängningskurser, utdelningar och senaste (intradags)kurs.
 * @returns {{ticker, currency, closes: Map<string, number>, dividends: {date, amount}[], last: {price, time, date}}}
 */
export async function getHistory(ticker, fromDay) {
  const period1 = Math.floor(new Date(fromDay + 'T00:00:00Z').getTime() / 1000) - 10 * 86400;
  const period2 = Math.floor(Date.now() / 1000) + 86400;
  const path = `/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${period1}&period2=${period2}&interval=1d&events=div%7Csplit&includePrePost=false`;
  const json = await fetchJson(path);
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`Ingen kursdata för ${ticker}`);
  const meta = result.meta;
  const off = meta.gmtoffset ?? 0;
  const closes = new Map();
  const quote = result.indicators?.quote?.[0] ?? {};
  (result.timestamp ?? []).forEach((ts, i) => {
    const c = quote.close?.[i];
    if (c != null && Number.isFinite(c)) closes.set(isoDay(ts, off), c);
  });
  const dividends = Object.values(result.events?.dividends ?? {})
    .map((d) => ({ date: isoDay(d.date, off), amount: d.amount }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const last = meta.regularMarketPrice != null
    ? { price: meta.regularMarketPrice, time: meta.regularMarketTime, date: isoDay(meta.regularMarketTime, off) }
    : null;
  if (last) closes.set(last.date, last.price); // dagens senaste kurs ersätter/kompletterar dagens stapel
  return { ticker, currency: meta.currency, name: meta.longName || meta.shortName, closes, dividends, last };
}

export async function getMany(tickers, fromDay, { concurrency = 6 } = {}) {
  const out = new Map();
  const errors = [];
  const queue = [...tickers];
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const t = queue.shift();
      try {
        out.set(t, await getHistory(t, fromDay));
      } catch (err) {
        errors.push({ ticker: t, error: String(err.message || err) });
      }
    }
  }));
  return { data: out, errors };
}
