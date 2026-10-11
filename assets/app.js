// Som kungen – "Frimärket". Läser data/portfolio.json och uppdaterar sig själv varje minut.
const DATA_URL = 'data/portfolio.json';
const POLL_MS = 60_000;
const NEW_MS = 24 * 3600_000;

const $ = (s) => document.querySelector(s);
const S = {
  data: null, generatedAt: null, view: 'return', hover: null, pick: null,
  amount: 10000, topN: null, keepCash: true, fetchError: false, tableOpen: false,
};
const mobileMq = matchMedia('(max-width: 639px)');

// ---------- Format ----------
const nf = (d) => new Intl.NumberFormat('sv-SE', { minimumFractionDigits: d, maximumFractionDigits: d });
const f1 = (v) => nf(1).format(v);
const sgn = (v, d = 1) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${nf(d).format(Math.abs(v))}`;
const mkr = (v, d = 1) => `${nf(d).format(v / 1e6)} Mkr`;
const money = (v) => (Math.abs(v) >= 100_000 ? mkr(v) : `${nf(0).format(Math.round(v))} kr`);
const tens = (v) => `${nf(0).format(Math.round(v / 10) * 10)} kr`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u ?? '') ? u : null);
const MON = ['januari', 'februari', 'mars', 'april', 'maj', 'juni', 'juli', 'augusti', 'september', 'oktober', 'november', 'december'];
const MON3 = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
const DAY = ['söndag', 'måndag', 'tisdag', 'onsdag', 'torsdag', 'fredag', 'lördag'];
const parts = (iso) => { const [y, m, d] = iso.slice(0, 10).split('-').map(Number); return { y, m, d, wd: new Date(Date.UTC(y, m - 1, d)).getUTCDay() }; };
const dLong = (iso) => { const p = parts(iso); return `${p.d} ${MON[p.m - 1]} ${p.y}`; };
const dShort = (iso) => { const p = parts(iso); return `${p.d} ${MON3[p.m - 1]}`; };
const dStamp = (iso) => { const p = parts(iso); return `${p.d}.${p.m}.${String(p.y).slice(2)}`; };
const sthlm = (ms, opts) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', ...opts }).format(new Date(ms));
const hhmm = (ms) => sthlm(ms, { hour: '2-digit', minute: '2-digit' });
const sthlmDay = (ms) => sthlm(ms, { year: 'numeric', month: '2-digit', day: '2-digit' });
const ago = (ms) => { const m = Math.round((Date.now() - ms) / 60000); return m < 60 ? `FÖR ${Math.max(1, m)} MIN SEDAN` : `FÖR ${Math.round(m / 60)} TIM SEDAN`; };
const COUNT = ['noll', 'en', 'två', 'tre', 'fyra', 'fem', 'sex', 'sju', 'åtta', 'nio', 'tio'];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Bransch → märkesfärg
const INK = { inv: '#9E1B32', bank: '#2F6B4F', ind: '#1F3D8A', tek: '#94550F', hal: '#1D6670', han: '#6E4A2E' };
const INK_NAME = { inv: 'Investmentbolag', bank: 'Bank och finans', ind: 'Industri', tek: 'Teknik', hal: 'Hälsovård och tjänster', han: 'Handel och bygg' };
const GROUP = {
  Investmentbolag: 'inv', Bank: 'bank', Kapitalförvaltning: 'bank',
  Verkstad: 'ind', Industri: 'ind', Råvaror: 'ind', Skog: 'ind', Försvar: 'ind',
  Teknik: 'tek', Telekom: 'tek', Spel: 'tek',
  Hälsovård: 'hal', Medicinteknik: 'hal', Läkemedel: 'hal', Tjänster: 'hal', Konsult: 'hal', Hygien: 'hal',
  Detaljhandel: 'han', Bygg: 'han', Hushåll: 'han', Konsument: 'han', Livsmedel: 'han', Fastighet: 'han',
};
const inkOf = (sector) => INK[GROUP[sector] ?? 'ind'];
const isEst = (basis) => /uppskatt/.test(basis ?? '');
// Mjuka bindestreck i långa sammansatta bolagsnamn (webbläsare saknar ofta svensk avstavning).
const soft = (name) => esc(name).replace(/^(Industri|Handels|Investment|Medi|Kinne)(\p{Ll}{4,})/u, '$1&shy;$2');

// ---------- Tema ----------
const isDark = () => (document.documentElement.dataset.theme
  ? document.documentElement.dataset.theme === 'dark'
  : matchMedia('(prefers-color-scheme: dark)').matches);
const setThemeLabel = () => $('#theme').setAttribute('aria-label', isDark() ? 'Byt till ljust tema' : 'Byt till mörkt tema');
try { const t = localStorage.getItem('theme'); if (t) document.documentElement.dataset.theme = t; } catch { /* privat läge */ }
setThemeLabel();
$('#theme').addEventListener('click', () => {
  const next = isDark() ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('theme', next); } catch { /* ignore */ }
  setThemeLabel();
});

// ---------- Härledda data ----------
function newsNew(n) {
  return n.firstSeen && ['ny affär', 'innehavstabell'].includes(n.status) && Date.now() - new Date(n.firstSeen) < NEW_MS;
}
function newEventIds() {
  const ids = new Map();
  for (const n of S.data.news) if (newsNew(n)) for (const id of n.eventIds ?? []) ids.set(id, n);
  return ids;
}

/** Affärer grupperade per rapport (källa), nyast först. Startportföljen hålls utanför. */
function reports() {
  const d = S.data;
  const map = new Map();
  for (const t of d.trades) {
    if (t.date === d.baseline) continue;
    const key = t.implied ? `snap:${t.eventId}` : t.side === 'spinoff' ? `spin:${t.eventId}` : `src:${t.source?.url ?? t.eventId}`;
    if (!map.has(key)) map.set(key, { key, snapshot: !!t.implied, spinoff: t.side === 'spinoff', source: t.source, trades: [], last: t.date });
    const g = map.get(key);
    g.trades.push(t);
    if (t.date > g.last) g.last = t.date;
  }
  const order = (g) => `${g.source?.date ?? g.last}|${g.snapshot || g.spinoff ? 0 : 1}|${g.last}`;
  return [...map.values()].sort((a, b) => order(b).localeCompare(order(a)));
}

function monthPhrase(trades) {
  const months = [...new Set(trades.map((t) => t.date.slice(0, 7)))];
  if (months.length === 1) { const p = parts(trades[0].date); return `i ${MON[p.m - 1]} ${p.y}`; }
  const ds = trades.map((t) => t.date).sort();
  return `mellan ${dShort(ds[0])} och ${dShort(ds[ds.length - 1])}`;
}

function verdictText(k, b) {
  if (k >= 0 && b < 0) return 'Kungen går plus medan börsen går minus.';
  if (k < 0 && b >= 0) return 'Börsen går plus medan kungen går minus.';
  if (k < 0 && b < 0) return k > b ? 'Kungens valör faller mindre än börsens.' : 'Kungens valör faller mer än börsens.';
  const r = b === 0 ? Infinity : k / b;
  if (r >= 2.2) return 'Kungens valör är mer än dubbelt så hög som börsens.';
  if (r >= 1.75) return 'Kungens valör är nästan dubbelt så hög som börsens.';
  if (r >= 1.25) return 'Kungens valör är klart högre än börsens.';
  if (r >= 1.03) return 'Kungens valör är något högre än börsens.';
  if (r > 0.97) return 'Kungens valör är lika hög som börsens.';
  return 'Börsens valör är högre än kungens.';
}

// Ett jämförelseindex (totalavkastning, inklusive utdelningar).
const BK = () => Object.keys(S.data.benchmarks)[0];
const benchLabel = () => S.data.benchmarks[BK()];
function benchSince() {
  const sr = S.data.series, k = BK();
  return (sr[sr.length - 1][k] / sr[0][k] - 1) * 100;
}

function shortPublisher(p) {
  if (!p) return '';
  if (/^https?:/.test(p)) { try { return new URL(p).hostname.replace(/^www\./, '').split('.')[0].toUpperCase(); } catch { return p; } }
  return p.split(' – ')[0].replace(/\.se$/i, '').replace(/\s*\/.*$/, '').toUpperCase();
}

function latestQuoteMs() {
  return Math.max(0, ...S.data.positions.map((p) => (p.quoteTime ?? 0) * 1000));
}
function missingQuotes() {
  const latest = latestQuoteMs();
  return S.data.positions.filter((p) => p.quoteTime && latest - p.quoteTime * 1000 > 4 * 86400_000);
}

function marketOpen(ms = Date.now()) {
  const wd = sthlm(ms, { weekday: 'short' });
  const [h, m] = hhmm(ms).split(':').map(Number);
  const mins = h * 60 + m;
  return !/lör|sön/.test(wd) && mins >= 540 && mins <= 1050;
}

function freshness() {
  const d = S.data;
  const now = Date.now();
  const gen = new Date(d.generatedAt).getTime();
  const scan = d.lastNewsScan ? new Date(d.lastNewsScan).getTime() : 0;
  const pricesStale = now - gen > (marketOpen() ? 40 : 150) * 60_000;
  const newsStale = !scan || now - scan > 150 * 60_000;
  return { gen, scan, pricesStale, newsStale };
}

// ---------- Status ----------
function setUpdating(on) {
  $('#status').classList.toggle('is-updating', on);
  $('#top').classList.toggle('is-updating', on);
  if (on) { $('#st-l1').textContent = 'STÄMPLAR'; $('#st-l2').textContent = '…'; $('#status').setAttribute('aria-label', 'Uppdaterar kurser och nyheter.'); }
}

function renderStatus() {
  const st = $('#status');
  if (!S.data) return;
  const { gen, scan, pricesStale, newsStale } = freshness();
  const q = latestQuoteMs() || gen;
  const qLabel = sthlmDay(q) === sthlmDay(Date.now()) ? hhmm(q) : `${sthlm(q, { weekday: 'short' }).replace('.', '')} ${hhmm(q)}`;
  st.classList.remove('is-updating');
  $('#top').classList.remove('is-updating');
  const stale = S.fetchError || pricesStale || newsStale;
  st.classList.toggle('is-stale', stale);
  let l1 = 'LIVE', l2 = hhmm(scan || gen), text = `Kurser ${qLabel} · Nyheter ${scan ? hhmm(scan) : '–'}`, aria = `Live. Kurser från ${qLabel}, nyheter lästa ${scan ? hhmm(scan) : 'ännu inte'}.`;
  if (S.fetchError) { l1 = 'FEL'; l2 = hhmm(Date.now()); text = 'Kunde inte hämta ny data'; aria = 'Varning: kunde inte hämta ny data.'; }
  else if (newsStale) { l1 = 'NYHETER'; l2 = scan ? hhmm(scan) : '–'; text = `Nyheter ej lästa sedan ${scan ? hhmm(scan) : '–'}`; aria = `Varning: ${text.toLowerCase()}.`; }
  else if (pricesStale) { l1 = 'KURSER'; l2 = hhmm(gen); text = `Kurser ej uppdaterade sedan ${hhmm(gen)}`; aria = `Varning: ${text.toLowerCase()}.`; }
  $('#st-l1').textContent = l1;
  $('#st-l2').textContent = l2;
  $('#status-text').textContent = text;
  st.setAttribute('aria-label', aria);
  st.title = text;

  // Notiser i hjältedelen och sorteringen
  const notes = [];
  if (S.fetchError) notes.push('Sidan kunde inte hämta ny data, så siffrorna kan vara inaktuella.');
  if (!S.fetchError && newsStale) notes.push(`Sorteringen har inte läst nyheter sedan ${scan ? hhmm(scan) : '–'}, så en ny affär kan saknas.`);
  if (!S.fetchError && pricesStale) notes.push(`Kurserna har inte uppdaterats sedan ${hhmm(gen)}.`);
  for (const p of missingQuotes()) notes.push(`Kursen för ${p.name} saknas – vi räknar med senast kända.`);
  $('#stale-note').hidden = !notes.length;
  $('#stale-text').textContent = notes.join(' ');
  const sn = $('#stale-news');
  sn.hidden = !(newsStale || S.fetchError);
  sn.textContent = S.fetchError ? 'Sidan kunde inte hämta ny data.' : `Sorteringen svarar inte sedan ${scan ? hhmm(scan) : '–'}. Nyheter efter det är inte lästa.`;
}

// ---------- Utgåvebanner ----------
function renderIssue() {
  const box = $('#issue');
  const fresh = S.data.news.filter(newsNew).sort((a, b) => b.firstSeen.localeCompare(a.firstSeen))[0];
  document.title = fresh ? '(1) Som kungen – Gallierafonden' : 'Som kungen – Gallierafonden';
  if (!fresh) { box.hidden = true; box.innerHTML = ''; return; }
  const trades = S.data.trades.filter((t) => fresh.eventIds?.includes(t.eventId));
  const pub = fresh.publisher.split(' – ')[0];
  let text;
  if (trades.length === 1) {
    const t = trades[0];
    text = `Kungen har ${t.side === 'buy' ? 'köpt' : 'sålt'} ${nf(0).format(t.shares)} aktier i ${t.name} för ${isEst(t.basis) ? '≈ ' : ''}${money(t.value)}, enligt ${pub}. Kopian har gjort samma affär.`;
  } else {
    text = `${cap(COUNT[trades.length] ?? String(trades.length))} affärer enligt ${pub}. Kopian har gjort samma affärer.`;
  }
  box.innerHTML = `<div class="wrap issue-in"><span class="issue-k">NY UTGÅVA · ${ago(new Date(fresh.firstSeen).getTime())}</span><span class="issue-t">${esc(text)}</span><a href="#postgangen">Se affären</a></div>`;
  box.hidden = false;
}

// ---------- Hjälte ----------
function renderHero(changed) {
  const d = S.data, s = d.summary;
  const kv = $('#king-value');
  kv.innerHTML = `${f1(s.nav / 1e6)}<small>Mkr</small>`;
  if (changed) { kv.classList.remove('thump'); void kv.offsetWidth; kv.classList.add('thump'); }
  const p = parts(d.asOf);
  $('#king').setAttribute('aria-label', `Gallierafondens värde ${f1(s.nav / 1e6)} miljoner kronor, ${s.dayChangePct >= 0 ? 'upp' : 'ned'} ${nf(2).format(Math.abs(s.dayChangePct))} procent ${DAY[p.wd]} ${p.d} ${MON[p.m - 1]}.`);
  $('#pm-date').textContent = dStamp(d.asOf);
  $('#pm-day').textContent = `${sgn(s.dayChangePct, 2)} %`;

  const k = s.sinceStartPct, b = benchSince();
  const mob = mobileMq.matches;
  const cap0 = mob ? 125 : 200, minH = mob ? 64 : 90;
  const scale = Math.min(mob ? 5.5 : 8.8, cap0 / Math.max(k, b, 1));
  $('#cmp-king').style.height = `${Math.max(minH, Math.round(Math.max(0, k) * scale))}px`;
  $('#cmp-bench').style.height = `${Math.max(minH, Math.round(Math.max(0, b) * scale))}px`;
  $('#cmp-king-v').innerHTML = `${sgn(k)}<small>%</small>`;
  $('#cmp-bench-v').innerHTML = `${sgn(b)}<small>%</small>`;
  $('#verdict').textContent = verdictText(k, b);
  $('#cmp-note').textContent = `Avkastning med utdelningar sedan ${dLong(d.baseline)}, jämfört med ${benchLabel()}. Märkenas höjd följer avkastningen.`;
  renderIncoming();
}

function reportHeadline(g) {
  const ts = g.trades;
  if (ts.length === 1) {
    const t = ts[0];
    if (t.side === 'spinoff') return `${t.name} har knoppats av och delats ut till fonden`;
    const all = t.side === 'sell' && t.positionAfter === 0;
    return `Kungen har ${t.side === 'buy' ? 'köpt' : 'sålt'} ${all ? 'hela innehavet i' : `${nf(0).format(t.shares)} aktier i`} ${t.name} för ${isEst(t.basis) ? '≈ ' : ''}${money(t.value)}`;
  }
  const buys = ts.filter((t) => t.side === 'buy').sort((a, b) => b.value - a.value);
  const sells = ts.filter((t) => t.side === 'sell').sort((a, b) => b.value - a.value);
  const exit = sells.find((t) => t.positionAfter === 0);
  const bits = [];
  if (buys[0]) bits.push(`köp av ${buys[0].name}`);
  if (exit) bits.push(`försäljning av hela ${exit.name}`);
  else if (sells[0]) bits.push(`försäljning av ${sells[0].name}`);
  const lead = g.snapshot ? `Avstämning: ${COUNT[ts.length] ?? ts.length} justeringar` : `${cap(COUNT[ts.length] ?? String(ts.length))} affärer ${monthPhrase(ts)}`;
  return `${lead}${bits.length ? ` – bland annat ${bits.join(' och ')}` : ''}`;
}

function renderIncoming() {
  const g = reports()[0];
  const el = $('#incoming');
  if (!g) { el.hidden = true; return; }
  const ids = newEventIds();
  const fresh = g.trades.map((t) => ids.get(t.eventId)).find(Boolean);
  const one = g.trades.length === 1 ? g.trades[0] : null;
  const pub = shortPublisher(g.source?.publisher);
  const ink = one ? inkOf(d_sector(one.ticker)) : '#9E1B32';
  const label = one ? one.name.split(' ')[0] : String(g.trades.length);
  const pm = fresh ? ['NY', hhmm(new Date(fresh.firstSeen).getTime())] : [pub.slice(0, 9), g.source?.date ? dStamp(g.source.date).slice(0, -3) : ''];
  el.innerHTML = `
    <span class="mini" style="background:${ink}">${esc(label)}<span class="mini-pm" aria-hidden="true"><span>${esc(pm[0])}</span><span>${esc(pm[1])}</span></span></span>
    <span class="inc-text">
      <span class="inc-k">${fresh ? `NYSS INKOMMET · ${esc(pub)}` : 'SENAST INKOMMET'}</span>
      <span class="inc-t">${esc(reportHeadline(g))}</span>
      <span class="inc-s">${fresh ? 'Kopian har satt in samma märke i albumet.' : 'Till postgången'}</span>
    </span>
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h12M11 5l5 5-5 5"/></svg>`;
  el.hidden = false;
}
function d_inflowOn(date) {
  return S.data.cashflows.find((c) => c.type === 'kapitaltillskott' && c.date === date)?.amount ?? 0;
}
function d_sector(ticker) {
  return S.data.positions.find((p) => p.ticker === ticker)?.sector ?? S.data.sectors?.[ticker] ?? '';
}

