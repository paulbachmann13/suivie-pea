/* ==========================================================================
   Suivi PEA — logique de l'application
   --------------------------------------------------------------------------
   Organisation du fichier :
     1. Formatage (formats français)
     2. Calculs purs (PRU, plus-value, simulateur, compteur PEA)
        → sans DOM, testables avec Node (voir tests/calc.test.js)
     3. Stockage (localStorage + export / import JSON)
     4. Fournisseurs de cours (manuel aujourd'hui, API demain)
     5. Graphiques SVG maison
     6. Interface
   ========================================================================== */
'use strict';

const APP_VERSION = '1.2.0'; // affichée en haut de l'écran ; garder identique à VERSION dans sw.js
const PEA_CEILING = 150000; // plafond de versements d'un PEA classique (€)

/* ==========================================================================
   1. FORMATAGE — euros, dates JJ/MM/AAAA, virgule décimale
   ========================================================================== */
const Fmt = (() => {
  const eur = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
  const eur0 = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
  const unit = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 4 });
  const num = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 4 });
  const pct = new Intl.NumberFormat('fr-FR', { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const compact = new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 });

  const sign = (v) => (v > 0 ? '+' : ''); // le signe « − » est déjà ajouté par Intl

  return {
    eur: (v) => eur.format(v),
    eur0: (v) => eur0.format(v),
    unitPrice: (v) => unit.format(v),
    num: (v) => num.format(v),
    /** Valeur pour un champ de saisie : virgule décimale, sans séparateur de milliers. */
    input: (v) => (v === null || v === undefined || v === '' ? '' : String(v).replace('.', ',')),
    pct: (ratio) => pct.format(ratio),
    signedEur: (v) => sign(v) + eur.format(v),
    signedPct: (ratio) => sign(ratio) + pct.format(ratio),
    compactEur: (v) => compact.format(v) + ' €',
    /** 'AAAA-MM-JJ' → 'JJ/MM/AAAA' */
    date: (iso) => {
      if (!iso) return '—';
      const [y, m, d] = iso.split('-');
      return `${d}/${m}/${y}`;
    },
    /** 'AAAA-MM-JJ' → 'mars 2026' (axes des graphiques) */
    monthYear: (iso) => {
      const d = Dates.parse(iso);
      return d.toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' });
    },
  };
})();

/* ==========================================================================
   Utilitaires de dates (tout en heure locale, sans décalage de fuseau)
   ========================================================================== */
const Dates = {
  /** 'AAAA-MM-JJ' → Date locale à minuit. */
  parse(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
  },
  /** Date → 'AAAA-MM-JJ' */
  toISO(date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
  },
  today() { return Dates.toISO(new Date()); },
  isValidISO(iso) {
    if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
    return Dates.toISO(Dates.parse(iso)) === iso;
  },
  addYears(date, n) {
    const r = new Date(date.getFullYear() + n, date.getMonth(), date.getDate());
    // 29 février + n ans → 28 février si l'année n'est pas bissextile
    if (r.getMonth() !== date.getMonth()) r.setDate(0);
    return r;
  },
  daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); },
  /** Nombre de jours entiers entre deux dates (b − a). */
  daysBetween(a, b) {
    return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) -
                       Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86400000);
  },
  /** Écart b − a en années / mois / jours (b ≥ a). */
  diffYMD(a, b) {
    let years = b.getFullYear() - a.getFullYear();
    let months = b.getMonth() - a.getMonth();
    let days = b.getDate() - a.getDate();
    if (days < 0) {
      months -= 1;
      // jours du mois précédant le mois de b
      const pm = b.getMonth() === 0 ? 11 : b.getMonth() - 1;
      const py = b.getMonth() === 0 ? b.getFullYear() - 1 : b.getFullYear();
      days += Dates.daysInMonth(py, pm);
    }
    if (months < 0) { years -= 1; months += 12; }
    return { years, months, days };
  },
};

/* ==========================================================================
   2. CALCULS PURS
   ========================================================================== */
