/* ==========================================================================
   Récupère les cours de clôture des ETF suivis et écrit data/prices.json.
   Lancé chaque soir de semaine par .github/workflows/prices.yml
   (ou à la main : node tools/fetch-prices.js). Node 18+ (fetch intégré).
   Source : API « chart » publique de Yahoo Finance (sans clé).
   ========================================================================== */
const fs = require('fs');
const path = require('path');

// Ticker affiché dans l'appli → symbole Yahoo Finance
const SYMBOLS = {
  DCAM: 'DCAM.PA', // Amundi PEA Monde (MSCI World) — FR001400U5Q4
};
const RANGE = '5y';           // profondeur d'historique
const OUT = path.join(__dirname, '..', 'data', 'prices.json');

/** Timestamp Unix → 'AAAA-MM-JJ' dans le fuseau de la place de cotation. */
function dayIn(ts, timeZone) {
  return new Date(ts * 1000).toLocaleDateString('sv-SE', { timeZone }); // format ISO
}
const round4 = (v) => Math.round(v * 10000) / 10000;

/** Transforme la réponse Yahoo en { price, date, currency, history }. */
function parseChart(json) {
  const res = json && json.chart && json.chart.result && json.chart.result[0];
  if (!res) throw new Error('Réponse Yahoo inattendue : ' + JSON.stringify(json && json.chart && json.chart.error));
  const tz = res.meta.exchangeTimezoneName || 'Europe/Paris';
  const closes = (res.indicators.quote[0] || {}).close || [];
  const byDay = new Map();
  (res.timestamp || []).forEach((ts, i) => {
    if (closes[i] > 0) byDay.set(dayIn(ts, tz), round4(closes[i]));
  });
  const history = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  let price = res.meta.regularMarketPrice;
  let date = res.meta.regularMarketTime ? dayIn(res.meta.regularMarketTime, tz) : null;
  if (!(price > 0) || !date) {
    if (!history.length) throw new Error('Aucun cours dans la réponse');
    [date, price] = history[history.length - 1];
  }
  price = round4(price);
  // Le dernier point de l'historique suit le dernier cours connu
  if (!history.length || history[history.length - 1][0] < date) history.push([date, price]);
  else if (history[history.length - 1][0] === date) history[history.length - 1][1] = price;
  return { price, date, currency: res.meta.currency || 'EUR', history };
}

async function fetchSymbol(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${RANGE}&interval=1d`;
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (suivi-pea)' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return parseChart(await r.json());
    } catch (e) {
      lastErr = e;
      await new Promise((ok) => setTimeout(ok, attempt * 3000));
    }
  }
  throw new Error(`${symbol} : ${lastErr.message}`);
}

async function main() {
  const quotes = {};
  for (const [ticker, symbol] of Object.entries(SYMBOLS)) {
    quotes[ticker] = { symbol, ...(await fetchSymbol(symbol)) };
    console.log(`${ticker} (${symbol}) : ${quotes[ticker].price} ${quotes[ticker].currency} au ${quotes[ticker].date}, ${quotes[ticker].history.length} jours d'historique`);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  // Une ligne par jour : diff Git lisible
  const body = Object.entries(quotes).map(([t, q]) => {
    const hist = q.history.map((h) => `        ${JSON.stringify(h)}`).join(',\n');
    return `    ${JSON.stringify(t)}: {\n      "symbol": ${JSON.stringify(q.symbol)},\n      "price": ${q.price},\n      "date": ${JSON.stringify(q.date)},\n      "currency": ${JSON.stringify(q.currency)},\n      "history": [\n${hist}\n      ]\n    }`;
  }).join(',\n');
  fs.writeFileSync(OUT, `{\n  "updatedAt": ${JSON.stringify(new Date().toISOString())},\n  "quotes": {\n${body}\n  }\n}\n`);
  console.log('Écrit :', OUT);
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
module.exports = { parseChart, dayIn };
