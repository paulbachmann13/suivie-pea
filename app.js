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

const APP_VERSION = '1.0.0';
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
      prices: {},               // { TICKER: {price, date, source} }
      sim: { monthly: 100, rate: 7, years: 20, initial: 0, ter: 0.2 },
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
    const prices = {};
    for (const [t, q] of Object.entries(data.prices || {})) {
      if (q && Number(q.price) > 0) prices[Calc.normTicker(t)] = { price: Number(q.price), date: String(q.date || ''), source: q.source || 'manuel' };
    }
    return {
      version: 1,
      openingDate: Dates.isValidISO(data.openingDate) ? data.openingDate : def.openingDate,
      purchases,
      prices,
      sim: { ...def.sim, ...(data.sim || {}) },
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
   Pour brancher une API plus tard : créer un objet respectant l'interface
     { id, label, auto: true, async getQuote(ticker) → {price, date} | null }
   l'ajouter à PriceProviders puis changer ACTIVE_PROVIDER.
   Le bouton « Actualiser les cours » apparaît automatiquement si auto = true.
   ========================================================================== */
const PriceProviders = {
  manual: {
    id: 'manuel',
    label: 'Saisie manuelle',
    auto: false,
    async getQuote() { return null; },
  },

  /* Exemple (non actif) :
  monApi: {
    id: 'mon-api',
    label: 'Mon API de cours',
    auto: true,
    async getQuote(ticker) {
      const r = await fetch(`https://exemple.com/quote?symbol=${encodeURIComponent(ticker + '.PA')}`);
      if (!r.ok) return null;
      const j = await r.json();
      return { price: j.price, date: Dates.today() };
    },
  },
  */
};
const ACTIVE_PROVIDER = PriceProviders.manual;

/* ==========================================================================
   5. GRAPHIQUES SVG MAISON
   --------------------------------------------------------------------------
   drawChart(container, { xs, series, xLabel, yFormat, step, stacked })
     xs      : valeurs numériques de l'axe X (timestamps, mois…)
     series  : [{ name, color (variable CSS), values: [...] , area: bool }]
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
  const pathFor = (vals) => {
    let d = '';
    vals.forEach((v, i) => {
      const X = sx(xs[i]); const Y = sy(v);
      if (i === 0) d += `M${X},${Y}`;
      else if (step) d += `H${X}V${Y}`;
      else d += `L${X},${Y}`;
    });
    if (xs.length === 1) d += `H${W - m.right}`; // un seul point : ligne horizontale
    return d;
  };
  series.forEach((s, si) => {
    const line = pathFor(shown[si]);
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

  init() {
    App.state = Store.load();
    App.applyTheme();
    App.bindNavigation();
    App.bindPurchases();
    App.bindSimulator();
    App.bindPea();
    App.renderAll();
    window.addEventListener('resize', App.debounce(() => { App.renderCharts(); }, 150));
    document.getElementById('app-version').textContent = `Suivi PEA v${APP_VERSION} — cours : ${ACTIVE_PROVIDER.label.toLowerCase()}`;

    // Service worker : mode hors ligne
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW non enregistré', e));
    }
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
      card.querySelector('[data-f=quote]').textContent = pos.hasQuote
        ? `Cours mis à jour le ${Fmt.date(pos.quoteDate)}`
        : `Aucun cours saisi (dernier prix d'achat : ${Fmt.unitPrice(pos.lastPrice)})`;
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
      btn.addEventListener('click', App.refreshQuotes);
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

  /** Actualise tous les cours via le fournisseur actif (API future). */
  async refreshQuotes() {
    const tickers = Calc.portfolio(App.state.purchases).positions.map((p) => p.ticker);
    let ok = 0;
    for (const t of tickers) {
      try {
        const q = await ACTIVE_PROVIDER.getQuote(t);
        if (q && q.price > 0) { App.state.prices[t] = { ...q, source: ACTIVE_PROVIDER.id }; ok++; }
      } catch (e) { console.warn('Cours indisponible pour', t, e); }
    }
    App.persist();
    App.renderAll();
    App.toast(`${ok}/${tickers.length} cours actualisé(s)`);
  },

  renderCumulChart() {
    const el = document.getElementById('chart-cumul');
    if (el.offsetParent === null) return; // vue masquée
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

  openPurchase(p) {
    const form = document.getElementById('purchase-form');
    const last = App.state.purchases.slice().sort((a, b) => b.date.localeCompare(a.date))[0];
    form.id.value = p ? p.id : '';
    form.date.value = p ? p.date : Dates.today();
    form.ticker.value = p ? p.ticker : (last ? last.ticker : 'DCAM');
    form.qty.value = p ? Fmt.input(p.qty) : '';
    form.price.value = p ? Fmt.input(p.price) : '';
    form.fees.value = p ? Fmt.input(p.fees) : '';
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

  /* ---------- Simulateur ---------- */
  bindSimulator() {
    const form = document.getElementById('sim-form');
    App.bindSimulatorValues();
    form.addEventListener('submit', (e) => e.preventDefault());
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

    const invested = Calc.portfolio(App.state.purchases).invested;
    const ce = Calc.ceiling(invested);
    document.getElementById('pea-ceiling').textContent = `${Fmt.eur0(ce.used)} / ${Fmt.eur0(PEA_CEILING)}`;
    document.getElementById('pea-gauge-ceiling').style.width = Math.max(ce.progress * 100, ce.used > 0 ? 1 : 0) + '%';
    document.getElementById('pea-ceiling-left').textContent = `Encore ${Fmt.eur0(ce.remaining)} de versements possibles (${Fmt.pct(ce.progress)} utilisé).`;
  },

  exportJSON() {
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
  module.exports = { Calc, Dates, Fmt, Store, PEA_CEILING };
}