const Calc = {
  /**
   * Convertit une saisie française en nombre : « 1 234,56 » → 1234.56.
   * Renvoie NaN si la saisie est invalide, 0 si elle est vide et allowEmpty.
   */
  parseNumber(value, allowEmpty = false) {
    if (typeof value === 'number') return value;
    const s = String(value ?? '').replace(/[\s  €%]/g, '').replace(',', '.');
    if (s === '') return allowEmpty ? 0 : NaN;
    if (!/^-?\d*\.?\d+$|^-?\d+\.$/.test(s)) return NaN;
    return Number(s);
  },

  /** Normalise un ticker : « dcam » → « DCAM ». */
  normTicker(t) { return String(t || '').trim().toUpperCase(); },

  /** Coût total d'un achat (frais inclus). */
  purchaseCost(p) { return p.qty * p.price + (p.fees || 0); },

  /**
   * Agrège les achats par titre et calcule la performance.
   * @param {Array} purchases  [{date, ticker, qty, price, fees}]
   * @param {Object} prices    { TICKER: { price, date } } — cours actuels
   * PRU = (Σ parts × prix + Σ frais) / Σ parts  (frais inclus, convention courante)
   * Si aucun cours n'est saisi pour un titre, on valorise au dernier prix d'achat.
   */
  portfolio(purchases, prices = {}) {
    const byTicker = new Map();
    for (const p of purchases) {
      const t = Calc.normTicker(p.ticker);
      if (!byTicker.has(t)) byTicker.set(t, { ticker: t, qty: 0, gross: 0, fees: 0, lastDate: '', lastPrice: 0, count: 0 });
      const pos = byTicker.get(t);
      pos.qty += p.qty;
      pos.gross += p.qty * p.price;
      pos.fees += p.fees || 0;
      pos.count += 1;
      if (p.date >= pos.lastDate) { pos.lastDate = p.date; pos.lastPrice = p.price; }
    }

    const positions = [...byTicker.values()].map((pos) => {
      const invested = pos.gross + pos.fees;
      const quote = prices[pos.ticker];
      const hasQuote = !!(quote && quote.price > 0);
      const currentPrice = hasQuote ? quote.price : pos.lastPrice;
      const value = pos.qty * currentPrice;
      const pv = value - invested;
      return {
        ...pos,
        invested,
        pru: pos.qty > 0 ? invested / pos.qty : 0,
        currentPrice,
        hasQuote,
        quoteDate: hasQuote ? quote.date : null,
        value,
        pv,
        pvPct: invested > 0 ? pv / invested : 0,
      };
    }).sort((a, b) => b.invested - a.invested);

    const invested = positions.reduce((s, p) => s + p.invested, 0);
    const value = positions.reduce((s, p) => s + p.value, 0);
    const qty = positions.reduce((s, p) => s + p.qty, 0);
    const fees = positions.reduce((s, p) => s + p.fees, 0);
    const pv = value - invested;
    return {
      positions,
      invested,
      value,
      fees,
      pv,
      pvPct: invested > 0 ? pv / invested : 0,
      qty,
      // Un PRU global n'a de sens que pour un seul titre
      pru: positions.length === 1 ? positions[0].pru : null,
      missingQuotes: positions.filter((p) => !p.hasQuote).map((p) => p.ticker),
    };
  },

  /** Série des versements cumulés (frais inclus), un point par date d'achat. */
  cumulativeSeries(purchases) {
    const byDate = new Map();
    for (const p of purchases) byDate.set(p.date, (byDate.get(p.date) || 0) + Calc.purchaseCost(p));
    let total = 0;
    return [...byDate.keys()].sort().map((date) => {
      total += byDate.get(date);
      return { date, total };
    });
  },

  /**
   * Simulateur de DCA à intérêts composés.
   * - taux mensuel équivalent : (1 + r_net)^(1/12) − 1
   * - r_net = (1 + rendement) × (1 − frais ETF) − 1
   * - versement en fin de mois
   * @returns {{final, invested, gains, gainsShare, points:[{month, invested, value}]}}
   */
  simulate({ monthly = 0, annualRate = 0, years = 0, initial = 0, ter = 0 }) {
    const net = (1 + annualRate / 100) * (1 - ter / 100) - 1;
    const i = Math.pow(1 + net, 1 / 12) - 1;
    const n = Math.max(0, Math.round(years * 12));
    let value = initial;
    const points = [{ month: 0, invested: initial, value }];
    for (let m = 1; m <= n; m++) {
      value = value * (1 + i) + monthly;
      points.push({ month: m, invested: initial + monthly * m, value });
    }
    const invested = initial + monthly * n;
    const gains = value - invested;
    return {
      final: value,
      invested,
      gains,
      gainsShare: value > 0 ? gains / value : 0,
      monthlyRate: i,
      points,
    };
  },

  /**
   * Compteur des 5 ans du PEA (après 5 ans : exonération d'impôt sur le
   * revenu des gains, seuls les prélèvements sociaux restent dus).
   */
  peaCountdown(openingISO, todayISO = Dates.today()) {
    const open = Dates.parse(openingISO);
    const today = Dates.parse(todayISO);
    const target = Dates.addYears(open, 5);
    const totalDays = Dates.daysBetween(open, target);
    const elapsed = Math.min(Math.max(Dates.daysBetween(open, today), 0), totalDays);
    const reached = today >= target;
    return {
      targetISO: Dates.toISO(target),
      reached,
      remaining: reached ? { years: 0, months: 0, days: 0 } : Dates.diffYMD(today, target),
      daysLeft: reached ? 0 : Dates.daysBetween(today, target),
      progress: totalDays > 0 ? elapsed / totalDays : 1,
    };
  },

  /** Jauge du plafond de versements. */
  ceiling(invested, cap = PEA_CEILING) {
    return {
      used: invested,
      remaining: Math.max(cap - invested, 0),
      progress: Math.min(invested / cap, 1),
    };
  },

  /**
   * Versements et cash : le plafond PEA porte sur l'argent versé sur le
   * compte, pas sur les achats. Sans versement saisi, on se rabat sur les
   * achats (frais inclus).
   */
  deposits(deposits, purchases) {
    const spent = purchases.reduce((s, p) => s + Calc.purchaseCost(p), 0);
    const total = deposits.reduce((s, d) => s + d.amount, 0);
    const hasDeposits = deposits.length > 0;
    return {
      hasDeposits,
      total,
      spent,
      base: hasDeposits ? total : spent, // montant compté pour le plafond
      cash: hasDeposits ? total - spent : null,
    };
  },

  /**
   * Calculateur « prochain achat » : nombre de parts entières achetables
   * avec un montant donné, frais de courtage déduits.
   */
  buyPlan(amount, price, fees = 0) {
    if (!(amount > 0) || !(price > 0) || fees < 0) return null;
    const qty = Math.max(Math.floor((amount - fees) / price + 1e-9), 0);
    const cost = qty > 0 ? qty * price + fees : 0;
    return { qty, cost, left: amount - cost };
  },

  /**
   * Taux de rendement interne annualisé (TRI / XIRR).
   * @param flows [{date: 'AAAA-MM-JJ', amount}] — négatif = argent investi,
   *              positif = argent récupéré (ou valeur actuelle).
   * @returns taux annuel (0.07 = 7 %) ou null si incalculable.
   * Résolution par dichotomie : lente mais toujours stable.
   */
  xirr(flows) {
    if (flows.length < 2) return null;
    const t0 = Dates.parse(flows[0].date);
    const pts = flows.map((f) => ({ t: Dates.daysBetween(t0, Dates.parse(f.date)) / 365, a: f.amount }));
    if (!pts.some((p) => p.a < 0) || !pts.some((p) => p.a > 0)) return null;
    const npv = (r) => pts.reduce((s, p) => s + p.a / Math.pow(1 + r, p.t), 0);
    let lo = -0.9999, hi = 10;
    let flo = npv(lo), fhi = npv(hi);
    if (!Number.isFinite(flo) || !Number.isFinite(fhi) || flo * fhi > 0) return null;
    for (let k = 0; k < 200; k++) {
      const mid = (lo + hi) / 2;
      const fm = npv(mid);
      if (Math.abs(fm) < 1e-9 || hi - lo < 1e-10) return mid;
      if (fm * flo < 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
    }
    return (lo + hi) / 2;
  },

  /** TRI du portefeuille : achats (sorties) + valeur actuelle (entrée) à la date du jour. */
  portfolioXirr(purchases, value, todayISO = Dates.today()) {
    if (!purchases.length || !(value > 0)) return null;
    const flows = purchases
      .map((p) => ({ date: p.date, amount: -Calc.purchaseCost(p) }))
      .sort((a, b) => a.date.localeCompare(b.date));
    const days = Dates.daysBetween(Dates.parse(flows[0].date), Dates.parse(todayISO));
    return { rate: Calc.xirr([...flows, { date: todayISO, amount: value }]), days };
  },

  /**
   * Série « valeur du portefeuille vs versements » à partir de l'historique
   * des cours. histories = { TICKER: [['AAAA-MM-JJ', clôture], ...] } triés.
   * Un point par jour de cotation depuis le premier achat. Renvoie [] si un
   * titre détenu n'a pas d'historique.
   */
  valueSeries(purchases, histories) {
    if (!purchases.length) return [];
    const sorted = purchases.slice().sort((a, b) => a.date.localeCompare(b.date));
    const tickers = [...new Set(sorted.map((p) => Calc.normTicker(p.ticker)))];
    if (tickers.some((t) => !histories[t] || !histories[t].length)) return [];
    const start = sorted[0].date;
    const dates = [...new Set(tickers.flatMap((t) => histories[t].map((h) => h[0])))]
      .filter((d) => d >= start)
      .sort();

    const out = [];
    const idx = Object.fromEntries(tickers.map((t) => [t, -1]));
    const qty = Object.fromEntries(tickers.map((t) => [t, 0]));
    let pi = 0;
    let invested = 0;
    for (const d of dates) {
      while (pi < sorted.length && sorted[pi].date <= d) {
        const p = sorted[pi++];
        qty[Calc.normTicker(p.ticker)] += p.qty;
        invested += Calc.purchaseCost(p);
      }
      let value = 0;
      let ok = true;
      for (const t of tickers) {
        const h = histories[t];
        while (idx[t] + 1 < h.length && h[idx[t] + 1][0] <= d) idx[t]++;
        if (qty[t] > 0) {
          if (idx[t] < 0) { ok = false; break; }
          value += qty[t] * h[idx[t]][1];
        }
      }
      if (ok) out.push({ date: d, invested, value });
    }
    return out;
  },
};

/* ==========================================================================
   3. STOCKAGE — localStorage + export / import JSON
   ========================================================================== */
const Store = {
  KEY: 'suivi-pea:v1',

  defaults() {
    return {
      version: 1,
      openingDate: Dates.today(),
      purchases: [],            // [{id, date, ticker, qty, price, fees}]
      deposits: [],             // versements sur le PEA [{id, date, amount}]
      prices: {},               // { TICKER: {price, date, source} }
      sim: { monthly: 100, rate: 7, years: 20, initial: 0, ter: 0.2 },
      plan: { amount: 100, fees: 0 }, // calculateur « prochain achat »
      lastExport: null,         // date du dernier export JSON
      theme: 'dark',
    };
  },

  load() {
    try {
      const raw = localStorage.getItem(Store.KEY);
      if (!raw) return Store.defaults();
      return Store.sanitize(JSON.parse(raw));
    } catch (e) {
      console.warn('Lecture des données impossible, valeurs par défaut.', e);
      return Store.defaults();
    }
  },

  save(state) {
    try {
      localStorage.setItem(Store.KEY, JSON.stringify(state));
    } catch (e) {
      console.error('Sauvegarde impossible', e);
    }
  },

  /** Valide et nettoie des données (localStorage ou fichier importé). */
  sanitize(data) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.purchases)) {
      throw new Error('Fichier invalide : liste des achats absente.');
    }
    const def = Store.defaults();
    const purchases = data.purchases.map((p, idx) => {
      const clean = {
        id: String(p.id || Store.newId()),
        date: String(p.date),
        ticker: Calc.normTicker(p.ticker),
        qty: Number(p.qty),
        price: Number(p.price),
        fees: Number(p.fees) || 0,
      };
      if (!Dates.isValidISO(clean.date) || !clean.ticker || !(clean.qty > 0) || !(clean.price > 0) || clean.fees < 0) {
        throw new Error(`Achat n°${idx + 1} invalide.`);
      }
      return clean;
    });
    const deposits = (Array.isArray(data.deposits) ? data.deposits : []).map((d, idx) => {
      const clean = { id: String(d.id || Store.newId()), date: String(d.date), amount: Number(d.amount) };
      if (!Dates.isValidISO(clean.date) || !(clean.amount > 0)) throw new Error(`Versement n°${idx + 1} invalide.`);
      return clean;
    });
    const prices = {};
    for (const [t, q] of Object.entries(data.prices || {})) {
      if (q && Number(q.price) > 0) prices[Calc.normTicker(t)] = { price: Number(q.price), date: String(q.date || ''), source: q.source || 'manuel' };
    }
    return {
      version: 1,
      openingDate: Dates.isValidISO(data.openingDate) ? data.openingDate : def.openingDate,
      purchases,
      deposits,
      prices,
      sim: { ...def.sim, ...(data.sim || {}) },
      plan: { ...def.plan, ...(data.plan || {}) },
      lastExport: Dates.isValidISO(data.lastExport) ? data.lastExport : null,
      theme: data.theme === 'light' ? 'light' : 'dark',
    };
  },

  newId() {
    return (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : Date.now().toString(36) + Math.random().toString(36).slice(2);
  },
};

