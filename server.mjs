#!/usr/bin/env node
// Lokal server: serverar sidan och kör uppdateringen löpande.
//   PORT=8080 PRICE_MINUTES=5 NEWS_MINUTES=15 node server.mjs
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = +(process.env.PORT ?? 8080);
const PRICE_MIN = +(process.env.PRICE_MINUTES ?? 5);
const NEWS_MIN = +(process.env.NEWS_MINUTES ?? 15);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

let running = false;
let lastNews = 0;
function update() {
  if (running) return;
  running = true;
  const withNews = Date.now() - lastNews >= NEWS_MIN * 60_000;
  if (withNews) lastNews = Date.now();
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts/update.mjs'), ...(withNews ? [] : ['--no-news'])], { stdio: 'inherit' });
  child.on('exit', () => { running = false; });
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
    if (!file.startsWith(ROOT) || /[\\/](\.git|node_modules|scripts|test)([\\/]|$)/.test(file.slice(ROOT.length))) throw Object.assign(new Error(), { code: 'ENOENT' });
    if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Hittades inte');
  }
}).listen(PORT, () => {
  console.log(`♛  Kungens Portfölj på http://localhost:${PORT}  (kurser var ${PRICE_MIN} min, nyheter var ${NEWS_MIN} min)`);
  update();
  setInterval(update, PRICE_MIN * 60_000);
});
