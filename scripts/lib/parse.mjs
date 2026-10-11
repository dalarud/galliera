// Tolkar artikeltext: hittar innehavstabeller och meningar om köp/sälj.

const MONTHS = ['januari', 'februari', 'mars', 'april', 'maj', 'juni', 'juli', 'augusti', 'september', 'oktober', 'november', 'december'];

// Verb/uttryck → riktning och typ av affär. Ordningen spelar roll: specifika först.
const VERBS = [
  { re: /\b(sålt|sålde|säljer|avyttra\w*|dumpa\w*|gjort sig av med|gör sig av med|gjorde sig av med|lämna\w*|plocka\w* bort|petats?|droppa\w*)\b[^.]{0,40}\b(hela|samtliga|resterande|sista)\b/gi, side: 'sell', kind: 'exit' },
  { re: /\b(hela|samtliga)\s+(innehavet|aktierna|posten|positionen)\b[^.]{0,60}\b(sål\w*|borta|försvunnit|avyttra\w*|ute)\b/gi, side: 'sell', kind: 'exit' },
  { re: /\b(försvunnit|borta ur|ute ur|lämnat portföljen|plockats? bort|plockades bort|petats? ut|sålts? ut|avyttrats?|dumpats?)\b/gi, side: 'sell', kind: 'exit' },
  { re: /\bhalvera\w*\b/gi, side: 'sell', kind: 'half' },
  { re: /\b(minska\w*|skala\w* (ned|ner)|drag\w* ned|dragit ned|tagit hem vinst\w*|vinsthemtagning|trimma\w*)\b/gi, side: 'sell', kind: 'reduce' },
  { re: /\b(sål(t|de|des|ts)|säljer|sälja|avyttra\w*|dumpa\w*|fört ut|fördes ut|förts ut)\b/gi, side: 'sell', kind: 'reduce' },
  { re: /\b(ny(tt|a)? (innehav|bolag|position|i portföljen)|tagit in|tar in|tog in|plocka\w* in|tillkommi\w*|tagit en position|tar en position|köpt in sig|köper in sig|klivit in|kliver in|nykomling\w*|återvän\w*|tillbaka i portföljen|är tillbaka|återkommit|återinträd\w*)\b/gi, side: 'buy', kind: 'new' },
  { re: /\b(ök(at|ar|ade)|fyll\w* på|utök\w*|köpt (fler|mer|ytterligare)|köper (fler|mer|ytterligare))\b/gi, side: 'buy', kind: 'increase' },
  { re: /\b(köp(t|te|er|a|ts)?|investera(t|r|de)|adderat|lagt till)\b/gi, side: 'buy', kind: 'buy' },
];

const PERF_RE = /\b(procent|%|stigit|rusat|fallit|sjunkit|avkastning|kursen|kursutveckling|gått upp|gått ned)\b/i;
const TRADE_CONTEXT_RE = /\b(aktier|innehav\w*|position\w*|portfölj\w*|miljoner kronor|mkr|msek|kronor)\b/i;
const KING_RE = /(galliera|kung\w*|carl xvi gustaf|fonden|förvaltare\w*|överintendent)/i;
const OTHER_ROYAL_RE = /(gluonen|kronprinsess\w*|prinsess\w*|prins \w+|kungabarn\w*|victoria|madeleine|carl philip)/i;

export function buildAliasIndex(securities) {
  const list = [];
  for (const [ticker, s] of Object.entries(securities)) {
    for (const alias of s.aliases ?? [s.name]) {
      list.push({ ticker, alias, re: new RegExp(`(?<![\\p{L}\\p{N}])(?:${alias})(?![\\p{L}\\p{N}])`, 'gu') });
    }
  }
  // Längre alias först så att "Atlas Copco" matchar före "Atlas".
  return list.sort((a, b) => b.alias.length - a.alias.length);
}