/* ==========================================================================
   4. FOURNISSEURS DE COURS
   --------------------------------------------------------------------------
   Interface d'un fournisseur :
     { id, label, auto, async load() → { quotes: {TICKER: {price, date}},
                                          histories: {TICKER: [[date, clôture], ...]} } | null }
   Le fournisseur actif est ACTIVE_PROVIDER. La saisie manuelle reste
   toujours possible et prime sur un cours automatique plus ancien.
   ========================================================================== */

/**
 * Où lire data/prices.json (mis à jour chaque soir de semaine par la
 * GitHub Action .github/workflows/prices.yml).
 * Sur GitHub Pages, on lit d'abord le fichier brut du dépôt (à jour dès le
 * commit, sans attendre la republication du site), puis la copie du site.
 */
function priceUrls(loc = (typeof location !== 'undefined' ? location : null)) {
  const urls = [];
  if (loc && /\.github\.io$/.test(loc.hostname)) {
    const owner = loc.hostname.split('.')[0];
    const repo = loc.pathname.split('/').filter(Boolean)[0];
    if (repo) urls.push(`https://raw.githubusercontent.com/${owner}/${repo}/main/data/prices.json`);
  }
  urls.push('data/prices.json');
  return urls;
}

/** Valide le contenu de prices.json et le met au format attendu par l'appli. */
function parsePricesFile(json) {
  if (!json || typeof json !== 'object' || !json.quotes) return null;
  const quotes = {};
  const histories = {};
  for (const [t, q] of Object.entries(json.quotes)) {
    const ticker = Calc.normTicker(t);
    if (q && Number(q.price) > 0 && Dates.isValidISO(q.date)) quotes[ticker] = { price: Number(q.price), date: q.date };
    if (q && Array.isArray(q.history)) {
      histories[ticker] = q.history
        .filter((h) => Array.isArray(h) && Dates.isValidISO(h[0]) && Number(h[1]) > 0)
        .map((h) => [h[0], Number(h[1])])
        .sort((a, b) => a[0].localeCompare(b[0]));
    }
  }
  return { quotes, histories, updatedAt: json.updatedAt || null };
}

const PriceProviders = {
  manual: {
    id: 'manuel',
    label: 'Saisie manuelle',
    auto: false,
    async load() { return null; },
  },

  /** Cours de clôture publiés par la GitHub Action dans data/prices.json. */
  githubAction: {
    id: 'auto',
    label: 'Automatique (clôture Euronext)',
    auto: true,
    async load() {
      for (const url of priceUrls()) {
        try {
          const r = await fetch(url, { cache: 'no-store' });
          if (!r.ok) continue;
          const parsed = parsePricesFile(await r.json());
          if (parsed) return parsed;
        } catch (e) { /* hors ligne ou fichier absent : on essaie l'URL suivante */ }
      }
      return null;
    },
  },
};
const ACTIVE_PROVIDER = PriceProviders.githubAction;

/**
 * Fusionne des cours automatiques dans les cours enregistrés.
 * Un cours auto remplace le cours stocké s'il est plus récent, ou si le cours
 * stocké vient lui-même du fournisseur auto. Un cours saisi à la main le même
 * jour ou plus tard est conservé.
 * @returns nombre de cours mis à jour
 */
function mergeQuotes(prices, quotes, source = 'auto') {
  let n = 0;
  for (const [t, q] of Object.entries(quotes)) {
    const cur = prices[t];
    if (!cur || q.date > cur.date || (cur.source === source && (q.date !== cur.date || q.price !== cur.price))) {
      prices[t] = { price: q.price, date: q.date, source };
      n++;
    }
  }
  return n;
}

/* ==========================================================================
   5. GRAPHIQUES SVG MAISON
   --------------------------------------------------------------------------
   drawChart(container, { xs, series, xLabel, yFormat, step, stacked })
     xs      : valeurs numériques de l'axe X (timestamps, mois…)
     series  : [{ name, color (variable CSS), values: [...], area: bool, step: bool }]
     step    : tracé en escalier pour toutes les séries (sinon par série)
     stacked : les aires sont empilées (valeur affichée = somme)
   Survol / toucher : ligne verticale + infobulle listant toutes les séries.
   ========================================================================== */
const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}, parent) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (parent) parent.appendChild(el);
  return el;
}