// ---------- Graf ----------
function niceStep(span, n) {
  const raw = span / n, mag = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) ?? 10 * mag;
}

function chartModel() {
  const sr = S.data.series;
  const k = BK();
  const u0 = sr[0].unit, b0 = sr[0][k];
  const ret = S.view === 'return';
  const fund = sr.map((r) => (r.unit / u0 - 1) * 100);
  const idx = sr.map((r) => (r[k] / b0 - 1) * 100);
  const total = sr.map((r) => r.nav / 1e6);
  const cash = sr.map((r) => r.cash / 1e6);
  const stocks = total.map((v, i) => v - cash[i]);
  // Nytt kapital per dag (köp större än kassan), för att förklara språng i värdegrafen.
  const inflow = new Map(S.data.cashflows.filter((c) => c.type === 'kapitaltillskott').map((c) => [c.date, c.amount]));
  return { sr, ret, fund, idx, total, cash, stocks, inflow };
}

function renderChart() {
  const el = $('#chart');
  const m = chartModel();
  const N = m.sr.length;
  const W = el.clientWidth, H = el.clientHeight;
  if (!W || !H) return;
  let lo, hi, step;
  if (m.ret) {
    const all = [...m.fund, ...m.idx];
    const span = Math.max(...all) - Math.min(...all);
    step = span > 30 ? 10 : 5;
    lo = Math.floor((Math.min(0, ...all) - 1) / step) * step;
    hi = Math.ceil((Math.max(...all) + 1) / step) * step;
  } else {
    lo = 0;
    step = niceStep(Math.max(...m.total) * 1.06, mobileMq.matches ? 3 : 5);
    hi = Math.ceil((Math.max(...m.total) * 1.06) / step) * step;
  }
  const X = (i) => (N === 1 ? W / 2 : (i / (N - 1)) * W);
  const Y = (v) => H - ((v - lo) / (hi - lo)) * H;
  const line = (a) => a.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join('');
  let grid = '';
  const ticks = [];
  for (let v = lo; v <= hi + 1e-9; v += step) {
    ticks.push({ y: Y(v), label: m.ret ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)} %` : `${nf(0).format(v)} Mkr` });
    if (Math.abs(v - (m.ret ? 0 : lo)) > 1e-9) grid += `M0 ${Y(v).toFixed(1)}H${W}`;
  }
  const base = `M0 ${Y(m.ret ? 0 : lo).toFixed(1)}H${W}`;
  let paths;
  const ends = [];
  if (m.ret) {
    const upper = m.fund.map((v, i) => Math.max(v, m.idx[i]));
    const back = m.idx.map((v, i) => `L${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).reverse().join('');
    paths = `<path class="band" d="${line(upper)}${back}Z"/><path class="l-idx" d="${line(m.idx)}"/><path class="l-fund" d="${line(m.fund)}"/>`;
    ends.push({ y: Y(m.fund[N - 1]), label: `${sgn(m.fund[N - 1])} %` }, { y: Y(m.idx[N - 1]), label: `${sgn(m.idx[N - 1])} %` });
  } else {
    const back = m.stocks.map((v, i) => `L${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).reverse().join('');
    paths = `<path class="a-stocks" d="${line(m.stocks)}L${W} ${H}L0 ${H}Z"/><path class="a-cash" d="${line(m.total)}${back}Z"/>
      <path class="l-fund" d="${line(m.stocks)}"/><path class="l-total" d="${line(m.total)}"/>`;
    ends.push({ y: Y(m.total[N - 1]), label: f1(m.total[N - 1]) });
  }
  // Undvik krockande slutetiketter
  ends.sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 16) ends[i].y = ends[i - 1].y + 16;

  const hv = S.hover;
  let hover = '';
  if (hv != null) {
    const x = X(hv);
    const dots = m.ret
      ? [[m.fund[hv], 'var(--accent)'], [m.idx[hv], 'var(--index)']]
      : [[m.total[hv], 'var(--ink)'], [m.stocks[hv], 'var(--accent)']];
    const r = m.sr[hv];
    const p = parts(r.d);
    const rows = m.ret
      ? [['#9E1B32', 3, 'Kungens fond', `${sgn(m.fund[hv])} %`], ['#7D7A88', 2, 'Börsen', `${sgn(m.idx[hv])} %`]]
      : [['rgba(158,27,50,.3)', 10, 'Aktier', `${f1(m.stocks[hv])} Mkr`], ['repeating-linear-gradient(-66deg,#4B2A86 0 1.3px,transparent 1.3px 5px)', 10, 'Kassa, uppskattad', `≈ ${f1(m.cash[hv])} Mkr`]];
    const sum = m.ret ? ['Kungens försprång', `${sgn(m.fund[hv] - m.idx[hv])} pe`] : ['Totalt', `${f1(m.total[hv])} Mkr`];
    const prev = hv ? m.sr[hv - 1].d : '0000';
    const dayTrades = S.data.trades.filter((t) => t.date > prev && t.date <= r.d && t.date !== S.data.baseline);
    const inflow = !m.ret && m.inflow.get(r.d);
    const right = hv > N * 0.6;
    hover = `<div class="cross" style="left:${x}px"></div>
      ${dots.map(([v, c]) => `<span class="dot" style="left:${x}px;top:${Y(v)}px;background:${c}"></span>`).join('')}
      <div class="tip" style="position:absolute;top:4px;left:${x}px;transform:${right ? 'translateX(calc(-100% - 14px))' : 'translateX(14px)'}">
        <div class="tip-d">${dStamp(r.d)} · ${DAY[p.wd].toUpperCase()}</div>
        ${rows.map(([sw, h, l, v]) => `<div class="tip-r"><span class="sw" style="height:${h}px;background:${sw}"></span><span class="l">${esc(l)}</span><b>${v}</b></div>`).join('')}
        <div class="tip-r sum"><span class="sw"></span><span class="l">${sum[0]}</span><b>${sum[1]}</b></div>
        ${inflow ? `<div class="tip-trades">Köpen enligt innehavslistan var större än kassan: ${mkr(inflow)} räknas som nytt kapital.</div>` : ''}
        ${dayTrades.length ? `<div class="tip-trades">${dayTrades.slice(0, 4).map((t) => `${t.side === 'buy' ? '▲ Köpt' : t.side === 'sell' ? '▼ Sålt' : '◆'} ${esc(t.name)}`).join('<br>')}${dayTrades.length > 4 ? `<br>+ ${dayTrades.length - 4} till` : ''}</div>` : ''}
      </div>`;
  }

  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" aria-hidden="true">
      <defs><pattern id="kassaRaster" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(-24)"><line class="hatch" x1="0" y1="0" x2="0" y2="5"/></pattern></defs>
      <path class="grid" d="${grid}"/><path class="base" d="${base}"/>${paths}
    </svg>
    ${ticks.map((t) => `<span class="tick" style="top:${t.y}px">${t.label}</span>`).join('')}
    ${ends.map((e) => `<span class="end" style="top:${e.y}px">${e.label}</span>`).join('')}
    ${hover}
    <div class="hit"></div>`;

  // x-axel
  const xs = [];
  let prevM = '';
  m.sr.forEach((r, i) => {
    const mo = r.d.slice(0, 7);
    if (mo === prevM) return;
    prevM = mo;
    const p = parts(r.d);
    const L = (X(i) / W) * 100;
    if (L > 94) return;
    if (mobileMq.matches && (p.m - 2) % 3 !== 0 && i !== 0) return;
    if (xs.length && L - xs[xs.length - 1].L < (mobileMq.matches ? 28 : 6)) return;
    xs.push({ L, text: `${MON3[p.m - 1]}${p.m === 1 || i === 0 ? ` ${p.y}` : ''}` });
  });
  $('#xaxis').innerHTML = xs.map((x) => `<span style="left:${x.L.toFixed(2)}%">${x.text}</span>`).join('');

  // Legend och fot
  const d = S.data;
  $('#legend').innerHTML = m.ret
    ? `<span class="lg"><span class="sw" style="height:3px;background:var(--accent)"></span>Kungens fond (vår kopia)</span>
       <span class="lg"><span class="sw" style="height:2px;background:var(--index)"></span>Börsen: ${esc(benchLabel())}</span>
       <span class="lg"><span class="sw" style="height:12px;background:var(--band)"></span>Kungens försprång</span>`
    : `<span class="lg"><span class="sw" style="height:12px;background:var(--accent-soft)"></span>Aktier</span>
       <span class="lg"><span class="sw" style="height:12px;background:repeating-linear-gradient(-66deg,var(--pm) 0 1.3px,transparent 1.3px 5px)"></span>Kassa, uppskattad</span>`;
  $('#chart-title').textContent = m.ret ? 'Kungens fond mot börsen' : 'Fondens värde – aktier och kassa';
  $('#chart-foot').textContent = m.ret
    ? 'Både fonden och indexet räknar med utdelningar. Andelsvärdet är tidsviktat, så nytt kapital påverkar det inte.'
    : 'Kassan är uppskattad ur rapporterade affärer och utdelningar. Språnget i april är köp ur nytt kapital.';
  if (S.tableOpen) renderTable();
}

function renderTable() {
  const m = chartModel();
  const rows = m.sr.map((r, i) => ({ r, i })).filter(({ r, i }) => i === m.sr.length - 1 || m.sr[i + 1].d.slice(0, 7) !== r.d.slice(0, 7));
  const d = S.data;
  $('#chart-table').innerHTML = `<table><thead><tr><th scope="col">Datum</th><th scope="col">Kungens fond</th><th scope="col">${esc(benchLabel())}</th><th scope="col">Fondvärde</th><th scope="col">Kassa ≈</th></tr></thead>
    <tbody>${rows.map(({ r, i }) => `<tr><td>${dLong(r.d)}</td><td>${sgn(m.fund[i])} %</td><td>${sgn(m.idx[i])} %</td><td>${f1(m.total[i])} Mkr</td><td>${f1(m.cash[i])} Mkr</td></tr>`).join('')}</tbody></table>`;
}

// Interaktion i grafen
const chartEl = $('#chart');
const hoverAt = (clientX) => {
  const r = chartEl.getBoundingClientRect();
  const N = S.data.series.length;
  const i = Math.max(0, Math.min(N - 1, Math.round(((clientX - r.left) / r.width) * (N - 1))));
  if (i !== S.hover) { S.hover = i; renderChart(); }
};
chartEl.addEventListener('pointermove', (e) => S.data && hoverAt(e.clientX));
chartEl.addEventListener('pointerdown', (e) => S.data && hoverAt(e.clientX));
chartEl.addEventListener('pointerleave', () => { if (document.activeElement !== chartEl) { S.hover = null; renderChart(); } });
chartEl.addEventListener('keydown', (e) => {
  if (!S.data) return;
  const N = S.data.series.length;
  const cur = S.hover ?? N - 1;
  const next = { ArrowLeft: cur - 1, ArrowRight: cur + 1, Home: 0, End: N - 1 }[e.key];
  if (e.key === 'Escape') { S.hover = null; renderChart(); return; }
  if (next == null) return;
  e.preventDefault();
  S.hover = Math.max(0, Math.min(N - 1, next));
  renderChart();
});
chartEl.addEventListener('blur', () => { S.hover = null; renderChart(); });
const setView = (v) => {
  S.view = v; S.hover = null;
  $('#tab-return').setAttribute('aria-selected', String(v === 'return'));
  $('#tab-value').setAttribute('aria-selected', String(v === 'value'));
  renderChart();
};
$('#tab-return').addEventListener('click', () => setView('return'));
$('#tab-value').addEventListener('click', () => setView('value'));
$('#table-toggle').addEventListener('click', (e) => {
  S.tableOpen = !S.tableOpen;
  e.currentTarget.setAttribute('aria-expanded', String(S.tableOpen));
  e.currentTarget.textContent = S.tableOpen ? 'Dölj tabellen' : 'Visa som tabell';
  $('#chart-table').hidden = !S.tableOpen;
  if (S.tableOpen) renderTable();
});

// ---------- Albumet ----------
function lastRealTrade(ticker) {
  return S.data.trades.find((t) => t.ticker === ticker && t.date !== S.data.baseline);
}

function renderAlbum() {
  const d = S.data, s = d.summary;
  const mob = mobileMq.matches;
  const base = mob ? 80 : 96, k = mob ? 6 : 9;
  const ids = newEventIds();
  const asOf = new Date(d.asOf).getTime();
  const missing = new Set(missingQuotes().map((p) => p.ticker));
  if (!S.pick || (S.pick !== 'cash' && !d.positions.some((p) => p.ticker === S.pick))) S.pick = d.positions[0]?.ticker ?? 'cash';

  $('#album-sub').textContent = `${d.positions.length} märken. Höjden följer andelen av fonden – tryck på ett märke för att vända det.`;
  const used = new Set(d.positions.map((p) => GROUP[p.sector] ?? 'ind'));
  $('#inks').innerHTML = Object.keys(INK).filter((g) => used.has(g)).map((g) => `<li><i style="background:${INK[g]}"></i>${INK_NAME[g]}</li>`).join('');

  const stamps = d.positions.map((p) => {
    // Poststämpel bara för rapporterade affärer, inte för avstämningar mot innehavslistor.
    const t = d.trades.find((x) => x.ticker === p.ticker && x.date !== d.baseline && !x.implied);
    let pm = null;
    if (t && ids.has(t.eventId)) pm = ['NY', hhmm(new Date(ids.get(t.eventId).firstSeen).getTime()), '#4B2A86'];
    else if (t && t.side !== 'spinoff' && asOf - new Date(t.date).getTime() < 62 * 86400_000) {
      const tp = parts(t.date);
      pm = [t.side === 'buy' ? 'KÖPT' : 'SÅLT', `${MON3[tp.m - 1].toUpperCase()} ${String(tp.y).slice(2)}`, '#4B2A86'];
    }
    if (missing.has(p.ticker)) pm = ['SENAST', 'KÄNDA', '#9A5800'];
    const est = isEst(p.basis);
    const val = missing.has(p.ticker) ? 'kurs saknas' : `${est ? '≈ ' : ''}${f1(p.value / 1e6)} Mkr`;
    return `<button type="button" class="st" data-pick="${esc(p.ticker)}" aria-pressed="${S.pick === p.ticker}" aria-label="${esc(`${p.name}, ${p.sector}, ${f1(p.weight)} procent av fonden`)}" style="height:${Math.round(base + p.weight * k)}px">
      <span class="perf perf-t" aria-hidden="true"></span><span class="perf perf-b" aria-hidden="true"></span><span class="perf perf-l" aria-hidden="true"></span><span class="perf perf-r" aria-hidden="true"></span>
      <span class="st-in" style="background:${inkOf(p.sector)}">
        <span class="st-n">${soft(p.name)}</span>
        <span class="st-v"><span class="st-p">${f1(p.weight)} %</span><span class="st-k">${val}</span></span>
      </span>
      ${pm ? `<span class="st-pm" style="--c:${pm[2]}" aria-hidden="true"><span>${pm[0]}</span><span>${pm[1]}</span></span>` : ''}
    </button>`;
  });

  $('#album').innerHTML = stamps.join('');
  renderBack();
  renderCash();
}

const onPick = (e) => {
  const b = e.target.closest('[data-pick]');
  if (!b) return;
  S.pick = b.dataset.pick;
  document.querySelectorAll('[data-pick]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.pick === S.pick)));
  renderBack();
};
$('#album').addEventListener('click', onPick);
$('#cash').addEventListener('click', onPick);

function tradeNote(t) {
  if (!t) return null;
  const src = t.source ? ` (${t.source.publisher.split(' – ')[0]}, ${dShort(t.source.date ?? t.date)})` : '';
  const tp = parts(t.date);
  if (t.side === 'spinoff') return `Avknoppat till fonden ${dLong(t.date)}: ${nf(0).format(t.shares)} aktier${src}.`;
  if (t.implied) return `Senaste ändring: ${t.side === 'buy' ? '+' : '−'}${nf(0).format(t.shares)} aktier vid avstämning mot innehavslistan${src}.`;
  return `Senaste affär: ${t.side === 'buy' ? 'köpt' : 'sålt'} ${nf(0).format(t.shares)} aktier för ${isEst(t.basis) ? '≈ ' : ''}${money(t.value)} i ${MON[tp.m - 1]} ${tp.y}${src}.`;
}

function renderBack() {
  const d = S.data, s = d.summary;
  const el = $('#back');
  if (S.pick === 'cash') {
    const lastFlow = d.cashflows[0];
    el.innerHTML = `
      <div class="back-top"><span>MÄRKETS BAKSIDA</span><span>Likvida medel · uppskattad</span></div>
      <div class="back-name"><h3>Kassa</h3><span><strong>${f1(s.cashPct)} %</strong> av fonden · <strong>≈ ${mkr(s.cash)}</strong></span></div>
      <div class="back-grid">
        <div><div>Utdelningar hittills</div><div>${mkr(s.dividends)}</div></div>
        <div><div>Realiserat resultat</div><div>${sgn(s.realized / 1e6)} Mkr</div></div>
        <div><div>Nytt kapital</div><div>${mkr(s.injected)}</div></div>
        <div><div>Senaste kassaflöde</div><div>${lastFlow ? dShort(lastFlow.date) : '–'}</div></div>
      </div>
      <p class="back-note">Uppskattad ur rapporterade affärer och utdelningar. Hovet redovisar inte fondens kassa.</p>`;
    return;
  }
  const p = d.positions.find((x) => x.ticker === S.pick);
  if (!p) return;
  const est = isEst(p.basis);
  const missing = missingQuotes().some((x) => x.ticker === p.ticker);
  const t = lastRealTrade(p.ticker);
  const startSrc = d.trades.find((x) => x.ticker === p.ticker && x.date === d.baseline)?.source;
  const note = tradeNote(t) ?? `Finns med sedan startportföljen${startSrc ? ` (${startSrc.publisher}, ${dShort(startSrc.date)})` : ''}.`;
  el.innerHTML = `
    <div class="back-top"><span>MÄRKETS BAKSIDA</span><span>${esc(p.sector)}</span></div>
    <div class="back-name"><h3>${esc(p.name)}</h3><span><strong>${f1(p.weight)} %</strong> av fonden · <strong>${missing ? 'kurs saknas' : `${est ? '≈ ' : ''}${mkr(p.value)}`}</strong></span></div>
    <div class="back-grid">
      <div><div>Antal aktier</div><div>${est ? '≈ ' : ''}${nf(0).format(p.shares)}</div></div>
      <div><div>Kurs</div><div>${missing ? `Saknas – senast kända ${nf(2).format(p.price)} kr` : `${nf(2).format(p.price)} kr`}</div></div>
      <div><div>Idag</div><div style="color:${p.dayChangePct > 0 ? '#1E6B43' : p.dayChangePct < 0 ? '#B23A1E' : 'inherit'}">${sgn(p.dayChangePct, 2)} %</div></div>
      <div><div>I albumet sedan</div><div>${dLong(p.since)}</div></div>
    </div>
    <p class="back-note">${esc(note)}${est ? ' Antalet aktier är uppskattat.' : ''}</p>`;
}

function cashStampHtml() {
  const s = S.data.summary;
  const mob = mobileMq.matches;
  const base = mob ? 80 : 96, k = mob ? 6 : 9;
  return `<button type="button" class="st st-cash" data-pick="cash" aria-pressed="${S.pick === 'cash'}" aria-label="Kassa, uppskattad, ${f1(s.cashPct)} procent av fonden" style="height:${Math.max(base + 28, Math.round(base + s.cashPct * k))}px">
      <span class="perf perf-t" aria-hidden="true"></span><span class="perf perf-b" aria-hidden="true"></span><span class="perf perf-l" aria-hidden="true"></span><span class="perf perf-r" aria-hidden="true"></span>
      <span class="st-in"><span class="st-n">Kassa</span><span class="st-v"><span class="st-p">${f1(s.cashPct)} %</span><span class="st-k">≈ ${f1(s.cash / 1e6)} Mkr</span></span><span class="over" aria-hidden="true">UPPSKATTAD</span></span>
    </button>`;
}

function renderCash() {
  const d = S.data, s = d.summary;
  const maxW = Math.max(...d.positions.map((p) => p.weight));
  const lead = s.cashPct > maxW
    ? `<strong>Kassan är fondens största post</strong> – ${f1(s.cashPct)} procent, mer än något enskilt innehav.`
    : `<strong>Kassan motsvarar ${f1(s.cashPct)} procent av fonden.</strong>`;
  const flows = d.cashflows.map((c) => {
    const label = c.type === 'utdelning' ? `Utdelning ${c.name}` : c.type === 'kapitaltillskott' ? 'Nytt kapital (köp större än kassan)' : cap(c.type);
    return `<li><span>${dShort(c.date)} · ${esc(label)}</span><span>${c.amount >= 0 ? '+' : '−'}${money(Math.abs(c.amount))}</span></li>`;
  }).join('');
  $('#cash').innerHTML = `
    <div class="cash-top">${cashStampHtml()}<div class="cash-v"><b>≈ ${mkr(s.cash)}</b></div></div>
    <p>${lead} Hovet redovisar den inte, så vi räknar fram den ur rapporterade affärer och utdelningar. <a href="#m-method" data-open-link="m-method">Så räknar vi</a></p>
    <div class="cash-row"><span>Utdelningar hittills</span><b>${mkr(s.dividends)}</b></div>
    ${flows ? `<details><summary>Alla utdelningar och kassaflöden</summary><ul class="flows">${flows}</ul></details>` : ''}`;
}

// ---------- Postgången ----------
const ARROW = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 10.5V1.5M2 5.5l4-4 4 4"/></svg>';

function reportHtml(g, ids) {
  const src = g.source;
  const pub = src?.publisher?.split(' – ')[0] ?? 'okänd källa';
  const link = safeUrl(src?.url) ? `<a href="${esc(src.url)}" target="_blank" rel="noopener">${esc(pub)} ↗</a>` : esc(pub);
  const sp = src?.date ? parts(src.date) : null;
  const when = sp ? ` den ${sp.d} ${MON[sp.m - 1]}` : '';
  const head = g.snapshot
    ? `Avstämning mot innehavslistan från ${link}${when}. Skillnader mot vår uppskattning bokförs som affärer.`
    : g.spinoff
      ? `Avknoppning ${dLong(g.trades[0].date)}, enligt ${link}${when}`
      : `Affärer ${monthPhrase(g.trades)}, rapporterade av ${link}${when}`;
  const rows = [...g.trades].sort((a, b) => b.value - a.value).map((t) => {
    const cls = t.side === 'buy' ? 'buy' : t.side === 'sell' ? 'sell' : 'spin';
    const type = t.side === 'buy' ? 'Köpt' : t.side === 'sell' ? 'Sålt' : 'Avknoppat';
    const all = t.side === 'sell' && t.positionAfter === 0;
    const est = isEst(t.basis);
    const fresh = ids.has(t.eventId);
    return `<div class="tr${fresh ? ' is-new' : ''}">
      <span class="tr-type ${cls}">${t.side === 'spinoff' ? '' : ARROW.replace('<svg', `<svg style="transform:${t.side === 'sell' ? 'rotate(180deg)' : 'none'}"`)}${type}</span>
      <span class="tr-co"><b>${esc(t.name)}</b>${fresh ? '<span class="badge-new">NY</span>' : ''}${est ? '<span class="est">UPPSKATTAD</span>' : ''}
        <small>${all ? `Hela innehavet · ${nf(0).format(t.shares)} aktier` : `${est ? '≈ ' : ''}${nf(0).format(t.shares)} aktier`}</small></span>
      <span class="tr-amt">${est ? '≈ ' : ''}${money(t.value)}</span>
    </div>`;
  }).join('');
  const sold = g.trades.filter((t) => t.side === 'sell').reduce((a, t) => a + t.value, 0);
  const bought = g.trades.filter((t) => t.side === 'buy').reduce((a, t) => a + t.value, 0);
  const nEst = g.trades.filter((t) => isEst(t.basis)).length;
  const net = sold - bought;
  let sum = '';
  if (sold && bought) sum = `Netto: sålt för ${mkr(sold)}, köpt för ${mkr(bought)}. Mellanskillnaden, ${mkr(Math.abs(net))}, har ${net >= 0 ? 'gått till' : 'tagits från'} kassan.`;
  else if (sold) sum = `Sålt för ${mkr(sold)}, som har gått till kassan.`;
  else if (bought) sum = `Köpt för ${mkr(bought)}, betalt ur kassan.`;
  else if (g.spinoff) sum = 'Aktierna delades ut till befintliga ägare och påverkar inte kassan.';
  sum += nEst ? ` ${nEst === g.trades.length ? 'Alla' : `${nEst} av ${g.trades.length}`} är uppskattade.` : g.trades.length > 1 ? ` Alla ${COUNT[g.trades.length] ?? g.trades.length} är rapporterade uppgifter.` : ' Rapporterad uppgift.';
  const pmTxt = shortPublisher(src?.publisher).slice(0, 9);
  const stamp = `<span class="pm-round" aria-hidden="true"><span>${esc(pmTxt)}</span><span>${src?.date ? dStamp(src.date) : ''}</span></span>`;
  if (g.snapshot) {
    // Avstämningar är justeringar, inte nyheter: sammanfattning först, raderna på begäran.
    const inflow = d_inflowOn(g.trades[0]?.date);
    return `<article class="report">
      <div class="rep-head">${stamp}<p>${head}</p></div>
      <p class="rep-sum">${sum}${inflow ? ` Köpen var större än kassan, så ${mkr(inflow)} räknas som nytt kapital.` : ''}</p>
      <details class="more"><summary>Visa ${COUNT[g.trades.length] ?? g.trades.length} justeringar</summary>${rows}</details>
    </article>`;
  }
  return `<article class="report">
    <div class="rep-head">${stamp}<p>${head}</p></div>
    ${rows}
    <p class="rep-sum">${sum}</p>
  </article>`;
}

function renderPost() {
  const d = S.data;
  const ids = newEventIds();
  const gs = reports();
  const first = gs.slice(0, 2).map((g) => reportHtml(g, ids)).join('');
  const rest = gs.slice(2).map((g) => reportHtml(g, ids)).join('');
  const start = d.trades.filter((t) => t.date === d.baseline);
  const ssrc = start[0]?.source;
  const startHtml = `<article class="report"><div class="rep-head"><span class="pm-round" aria-hidden="true"><span>START</span><span>${dStamp(d.baseline)}</span></span>
    <p>Startportföljen: ${start.length} märken för ${mkr(d.summary.startCapital)} enligt ${safeUrl(ssrc?.url) ? `<a href="${esc(ssrc.url)}" target="_blank" rel="noopener">${esc(ssrc.publisher)} ↗</a>` : 'publicerad innehavslista'}.</p></div></article>`;
  $('#post').innerHTML = first + `<details class="older"><summary>Äldre utgåvor (${gs.length - 2 + 1})</summary>${rest}${startHtml}</details>`;

  // Sorteringen
  const OUT = {
    'ny affär': ['in', (n) => `INSATT I ALBUMET · ${n.eventIds?.length ?? ''} ${n.eventIds?.length === 1 ? 'AFFÄR' : 'AFFÄRER'}`],
    innehavstabell: ['in', () => 'INSATT · INNEHAVSLISTA'],
    'redan känd': ['ret', () => 'RETUR · REDAN I ALBUMET'],
    'ingen affär': ['ret', () => 'RETUR · INGEN AFFÄR'],
    'endast rubrik': ['ret', () => 'RETUR · ENDAST RUBRIK'],
    'ej läsbar': ['ret', () => 'RETUR · EJ LÄSBAR'],
  };
  const items = d.news.filter((n) => n.status !== 'före start').map((n) => {
    const [c, f] = OUT[n.status] ?? ['ret', () => 'RETUR'];
    const p = parts(n.date);
    const when = `${DAY[p.wd].slice(0, 3).toUpperCase()} ${p.d} ${MON3[p.m - 1].toUpperCase()}${newsNew(n) ? ' · NYSS' : ''}`;
    const href = safeUrl(n.url);
    return `<li>
      <div class="sort-meta"><span>${esc(shortPublisher(n.publisher))}</span><span>${when}</span></div>
      ${href ? `<a class="sort-h" href="${esc(href)}" target="_blank" rel="noopener">${esc(n.title)}</a>` : `<span class="sort-h">${esc(n.title)}</span>`}
      <div class="sort-i"><strong>Tolkning:</strong> ${esc(n.summary || '–')}</div>
      <span class="outcome ${c}">${esc(f(n))}</span>
    </li>`;
  });
  $('#sort').innerHTML = items.slice(0, 3).join('') + (items.length > 3 ? `<li class="more-li"><details class="more"><summary>Fler artiklar (${items.length - 3})</summary><ol class="sort" style="margin-top:14px">${items.slice(3).join('')}</ol></details></li>` : '');
  $('#scanline').innerHTML = `<span>${d.lastNewsScan ? `Senast läst ${sthlm(new Date(d.lastNewsScan).getTime(), { weekday: 'short' }).replace('.', '')} ${hhmm(new Date(d.lastNewsScan).getTime())}` : ''}</span><a href="data/feed.xml">Följ affärerna via RSS</a>`;
}

// ---------- Ditt album ----------
const PRESETS = [10000, 50000, 100000];
function renderCopy() {
  const d = S.data, s = d.summary;
  const N = d.positions.length;
  if (S.topN == null || S.topN > N) S.topN = N;
  $('#presets').innerHTML = PRESETS.map((v) => `<button type="button" data-amt="${v}" aria-pressed="${S.amount === v}">${nf(0).format(v)} kr</button>`).join('');
  const segs = [[N, `Alla ${N}`], [10, '10 största'], [5, '5 största']].filter(([n], i) => i === 0 || n < N);
  $('#segs').innerHTML = segs.map(([n, l]) => `<button type="button" data-top="${n}" aria-pressed="${S.topN === n}">${l}</button>`).join('');
  $('#keep-cash-hint').textContent = `Cirka ${Math.round(s.cashPct)} % av beloppet ligger kvar som likvida medel.`;
  const chosen = d.positions.slice(0, S.topN);
  const wsum = chosen.reduce((a, p) => a + p.weight, 0);
  const den = wsum + (S.keepCash ? s.cashPct : 0);
  const amt = S.amount;
  const rows = chosen.map((p) => `<div><i style="background:${inkOf(p.sector)}"></i><span>${esc(p.name)}</span><b>${tens((amt * p.weight) / den)}</b></div>`);
  if (S.keepCash) rows.push(`<div><i style="background:#FFFDF6;border:1.5px dashed #4B2A86"></i><span>Kassa</span><b>${tens((amt * s.cashPct) / den)}</b></div>`);
  $('#mine').innerHTML = rows.join('');
  $('#strip').innerHTML = chosen.map((p) => `<i style="flex:${p.weight};background:${inkOf(p.sector)}" title="${esc(p.name)}"></i>`).join('')
    + (S.keepCash ? `<i style="flex:${s.cashPct};background:repeating-linear-gradient(-66deg,#4B2A86 0 1.3px,transparent 1.3px 5px)" title="Kassa"></i>` : '');
  $('#coverage').textContent = `Täcker ${Math.round((wsum / (100 - s.cashPct)) * 100)} % av kungens aktier`;
}
$('#presets').addEventListener('click', (e) => {
  const b = e.target.closest('[data-amt]'); if (!b) return;
  S.amount = +b.dataset.amt; $('#belopp').value = nf(0).format(S.amount); renderCopy();
});
$('#segs').addEventListener('click', (e) => { const b = e.target.closest('[data-top]'); if (!b) return; S.topN = +b.dataset.top; renderCopy(); });
$('#keep-cash').addEventListener('change', (e) => { S.keepCash = e.target.checked; renderCopy(); });
$('#belopp').addEventListener('input', (e) => {
  const digits = e.target.value.replace(/\D/g, '').slice(0, 10);
  S.amount = +digits || 0;
  e.target.value = digits ? nf(0).format(S.amount) : '';
  if (S.data) renderCopy();
});
$('#copy-form').addEventListener('submit', (e) => e.preventDefault());

// ---------- Sidfot ----------
function renderFoot() {
  const d = S.data;
  $('#notes').innerHTML = (d.notes ?? []).map((n) => `<li>${esc(n)}</li>`).join('');
  const seen = new Map();
  for (const t of d.trades) if (t.source?.url && !seen.has(t.source.url)) seen.set(t.source.url, t.source);
  $('#sources').innerHTML = [...seen.values()].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
    .map((s) => `<li><a href="${esc(safeUrl(s.url) ?? '#')}" target="_blank" rel="noopener">${esc(s.title)}</a> – ${esc(s.publisher)}${s.date ? `, ${dLong(s.date)}` : ''}</li>`).join('');
}
const openPanel = (id, scroll) => {
  document.querySelectorAll('.foot-panel').forEach((p) => { p.hidden = p.id !== id || !p.hidden; });
  document.querySelectorAll('[data-open]').forEach((b) => b.setAttribute('aria-expanded', String(b.dataset.open === id && !$(`#${id}`).hidden)));
  if (scroll && !$(`#${id}`).hidden) $(`#${id}`).scrollIntoView({ behavior: 'smooth', block: 'start' });
};
document.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openPanel(b.dataset.open)));
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-open-link]');
  if (!a) return;
  e.preventDefault();
  const id = a.dataset.openLink;
  if ($(`#${id}`).hidden) openPanel(id, true); else $(`#${id}`).scrollIntoView({ behavior: 'smooth' });
});

