#!/usr/bin/env node
// Kör hela kedjan: nyhetsskanning → nya affärer i affärsboken → kurser → portfolio.json.
//   node scripts/update.mjs            (skanna nyheter + räkna om)
//   node scripts/update.mjs --no-news  (bara kurser)
//   node scripts/update.mjs --dry-run  (skriv inget till ledger/news)
import { readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getMany } from './lib/yahoo.mjs';
import { replay, ledgerTickers } from './lib/engine.mjs';
import { discover, resolveGoogleNewsUrl, fetchArticle } from './lib/news.mjs';
import { buildAliasIndex, extractSignals, extractHoldingsTable } from './lib/parse.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = (f) => path.join(ROOT, 'data', f);
const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// Totalavkastningsindex (inklusive utdelningar), eftersom fonden också räknar med utdelningar.
// OMXSBGI är det index svenska aktiefonder normalt jämförs med.
const BENCHMARKS = {
  OMXSBGI: { ticker: '^OMXSBGI', label: 'OMX Stockholm Benchmark GI' },
};

const readJson = async (f, fallback) => {
  try { return JSON.parse(await readFile(f, 'utf8')); } catch { return fallback; }
};
const writeJson = async (f, obj) => {
  const tmp = f + '.tmp';
  await writeFile(tmp, JSON.stringify(obj, null, 2) + '\n');
  await rename(tmp, f);
};

async function compute(ledger, securities) {
  const tickers = ledgerTickers(ledger);
  const { data: prices, errors } = await getMany(tickers, ledger.baseline);
  const { data: bench, errors: bErr } = await getMany(Object.values(BENCHMARKS).map((b) => b.ticker), ledger.baseline);
  const benchmarks = Object.fromEntries(Object.entries(BENCHMARKS)
    .filter(([, b]) => bench.has(b.ticker) && bench.get(b.ticker).closes.size > 20)
    .map(([k, b]) => [k, { label: b.label, history: bench.get(b.ticker) }]));
  if (!benchmarks.OMXSBGI) throw new Error('Kunde inte hämta jämförelseindex med historik');
  const result = replay({ ledger, securities, prices, benchmarks });
  return { result, errors: [...errors, ...bErr], benchmarks };
}

const positionAt = (result, ticker, date) => {
  // trades är sorterade nyast först
  const t = result.trades.find((x) => x.ticker === ticker && x.date <= date);
  return t ? t.positionAfter : 0;
};