/** Hitta bolagsnamn i en text, utan överlappande träffar. */
export function findCompanies(text, aliasIndex) {
  const hits = [];
  const taken = [];
  for (const { ticker, re } of aliasIndex) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const start = m.index, end = m.index + m[0].length;
      if (taken.some(([s, e]) => start < e && end > s)) continue;
      taken.push([start, end]);
      hits.push({ ticker, start, end, match: m[0] });
    }
  }
  return hits.sort((a, b) => a.start - b.start);
}

const parseInteger = (s) => Number(String(s).replace(/[\s  .,]/g, ''));
const SHARES_RE = /(\d{1,3}(?:[\s  .,]\d{3})+|\d{2,7})\s*(?:st\.?\s*)?(?:aktier|st\b)/i;
const VALUE_RE = /(\d+(?:[.,]\d+)?)\s*(miljoner kronor|miljoner|mkr|msek|miljarder|mdkr)/i;
const PERCENT_RE = /(?:med|cirka|omkring|drygt|knappt)?\s*(\d{1,2})\s*(?:procent|%)/i;

export function parseQuantity(fragment) {
  const q = {};
  const s = fragment.match(SHARES_RE);
  if (s) q.shares = parseInteger(s[1]);
  const v = fragment.match(VALUE_RE);
  if (v) q.value = parseFloat(v[1].replace(',', '.')) * (/miljard|mdkr/i.test(v[2]) ? 1e9 : 1e6);
  return q;
}

export function resolveDate(sentence, published) {
  const pub = new Date(published);
  const y = pub.getUTCFullYear(), m = pub.getUTCMonth();
  if (/\bförra månaden\b/i.test(sentence)) {
    const d = new Date(Date.UTC(y, m - 1, 15));
    return { date: d.toISOString().slice(0, 10), precision: 'månad' };
  }
  if (/\b(i fjol|förra året|fjolårets)\b/i.test(sentence)) return { date: `${y - 1}-07-01`, precision: 'år', old: true };
  const mm = sentence.toLowerCase().match(new RegExp(`\\b(?:i|under|sedan|i början av|i slutet av|i mitten av)\\s+(${MONTHS.join('|')})(?:\\s+(20\\d\\d))?`));
  if (mm) {
    const mi = MONTHS.indexOf(mm[1]);
    let year = mm[2] ? +mm[2] : y;
    if (!mm[2] && mi > m) year -= 1;
    const day = /i slutet av/.test(mm[0]) ? 25 : /i början av/.test(mm[0]) ? 5 : 15;
    const d = new Date(Date.UTC(year, mi, day));
    const iso = d.toISOString().slice(0, 10);
    return { date: iso > published.slice(0, 10) ? published.slice(0, 10) : iso, precision: 'månad' };
  }
  return { date: published.slice(0, 10), precision: 'publicering' };
}

export function splitSentences(text) {
  return text
    .split(/\n+/)
    .flatMap((p) => p.split(/(?<=[.!?])\s+(?=[A-ZÅÄÖ"”«–-])/))
    .map((s) => s.trim())
    .filter((s) => s.length > 15);
}

/** Försök läsa en innehavstabell: rader med bolagsnamn + antal aktier. */
export function extractHoldingsTable({ rows = [], text = '' }, aliasIndex) {
  const found = new Map();
  const consider = (cells) => {
    if (cells.length < 2) return;
    const comp = findCompanies(cells[0], aliasIndex)[0] ?? findCompanies(cells.slice(0, 2).join(' '), aliasIndex)[0];
    if (!comp) return;
    // Första heltalscellen ≥ 100 utan decimaler tolkas som antal aktier.
    for (const c of cells.slice(1)) {
      const t = c.replace(/[  ]/g, ' ').trim();
      if (/^\d{1,3}( \d{3})+$|^\d{3,7}$/.test(t)) {
        const n = parseInteger(t);
        if (n >= 100 && !found.has(comp.ticker)) found.set(comp.ticker, n);
        return;
      }
    }
  };
  rows.forEach(consider);
  // Tabeller återgivna som text: "Investor 31 300 12,9"
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-ZÅÄÖ][\p{L}&.\- ]{1,40}?)\s+(\d{1,3}(?:[   ]\d{3})+)\s+\d+[,.]\d/u);
    if (m) consider([m[1], m[2]]);
  }
  return found;
}

