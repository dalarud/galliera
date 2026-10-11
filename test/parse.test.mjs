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

test('två tabeller sida vid sida: Gallierafondens kolumner väljs, inte Gluonens', () => {
  const rows = [
    ['GLUONEN', '', '', '', 'GALLIERAFONDEN', '', ''],
    ['Bolag', 'Aktier', 'Värde i Mkr', '', 'Bolag', 'Aktier', 'Värde i Mkr'],
    ['Investor', '51 000', '20,6', '', 'Investor', '31 300', '12,9'],
    ['Volvo', '30 350', '9,6', '', 'Nordea Bank', '51 300', '9,6'],
    ['Atlas Copco', '50 800', '9,3', '', 'Epiroc', '38 000', '8,5'],
    ['Hexagon', '84 000', '8,8', '', 'Sandvik', '20 500', '7,4'],
    ['Alfa Laval', '10 500', '6', '', 'Alfa Laval', '10 950', '6,3'],
    ['', '', '', '', 'Essity', '21 500', '5,7'],
  ];
  const t = extractHoldingsTable({ tables: [{ context: 'Kungafamiljens innehav', rows }] }, aliasIndex);
  assert.equal(t.get('INVE-B.ST'), 31300);
  assert.equal(t.get('ALFA.ST'), 10950);
  assert.equal(t.get('ESSITY-B.ST'), 21500);
  assert.ok(!t.has('VOLV-B.ST'));
});

test('tabell med rubriken Gluonen hoppas över', () => {
  const body = [['Bolag', 'Aktier'], ['Investor', '58 400'], ['Volvo', '30 350'], ['Securitas', '50 000'], ['Atlas Copco', '50 800'], ['Medicover', '25 900']];
  const galliera = [['Bolag', 'Aktier'], ['Investor', '43 300'], ['Industrivärden', '23 000'], ['Nordea Bank', '45 000'], ['Essity', '24 999'], ['Sandvik', '18 000']];
  const t = extractHoldingsTable({ tables: [
    { context: 'Gallierafondens innehav', rows: galliera },
    { context: 'Gluonens innehav', rows: body },
  ] }, aliasIndex);
  assert.equal(t.get('INVE-B.ST'), 43300);
  assert.ok(!t.has('VOLV-B.ST'));
});

test('topplista markeras som delvis', () => {
  const rows = [['#', 'Bolag', 'Antal aktier', 'Värde (Mkr)'], ['1', 'Investor', '39 300', '14,6'], ['2', 'Industrivärden', '26 200', '12,6'], ['3', 'Nordea Bank', '51 300', '8,7'], ['4', 'Epiroc', '38 000', '8,2'], ['5', 'Sandvik', '20 500', '8,1']];
  const t = extractHoldingsTable({ tables: [{ context: 'Kung Carl XVI Gustafs topp 10 innehav i Gallierafonden:', rows }] }, aliasIndex);
  assert.equal(t.size, 5);
  assert.equal(t.partial, true);
});

test('flera omärkta tabeller ger ingen avstämning', () => {
  const a = [['Bolag', 'Aktier'], ['Investor', '1 000'], ['SEB', '2 000'], ['Nordea', '3 000'], ['Sandvik', '4 000'], ['Epiroc', '5 000']];
  const b = [['Bolag', 'Aktier'], ['Volvo', '1 000'], ['SKF', '2 000'], ['Saab', '3 000'], ['ABB', '4 000'], ['Telia', '5 000']];
  const t = extractHoldingsTable({ tables: [{ context: 'Innehav', rows: a }, { context: 'Innehav', rows: b }] }, aliasIndex);
  assert.equal(t.size, 0);
  assert.equal(t.ambiguous, true);
});