/** Gör om signaler från en artikel till händelser i affärsboken (eller förklarar varför inte). */
function planEvents(article, { table, signals }, { ledger, result }) {
  const events = [];
  const notes = [];
  const lastFull = ledger.events.filter((e) => e.type === 'snapshot' && e.full && !e.disabled).map((e) => e.date).sort().pop() ?? ledger.baseline;
  const source = { publisher: article.publisher, title: article.title, url: article.url, date: article.date };
  const currentCount = result.positions.length;

  if (table.ambiguous) notes.push('Flera tabeller utan rubrik – oklart vilken som är Gallierafonden, ingen avstämning gjord');
  if (table.size >= 5) {
    const near = ledger.events.find((e) => e.type === 'snapshot'
      && (e.source?.url === article.url || Math.abs(new Date(e.date) - new Date(article.date)) < 12 * 864e5));
    if (near) {
      notes.push(`Innehavstabell (${table.size} bolag) – redan inlagd från ${near.source?.publisher ?? 'tidigare källa'}`);
    } else {
      const full = !table.partial && table.size >= Math.max(5, currentCount - 2);
      const d = new Date(article.date); d.setUTCDate(d.getUTCDate() - 1);
      events.push({
        id: `auto-${article.id}-snapshot`, date: d.toISOString().slice(0, 10), type: 'snapshot', full, auto: true,
        basis: 'rapporterad', note: `Innehavstabell med ${table.size} bolag hittad automatiskt${full ? '' : ' (delvis lista)'}.`,
        source, holdings: Object.fromEntries(table),
      });
      notes.push(`Innehavstabell med ${table.size} bolag → avstämning av innehav`);
    }
    return { events, notes };
  }

  const nav = result.summary.nav;
  const weights = result.positions.map((p) => p.weight).sort((a, b) => a - b);
  const medianWeight = (weights[Math.floor(weights.length / 2)] ?? 4) / 100;

  for (const s of signals) {
    const label = `${s.side === 'buy' ? 'Köp' : 'Sälj'} ${s.ticker}`;
    if (s.old || s.date < ledger.baseline) { notes.push(`${label}: före startdatum – ignoreras`); continue; }
    if (s.date <= lastFull) { notes.push(`${label}: redan fångad av innehavstabell ${lastFull}`); continue; }
    const held = positionAt(result, s.ticker, s.date);
    if (s.side === 'sell' && held === 0) { notes.push(`${label}: inget innehav att sälja – redan bokfört`); continue; }
    if (s.side === 'buy' && s.kind === 'new' && held > 0) { notes.push(`${label}: finns redan i portföljen`); continue; }
    const dup = ledger.events.find((e) => e.type === 'trade' && !e.disabled && e.ticker === s.ticker && e.side === s.side
      && Math.abs(new Date(e.date) - new Date(s.date)) < 45 * 864e5);
    if (dup) { notes.push(`${label}: samma affär redan bokförd (${dup.source?.publisher ?? dup.id})`); continue; }

    const e = {
      id: `auto-${article.id}-${s.ticker}-${s.side}`, date: s.date, type: 'trade', ticker: s.ticker, side: s.side, auto: true,
      source, quote: s.sentence.slice(0, 300),
    };
    if (s.shares) { e.shares = s.shares; e.basis = 'rapporterad'; }
    else if (s.value) { e.value = s.value; e.basis = 'rapporterad belopp'; }
    else if (s.fraction != null) { e.fraction = s.fraction; e.basis = s.fraction === 1 ? 'rapporterad' : 'uppskattad'; }
    else if (s.side === 'sell') { e.fraction = 1 / 3; e.basis = 'uppskattad'; }
    else if (held > 0) { e.fraction = 1 / 3; e.basis = 'uppskattad'; }
    else { e.weightOfNav = medianWeight; e.basis = 'uppskattad'; }

    const how = e.shares ? `${e.shares.toLocaleString('sv-SE')} aktier`
      : e.value ? `${(e.value / 1e6).toLocaleString('sv-SE')} Mkr`
      : e.weightOfNav ? `≈ ${(e.weightOfNav * 100).toFixed(1)} % av fonden (medianvikt)`
      : `${Math.round(e.fraction * 100)} % av innehavet`;
    e.note = `Automatiskt tolkat: "${s.verb}" → ${s.side === 'buy' ? 'köp' : 'sälj'} ${how}${s.precision === 'publicering' ? ' (datum = publicering)' : ''}.`;
    events.push(e);
    notes.push(`${label}: bokförd (${how}, ${e.basis})`);
    void nav;
  }
  return { events, notes };
}

