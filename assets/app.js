// Kungens Portfölj – frontend. Läser data/portfolio.json och uppdaterar sig själv.
const DATA_URL = 'data/portfolio.json';
const POLL_MS = 60_000;

const $ = (sel) => document.querySelector(sel);
const state = { data: null, mode: 'pct', range: 'MAX', bench: 'OMXSPI', generatedAt: null };

// ---------- Format ----------
const nf = (d = 0) => new Intl.NumberFormat('sv-SE', { minimumFractionDigits: d, maximumFractionDigits: d });
const kr = (v) => `${nf(0).format(Math.round(v))} kr`;
const mkr = (v, d = 1) => `${nf(d).format(v / 1e6)} Mkr`;
const money = (v) => (Math.abs(v) >= 1e6 ? mkr(v, Math.abs(v) >= 1e8 ? 0 : 1) : kr(v));
const pct = (v, d = 1) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${nf(d).format(Math.abs(v))} %`;
const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
const dateSv = (iso, year = true) => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}${year ? ' ' + y : ''}`;
};
const timeSv = (iso) => new Date(iso).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Stockholm' });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u ?? '') ? u : null);

// ---------- Tema ----------
try {
  const saved = localStorage.getItem('theme');
  if (saved) document.documentElement.dataset.theme = saved;
} catch { /* privat läge */ }
$('#theme-btn').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('theme', next); } catch { /* ignore */ }
  renderChart();
});

// ---------- Datahämtning ----------
async function load({ initial = false } = {}) {
  try {
    const res = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    const changed = data.generatedAt !== state.generatedAt;
    state.data = data;
    state.generatedAt = data.generatedAt;
    if (changed) {
      renderAll();
      if (!initial) document.querySelectorAll('.crest, #holdings tbody').forEach((el) => { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); });
    }
    setLive(data);
  } catch (err) {
    $('#live').className = 'live stale';
    $('#live-text').textContent = 'Kunde inte hämta data – försöker igen';
  }
}

function setLive(d) {
  const ageMin = (Date.now() - new Date(d.generatedAt)) / 60000;
  const live = $('#live');
  live.className = 'live ' + (ageMin < 45 ? 'on' : 'stale');
  const scan = d.lastNewsScan ? ` · nyheter ${timeSv(d.lastNewsScan)}` : '';
  $('#live-text').textContent = ageMin < 45
    ? `Live · kurser ${timeSv(d.generatedAt)}${scan}`
    : `Uppdaterad ${dateSv(d.generatedAt, false)} ${timeSv(d.generatedAt)}${scan}`;
}

// ---------- Rendering ----------
function renderAll() {
  const d = state.data;
  if (!d.benchmarks[state.bench]) state.bench = Object.keys(d.benchmarks)[0];
  renderHero();
  renderBenchSelect();
  renderChart();
  renderHoldings();
  renderTrades();
  renderCopy();
  renderNews();
  $('#notes').innerHTML = (d.notes ?? []).map((n) => `<li>${esc(n)}</li>`).join('');
  $('#generated').textContent = `${dateSv(d.generatedAt)} kl. ${timeSv(d.generatedAt)}`;
}

function renderHero() {
  const { summary: s, series, asOf, baseline } = state.data;
  const b0 = series[0][state.bench], b1 = series[series.length - 1][state.bench];
  const benchPct = (b1 / b0 - 1) * 100;
  $('#nav').textContent = mkr(s.nav, 1);
  const day = $('#day');
  day.className = 'crest-day ' + cls(s.dayChangePct);
  day.textContent = `${pct(s.dayChangePct, 2)} idag (${s.dayChangeKr >= 0 ? '+' : '−'}${money(Math.abs(s.dayChangeKr))})`;
  const since = $('#since');
  since.className = cls(s.sinceStartPct);
  since.textContent = pct(s.sinceStartPct);
  $('#bench-label-short').textContent = state.bench === 'OMXS30' ? 'OMXS30' : 'OMXSPI';
  const sb = $('#since-bench');
  sb.className = cls(benchPct);
  sb.textContent = pct(benchPct);
  $('#cash').innerHTML = `${mkr(s.cash, 1)} <small>${nf(1).format(s.cashPct)} %</small>`;
  $('#count').innerHTML = `${s.positions} <small>bolag</small>`;
  $('#asof').textContent = `Start ${dateSv(baseline)} · andelsvärde ${nf(2).format(s.unit)} kr (start 100) · kurser per ${dateSv(asOf)}`;
}