/** Graduations « rondes » pour l'axe Y. */
function niceTicks(max, count = 4) {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const ticks = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

function drawChart(container, opts) {
  const { xs, series, xLabel, yFormat, step = false, stacked = false, emptyText = 'Pas encore de données' } = opts;
  container.innerHTML = '';
  const W = container.clientWidth || 320;
  const H = container.clientHeight || 220;
  const m = { top: 10, right: 12, bottom: 26, left: 48 };
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none' }, container);

  if (!xs.length) {
    svgEl('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'empty-msg' }, svg).textContent = emptyText;
    return;
  }

  // Valeurs affichées (empilées si besoin)
  const shown = [];
  series.forEach((s, si) => {
    shown[si] = s.values.map((v, i) => (stacked && si > 0 ? shown[si - 1][i] + v : v));
  });
  const yMax = Math.max(...shown.flat(), 1);
  const ticks = niceTicks(yMax);
  const top = ticks[ticks.length - 1];

  const x0 = xs[0];
  const x1 = xs.length > 1 ? xs[xs.length - 1] : xs[0] + 1;
  const sx = (x) => m.left + ((x - x0) / (x1 - x0)) * (W - m.left - m.right);
  const sy = (y) => H - m.bottom - (y / top) * (H - m.top - m.bottom);

  // Quadrillage + axe Y
  const grid = svgEl('g', { class: 'grid' }, svg);
  ticks.forEach((t) => {
    if (t > 0) svgEl('line', { x1: m.left, x2: W - m.right, y1: sy(t), y2: sy(t) }, grid);
    svgEl('text', { x: m.left - 6, y: sy(t) + 4, 'text-anchor': 'end', class: 'tick' }, svg).textContent = Fmt.compactEur(t);
  });
  svgEl('line', { x1: m.left, x2: W - m.right, y1: sy(0), y2: sy(0), class: 'baseline' }, svg);

  // Axe X : 2 à 4 étiquettes
  const nLabels = Math.min(xs.length, W < 360 ? 3 : 4);
  const seen = new Set();
  for (let k = 0; k < nLabels; k++) {
    const idx = nLabels === 1 ? 0 : Math.round((k * (xs.length - 1)) / (nLabels - 1));
    if (seen.has(idx)) continue;
    seen.add(idx);
    const anchor = k === 0 ? 'start' : k === nLabels - 1 ? 'end' : 'middle';
    svgEl('text', { x: sx(xs[idx]), y: H - 6, 'text-anchor': anchor, class: 'tick' }, svg).textContent = xLabel(xs[idx]);
  }

  // Chemins : ligne (2px) + aire translucide
  const pathFor = (vals, st) => {
    let d = '';
    vals.forEach((v, i) => {
      const X = sx(xs[i]); const Y = sy(v);
      if (i === 0) d += `M${X},${Y}`;
      else if (st) d += `H${X}V${Y}`;
      else d += `L${X},${Y}`;
    });
    if (xs.length === 1) d += `H${W - m.right}`; // un seul point : ligne horizontale
    return d;
  };
  series.forEach((s, si) => {
    const line = pathFor(shown[si], step || s.step);
    if (s.area) {
      const lower = si > 0 && stacked ? shown[si - 1] : null;
      let d = line;
      if (lower) {
        // referme l'aire sur la série du dessous (parcours inverse)
        for (let i = xs.length - 1; i >= 0; i--) d += `L${sx(xs[i])},${sy(lower[i])}`;
        d += 'Z';
      } else {
        d += `V${sy(0)}H${sx(xs[0])}Z`;
      }
      svgEl('path', { d, fill: `var(${s.color})`, 'fill-opacity': 0.22, stroke: 'none' }, svg);
    }
    svgEl('path', { d: line, fill: 'none', stroke: `var(${s.color})`, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
  });

  // Couche d'interaction (crosshair + infobulle)
  const cross = svgEl('line', { class: 'crosshair', y1: m.top, y2: H - m.bottom, visibility: 'hidden' }, svg);
  const dots = series.map((s) => svgEl('circle', { r: 4, fill: `var(${s.color})`, stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' }, svg));
  const hit = svgEl('rect', { x: m.left, y: 0, width: W - m.left - m.right, height: H, fill: 'transparent' }, svg);

  const tooltip = document.getElementById('tooltip');
  const show = (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    // point le plus proche en X
    let idx = 0; let best = Infinity;
    xs.forEach((x, i) => { const dd = Math.abs(sx(x) - px); if (dd < best) { best = dd; idx = i; } });
    const X = sx(xs[idx]);
    cross.setAttribute('x1', X); cross.setAttribute('x2', X); cross.setAttribute('visibility', 'visible');
    dots.forEach((dot, si) => { dot.setAttribute('cx', X); dot.setAttribute('cy', sy(shown[si][idx])); dot.setAttribute('visibility', 'visible'); });

    tooltip.replaceChildren();
    const title = document.createElement('div');
    title.className = 'tt-title';
    title.textContent = opts.tooltipTitle ? opts.tooltipTitle(xs[idx], idx) : xLabel(xs[idx]);
    tooltip.appendChild(title);
    const rows = opts.tooltipRows ? opts.tooltipRows(idx) : series.map((s) => ({ name: s.name, color: s.color, value: yFormat(s.values[idx]) }));
    rows.forEach((r) => {
      const row = document.createElement('div'); row.className = 'tt-row';
      const key = document.createElement('i'); key.className = 'tt-key'; key.style.background = r.color ? `var(${r.color})` : 'transparent';
      const b = document.createElement('b'); b.textContent = r.value;
      const span = document.createElement('span'); span.textContent = r.name;
      row.append(key, b, span);
      tooltip.appendChild(row);
    });
    tooltip.hidden = false;
    const tw = tooltip.offsetWidth;
    const left = Math.min(Math.max(ev.clientX - tw / 2, 8), window.innerWidth - tw - 8);
    tooltip.style.left = left + 'px';
    tooltip.style.top = (rect.top - tooltip.offsetHeight - 8 > 0 ? rect.top - tooltip.offsetHeight - 8 : rect.bottom + 8) + 'px';
  };
  const hide = () => {
    tooltip.hidden = true;
    cross.setAttribute('visibility', 'hidden');
    dots.forEach((d) => d.setAttribute('visibility', 'hidden'));
  };
  hit.addEventListener('pointermove', show);
  hit.addEventListener('pointerdown', show);
  hit.addEventListener('pointerleave', hide);
  hit.addEventListener('pointercancel', hide);
}

/* ==========================================================================
   6. INTERFACE
   ========================================================================== */
const App = {
  state: null,

  histories: {},     // historiques de cours (pas dans l'export : ce sont des données publiques)
  lastQuoteFetch: 0,

  init() {
    App.state = Store.load();
    App.histories = App.loadHistories();
    App.applyTheme();
    App.bindNavigation();
    App.bindPurchases();
    App.bindPlanner();
    App.bindSimulator();
    App.bindPea();
    App.bindBanners();
    App.renderAll();
    window.addEventListener('resize', App.debounce(() => { App.renderCharts(); }, 150));
    document.getElementById('app-version').textContent = `Suivi PEA v${APP_VERSION} — cours : ${ACTIVE_PROVIDER.label.toLowerCase()}`;
    document.getElementById('version-badge').textContent = `v${APP_VERSION}`;

    // Cours automatiques : au démarrage puis à chaque retour dans l'appli (au plus 1 fois / 30 min)
    App.refreshQuotes({ silent: true });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && Date.now() - App.lastQuoteFetch > 30 * 60 * 1000) App.refreshQuotes({ silent: true });
    });

    App.registerServiceWorker();
  },

  /* ---------- Service worker : hors ligne + avis de mise à jour ---------- */
  swReg: null,
  reloadOnUpdate: false,

  registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    // Une page déjà contrôlée qui change de contrôleur = nouvelle version installée
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (App.reloadOnUpdate) location.reload(); // demandé via le bouton ↻
      else if (hadController) document.getElementById('update-banner').hidden = false;
    });
    navigator.serviceWorker.register('sw.js')
      .then((reg) => { App.swReg = reg; return reg.update(); })
      .catch((e) => console.warn('SW non enregistré', e));
  },

  /**
   * Bouton ↻ : cherche une nouvelle version de l'appli (et la charge),
   * sinon actualise les cours. Utile dans l'appli installée sur iPhone,
   * où l'on ne peut pas recharger la page.
   */
  async refreshApp() {
    const btn = document.getElementById('btn-refresh');
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add('spinning');
    try {
      const reg = App.swReg;
      if (!reg) { location.reload(); return; }
      await reg.update();
      if (reg.installing || reg.waiting) {
        // Nouvelle version trouvée : on recharge dès qu'elle est active
        App.reloadOnUpdate = true;
        App.toast('Mise à jour en cours…');
        setTimeout(() => location.reload(), 8000); // filet de sécurité
        return;
      }
      await App.refreshQuotes({ silent: true });
      App.toast(`Appli à jour (v${APP_VERSION}) · cours actualisés`);
    } catch (e) {
      console.warn('Actualisation impossible', e);
      App.toast('Actualisation impossible (hors ligne ?)');
    }
    btn.disabled = false;
    btn.classList.remove('spinning');
  },

  bindBanners() {
    document.getElementById('btn-refresh').addEventListener('click', App.refreshApp);
    document.getElementById('btn-reload').addEventListener('click', () => location.reload());
    document.getElementById('btn-backup-now').addEventListener('click', App.exportJSON);
  },

  /* ---------- Historique des cours (cache local pour le hors ligne) ---------- */
  HISTORY_KEY: 'suivi-pea:histories',
  loadHistories() {
    try { return JSON.parse(localStorage.getItem(App.HISTORY_KEY)) || {}; } catch (e) { return {}; }
  },
  saveHistories() {
    try { localStorage.setItem(App.HISTORY_KEY, JSON.stringify(App.histories)); } catch (e) { /* quota : tant pis */ }
  },

  persist() { Store.save(App.state); },

  debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; },

  toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(App._toastT);
    App._toastT = setTimeout(() => { el.hidden = true; }, 2500);
  },

  /* ---------- Navigation par onglets (hash) ---------- */
  bindNavigation() {
    const go = () => {
      const name = (location.hash || '#dashboard').slice(1);
      const view = document.getElementById('view-' + name) || document.getElementById('view-dashboard');
      document.querySelectorAll('.view').forEach((v) => { v.hidden = v !== view; });
      document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('active', 'view-' + a.dataset.view === view.id));
      document.getElementById('view-title').textContent = view.dataset.title;
      document.getElementById('tooltip').hidden = true;
      window.scrollTo(0, 0);
      App.renderCharts(); // les graphiques ont besoin d'une vue visible pour connaître leur largeur
    };
    window.addEventListener('hashchange', go);
    go();
  },

  renderAll() {
    App.renderDashboard();
    App.renderPlanner();
    App.renderPurchases();
    App.renderSimulator();
    App.renderPea();
    App.renderCharts();
  },

  renderCharts() {
    App.renderCumulChart();
    App.renderSimChart();
  },

  /* ---------- Tableau de bord ---------- */
  renderDashboard() {
    const pf = Calc.portfolio(App.state.purchases, App.state.prices);
    const cls = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');

    document.getElementById('kpi-value').textContent = Fmt.eur(pf.value);
    const pvEl = document.getElementById('kpi-pv');
    pvEl.textContent = `${Fmt.signedEur(pf.pv)} (${Fmt.signedPct(pf.pvPct)})`;
    pvEl.className = 'hero-delta ' + cls(pf.pv);
    document.getElementById('kpi-invested').textContent = Fmt.eur(pf.invested);
    const pvEur = document.getElementById('kpi-pv-eur');
    pvEur.textContent = Fmt.signedEur(pf.pv);
    pvEur.className = 'kpi-value ' + cls(pf.pv);
    document.getElementById('kpi-pru').textContent = pf.pru !== null ? Fmt.unitPrice(pf.pru) : (pf.positions.length ? 'voir titres' : '—');
    document.getElementById('kpi-qty').textContent = Fmt.num(pf.qty);

    // Rendement annualisé (TRI) : n'a de sens qu'après quelques semaines
    const xr = Calc.portfolioXirr(App.state.purchases, pf.value);
    const xEl = document.getElementById('kpi-xirr');
    const xHint = document.getElementById('kpi-xirr-hint');
    if (!xr) {
      xEl.textContent = '—'; xEl.className = 'kpi-value'; xHint.textContent = '';
    } else if (xr.days < 30 || xr.rate === null) {
      xEl.textContent = '—'; xEl.className = 'kpi-value';
      xHint.textContent = 'Disponible après 1 mois';
    } else {
      xEl.textContent = Fmt.signedPct(xr.rate);
      xEl.className = 'kpi-value ' + cls(xr.rate);
      xHint.textContent = xr.days < 365 ? 'par an · moins d\'1 an de recul' : 'par an';
    }

    // Cash disponible = versements − achats
    const dep = Calc.deposits(App.state.deposits, App.state.purchases);
    const cashEl = document.getElementById('kpi-cash');
    const cashHint = document.getElementById('kpi-cash-hint');
    if (dep.hasDeposits) {
      cashEl.textContent = Fmt.eur(dep.cash);
      cashEl.className = 'kpi-value ' + (dep.cash < 0 ? 'neg' : '');
      cashHint.textContent = dep.cash < 0 ? 'Achats > versements : un versement manque ?' : '';
    } else {
      cashEl.textContent = '—';
      cashEl.className = 'kpi-value';
      cashHint.textContent = 'Saisissez vos versements (onglet PEA)';
    }

    // Rappel de sauvegarde
    const banner = document.getElementById('backup-banner');
    const last = App.state.lastExport;
    const age = last ? Dates.daysBetween(Dates.parse(last), new Date()) : Infinity;
    banner.hidden = !(App.state.purchases.length && age > 30);
    document.getElementById('backup-text').textContent = last
      ? `Dernière sauvegarde il y a ${age} jours.`
      : 'Aucune sauvegarde de vos données pour l\'instant.';

    const warn = document.getElementById('kpi-warning');
    warn.hidden = !pf.missingQuotes.length;
    warn.textContent = pf.missingQuotes.length
      ? `Cours non saisi pour ${pf.missingQuotes.join(', ')} : valorisé au dernier prix d'achat.`
      : '';

    // Une carte par titre, avec saisie du cours actuel
    const box = document.getElementById('positions');
    box.replaceChildren();
    if (!pf.positions.length) {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = 'Ajoutez un achat pour voir vos positions.';
      box.appendChild(p);
      return;
    }
    for (const pos of pf.positions) {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `
        <div class="position-head"><strong></strong><span class="${cls(pos.pv)}"></span></div>
        <div class="position-grid">
          <div>Parts<b data-f="qty"></b></div>
          <div>PRU<b data-f="pru"></b></div>
          <div>Investi<b data-f="invested"></b></div>
          <div>Valeur<b data-f="value"></b></div>
        </div>
        <form class="price-row" autocomplete="off">
          <label>Cours actuel (€)
            <input type="text" inputmode="decimal" name="price" enterkeyhint="done">
          </label>
          <button class="btn btn-primary btn-small" type="submit">OK</button>
        </form>
        <p class="hint" data-f="quote"></p>`;
      // textContent pour les données saisies (jamais d'innerHTML avec des données)
      card.querySelector('.position-head strong').textContent = pos.ticker;
      card.querySelector('.position-head span').textContent = `${Fmt.signedEur(pos.pv)} · ${Fmt.signedPct(pos.pvPct)}`;
      card.querySelector('[data-f=qty]').textContent = Fmt.num(pos.qty);
      card.querySelector('[data-f=pru]').textContent = Fmt.unitPrice(pos.pru);
      card.querySelector('[data-f=invested]').textContent = Fmt.eur(pos.invested);
      card.querySelector('[data-f=value]').textContent = Fmt.eur(pos.value);
      const src = (App.state.prices[pos.ticker] || {}).source;
      card.querySelector('[data-f=quote]').textContent = !pos.hasQuote
        ? `Aucun cours (dernier prix d'achat : ${Fmt.unitPrice(pos.lastPrice)})`
        : src === 'auto'
          ? `Cours de clôture du ${Fmt.date(pos.quoteDate)} (automatique)`
          : `Cours saisi le ${Fmt.date(pos.quoteDate)}`;
      const input = card.querySelector('input');
      input.value = pos.hasQuote ? Fmt.input(pos.currentPrice) : '';
      input.placeholder = Fmt.input(pos.lastPrice);
      card.querySelector('form').addEventListener('submit', (e) => {
        e.preventDefault();
        App.setPrice(pos.ticker, input.value);
      });
      box.appendChild(card);
    }

    if (ACTIVE_PROVIDER.auto) {
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = '↻ Actualiser les cours';
      btn.addEventListener('click', () => App.refreshQuotes({ silent: false }));
      box.appendChild(btn);
    }
  },

  setPrice(ticker, raw) {
    const price = Calc.parseNumber(raw);
    if (raw.trim() === '') {
      delete App.state.prices[ticker];
    } else if (!(price > 0)) {
      App.toast('Cours invalide');
      return;
    } else {
      App.state.prices[ticker] = { price, date: Dates.today(), source: 'manuel' };
    }
    App.persist();
    App.renderAll();
    App.toast('Cours enregistré');
  },

  /** Charge les cours du fournisseur actif et les fusionne avec les cours saisis. */
  async refreshQuotes({ silent = false } = {}) {
    if (!ACTIVE_PROVIDER.auto) return;
    App.lastQuoteFetch = Date.now();
    let data = null;
    try { data = await ACTIVE_PROVIDER.load(); } catch (e) { console.warn('Cours indisponibles', e); }
    if (!data) {
      if (!silent) App.toast('Cours indisponibles (hors ligne ?)');
      return;
    }
    const n = mergeQuotes(App.state.prices, data.quotes, ACTIVE_PROVIDER.id);
    App.histories = data.histories;
    App.saveHistories();
    if (n) App.persist();
    App.renderAll();
    if (!silent) App.toast(n ? `${n} cours mis à jour` : 'Cours déjà à jour');
  },

  renderCumulChart() {
    const el = document.getElementById('chart-cumul');
    if (el.offsetParent === null) return; // vue masquée

    // Avec l'historique des cours : valeur réelle vs versements, jour par jour
    const vs = Calc.valueSeries(App.state.purchases, App.histories);
    document.getElementById('legend-value').hidden = vs.length < 2;
    document.getElementById('chart-cumul-legend').hidden = vs.length < 2;
    document.getElementById('chart-cumul-title').textContent = vs.length >= 2 ? 'Valeur et versements' : 'Versements cumulés';
    if (vs.length >= 2) {
      drawChart(el, {
        xs: vs.map((p) => Dates.parse(p.date).getTime()),
        series: [
          { name: 'Versé', color: '--series-invested', values: vs.map((p) => p.invested), area: true, step: true },
          { name: 'Valeur', color: '--series-value', values: vs.map((p) => p.value) },
        ],
        xLabel: (x) => Fmt.monthYear(Dates.toISO(new Date(x))),
        tooltipTitle: (x) => Fmt.date(Dates.toISO(new Date(x))),
        tooltipRows: (i) => [
          { name: 'Valeur', color: '--series-value', value: Fmt.eur(vs[i].value) },
          { name: 'Versé', color: '--series-invested', value: Fmt.eur(vs[i].invested) },
          { name: 'Plus-value', value: Fmt.signedEur(vs[i].value - vs[i].invested) },
        ],
        yFormat: Fmt.eur,
      });
      return;
    }

    // Sinon : versements cumulés seuls
    const pts = Calc.cumulativeSeries(App.state.purchases);
    drawChart(el, {
      xs: pts.map((p) => Dates.parse(p.date).getTime()),
      series: [{ name: 'Versé', color: '--series-invested', values: pts.map((p) => p.total), area: true }],
      xLabel: (x) => Fmt.monthYear(Dates.toISO(new Date(x))),
      tooltipTitle: (x) => Fmt.date(Dates.toISO(new Date(x))),
      yFormat: Fmt.eur,
      step: true,
      emptyText: 'Ajoutez un achat pour voir la courbe',
    });
  },

  /* ---------- Achats ---------- */
  bindPurchases() {
    const dlg = document.getElementById('purchase-dialog');
    const form = document.getElementById('purchase-form');
    document.getElementById('btn-add').addEventListener('click', () => App.openPurchase());
    document.getElementById('btn-cancel').addEventListener('click', () => dlg.close());
    form.addEventListener('input', App.updatePurchaseTotal);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (App.savePurchase()) dlg.close();
    });
  },

  /** Ticker par défaut : celui du dernier achat, sinon DCAM. */
  defaultTicker() {
    const last = App.state.purchases.slice().sort((a, b) => b.date.localeCompare(a.date))[0];
    return last ? last.ticker : 'DCAM';
  },

  /**
   * Ouvre la fenêtre d'achat.
   * @param p        achat existant à modifier (avec id) — ou rien pour un nouvel achat
   * @param prefill  valeurs pré-remplies d'un nouvel achat (calculateur)
   */
  openPurchase(p, prefill = null) {
    const form = document.getElementById('purchase-form');
    const v = p || prefill || {};
    form.id.value = p ? p.id : '';
    form.date.value = v.date || Dates.today();
    form.ticker.value = v.ticker || App.defaultTicker();
    form.qty.value = Fmt.input(v.qty);
    form.price.value = Fmt.input(v.price);
    form.fees.value = Fmt.input(v.fees);
    document.getElementById('purchase-dialog-title').textContent = p ? "Modifier l'achat" : 'Nouvel achat';
    document.getElementById('purchase-error').hidden = true;
    App.updatePurchaseTotal();
    document.getElementById('purchase-dialog').showModal();
  },

  readPurchaseForm() {
    const f = document.getElementById('purchase-form');
    return {
      id: f.id.value || Store.newId(),
      date: f.date.value,
      ticker: Calc.normTicker(f.ticker.value),
      qty: Calc.parseNumber(f.qty.value),
      price: Calc.parseNumber(f.price.value),
      fees: Calc.parseNumber(f.fees.value, true),
    };
  },

  updatePurchaseTotal() {
    const p = App.readPurchaseForm();
    const el = document.getElementById('purchase-total');
    el.textContent = p.qty > 0 && p.price > 0 && p.fees >= 0 ? `Montant total : ${Fmt.eur(Calc.purchaseCost(p))}` : '';
  },

  savePurchase() {
    const p = App.readPurchaseForm();
    const err = document.getElementById('purchase-error');
    let msg = '';
    if (!Dates.isValidISO(p.date)) msg = 'Date invalide.';
    else if (!p.ticker) msg = 'Indiquez un ticker ou un nom.';
    else if (!(p.qty > 0)) msg = 'Nombre de parts invalide.';
    else if (!(p.price > 0)) msg = 'Prix unitaire invalide.';
    else if (!(p.fees >= 0)) msg = 'Frais invalides.';
    if (msg) { err.textContent = msg; err.hidden = false; return false; }

    const i = App.state.purchases.findIndex((x) => x.id === p.id);
    if (i >= 0) App.state.purchases[i] = p; else App.state.purchases.push(p);
    App.persist();
    App.renderAll();
    App.toast(i >= 0 ? 'Achat modifié' : 'Achat ajouté');
    return true;
  },

  deletePurchase(id) {
    const p = App.state.purchases.find((x) => x.id === id);
    if (!p || !confirm(`Supprimer l'achat ${p.ticker} du ${Fmt.date(p.date)} ?`)) return;
    App.state.purchases = App.state.purchases.filter((x) => x.id !== id);
    App.persist();
    App.renderAll();
    App.toast('Achat supprimé');
  },

  renderPurchases() {
    const list = document.getElementById('purchase-list');
    const sorted = App.state.purchases.slice().sort((a, b) => b.date.localeCompare(a.date));
    document.getElementById('purchase-empty').hidden = sorted.length > 0;
    list.replaceChildren();
    for (const p of sorted) {
      const card = document.createElement('div');
      card.className = 'card purchase';
      card.innerHTML = `
        <div class="purchase-top"><strong></strong><strong data-f="total"></strong></div>
        <div class="purchase-meta"></div>
        <div class="purchase-actions">
          <button class="btn" data-a="edit">Modifier</button>
          <button class="btn btn-danger" data-a="del">Supprimer</button>
        </div>`;
      card.querySelector('.purchase-top strong').textContent = `${p.ticker} · ${Fmt.date(p.date)}`;
      card.querySelector('[data-f=total]').textContent = Fmt.eur(Calc.purchaseCost(p));
      card.querySelector('.purchase-meta').textContent =
        `${Fmt.num(p.qty)} part${p.qty > 1 ? 's' : ''} × ${Fmt.unitPrice(p.price)} · frais ${Fmt.eur(p.fees)}`;
      card.querySelector('[data-a=edit]').addEventListener('click', () => App.openPurchase(p));
      card.querySelector('[data-a=del]').addEventListener('click', () => App.deletePurchase(p.id));
      list.appendChild(card);
    }
  },

  /* ---------- Calculateur « prochain achat » ---------- */
  bindPlanner() {
    const form = document.getElementById('plan-form');
    form.amount.value = Fmt.input(App.state.plan.amount);
    form.fees.value = App.state.plan.fees ? Fmt.input(App.state.plan.fees) : '';
    form.addEventListener('submit', (e) => e.preventDefault());
    form.addEventListener('input', (e) => {
      if (e.target.name === 'price') form.price.dataset.touched = '1';
      const amount = Calc.parseNumber(form.amount.value);
      const fees = Calc.parseNumber(form.fees.value, true);
      if (amount > 0 && fees >= 0) { App.state.plan = { amount, fees }; App.persist(); }
      App.renderPlanner();
    });
    document.getElementById('btn-plan-save').addEventListener('click', () => {
      const r = App.planResult();
      if (!r) return;
      App.openPurchase(null, { ticker: App.defaultTicker(), qty: r.qty, price: r.price, fees: r.fees });
    });
  },

  /** Lit le calculateur : cours saisi, sinon dernier cours connu du titre. */
  planResult() {
    const form = document.getElementById('plan-form');
    const ticker = App.defaultTicker();
    const known = App.state.prices[ticker];
    if (!form.price.dataset.touched || form.price.value === '') {
      form.price.value = known ? Fmt.input(known.price) : '';
    }
    const amount = Calc.parseNumber(form.amount.value);
    const price = Calc.parseNumber(form.price.value);
    const fees = Calc.parseNumber(form.fees.value, true);
    const plan = Calc.buyPlan(amount, price, fees);
    return plan ? { ...plan, amount, price, fees, ticker } : null;
  },

  renderPlanner() {
    const r = App.planResult();
    const res = document.getElementById('plan-result');
    const left = document.getElementById('plan-left');
    const btn = document.getElementById('btn-plan-save');
    if (!r) {
      res.textContent = '';
      left.textContent = 'Indiquez un montant et le cours actuel.';
      btn.disabled = true;
      return;
    }
    if (r.qty === 0) {
      res.textContent = '0 part';
      left.textContent = `Montant insuffisant pour une part à ${Fmt.unitPrice(r.price)}${r.fees ? ' frais compris' : ''}.`;
      btn.disabled = true;
      return;
    }
    res.textContent = `${Fmt.num(r.qty)} ${r.ticker} × ${Fmt.unitPrice(r.price)}`;
    left.textContent = `Coût ${Fmt.eur(r.cost)}${r.fees ? ' frais compris' : ''} · reste ${Fmt.eur(r.left)} en cash.`;
    btn.disabled = false;
  },

  /* ---------- Simulateur ---------- */
  bindSimulator() {
    const form = document.getElementById('sim-form');
    App.bindSimulatorValues();
    form.addEventListener('submit', (e) => e.preventDefault());
    document.getElementById('btn-sim-from-pf').addEventListener('click', () => {
      const value = Calc.portfolio(App.state.purchases, App.state.prices).value;
      form.initial.value = Fmt.input(Math.round(value * 100) / 100);
      form.dispatchEvent(new Event('input'));
      App.toast(value > 0 ? 'Capital de départ = valeur actuelle' : 'Portefeuille vide pour l\'instant');
    });
    form.addEventListener('input', App.debounce(() => {
      const v = {
        monthly: Calc.parseNumber(form.monthly.value, true),
        rate: Calc.parseNumber(form.rate.value, true),
        years: Calc.parseNumber(form.years.value, true),
        initial: Calc.parseNumber(form.initial.value, true),
        ter: Calc.parseNumber(form.ter.value, true),
      };
      // On ignore les saisies incomplètes / invalides
      if (Object.values(v).some((x) => !Number.isFinite(x)) || v.years > 80 || v.years < 0 || v.monthly < 0 || v.initial < 0) return;
      App.state.sim = v;
      App.persist();
      App.renderSimulator();
      App.renderSimChart();
    }, 200));
  },

  simResult() {
    const s = App.state.sim;
    return Calc.simulate({ monthly: s.monthly, annualRate: s.rate, years: s.years, initial: s.initial, ter: s.ter });
  },

  renderSimulator() {
    const r = App.simResult();
    document.getElementById('sim-final').textContent = Fmt.eur0(r.final);
    document.getElementById('sim-invested').textContent = Fmt.eur0(r.invested);
    const g = document.getElementById('sim-gains');
    g.textContent = Fmt.eur0(r.gains);
    const investedShare = r.final > 0 ? Math.min(r.invested / r.final, 1) : 1;
    document.getElementById('sim-bar-invested').style.width = (investedShare * 100) + '%';
    document.getElementById('sim-bar-gains').style.width = (Math.max(1 - investedShare, 0) * 100) + '%';
    document.getElementById('sim-share').textContent = r.gains >= 0
      ? `Les gains représentent ${Fmt.pct(r.gainsShare)} du capital final (×${Fmt.num(Math.round((r.final / (r.invested || 1)) * 100) / 100)} vos versements).`
      : 'Rendement net négatif : le capital final est inférieur aux versements.';
  },

  renderSimChart() {
    const el = document.getElementById('chart-sim');
    if (el.offsetParent === null) return;
    const r = App.simResult();
    // Un point par an (plus lisible et léger) + le dernier mois
    const pts = r.points.filter((p, i) => p.month % 12 === 0 || i === r.points.length - 1);
    if (pts.length < 2) { drawChart(el, { xs: [], series: [], xLabel: String, yFormat: Fmt.eur, emptyText: 'Indiquez une durée' }); return; }
    drawChart(el, {
      xs: pts.map((p) => p.month / 12),
      series: [
        { name: 'Versé', color: '--series-invested', values: pts.map((p) => p.invested), area: true },
        { name: 'Gains', color: '--series-gains', values: pts.map((p) => Math.max(p.value - p.invested, 0)), area: true },
      ],
      stacked: true,
      xLabel: (x) => `${Math.round(x * 10) / 10} an${x >= 2 ? 's' : ''}`,
      tooltipTitle: (x) => `Après ${Math.round(x * 10) / 10} an${x >= 2 ? 's' : ''}`,
      tooltipRows: (i) => [
        { name: 'Capital', value: Fmt.eur0(pts[i].value) },
        { name: 'Versé', color: '--series-invested', value: Fmt.eur0(pts[i].invested) },
        { name: 'Gains', color: '--series-gains', value: Fmt.eur0(pts[i].value - pts[i].invested) },
      ],
      yFormat: Fmt.eur0,
    });
  },

  /* ---------- PEA : 5 ans, plafond, sauvegarde, thème ---------- */
  bindPea() {
    const od = document.getElementById('opening-date');
    od.value = App.state.openingDate;
    od.addEventListener('change', () => {
      if (!Dates.isValidISO(od.value)) return;
      App.state.openingDate = od.value;
      App.persist();
      App.renderPea();
    });

    // Versements
    const df = document.getElementById('deposit-form');
    df.date.value = Dates.today();
    df.addEventListener('submit', (e) => {
      e.preventDefault();
      const amount = Calc.parseNumber(df.amount.value);
      const err = document.getElementById('deposit-error');
      if (!Dates.isValidISO(df.date.value) || !(amount > 0)) {
        err.textContent = 'Date ou montant invalide.';
        err.hidden = false;
        return;
      }
      err.hidden = true;
      App.state.deposits.push({ id: Store.newId(), date: df.date.value, amount });
      App.persist();
      df.amount.value = '';
      App.renderAll();
      App.toast('Versement ajouté');
    });

    document.getElementById('btn-export').addEventListener('click', App.exportJSON);
    document.getElementById('import-file').addEventListener('change', App.importJSON);
    document.getElementById('btn-theme').addEventListener('click', () => {
      App.state.theme = App.state.theme === 'dark' ? 'light' : 'dark';
      App.persist();
      App.applyTheme();
      App.renderCharts();
    });
  },

  applyTheme() {
    const theme = App.state.theme;
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name=theme-color]').setAttribute('content', theme === 'dark' ? '#0d0d0d' : '#f9f9f7');
    document.getElementById('btn-theme').textContent = theme === 'dark' ? 'Passer en thème clair' : 'Passer en thème sombre';
  },

  renderPea() {
    const c = Calc.peaCountdown(App.state.openingDate);
    const rem = c.remaining;
    const parts = [];
    if (rem.years) parts.push(`${rem.years} an${rem.years > 1 ? 's' : ''}`);
    if (rem.months) parts.push(`${rem.months} mois`);
    if (rem.days || !parts.length) parts.push(`${rem.days} jour${rem.days > 1 ? 's' : ''}`);
    document.getElementById('pea-remaining').textContent = c.reached ? '✓ 5 ans atteints' : parts.join(' ');
    document.getElementById('pea-date').textContent = c.reached
      ? `Depuis le ${Fmt.date(c.targetISO)} : gains exonérés d'impôt sur le revenu (prélèvements sociaux dus).`
      : `Échéance le ${Fmt.date(c.targetISO)} (${Fmt.num(c.daysLeft)} jours). ${Fmt.pct(c.progress)} du chemin.`;
    document.getElementById('pea-gauge-time').style.width = (c.progress * 100) + '%';

    const dep = Calc.deposits(App.state.deposits, App.state.purchases);
    const ce = Calc.ceiling(dep.base);
    document.getElementById('pea-ceiling-source').textContent = dep.hasDeposits
      ? 'Calculé sur vos versements.'
      : 'Estimé à partir de vos achats (frais inclus) : ajoutez vos versements pour un calcul exact.';
    App.renderDeposits();
    document.getElementById('pea-ceiling').textContent = `${Fmt.eur0(ce.used)} / ${Fmt.eur0(PEA_CEILING)}`;
    document.getElementById('pea-gauge-ceiling').style.width = Math.max(ce.progress * 100, ce.used > 0 ? 1 : 0) + '%';
    document.getElementById('pea-ceiling-left').textContent = `Encore ${Fmt.eur0(ce.remaining)} de versements possibles (${Fmt.pct(ce.progress)} utilisé).`;
  },

  renderDeposits() {
    const list = document.getElementById('deposit-list');
    list.replaceChildren();
    const sorted = App.state.deposits.slice().sort((a, b) => b.date.localeCompare(a.date));
    for (const d of sorted) {
      const row = document.createElement('div');
      row.className = 'deposit';
      const date = document.createElement('span');
      date.textContent = Fmt.date(d.date);
      const amount = document.createElement('b');
      amount.textContent = Fmt.eur(d.amount);
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn btn-danger';
      del.setAttribute('aria-label', `Supprimer le versement du ${Fmt.date(d.date)}`);
      del.textContent = '✕';
      del.addEventListener('click', () => {
        if (!confirm(`Supprimer le versement de ${Fmt.eur(d.amount)} du ${Fmt.date(d.date)} ?`)) return;
        App.state.deposits = App.state.deposits.filter((x) => x.id !== d.id);
        App.persist();
        App.renderAll();
      });
      row.append(date, amount, del);
      list.appendChild(row);
    }
  },

  exportJSON() {
    App.state.lastExport = Dates.today();
    App.persist();
    App.renderDashboard();
    const blob = new Blob([JSON.stringify(App.state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `suivi-pea-${Dates.today()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },

  importJSON(e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = Store.sanitize(JSON.parse(reader.result));
        if (!confirm(`Remplacer les données actuelles par cette sauvegarde (${data.purchases.length} achat(s)) ?`)) return;
        App.state = data;
        App.persist();
        document.getElementById('opening-date').value = data.openingDate;
        App.applyTheme();
        App.bindSimulatorValues();
        App.renderAll();
        App.toast('Sauvegarde importée');
      } catch (err) {
        alert('Import impossible : ' + err.message);
      }
    };
    reader.readAsText(file);
  },

  /** Recharge les champs du simulateur après un import. */
  bindSimulatorValues() {
    const form = document.getElementById('sim-form');
    const s = App.state.sim;
    for (const k of ['monthly', 'rate', 'years', 'initial', 'ter']) form[k].value = Fmt.input(s[k]);
  },
};

/* ---------- Démarrage (navigateur) / export (tests Node) ---------- */
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', App.init);
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Calc, Dates, Fmt, Store, PEA_CEILING, APP_VERSION, parsePricesFile, mergeQuotes, priceUrls };
}
