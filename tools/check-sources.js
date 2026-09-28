/* ==========================================================================
   Diagnostic des sources de cours — node tools/check-sources.js PSP5 DCAM …
   Utilise EXACTEMENT le code Euronext de l'appli (app.js), en envoyant
   l'origine du site pour vérifier l'autorisation CORS. Vérifie aussi Yahoo
   (source de secours de la GitHub Action quotidienne).
   Code de sortie 1 si Euronext échoue pour un titre (alerte e-mail de GitHub
   quand le workflow planifié échoue).
   ========================================================================== */
const { Euronext, QuoteError } = require('../app.js');
const { parseChart } = require('./fetch-prices.js');

const ORIGIN = 'https://paulbachmann13.github.io';
const queries = process.argv.slice(2).length ? process.argv.slice(2) : ['PSP5', 'FR0011871128', 'DCAM'];

async function main() {
  let failures = 0;
  let busy = 0;
  for (const query of queries) {
    const cors = new Set();
    // Même appel que dans le navigateur, avec l'en-tête Origin du site
    const fetchWithOrigin = async (url, opts = {}) => {
      const res = await fetch(url, { signal: opts.signal, headers: { Origin: ORIGIN } });
      cors.add(res.headers.get('access-control-allow-origin') || 'ABSENT');
      return res;
    };
    try {
      const q = await Euronext.quote(query, null, fetchWithOrigin);
      const corsOk = [...cors].every((v) => v === '*' || v === ORIGIN);
      console.log(`✅ Euronext ${query} → ${q.instrument.symbol} (${q.instrument.isin}-${q.instrument.mic}) ` +
        `${q.price} € séance du ${q.date} | CORS : ${[...cors].join(', ')}${corsOk ? '' : ' ⚠️ NON AUTORISÉ'}`);
      if (!corsOk) failures++;
    } catch (e) {
      if (e instanceof QuoteError && e.code === 'ambiguous') {
        // Recherche par nom : normal, l'appli propose ces choix à l'utilisateur
        console.log(`ℹ️  Euronext « ${query} » → choix proposés : ${e.candidates.map((c) => `${c.symbol} (${c.isin}-${c.mic})`).join(', ')}`);
        continue;
      }
      if (e instanceof QuoteError && e.code === 'busy') {
        // Raté passager d'Euronext sur un titre : avertissement, pas d'alerte e-mail
        busy++;
        console.log(`::warning::Euronext ${query} momentanément indisponible (réponse parasite répétée)`);
        continue;
      }
      failures++;
      console.log(`❌ Euronext ${query} → ${e instanceof QuoteError ? `${e.code} : ${e.message} ${e.detail}` : e.message}`);
    }
  }

  // Source de secours : Yahoo (utilisée par la GitHub Action quotidienne)
  for (const symbol of ['PSP5.PA', 'DCAM.PA']) {
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=5d&interval=1d`, { headers: { 'User-Agent': 'Mozilla/5.0 (suivi-pea)' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const q = parseChart(await r.json());
      console.log(`✅ Yahoo ${symbol} → ${q.price} € séance du ${q.date}`);
    } catch (e) {
      console.log(`::warning::Yahoo ${symbol} indisponible (${e.message}) : la clôture quotidienne de secours risque de manquer`);
    }
  }
  // Euronext indisponible pour TOUS les titres : là, c'est une vraie panne
  if (busy === queries.length) failures++;
  process.exit(failures ? 1 : 0);
}
main();
