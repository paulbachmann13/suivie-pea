/* ==========================================================================
   Test de bout en bout du site EN LIGNE, dans un vrai Chrome :
   node tools/e2e-live.js <url du site> <version attendue> [ticker…]
   Ajoute un achat par ticker, touche « Actualiser le cours » et vérifie que
   le cours Euronext s'affiche (CORS réel, origine github.io réelle).
   Nécessite playwright-core et Google Chrome (présents sur les runners GitHub).
   ========================================================================== */
const { chromium } = require('playwright-core');

const [url, version, ...tickersArg] = process.argv.slice(2);
const tickers = tickersArg.length ? tickersArg : ['PSP5', 'FR0011871128'];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome' });
  // Service worker bloqué : on teste toujours la version publiée, pas un cache
  const ctx = await browser.newContext({ serviceWorkers: 'block', locale: 'fr-FR', timezoneId: 'Europe/Paris', viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // Attendre que GitHub Pages serve la bonne version (republication ~1 min)
  for (let i = 0; i < 20; i++) {
    await page.goto(url + '?t=' + Date.now());
    const v = await page.locator('#version-badge').textContent();
    if (!version || v === 'v' + version) break;
    console.log(`Version en ligne ${v}, attendue v${version} : nouvel essai dans 15 s`);
    await page.waitForTimeout(15000);
  }
  console.log('Version en ligne :', await page.locator('#version-badge').textContent());

  await page.evaluate((list) => localStorage.setItem('suivi-pea:v1', JSON.stringify({
    purchases: list.map((t, i) => ({ id: 'e2e' + i, date: '2026-09-01', ticker: t, qty: 1, price: 50, fees: 0 })),
    settings: { autoRefresh: false },
  })), tickers);
  await page.reload();

  let failed = 0;
  for (const t of tickers) {
    const card = page.locator('#positions .card').filter({ has: page.locator('.position-head strong', { hasText: t.toUpperCase() }) });
    await card.locator('[data-a=live]').click();
    // La carte est redessinée après la réponse : on relit le bouton à chaque fois
    for (let i = 0; i < 40 && (await card.locator('[data-a=live]').textContent()).includes('Récupération'); i++) {
      await page.waitForTimeout(500);
    }
    const price = await card.locator('[data-f=price]').textContent();
    const meta = await card.locator('[data-f=meta]').textContent();
    const name = await card.locator('[data-f=name]').textContent();
    const err = await card.locator('[data-f=error]').isVisible() ? await card.locator('[data-f=error]').textContent() : '';
    if (err || !/Euronext/.test(meta)) {
      failed++;
      console.log(`❌ ${t} : ${err || meta}`);
    } else {
      console.log(`✅ ${t} → ${price.trim()} | ${meta.trim()} | ${name.trim()}`);
    }
  }
  if (errors.length) { failed++; console.log('❌ Erreurs JavaScript :', errors); }
  await browser.close();
  process.exit(failed ? 1 : 0);
})();
