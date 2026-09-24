/* Tests des calculs — lancer avec : node --test tests/ */
const test = require('node:test');
const assert = require('node:assert/strict');
const { Calc, Dates, Store, Fmt } = require('../app.js');

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

// Scénario DCA type : 3 achats de DCAM
const purchases = [
  { id: 'a', date: '2026-01-05', ticker: 'DCAM', qty: 16, price: 6.00, fees: 0.99 },
  { id: 'b', date: '2026-02-05', ticker: 'dcam', qty: 17, price: 5.80, fees: 0.99 },
  { id: 'c', date: '2026-03-05', ticker: 'DCAM', qty: 15, price: 6.40, fees: 0 },
];

test('parseNumber accepte les formats français', () => {
  assert.equal(Calc.parseNumber('6,12'), 6.12);
  assert.equal(Calc.parseNumber('1 234,5'), 1234.5);
  assert.equal(Calc.parseNumber('1 234,50 €'), 1234.5);
  assert.equal(Calc.parseNumber('7.5'), 7.5);
  assert.equal(Calc.parseNumber('', true), 0);
  assert.ok(Number.isNaN(Calc.parseNumber('')));
  assert.ok(Number.isNaN(Calc.parseNumber('abc')));
  assert.ok(Number.isNaN(Calc.parseNumber('1,2,3')));
});

test('PRU = (Σ parts × prix + frais) / Σ parts', () => {
  const pf = Calc.portfolio(purchases, {});
  // investi = 96 + 0,99 + 98,6 + 0,99 + 96 = 292,58 ; parts = 48
  close(pf.invested, 292.58);
  assert.equal(pf.qty, 48);
  close(pf.pru, 292.58 / 48);
  close(pf.fees, 1.98);
  assert.equal(pf.positions.length, 1, 'tickers normalisés en majuscules');
});

test('plus-value avec cours saisi', () => {
  const pf = Calc.portfolio(purchases, { DCAM: { price: 6.50, date: '2026-03-10' } });
  close(pf.value, 48 * 6.5);              // 312
  close(pf.pv, 312 - 292.58);             // +19,42
  close(pf.pvPct, (312 - 292.58) / 292.58);
  assert.deepEqual(pf.missingQuotes, []);
});

test('moins-value et valorisation au dernier prix sans cours', () => {
  const baisse = Calc.portfolio(purchases, { DCAM: { price: 5.00 } });
  close(baisse.pv, 240 - 292.58);
  assert.ok(baisse.pvPct < 0);

  const sansCours = Calc.portfolio(purchases, {});
  close(sansCours.value, 48 * 6.40); // dernier achat (05/03) à 6,40
  assert.deepEqual(sansCours.missingQuotes, ['DCAM']);
});

test('portefeuille vide', () => {
  const pf = Calc.portfolio([], {});
  assert.equal(pf.invested, 0);
  assert.equal(pf.pvPct, 0);
  assert.equal(pf.pru, null);
});

test('plusieurs titres : pas de PRU global', () => {
  const pf = Calc.portfolio([...purchases, { date: '2026-03-06', ticker: 'PAEEM', qty: 2, price: 25, fees: 0 }], {});
  assert.equal(pf.positions.length, 2);
  assert.equal(pf.pru, null);
  close(pf.invested, 342.58);
});

test('versements cumulés', () => {
  const s = Calc.cumulativeSeries([...purchases].reverse());
  assert.deepEqual(s.map((p) => p.date), ['2026-01-05', '2026-02-05', '2026-03-05']);
  close(s[0].total, 96.99);
  close(s[2].total, 292.58);
});

test('simulateur : taux nul = somme des versements', () => {
  const r = Calc.simulate({ monthly: 100, annualRate: 0, years: 10 });
  close(r.final, 12000);
  close(r.gains, 0);
  assert.equal(r.points.length, 121);
});

test('simulateur : formule de la rente (versements fin de mois)', () => {
  const r = Calc.simulate({ monthly: 100, annualRate: 7, years: 20 });
  const i = Math.pow(1.07, 1 / 12) - 1;
  const n = 240;
  const expected = 100 * (Math.pow(1 + i, n) - 1) / i;
  close(r.final, expected, 1e-6);
  close(r.invested, 24000);
  close(r.gains, expected - 24000, 1e-6);
  close(r.gainsShare, (expected - 24000) / expected, 1e-9);
  // ordre de grandeur connu : ~50 900 €
  assert.ok(r.final > 50500 && r.final < 51500, String(r.final));
});

test('simulateur : capital initial et frais ETF', () => {
  const init = Calc.simulate({ monthly: 0, annualRate: 5, years: 10, initial: 1000 });
  close(init.final, 1000 * Math.pow(1.05, 10), 1e-6);

  const withTer = Calc.simulate({ monthly: 0, annualRate: 7, years: 10, initial: 1000, ter: 0.2 });
  close(withTer.final, 1000 * Math.pow(1.07 * 0.998, 10), 1e-6);
});

test('compteur 5 ans', () => {
  const c = Calc.peaCountdown('2026-09-24', '2026-09-24');
  assert.equal(c.targetISO, '2031-09-24');
  assert.deepEqual(c.remaining, { years: 5, months: 0, days: 0 });
  assert.equal(c.progress, 0);
  assert.equal(c.reached, false);

  const mid = Calc.peaCountdown('2024-01-31', '2026-03-15');
  assert.equal(mid.targetISO, '2029-01-31');
  assert.deepEqual(mid.remaining, { years: 2, months: 10, days: 16 });

  const done = Calc.peaCountdown('2020-02-29', '2025-03-01');
  assert.equal(done.targetISO, '2025-02-28');
  assert.equal(done.reached, true);
  assert.equal(done.progress, 1);
});

test('plafond 150 000 €', () => {
  const c = Calc.ceiling(30000);
  assert.equal(c.remaining, 120000);
  close(c.progress, 0.2);
  assert.equal(Calc.ceiling(200000).progress, 1);
});

test('import : données valides nettoyées, invalides rejetées', () => {
  const ok = Store.sanitize({ purchases, prices: { dcam: { price: 6.5 } }, openingDate: '2025-01-01' });
  assert.equal(ok.purchases[1].ticker, 'DCAM');
  assert.equal(ok.prices.DCAM.price, 6.5);
  assert.throws(() => Store.sanitize({}));
  assert.throws(() => Store.sanitize({ purchases: [{ date: '2026-13-01', ticker: 'X', qty: 1, price: 1 }] }));
  assert.throws(() => Store.sanitize({ purchases: [{ date: '2026-01-01', ticker: 'X', qty: -1, price: 1 }] }));
});

test('formats français', () => {
  const nbsp = /[  ]/g;
  assert.equal(Fmt.eur(1234.5).replace(nbsp, ' '), '1 234,50 €');
  assert.equal(Fmt.date('2026-03-05'), '05/03/2026');
  assert.equal(Fmt.input(6.12), '6,12');
  assert.equal(Fmt.signedPct(0.0664).replace(nbsp, ' '), '+6,64 %');
});
