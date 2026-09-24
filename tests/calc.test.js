/* Tests des calculs — lancer avec : node --test tests/ */
const test = require('node:test');
const assert = require('node:assert/strict');
const { Calc, Dates, Store, Fmt, parsePricesFile, mergeQuotes, priceUrls } = require('../app.js');
const { parseChart } = require('../tools/fetch-prices.js');

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

test('calculateur prochain achat : parts entières et reste', () => {
  const r = Calc.buyPlan(100, 6.12, 0);
  assert.equal(r.qty, 16);
  close(r.cost, 97.92);
  close(r.left, 2.08);

  const withFees = Calc.buyPlan(100, 6.12, 0.99); // (100 − 0,99) / 6,12 = 16,17
  assert.equal(withFees.qty, 16);
  close(withFees.cost, 98.91);

  assert.equal(Calc.buyPlan(12, 6, 0).qty, 2, 'montant pile : pas d\'erreur d\'arrondi');
  assert.equal(Calc.buyPlan(5, 6.12).qty, 0);
  assert.equal(Calc.buyPlan(0, 6), null);
  assert.equal(Calc.buyPlan(100, 0), null);
});

test('versements, cash et base du plafond', () => {
  const none = Calc.deposits([], purchases);
  assert.equal(none.hasDeposits, false);
  close(none.base, 292.58);
  assert.equal(none.cash, null);

  const dep = Calc.deposits([{ date: '2026-01-02', amount: 200 }, { date: '2026-03-01', amount: 150 }], purchases);
  close(dep.base, 350);
  close(dep.cash, 350 - 292.58);
});

test('TRI : cas simples', () => {
  // 1 000 € placés, 1 100 € un an (365 j) plus tard → 10 %
  close(Calc.xirr([{ date: '2025-01-01', amount: -1000 }, { date: '2026-01-01', amount: 1100 }]), 0.10, 1e-6);
  // perte : 1 000 → 900 → −10 %
  close(Calc.xirr([{ date: '2025-01-01', amount: -1000 }, { date: '2026-01-01', amount: 900 }]), -0.10, 1e-6);
  // DCA : deux versements de 100 €, valeur finale 210 €, contrôle par la VAN
  const flows = [{ date: '2025-01-01', amount: -100 }, { date: '2025-07-02', amount: -100 }, { date: '2026-01-01', amount: 210 }];
  const r = Calc.xirr(flows);
  const t0 = Dates.parse('2025-01-01');
  const npv = flows.reduce((s, f) => s + f.amount / Math.pow(1 + r, Dates.daysBetween(t0, Dates.parse(f.date)) / 365), 0);
  close(npv, 0, 1e-6);
  assert.ok(r > 0.05 && r < 0.08, String(r));
  // incalculable : que des sorties
  assert.equal(Calc.xirr([{ date: '2025-01-01', amount: -100 }, { date: '2025-02-01', amount: -100 }]), null);
});

test('TRI du portefeuille', () => {
  const x = Calc.portfolioXirr(purchases, 312, '2026-09-05');
  assert.equal(x.days, 243);
  assert.ok(x.rate > 0);
  assert.equal(Calc.portfolioXirr([], 0), null);
});

test('série valeur vs versements', () => {
  const hist = { DCAM: [['2026-01-02', 5.9], ['2026-01-05', 6.0], ['2026-01-06', 6.1], ['2026-02-05', 5.8], ['2026-02-06', 5.9], ['2026-03-05', 6.4], ['2026-03-06', 6.5]] };
  const s = Calc.valueSeries(purchases, hist);
  assert.equal(s[0].date, '2026-01-05', 'démarre au premier achat');
  close(s[0].value, 16 * 6.0);
  close(s[0].invested, 96.99);
  close(s[1].value, 16 * 6.1);
  const last = s[s.length - 1];
  assert.equal(last.date, '2026-03-06');
  close(last.value, 48 * 6.5);
  close(last.invested, 292.58);
  // titre sans historique → pas de série
  assert.deepEqual(Calc.valueSeries(purchases, {}), []);
});

test('fichier de cours : lecture et fusion avec les cours saisis', () => {
  const parsed = parsePricesFile({
    updatedAt: '2026-09-24T18:00:00Z',
    quotes: { dcam: { price: 6.17, date: '2026-09-24', history: [['2026-09-24', 6.17], ['2026-09-23', 6.1], ['bad', 1]] } },
  });
  assert.deepEqual(parsed.quotes.DCAM, { price: 6.17, date: '2026-09-24' });
  assert.deepEqual(parsed.histories.DCAM, [['2026-09-23', 6.1], ['2026-09-24', 6.17]]);
  assert.equal(parsePricesFile({}), null);

  // cours manuel du jour : conservé ; cours manuel plus ancien : remplacé
  const p1 = { DCAM: { price: 6.2, date: '2026-09-24', source: 'manuel' } };
  assert.equal(mergeQuotes(p1, parsed.quotes), 0);
  assert.equal(p1.DCAM.price, 6.2);
  const p2 = { DCAM: { price: 6.0, date: '2026-09-20', source: 'manuel' } };
  assert.equal(mergeQuotes(p2, parsed.quotes), 1);
  assert.deepEqual(p2.DCAM, { price: 6.17, date: '2026-09-24', source: 'auto' });
  // cours auto déjà identique : rien à faire
  assert.equal(mergeQuotes(p2, parsed.quotes), 0);
});

test('URL des cours selon l\'hébergement', () => {
  assert.deepEqual(priceUrls({ hostname: 'paulbachmann13.github.io', pathname: '/suivie-pea/' }), [
    'https://raw.githubusercontent.com/paulbachmann13/suivie-pea/main/data/prices.json',
    'data/prices.json',
  ]);
  assert.deepEqual(priceUrls({ hostname: 'localhost', pathname: '/' }), ['data/prices.json']);
});

test('script GitHub Action : lecture de la réponse Yahoo', () => {
  // 2 séances (heure de Paris) ; une clôture manquante (null) est ignorée
  const ts = (iso) => Math.floor(Date.parse(iso) / 1000);
  const json = { chart: { result: [{
    meta: { currency: 'EUR', exchangeTimezoneName: 'Europe/Paris', regularMarketPrice: 6.1734, regularMarketTime: ts('2026-09-24T15:30:00Z') },
    timestamp: [ts('2026-09-22T07:00:00Z'), ts('2026-09-23T07:00:00Z'), ts('2026-09-24T07:00:00Z')],
    indicators: { quote: [{ close: [6.1, null, 6.15] }] },
  }] } };
  const q = parseChart(json);
  assert.equal(q.price, 6.1734);
  assert.equal(q.date, '2026-09-24');
  assert.deepEqual(q.history, [['2026-09-22', 6.1], ['2026-09-24', 6.1734]]);
  assert.throws(() => parseChart({ chart: { result: null, error: { code: 'Not Found' } } }));
});
