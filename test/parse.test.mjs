import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildAliasIndex, extractSignals, extractHoldingsTable, resolveDate, findCompanies } from '../scripts/lib/parse.mjs';

const securities = JSON.parse(readFileSync(new URL('../data/securities.json', import.meta.url)));
const aliasIndex = buildAliasIndex(securities);
const published = '2026-10-09T13:00:00.000Z';
const sig = (text) => extractSignals(text, { published, aliasIndex });

test('hela innehavet sålt → exit', () => {
  const [s] = sig('Samtidigt är hela innehavet i Handelsbanken borta ur Gallierafonden.');
  assert.equal(s.ticker, 'SHB-A.ST');
  assert.equal(s.side, 'sell');
  assert.equal(s.fraction, 1);
});

test('nytt innehav med antal aktier', () => {
  const out = sig('Kungen har tagit in 29 000 aktier i kylteknikbolaget Beijer Ref, värda 4,1 miljoner kronor.');
  const s = out.find((x) => x.ticker === 'BEIJ-B.ST');
  assert.equal(s.side, 'buy');
  assert.equal(s.kind, 'new');
});

test('antal och månad läses ut', () => {
  const [s] = sig('I september sålde kungen 8 000 aktier i Investor ur Gallierafonden.');
  assert.equal(s.ticker, 'INVE-B.ST');
  assert.equal(s.side, 'sell');
  assert.equal(s.shares, 8000);
  assert.equal(s.date, '2026-09-15');
});

test('halverat innehav', () => {
  const [s] = sig('Kungen har också halverat innehavet i Industrivärden.');
  assert.equal(s.ticker, 'INDU-C.ST');
  assert.equal(s.fraction, 0.5);
});

test('bolag som köper i annat bolag räknas inte som kungens affär', () => {
  const out = extractSignals('Investor köper aktier i EQT för 349 miljoner.', { published, aliasIndex, kingInTitle: true });
  assert.ok(!out.some((s) => s.ticker === 'INVE-B.ST' && s.side === 'buy'));
});

test('Gluonen-meningar ignoreras', () => {
  assert.deepEqual(sig('Gluonen har köpt aktier i Silex och Saab under våren.'), []);
});

test('rena kursnyheter ignoreras', () => {
  assert.deepEqual(sig('Investor har stigit 30 procent i år och är kungens största innehav.'), []);
});

test('flera bolag och riktningar i samma mening', () => {
  const out = sig('I mars sålde kungen hela innehavet i Handelsbanken och köpte Nordea.');
  assert.equal(out.find((s) => s.ticker === 'SHB-A.ST').side, 'sell');
  assert.equal(out.find((s) => s.ticker === 'NDA-SE.ST').side, 'buy');
});

test('månad senare än publicering tolkas som föregående år', () => {
  assert.equal(resolveDate('I november köpte kungen', '2026-03-01T00:00:00Z').date, '2025-11-15');
});

test('Volvo Cars matchar inte Volvo', () => {
  assert.deepEqual(findCompanies('Volvo Cars rapporterar', aliasIndex), []);
});

test('innehavstabell från HTML-rader', () => {
  const rows = [['Bolag', 'Aktier', 'Värde'], ['Investor', '31 300', '12,9'], ['Nordea Bank', '51 300', '9,6'], ['Epiroc', '38 000', '8,5'], ['Sandvik', '20 500', '7,4'], ['EQT', '25 600', '7,2']];
  const t = extractHoldingsTable({ rows }, aliasIndex);
  assert.equal(t.size, 5);
  assert.equal(t.get('INVE-B.ST'), 31300);
  assert.equal(t.get('NDA-SE.ST'), 51300);
});
