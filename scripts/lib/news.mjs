// Nyhetsbevakning: Google News RSS (svenska) → publicistens URL → artikeltext.
import { createHash } from 'node:crypto';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export const QUERIES = [
  'Gallierafonden',
  'Galliera kungen aktier',
  'kungens aktier',
  'kungens portfölj',
  'kungens aktieportfölj',
  'kungen säljer aktier',
  'kungen köper aktier',
  'kungafamiljen aktier Holdings',
  'kungafamiljens portföljer',
  'kungliga förvaltaren aktier',
  'Carl XVI Gustaf aktier',
];

// Artikeln måste handla om kungen/Gallierafonden ...
export const KING_RE = /(galliera|kung(en|ens|liga|ahus|afamilj|a-?aktie)|carl xvi gustaf|överintendent|kungliga hovstaterna)/i;
// ... och om aktier/affärer.
export const TRADE_RE = /(aktie|portfölj|köp|sål|sälj|innehav|minsk|ökar|ökat|dump|investera|placer|börs|förvaltar)/i;

const decodeEntities = (s) => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;|&#160;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));

const tag = (xml, name) => decodeEntities(xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1] ?? '').trim();

export function newsId(title) {
  const base = title.replace(/\s+-\s+[^-]+$/, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return createHash('sha1').update(base).digest('hex').slice(0, 12);
}

export async function fetchFeed(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=sv&gl=SE&ceid=SE:sv`;
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`Google News ${res.status}`);
  const xml = await res.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, item]) => {
    const rawTitle = tag(item, 'title');
    const publisher = tag(item, 'source');
    const title = publisher && rawTitle.endsWith(' - ' + publisher) ? rawTitle.slice(0, -(publisher.length + 3)) : rawTitle;
    const pub = new Date(tag(item, 'pubDate'));
    return {
      id: newsId(title),
      title,
      publisher,
      gnLink: tag(item, 'link'),
      published: pub.toISOString(),
      date: pub.toISOString().slice(0, 10),
      description: tag(item, 'description').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    };
  });
}

/** Sök alla frågor, slå ihop dubbletter och filtrera på relevans. */
export async function discover({ since } = {}) {
  const seen = new Map();
  const errors = [];
  for (const q of QUERIES) {
    try {
      for (const it of await fetchFeed(q)) {
        if (since && it.date < since) continue;
        if (!seen.has(it.id)) seen.set(it.id, { ...it, queries: [q] });
        else seen.get(it.id).queries.push(q);
      }
    } catch (err) {
      errors.push({ query: q, error: String(err.message || err) });
    }
  }
  const items = [...seen.values()].filter((it) => {
    const hay = `${it.title} ${it.description}`;
    return KING_RE.test(hay) && TRADE_RE.test(hay);
  });
  return { items: items.sort((a, b) => a.published.localeCompare(b.published)), errors };
}

/** Google News-länkar är kodade; slå upp publicistens riktiga URL. */
export async function resolveGoogleNewsUrl(link) {
  const id = new URL(link).pathname.split('/').pop();
  const page = await fetch(`https://news.google.com/rss/articles/${id}`, { headers: { 'user-agent': UA } }).then((r) => r.text());
  const sig = page.match(/data-n-a-sg="([^"]+)"/)?.[1];
  const ts = page.match(/data-n-a-ts="([^"]+)"/)?.[1];
  if (!sig || !ts) throw new Error('Kunde inte avkoda Google News-länk');
  const payload = [[['Fbv4je', `["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${id}",${ts},"${sig}"]`]]];
  const res = await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', 'user-agent': UA },
    body: 'f.req=' + encodeURIComponent(JSON.stringify(payload)),
  });
  const text = await res.text();
  const chunk = text.split('\n\n')[1];
  const url = JSON.parse(JSON.parse(chunk)[0][2])[1];
  if (!/^https?:\/\//.test(url)) throw new Error('Oväntat svar vid avkodning');
  return url;
}

/** Hämta artikel och plocka ut brödtext + tabellrader. */
export async function fetchArticle(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'sv-SE,sv;q=0.9' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return extractArticle(await res.text());
}

export function extractArticle(html) {
  html = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const clean = (s) => decodeEntities(s.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  const rows = [...html.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map(([tr]) =>
    [...tr.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(([, c]) => clean(c)));
  const blocks = [...html.matchAll(/<(p|li|h1|h2|h3|figcaption|blockquote)[^>]*>([\s\S]*?)<\/\1>/gi)]
    .map(([, , inner]) => clean(inner))
    .filter((t) => t.length > 1);
  // Om sidan saknar <p>-struktur (t.ex. JSON-renderad), fall tillbaka på JSON-LD articleBody.
  const ld = html.match(/"articleBody"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1];
  if (ld) blocks.push(JSON.parse(`"${ld}"`));
  return { text: blocks.join('\n'), rows: rows.filter((r) => r.length >= 2) };
}
