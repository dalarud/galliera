import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replay } from '../scripts/lib/engine.mjs';

const hist = (pairs, dividends = []) => ({ closes: new Map(pairs), dividends, last: null });
const days = ['2026-01-02', '2026-01-05', '2026-01-06', '2026-01-07'];
const prices = new Map([
  ['AAA', hist(days.map((d, i) => [d, [100, 110, 110, 121][i]]), [{ date: '2026-01-06', amount: 5 }])],
  ['BBB', hist(days.map((d) => [d, 50]))],
]);
const benchmarks = { OMXSPI: { label: 'Index', history: hist(days.map((d, i) => [d, 1000 + i * 10])) } };
const securities = { AAA: { name: 'A' }, BBB: { name: 'B' } };

test('kassa, utdelning, tillskott och andelsvärde', () => {
  const ledger = {
    baseline: '2026-01-02', startUnitValue: 100, startCash: 0,
    events: [
      { id: 's', date: '2026-01-02', type: 'snapshot', full: true, holdings: { AAA: 1000 } },
      { id: 'sell', date: '2026-01-05', type: 'trade', ticker: 'AAA', side: 'sell', fraction: 0.5 },
      { id: 'buy', date: '2026-01-07', type: 'trade', ticker: 'BBB', side: 'buy', shares: 2000 },
    ],
  };
  const r = replay({ ledger, securities, prices, benchmarks });
  const [d0, d1, d2, d3] = r.series;
  assert.equal(d0.nav, 100000);
  assert.equal(d0.unit, 100);
  // Dag 1: sälj 500 à 110 → kassa 55 000, NAV 110 000, andel +10 %
  assert.equal(d1.cash, 55000);
  assert.equal(d1.unit, 110);
  // Dag 2: utdelning 5 kr × 500 = 2 500 i kassan
  assert.equal(d2.cash, 57500);
  // Dag 3: köp 2 000 BBB à 50 = 100 000 → underskott 42 500 blir tillskott, kassa 0
  assert.equal(d3.cash, 0);
  assert.equal(r.summary.injected, 42500);
  // Andelsvärdet påverkas inte av tillskottet: (500×121 + 100 000 − 42 500) / andelar
  const expectedUnit = ((500 * 121 + 57500) / 1000);
  assert.ok(Math.abs(d3.unit - expectedUnit) < 1e-6);
  assert.equal(r.positions.length, 2);
});
