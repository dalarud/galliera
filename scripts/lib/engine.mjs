// Replikeringsmotor: spelar upp affärsboken dag för dag och räknar fram
// innehav, kassa, fondvärde (NAV) och andelsvärde (tidsviktad avkastning).

const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

function makePriceLookup(history) {
  const days = [...history.closes.keys()].sort();
  const values = days.map((d) => history.closes.get(d));
  // Senaste stängningskurs på eller före en viss dag (binärsökning).
  return (day) => {
    let lo = 0, hi = days.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (days[mid] <= day) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return idx >= 0 ? values[idx] : (days.length ? values[0] : null);
  };
}

/** Vilka tickers förekommer i affärsboken? */
export function ledgerTickers(ledger) {
  const set = new Set();
  for (const e of ledger.events) {
    if (e.ticker) set.add(e.ticker);
    if (e.holdings) Object.keys(e.holdings).forEach((t) => set.add(t));
  }
  return [...set];
}

/**
 * @param ledger      data/ledger.json
 * @param securities  data/securities.json
 * @param prices      Map<ticker, history> från yahoo.getMany
 * @param benchmarks  { key: { label, history } }
 * @param calendarKey benchmark vars handelsdagar används som kalender
 */
export function replay({ ledger, securities, prices, benchmarks, calendarKey = 'OMXSPI', today }) {
  const lookups = new Map([...prices].map(([t, h]) => [t, makePriceLookup(h)]));
  const benchLookups = Object.fromEntries(Object.entries(benchmarks).map(([k, b]) => [k, makePriceLookup(b.history)]));
  const nameOf = (t) => securities[t]?.name ?? t.replace(/\.ST$/, '');
  const price = (t, day) => {
    const lk = lookups.get(t);
    const p = lk ? lk(day) : null;
    if (p == null) throw new Error(`Saknar kurs för ${t} ${day}`);
    return p;
  };

  // Kalender: indexets handelsdagar från startdatum, plus senaste dag med kursdata.
  const cal = new Set([...benchmarks[calendarKey].history.closes.keys()].filter((d) => d >= ledger.baseline));
  for (const h of prices.values()) if (h.last?.date >= ledger.baseline) cal.add(h.last.date);
  let calendar = [...cal].sort();
  if (today) calendar = calendar.filter((d) => d <= today);
  if (!calendar.length || calendar[0] !== ledger.baseline) calendar.unshift(ledger.baseline);
  calendar = [...new Set(calendar)].sort();

  const events = [...ledger.events].sort((a, b) => a.date.localeCompare(b.date) || (a.order ?? 0) - (b.order ?? 0));
  const dividends = [];
  for (const [t, h] of prices) for (const d of h.dividends) if (d.date > ledger.baseline) dividends.push({ ticker: t, ...d });

  const holdings = new Map(); // ticker -> { shares, cost (totalt anskaffningsvärde), first }
  let cash = ledger.startCash ?? 0;
  let units = 0;
  let unitValue = ledger.startUnitValue ?? 100;
  let injectedTotal = 0;
  let startCapital = ledger.startCash ?? 0;
  let realized = 0;
  let dividendTotal = 0;
  const trades = [];
  const cashflows = [];
  const series = [];
  let ei = 0;
  let prevDay = null;
  let prevNav = null;

  const holdingValue = (day) => {
    let v = 0;
    for (const [t, h] of holdings) if (h.shares > 0) v += h.shares * price(t, day);
    return v;
  };

  const execute = (day, ticker, side, shares, meta) => {
    shares = Math.round(shares);
    if (shares <= 0) return;
    const p = price(ticker, day);
    const h = holdings.get(ticker) ?? { shares: 0, cost: 0, first: day };
    if (side === 'sell') {
      shares = Math.min(shares, h.shares);
      if (shares <= 0) return;
      const avg = h.shares ? h.cost / h.shares : p;
      realized += (p - avg) * shares;
      h.cost -= avg * shares;
      h.shares -= shares;
      cash += shares * p;
    } else {
      if (h.shares === 0) h.first = day;
      h.shares += shares;
      h.cost += shares * p;
      cash -= shares * p;
    }
    h.basis = meta.basis;
    holdings.set(ticker, h);
    trades.push({
      date: day, ticker, name: nameOf(ticker), side, shares, price: round(p, 3), value: round(shares * p, 0),
      positionAfter: h.shares, ...meta,
    });
  };

  const sourceMeta = (e, extra = {}) => ({
    eventId: e.id, basis: e.basis ?? 'rapporterad', note: e.note ?? '', source: e.source ?? null,
    auto: !!e.auto, implied: false, ...extra,
  });

  for (let di = 0; di < calendar.length; di++) {
    const day = calendar[di];
    let injectedToday = 0;

    // 1) Utdelningar (x-dag mellan föregående handelsdag och idag) till kassan.
    if (prevDay) {
      for (const d of dividends) {
        if (d.date > prevDay && d.date <= day) {
          const h = holdings.get(d.ticker);
          if (h?.shares > 0) {
            const amount = h.shares * d.amount;
            cash += amount;
            dividendTotal += amount;
            cashflows.push({ date: day, type: 'utdelning', ticker: d.ticker, name: nameOf(d.ticker), perShare: d.amount, shares: h.shares, amount: round(amount, 0) });
          }
        }
      }
    }

    // 2) Händelser fram till och med idag.
    const navBefore = holdingValue(prevDay ?? day) + cash;
    while (ei < events.length && events[ei].date <= day) {
      const e = events[ei++];
      if (e.disabled) continue;
      if (e.type === 'snapshot') {
        const targets = new Map();
        for (const [t, spec] of Object.entries(e.holdings)) {
          let shares, basis = e.basis;
          if (typeof spec === 'number') shares = spec;
          else if (spec.shares != null) { shares = spec.shares; basis = spec.basis ?? basis; }
          else if (spec.value != null) { shares = Math.round(spec.value / price(t, day) / 100) * 100; basis = spec.basis ?? 'uppskattad'; }
          targets.set(t, { shares, basis });
        }
        if (e.full) for (const t of holdings.keys()) if (!targets.has(t)) targets.set(t, { shares: 0, basis: e.basis });
        // Sälj först så att likviden finns för köpen.
        const diffs = [...targets].map(([t, { shares, basis }]) => ({ t, basis, diff: shares - (holdings.get(t)?.shares ?? 0) }));
        for (const { t, basis, diff } of diffs.filter((x) => x.diff < 0)) execute(day, t, 'sell', -diff, sourceMeta(e, { basis, implied: true }));
        for (const { t, basis, diff } of diffs.filter((x) => x.diff > 0)) execute(day, t, 'buy', diff, sourceMeta(e, { basis, implied: true }));
        // En innehavslista bekräftar även oförändrade innehav.
        for (const [t, { shares, basis }] of targets) { const h = holdings.get(t); if (h && shares > 0) h.basis = basis ?? 'rapporterad'; }
      } else if (e.type === 'trade') {
        const held = holdings.get(e.ticker)?.shares ?? 0;
        let shares = e.shares;
        if (shares == null && e.value != null) shares = e.value / price(e.ticker, day);
        if (shares == null && e.fraction != null) shares = held * e.fraction;
        if (shares == null && e.weightOfNav != null) shares = (e.weightOfNav * navBefore) / price(e.ticker, day);
        if (shares == null) continue;
        if (e.side === 'sell' && e.fraction == null && shares > held) shares = held;
        // Avrunda uppskattade antal till jämna 100-tal, som i rapporterade innehav.
        if (e.basis === 'uppskattad' && shares > 100) shares = Math.round(shares / 100) * 100;
        execute(day, e.ticker, e.side, shares, sourceMeta(e));
      } else if (e.type === 'spinoff') {
        const h = holdings.get(e.ticker) ?? { shares: 0, cost: 0, first: day };
        const p = price(e.ticker, day);
        if (h.shares === 0) h.first = day;
        h.shares += e.shares;
        h.basis = e.basis ?? 'rapporterad';
        h.cost += e.shares * p;
        holdings.set(e.ticker, h);
        trades.push({ date: day, ticker: e.ticker, name: nameOf(e.ticker), side: 'spinoff', shares: e.shares, price: round(p, 3), value: round(e.shares * p, 0), positionAfter: h.shares, ...sourceMeta(e) });
      } else if (e.type === 'cash') {
        cash += e.amount;
        cashflows.push({ date: day, type: e.amount >= 0 ? 'insättning' : 'uttag', amount: e.amount, note: e.note ?? '' });
        if (di > 0) injectedToday += e.amount;
      }
    }

    // 3) Underskott i kassan = kapitaltillskott (påverkar inte andelsvärdet).
    if (cash < -0.5) {
      const inj = -cash;
      cash = 0;
      if (di === 0) startCapital += inj;
      else injectedTotal += inj;
      if (di > 0) {
        injectedToday += inj;
        cashflows.push({ date: day, type: 'kapitaltillskott', amount: round(inj, 0) });
      }
    }

    const invested = holdingValue(day);
    const nav = invested + cash;
    if (di === 0) {
      units = nav / unitValue;
    } else if (injectedToday) {
      const uv = (nav - injectedToday) / units;
      units += injectedToday / uv;
    }
    unitValue = nav / units;

    const bench = {};
    for (const [k, lk] of Object.entries(benchLookups)) bench[k] = round(lk(day), 2);
    series.push({ d: day, nav: round(nav, 0), cash: round(cash, 0), unit: round(unitValue, 4), ...bench });
    prevNav = nav;
    prevDay = day;
  }

  // Nuläge
  const lastDay = calendar[calendar.length - 1];
  const prevTradingDay = calendar[calendar.length - 2] ?? lastDay;
  const last = series[series.length - 1];
  const positions = [...holdings]
    .filter(([, h]) => h.shares > 0)
    .map(([t, h]) => {
      const p = price(t, lastDay);
      const pPrev = price(t, prevTradingDay);
      const value = h.shares * p;
      return {
        ticker: t, name: nameOf(t), sector: securities[t]?.sector ?? '',
        shares: h.shares, price: round(p, 3), prevClose: round(pPrev, 3),
        dayChangePct: round((p / pPrev - 1) * 100, 2),
        value: round(value, 0), weight: round((value / last.nav) * 100, 2),
        avgCost: round(h.cost / h.shares, 3), gainPct: round((p / (h.cost / h.shares) - 1) * 100, 2),
        since: h.first,
        basis: h.basis ?? 'rapporterad',
        quoteTime: prices.get(t)?.last?.time ?? null,
      };
    })
    .sort((a, b) => b.value - a.value);

  return {
    asOf: lastDay,
    summary: {
      nav: last.nav,
      cash: last.cash,
      cashPct: round((last.cash / last.nav) * 100, 2),
      invested: round(last.nav - last.cash, 0),
      unit: last.unit,
      dayChangePct: series.length > 1 ? round((last.unit / series[series.length - 2].unit - 1) * 100, 2) : 0,
      dayChangeKr: series.length > 1 ? round(last.nav - series[series.length - 2].nav, 0) : 0,
      sinceStartPct: round((last.unit / (ledger.startUnitValue ?? 100) - 1) * 100, 2),
      positions: positions.length,
      dividends: round(dividendTotal, 0),
      realized: round(realized, 0),
      startCapital: round(startCapital, 0),
      injected: round(injectedTotal, 0),
    },
    positions,
    trades: trades.reverse(),
    cashflows: cashflows.reverse(),
    series,
  };
}