async function scanNews({ ledger, securities, newsDb, result }) {
  const aliasIndex = buildAliasIndex(securities);
  const { items, errors } = await discover();
  log(`Nyhetsflöde: ${items.length} relevanta träffar`);
  const added = [];
  for (const it of items) {
    if (newsDb.items[it.id]) {
      newsDb.items[it.id].lastSeen = new Date().toISOString();
      continue;
    }
    const rec = { ...it, firstSeen: new Date().toISOString(), status: 'ingen affär', notes: [], eventIds: [] };
    newsDb.items[it.id] = rec;
    if (it.date < ledger.baseline) { rec.status = 'före start'; continue; }
    try {
      rec.url = await resolveGoogleNewsUrl(it.gnLink).catch(() => null);
      let article = { text: '', rows: [] };
      try {
        if (!rec.url) throw new Error('Kunde inte avkoda länken');
        article = await fetchArticle(rec.url);
      } catch (err) {
        // Låst/blockerad sida: tolka rubrik + ingress från nyhetsflödet i stället.
        rec.notes.push(`Artikeln kunde inte läsas (${err.message}) – tolkar rubrik och ingress`);
        rec.headlineOnly = true;
      }
      const kingInTitle = /(galliera|kung|carl xvi gustaf)/i.test(it.title);
      const text = `${it.title}.\n${it.description}\n${article.text}`;
      const table = extractHoldingsTable(article, aliasIndex);
      const signals = extractSignals(text, { published: it.published, aliasIndex, kingInTitle });
      rec.chars = article.text.length;
      const { events, notes } = planEvents({ ...it, url: rec.url }, { table, signals }, { ledger, result });
      rec.notes.push(...notes);
      rec.signals = signals.map(({ sentence, ...s }) => s);
      if (events.length) {
        ledger.events.push(...events);
        rec.eventIds = events.map((e) => e.id);
        rec.status = events.some((e) => e.type === 'snapshot') ? 'innehavstabell' : 'ny affär';
        added.push(...events);
      } else if (signals.length || table.size) {
        rec.status = 'redan känd';
      } else if (rec.headlineOnly) {
        rec.status = 'endast rubrik';
      }
    } catch (err) {
      rec.status = 'ej läsbar';
      rec.notes.push(String(err.message || err));
    }
    log(`  [${rec.status}] ${it.date} ${it.publisher}: ${it.title}`);
    rec.notes.forEach((n) => log(`      · ${n}`));
  }
  newsDb.lastScan = new Date().toISOString();
  newsDb.errors = errors;
  return added;
}

/** En mening om hur skannern tolkade artikeln, för besökaren. */
function summarizeNews(rec, ledger, securities) {
  const name = (t) => securities[t]?.name ?? t;
  const list = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} och ${xs[xs.length - 1]}` : xs[0] ?? '');
  const table = (rec.notes ?? []).map((n) => n.match(/Innehavstabell[^\d]*(\d+) bolag/)).find(Boolean);
  switch (rec.status) {
    case 'ny affär': {
      const evs = (rec.eventIds ?? []).map((id) => ledger.events.find((e) => e.id === id)).filter(Boolean);
      const parts = evs.map((e) => `${e.side === 'buy' ? 'köp av' : 'försäljning av'} ${name(e.ticker)}`);
      return `${evs.length === 1 ? 'En affär' : `${evs.length} affärer`}: ${list(parts)}.`;
    }
    case 'innehavstabell':
      return `Innehavslista med ${table?.[1] ?? 'flera'} bolag – albumet stäms av mot den.`;
    case 'redan känd': {
      if (table) return `Innehavslista med ${table[1]} bolag som redan finns i albumet.`;
      const names = [...new Set((rec.signals ?? []).map((s) => name(s.ticker)))];
      const old = (rec.notes ?? []).filter((n) => /: /.test(n) && !/kunde inte läsas/i.test(n)).every((n) => /före startdatum/.test(n));
      if (names.length && old) return `Gäller ${list(names)} – affären gjordes före albumets start.`;
      return names.length ? `Gäller ${list(names)} – affären finns redan i postgången.` : 'Gäller affärer som redan finns i postgången.';
    }
    case 'ingen affär': return 'Handlar om fonden men nämner inga köp eller försäljningar.';
    case 'endast rubrik': return 'Artikeln är låst och rubriken nämner inget bolag.';
    case 'ej läsbar': return 'Artikeln gick inte att läsa.';
    case 'före start': return 'Publicerad före albumets startdatum.';
    default: return '';
  }
}

const xmlEsc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Atom-flöde med de senaste affärerna, så att man kan prenumerera i en flödesläsare. */
function buildFeed(result, baseline) {
  const nf = (n) => Math.round(n).toLocaleString('sv-SE');
  const trades = result.trades.filter((t) => t.date !== baseline && !t.implied).slice(0, 40);
  const entries = trades.map((t) => {
    const verb = t.side === 'buy' ? 'köpt' : t.side === 'sell' ? 'sålt' : 'fått (avknoppning)';
    const est = /uppskatt/.test(t.basis) ? '≈ ' : '';
    const title = `Kungen har ${verb} ${est}${nf(t.shares)} aktier i ${t.name} (${est}${(t.value / 1e6).toLocaleString('sv-SE', { maximumFractionDigits: 1 })} Mkr)`;
    const updated = `${t.source?.date ?? t.date}T08:00:00Z`;
    return `  <entry>
    <id>urn:som-kungen:${xmlEsc(t.eventId)}:${xmlEsc(t.ticker)}</id>
    <title>${xmlEsc(title)}</title>
    <updated>${updated}</updated>
    ${t.source?.url ? `<link href="${xmlEsc(t.source.url)}"/>` : ''}
    <summary>${xmlEsc(`${t.note ?? ''} Källa: ${t.source?.publisher ?? 'okänd'}.`.trim())}</summary>
  </entry>`;
  });
  const updated = trades[0] ? `${trades[0].source?.date ?? trades[0].date}T08:00:00Z` : new Date().toISOString();
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>urn:som-kungen:gallierafonden</id>
  <title>Som kungen – Gallierafondens affärer</title>
  <subtitle>Köp och försäljningar i kungens Gallierafond, så som de rapporterats i medier. Fiktiv kopia, inte investeringsrådgivning.</subtitle>
  <updated>${updated}</updated>
  <link href="../"/>
${entries.join('\n')}
</feed>
`;
}