function renderBenchSelect() {
  const sel = $('#bench-select');
  sel.innerHTML = Object.entries(state.data.benchmarks)
    .map(([k, label]) => `<option value="${k}" ${k === state.bench ? 'selected' : ''}>${esc(label)}</option>`).join('');
}

// ---------- Graf ----------
function sliceRange(series) {
  const last = series[series.length - 1].d;
  const cut = (() => {
    const dt = new Date(last + 'T00:00:00Z');
    switch (state.range) {
      case '1M': dt.setUTCMonth(dt.getUTCMonth() - 1); break;
      case '3M': dt.setUTCMonth(dt.getUTCMonth() - 3); break;
      case '6M': dt.setUTCMonth(dt.getUTCMonth() - 6); break;
      case 'YTD': return `${last.slice(0, 4)}-01-01`;
      default: return '0000';
    }
    return dt.toISOString().slice(0, 10);
  })();
  // Inkludera dagen före perioden som bas så att första punkten är 0 %.
  const idx = series.findIndex((r) => r.d >= cut);
  return series.slice(Math.max(0, idx - (state.range === 'MAX' ? 0 : 1)));
}

function niceTicks(min, max, count = 5) {
  const span = max - min || 1;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? 10 * mag;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) ticks.push(+v.toFixed(10));
  return ticks;
}

function tradesByDay() {
  const map = new Map();
  for (const t of state.data.trades) {
    if (t.date === state.data.baseline) continue;
    if (!map.has(t.date)) map.set(t.date, []);
    map.get(t.date).push(t);
  }
  return map;
}