// ---------- Hämtning ----------
let loading = false;
async function load({ initial = false } = {}) {
  if (loading) return;
  loading = true;
  const started = Date.now();
  if (!initial) setUpdating(true);
  try {
    const res = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    const changed = data.generatedAt !== S.generatedAt;
    const navChanged = S.data && Math.round(S.data.summary.nav / 1e5) !== Math.round(data.summary.nav / 1e5);
    S.data = data;
    S.generatedAt = data.generatedAt;
    S.fetchError = false;
    if (!initial) await new Promise((r) => setTimeout(r, Math.max(0, 900 - (Date.now() - started))));
    if (changed) renderAll(navChanged);
    if (navChanged) { const st = $('#status-stamp'); st.classList.remove('thump'); void st.offsetWidth; st.classList.add('thump'); }
  } catch {
    S.fetchError = true;
  } finally {
    loading = false;
    if (S.data) { renderStatus(); renderIssue(); }
    else { $('#status').classList.add('is-stale'); $('#st-l1').textContent = 'FEL'; $('#status-text').textContent = 'Kunde inte hämta data'; }
  }
}

function renderAll(changed = false) {
  renderHero(changed);
  renderChart();
  renderAlbum();
  renderPost();
  renderCopy();
  renderFoot();
}

$('#retry').addEventListener('click', () => load());
let rz;
addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => S.data && renderChart(), 120); });
mobileMq.addEventListener('change', () => S.data && renderAll());
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });

load({ initial: true });
setInterval(load, POLL_MS);