/**
 * Hitta affärssignaler i en artikel.
 * @returns {{ticker, side, kind, shares?, value?, fraction?, date, precision, old?, sentence}[]}
 */
export function extractSignals(text, { published, aliasIndex, kingInTitle = true }) {
  const out = [];
  for (const sentence of splitSentences(text)) {
    const mentionsKing = KING_RE.test(sentence);
    // Meningar om andra kungliga portföljer (t.ex. Gluonen) räknas inte, om inte kungen/fonden också nämns.
    if (OTHER_ROYAL_RE.test(sentence) && !/(galliera|kungen|kungens|carl xvi gustaf)/i.test(sentence)) continue;
    if (!mentionsKing && !kingInTitle) continue;
    const companies = findCompanies(sentence, aliasIndex);
    if (!companies.length) continue;

    const verbs = [];
    for (const v of VERBS) {
      v.re.lastIndex = 0;
      for (const m of sentence.matchAll(v.re)) {
        if (verbs.some((x) => m.index < x.end && m.index + m[0].length > x.start)) continue;
        verbs.push({ ...v, start: m.index, end: m.index + m[0].length, text: m[0] });
      }
    }
    if (!verbs.length) continue;
    // Rena kursnyheter ("Investor har stigit 30 procent") är inga affärer.
    if (PERF_RE.test(sentence) && !TRADE_CONTEXT_RE.test(sentence) && !verbs.some((v) => v.kind === 'exit' || v.kind === 'new')) continue;
    verbs.sort((a, b) => a.start - b.start);

    for (const [ci, c] of companies.entries()) {
      // Bolaget är själv subjekt ("Investor köper aktier i EQT") → inte kungens affär.
      const after = sentence.slice(c.end, c.end + 25);
      if (/^\s*(har\s+)?(köp|sälj|sål|ök|minsk|investera)/i.test(after) && !mentionsKing && companies.length > 1) continue;
      if (/^\s*s\s+(vd|ordförande|styrelse|storägare|ledning)/i.test(after)) continue;

      const before = verbs.filter((v) => v.end <= c.start);
      const afterV = verbs.filter((v) => v.start >= c.end);
      const spanning = verbs.find((v) => v.start <= c.start && v.end >= c.end);
      const verb = spanning ?? (before.length ? before[before.length - 1] : afterV[0]);
      if (!verb) continue;
      // Kvantitet: närmast efter bolagsnamnet (fram till nästa bolag), annars före.
      const nextStart = companies[ci + 1]?.start ?? sentence.length;
      const prevEnd = companies[ci - 1]?.end ?? 0;
      let q = parseQuantity(sentence.slice(c.end, nextStart));
      if (!q.shares && !q.value) q = parseQuantity(sentence.slice(Math.max(prevEnd, verb.start), c.start));
      const sig = { ticker: c.ticker, side: verb.side, kind: verb.kind, ...q, verb: verb.text, sentence };
      if (verb.kind === 'exit') sig.fraction = 1;
      if (verb.kind === 'half') sig.fraction = 0.5;
      const pct = verb.kind === 'reduce' && !q.shares && !q.value ? sentence.slice(verb.end, verb.end + 30).match(PERCENT_RE) : null;
      if (pct) sig.fraction = Math.min(1, +pct[1] / 100);
      Object.assign(sig, resolveDate(sentence, published));
      if (!out.some((o) => o.ticker === sig.ticker && o.side === sig.side)) out.push(sig);
    }
  }
  return out;
}