async function main() {
  const securities = await readJson(DATA('securities.json'));
  const ledger = await readJson(DATA('ledger.json'));
  const newsDb = await readJson(DATA('news.json'), { items: {} });

  let { result, errors, benchmarks } = await compute(ledger, securities);
  log(`Fondvärde ${Math.round(result.summary.nav).toLocaleString('sv-SE')} kr, ${result.positions.length} innehav`);

  if (!args.has('--no-news')) {
    const added = await scanNews({ ledger, securities, newsDb, result });
    if (added.length) {
      log(`${added.length} nya händelser i affärsboken – räknar om`);
      ({ result, errors, benchmarks } = await compute(ledger, securities));
    }
    if (!DRY) {
      await writeJson(DATA('ledger.json'), ledger);
      await writeJson(DATA('news.json'), newsDb);
    }
  }

  const news = Object.values(newsDb.items)
    .sort((a, b) => b.published.localeCompare(a.published))
    .slice(0, 40)
    .map((rec) => ({
      id: rec.id, title: rec.title, publisher: rec.publisher, url: rec.url ?? rec.gnLink, date: rec.date,
      published: rec.published, firstSeen: rec.firstSeen ?? null, status: rec.status, notes: rec.notes,
      eventIds: rec.eventIds, summary: summarizeNews(rec, ledger, securities),
    }));

  const out = {
    generatedAt: new Date().toISOString(),
    lastNewsScan: newsDb.lastScan ?? null,
    fund: ledger.fund,
    baseline: ledger.baseline,
    denseFrom: ledger.denseFrom ?? null,
    notes: ledger.notes,
    benchmarks: Object.fromEntries(Object.entries(benchmarks).map(([k, b]) => [k, b.label])),
    sectors: Object.fromEntries(ledgerTickers(ledger).map((t) => [t, securities[t]?.sector ?? ''])),
    ...result,
    news,
    errors,
  };
  if (!DRY) {
    await writeJson(DATA('portfolio.json'), out);
    await writeFile(DATA('feed.xml'), buildFeed(result, ledger.baseline));
  }
  log(`Klart: andelsvärde ${result.summary.unit.toFixed(2)}, kassa ${Math.round(result.summary.cash).toLocaleString('sv-SE')} kr` + (errors.length ? `, ${errors.length} fel` : ''));
  return out;
}

export { main };
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