function renderChart() {
  const d = state.data;
  if (!d) return;
  const el = $('#chart');
  const rows = sliceRange(d.series);
  const W = el.clientWidth || 800, H = el.clientHeight || 360;
  const narrow = W < 560;
  const m = { t: 14, r: narrow ? 58 : 84, b: 28, l: narrow ? 46 : 64 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const bench = state.bench;
  const benchLabel = bench === 'OMXS30' ? 'OMXS30' : 'OMXSPI';
  const pctMode = state.mode === 'pct';
  const u0 = rows[0].unit, b0 = rows[0][bench];

  const fund = rows.map((r) => (pctMode ? (r.unit / u0 - 1) * 100 : r.nav));
  const ben = rows.map((r) => (r[bench] / b0 - 1) * 100);
  const cash = rows.map((r) => r.cash);

  let lo, hi;
  if (pctMode) { lo = Math.min(0, ...fund, ...ben); hi = Math.max(0, ...fund, ...ben); const pad = (hi - lo) * 0.08 || 1; lo -= pad; hi += pad; }
  else { lo = 0; hi = Math.max(...fund) * 1.06; }
  const ticks = niceTicks(lo, hi, narrow ? 4 : 5);
  lo = Math.min(lo, ticks[0]); hi = Math.max(hi, ticks[ticks.length - 1]);
  const x = (i) => m.l + (rows.length === 1 ? iw / 2 : (i / (rows.length - 1)) * iw);
  const y = (v) => m.t + ih - ((v - lo) / (hi - lo)) * ih;
  const path = (arr) => arr.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const fmtY = (v) => (pctMode ? `${v > 0 ? '+' : ''}${nf(Math.abs(hi - lo) < 8 ? 1 : 0).format(v)} %` : `${nf(0).format(v / 1e6)} Mkr`);

  // x-etiketter vid månadsskiften
  const xTicks = [];
  let lastM = null;
  rows.forEach((r, i) => { const mo = r.d.slice(0, 7); if (mo !== lastM) { xTicks.push(i); lastM = mo; } });
  const minGap = narrow ? 58 : 64;
  const xT = xTicks.filter((i, k) => k === 0 || x(i) - x(xTicks[k - 1]) >= 0).reduce((acc, i) => {
    if (!acc.length || x(i) - x(acc[acc.length - 1]) >= minGap) acc.push(i);
    return acc;
  }, []);

  // Handelsmarkeringar
  const tdays = tradesByDay();
  const markers = [];
  rows.forEach((r, i) => {
    const prev = i ? rows[i - 1].d : '0000';
    const ts = [...tdays].filter(([day]) => day > prev && day <= r.d && (i > 0 || day === r.d)).flatMap(([, v]) => v);
    if (!ts.length) return;
    const net = ts.reduce((s, t) => s + (t.side === 'buy' ? t.value : t.side === 'sell' ? -t.value : 0), 0);
    markers.push({ i, side: net >= 0 ? 'buy' : 'sell', trades: ts });
  });
  const markerAt = new Map(markers.map((mk) => [mk.i, mk]));

  const lastI = rows.length - 1;
  let endF = y(fund[lastI]), endB = y(ben[lastI]);
  if (pctMode && Math.abs(endF - endB) < 16) { const mid = (endF + endB) / 2; const s = endF < endB ? -8 : 8; endF = mid + s; endB = mid - s; }

  const svg = `
  <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <defs>
      <linearGradient id="fundGrad" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0" style="stop-color:var(--gold);stop-opacity:.28"/>
        <stop offset="1" style="stop-color:var(--gold);stop-opacity:.04"/>
      </linearGradient>
    </defs>
    <g class="grid">${ticks.map((t) => `<line x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/>`).join('')}</g>
    ${pctMode ? `<line class="zero" x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}"/>` : ''}
    <g class="axis">
      ${ticks.map((t) => `<text x="${m.l - 8}" y="${y(t) + 4}" text-anchor="end">${fmtY(t)}</text>`).join('')}
      ${xT.map((i) => `<text x="${x(i)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : 'middle'}">${MONTHS[+rows[i].d.slice(5, 7) - 1]}${rows[i].d.slice(5, 7) === '01' || i === 0 ? ' ' + rows[i].d.slice(2, 4) : ''}</text>`).join('')}
    </g>
    ${pctMode
      ? `<path class="line-bench" d="${path(ben)}"/>`
      : `<path class="area-fund" d="${path(fund)}L${x(lastI)},${y(0)}L${x(0)},${y(0)}Z"/>
         <path class="area-cash" d="${path(cash)}L${x(lastI)},${y(0)}L${x(0)},${y(0)}Z"/>`}
    <path class="line-fund" d="${path(fund)}"/>
    ${markers.map((mk) => {
      const cx = x(mk.i), cy = y(fund[mk.i]);
      return mk.side === 'buy'
        ? `<path class="mk-buy-shape" d="M${cx},${cy + 7} l5,9 h-10 z"/>`
        : `<path class="mk-sell-shape" d="M${cx},${cy - 7} l5,-9 h-10 z"/>`;
    }).join('')}
    <text class="end-label" x="${x(lastI) + 8}" y="${endF + 4}">${pctMode ? pct(fund[lastI]) : mkr(fund[lastI])}</text>
    ${pctMode ? `<text class="end-label" x="${x(lastI) + 8}" y="${endB + 4}" style="fill:var(--ink-2)">${pct(ben[lastI])}</text>` : ''}
    <g id="hover" style="display:none">
      <line class="crosshair" y1="${m.t}" y2="${m.t + ih}"/>
      ${pctMode ? '<circle class="dot" r="4.5" style="fill:var(--bench)" data-s="b"/>' : '<circle class="dot" r="4.5" style="fill:var(--gold);opacity:.6" data-s="c"/>'}
      <circle class="dot" r="5" style="fill:var(--gold)" data-s="f"/>
    </g>
    <rect x="${m.l}" y="0" width="${iw}" height="${H}" fill="transparent" id="hit"/>
  </svg>`;
  el.innerHTML = svg;

  // Legend
  const last = rows[lastI];
  $('#legend').innerHTML = pctMode
    ? `<span class="item"><span class="sw" style="border-color:var(--gold)"></span>Gallierafonden (replikerad) <span class="val">${pct(fund[lastI])}</span></span>
       <span class="item"><span class="sw dash" style="border-color:var(--bench)"></span>${esc(d.benchmarks[bench])} <span class="val">${pct(ben[lastI])}</span></span>`
    : `<span class="item"><span class="sw" style="border-color:var(--gold)"></span>Fondvärde <span class="val">${mkr(last.nav)}</span></span>
       <span class="item"><span class="sw area"></span>varav kassa <span class="val">${mkr(last.cash)}</span></span>`;
  $('#chart-sub').textContent = pctMode
    ? `Andelsvärdets utveckling (tidsviktad, inklusive utdelningar) mot ${d.benchmarks[bench]}, ${dateSv(rows[0].d)} – ${dateSv(last.d)}.`
    : `Fondens totala värde i kronor; den skuggade ytan längst ned är den uppskattade kassan.`;

  // Hover
  const hover = el.querySelector('#hover');
  const tip = $('#tooltip');
  const show = (evt) => {
    const rect = el.getBoundingClientRect();
    const px = ((evt.clientX - rect.left) / rect.width) * W;
    const i = Math.max(0, Math.min(lastI, Math.round(((px - m.l) / iw) * lastI)));
    const r = rows[i];
    hover.style.display = '';
    hover.querySelector('line').setAttribute('x1', x(i));
    hover.querySelector('line').setAttribute('x2', x(i));
    const f = hover.querySelector('[data-s="f"]');
    f.setAttribute('cx', x(i)); f.setAttribute('cy', y(fund[i]));
    const other = hover.querySelector('[data-s="b"], [data-s="c"]');
    other.setAttribute('cx', x(i)); other.setAttribute('cy', y(pctMode ? ben[i] : cash[i]));
    const mk = markerAt.get(i);
    tip.innerHTML = `<div class="t-date">${dateSv(r.d)}</div>` + (pctMode
      ? `<div class="t-row"><span><i class="t-sw" style="border-color:var(--gold)"></i>Gallierafonden</span><b>${pct(fund[i], 2)}</b></div>
         <div class="t-row"><span><i class="t-sw" style="border-color:var(--bench)"></i>${benchLabel}</span><b>${pct(ben[i], 2)}</b></div>
         <div class="t-row"><span>Andelsvärde</span><b>${nf(2).format(r.unit)} kr</b></div>`
      : `<div class="t-row"><span><i class="t-sw" style="border-color:var(--gold)"></i>Fondvärde</span><b>${mkr(r.nav, 2)}</b></div>
         <div class="t-row"><span>Aktier</span><b>${mkr(r.nav - r.cash, 2)}</b></div>
         <div class="t-row"><span>Kassa</span><b>${mkr(r.cash, 2)}</b></div>`)
      + (mk ? `<div class="t-trades">${mk.trades.slice(0, 7).map((t) => `<div class="t-row"><span>${t.side === 'buy' ? '▲ Köp' : t.side === 'sell' ? '▼ Sälj' : '◆ Avknoppning'} ${esc(t.name)}</span><b>${money(t.value)}</b></div>`).join('')}${mk.trades.length > 7 ? `<div class="t-row"><span>+ ${mk.trades.length - 7} till</span></div>` : ''}</div>` : '');
    tip.hidden = false;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = evt.clientX + 16; if (left + tw > innerWidth - 8) left = evt.clientX - tw - 16;
    let top = evt.clientY - th / 2; top = Math.max(8, Math.min(innerHeight - th - 8, top));
    tip.style.left = `${Math.max(8, left)}px`; tip.style.top = `${top}px`;
  };
  const hide = () => { hover.style.display = 'none'; tip.hidden = true; };
  const hit = el.querySelector('#hit');
  hit.addEventListener('pointermove', show);
  hit.addEventListener('pointerdown', show);
  hit.addEventListener('pointerleave', hide);
}

// ---------- Innehav ----------
function renderHoldings() {
  const { positions, summary: s } = state.data;
  const maxW = Math.max(...positions.map((p) => p.weight));
  const recent = new Set(state.data.trades.filter((t) => t.side === 'buy' && t.positionAfter === t.shares && t.date > state.data.baseline).map((t) => t.ticker));
  $('#holdings tbody').innerHTML = positions.map((p) => `
    <tr>
      <td><div class="co"><b>${esc(p.name)} ${recent.has(p.ticker) ? '<span class="badge new">Ny</span>' : ''}</b><small>${esc(p.sector)} · ${esc(p.ticker.replace('.ST', ''))}</small></div></td>
      <td class="num">${nf(0).format(p.shares)}</td>
      <td class="num">${nf(2).format(p.price)}</td>
      <td class="num ${cls(p.dayChangePct)}">${pct(p.dayChangePct, 2)}</td>
      <td class="num">${money(p.value)}</td>
      <td class="num"><span class="bar"><i style="width:${(p.weight / maxW) * 56}px"></i>${nf(1).format(p.weight)} %</span></td>
    </tr>`).join('');
  $('#holdings tfoot').innerHTML = `
    <tr><td>Aktier</td><td></td><td></td><td></td><td class="num">${money(s.invested)}</td><td class="num">${nf(1).format(100 - s.cashPct)} %</td></tr>
    <tr><td>Kassa <span class="badge">uppskattad</span></td><td></td><td></td><td></td><td class="num">${money(s.cash)}</td><td class="num">${nf(1).format(s.cashPct)} %</td></tr>
    <tr><td>Totalt</td><td></td><td></td><td class="num ${cls(s.dayChangePct)}">${pct(s.dayChangePct, 2)}</td><td class="num">${money(s.nav)}</td><td class="num">100 %</td></tr>`;
  $('#weights').innerHTML = positions.map((p) => `<span style="flex:${p.weight}" title="${esc(p.name)} ${nf(1).format(p.weight)} %"></span>`).join('')
    + `<span class="cash" style="flex:${s.cashPct}" title="Kassa ${nf(1).format(s.cashPct)} %"></span>`;
}

// ---------- Affärer ----------
function tradeItem(t) {
  const chip = t.side === 'buy' ? ['buy', 'Köp'] : t.side === 'sell' ? ['sell', 'Sälj'] : ['spinoff', 'Avkn.'];
  const est = /uppskatt/.test(t.basis);
  const src = t.source ? `${safeUrl(t.source.url) ? `<a href="${esc(safeUrl(t.source.url))}" target="_blank" rel="noopener">${esc(t.source.publisher)}</a>` : esc(t.source.publisher)}${t.source.date ? ' · ' + dateSv(t.source.date) : ''}` : '';
  return `<li>
    <div class="chip ${chip[0]}" aria-label="${chip[1]}">${t.side === 'buy' ? '▲' : t.side === 'sell' ? '▼' : '◆'}</div>
    <div>
      <div class="f-top"><span class="f-title">${chip[1]} ${esc(t.name)}</span><span class="f-date">${dateSv(t.date)}</span></div>
      <div class="f-meta">${nf(0).format(t.shares)} aktier à ${nf(2).format(t.price)} kr = <b>${money(t.value)}</b>
        <span class="basis ${est ? 'est' : ''}">${esc(t.basis)}</span>${t.implied ? ' <span class="basis">avstämning</span>' : ''}${t.auto ? ' <span class="basis auto">auto</span>' : ''}</div>
      ${t.note && !t.implied ? `<div class="f-note">${esc(t.note)}</div>` : ''}
      ${src ? `<div class="f-src">Källa: ${src}</div>` : ''}
    </div>
  </li>`;
}

function renderTrades() {
  const { trades, baseline, summary: s } = state.data;
  const list = trades.filter((t) => t.date !== baseline);
  const start = trades.filter((t) => t.date === baseline);
  const first = list.slice(0, 10).map(tradeItem).join('');
  const rest = list.slice(10).map(tradeItem).join('');
  const startItem = `<li>
    <div class="chip spinoff">♛</div>
    <div>
      <div class="f-top"><span class="f-title">Startportfölj</span><span class="f-date">${dateSv(baseline)}</span></div>
      <div class="f-meta">${start.length} bolag för <b>${money(s.startCapital)}</b> enligt publicerad innehavslista.</div>
      ${start[0]?.source ? `<div class="f-src">Källa: <a href="${esc(safeUrl(start[0].source.url) ?? '#')}" target="_blank" rel="noopener">${esc(start[0].source.publisher)}</a></div>` : ''}
    </div></li>`;
  $('#trades').innerHTML = first + (rest ? `<li style="display:block"><details><summary>Visa ${list.length - 10} äldre affärer</summary><ol class="feed">${rest}${startItem}</ol></details></li>` : startItem);
}

// ---------- Köp som kungen ----------
function renderCopy() {
  const { positions, summary: s } = state.data;
  const raw = Number(($('#amount').value || '').replace(/[^\d]/g, '')) || 0;
  const keepCash = $('#keep-cash').checked;
  const investable = keepCash ? raw * (1 - s.cashPct / 100) : raw;
  let spent = 0;
  const cards = positions.map((p) => {
    const target = investable * (p.value / s.invested);
    const n = Math.floor(target / p.price);
    spent += n * p.price;
    return `<div class="pos"><b>${esc(p.name)}</b><span class="n">${nf(0).format(n)}</span> <small>st · ${kr(n * p.price)}</small><br><small>kungen: ${nf(1).format(p.weight)} %</small></div>`;
  });
  const left = raw - spent;
  $('#copy-out').innerHTML = cards.join('')
    + `<div class="pos cash"><b>Kassa</b><span class="n">${kr(left)}</span><br><small>kungen: ${nf(1).format(s.cashPct)} %</small></div>`
    + `<p class="copy-sum">Du köper aktier för ${kr(spent)} och behåller ${kr(left)} i kassan. Med mindre belopp blir dyra aktier svåra att få med, så fördelningen blir mer exakt ju större beloppet är.</p>`;
}
$('#amount').addEventListener('input', (e) => {
  const digits = e.target.value.replace(/[^\d]/g, '').slice(0, 10);
  e.target.value = digits ? nf(0).format(+digits) : '';
  if (state.data) renderCopy();
});
$('#keep-cash').addEventListener('change', () => state.data && renderCopy());

// ---------- Nyheter ----------
const STATUS = {
  'ny affär': ['trade', 'Ny affär'], innehavstabell: ['table', 'Innehavstabell'], 'redan känd': ['', 'Redan bokförd'],
  'ingen affär': ['', 'Ingen affär'], 'ej läsbar': ['', 'Ej läsbar'], 'endast rubrik': ['', 'Endast rubrik'],
  'före start': ['', 'Före start'], 'manuellt verifierad': ['table', 'Verifierad'],
};
function renderNews() {
  const { news, lastNewsScan } = state.data;
  $('#news-sub').textContent = `Nyheter som skannats automatiskt och hur de tolkats${lastNewsScan ? ` · senaste skanning ${dateSv(lastNewsScan, false)} kl. ${timeSv(lastNewsScan)}` : ''}.`;
  $('#news').innerHTML = news.length ? news.slice(0, 20).map((n) => {
    const [c, label] = STATUS[n.status] ?? ['', n.status];
    const href = safeUrl(n.url);
    return `<li>
      <div>${href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(n.title)}</a>` : esc(n.title)}</div>
      <span class="status ${c}">${esc(label)}</span>
      <div class="n-meta">${esc(n.publisher)} · ${dateSv(n.date)}</div>
      ${n.notes?.length ? `<ul class="n-notes">${n.notes.slice(0, 4).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    </li>`;
  }).join('') : '<li>Inga nyheter skannade ännu.</li>';
}

// ---------- Kontroller ----------
function bindSeg(id, key, attr) {
  $(id).addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    state[key] = btn.dataset[attr];
    $(id).querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    renderChart();
  });
}
bindSeg('#mode-seg', 'mode', 'mode');
bindSeg('#range-seg', 'range', 'range');
$('#bench-select').addEventListener('change', (e) => { state.bench = e.target.value; renderHero(); renderChart(); });
let rz;
addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(renderChart, 120); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });

load({ initial: true });
setInterval(load, POLL_MS);
