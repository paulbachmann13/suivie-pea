# Suivi PEA

Petite PWA (HTML/CSS/JS vanilla, sans build) pour suivre un PEA en DCA :
achats, cours en direct (Euronext) et clôture quotidienne, plus-value, PRU, rendement annualisé (TRI),
courbe valeur / versements, calculateur « prochain achat », versements et cash,
simulateur d'intérêts composés (à partir de vos vrais chiffres, avec comparaison
« mon DCA réel vs l'hypothèse de rendement »), compteur des 5 ans et plafond de 150 000 €.
Les données restent **sur le téléphone** (localStorage) ; export/import JSON pour les sauvegarder.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | Structure des 4 onglets (Bilan, Achats, Simulateur, PEA) |
| `style.css` | Thème sombre (clair en option), mobile-first |
| `app.js` | Calculs, stockage, graphiques SVG, interface |
| `sw.js` | Service worker (hors ligne) |
| `tools/fetch-prices.js` | Récupère les cours (Yahoo Finance) → `data/prices.json` |
| `.github/workflows/prices.yml` | Lance ce script chaque soir de semaine |
| `tools/check-sources.js`, `tools/e2e-live.js` | Diagnostic des sources et test du site en ligne |
| `.github/workflows/diagnostic-cours.yml` | Diagnostic à la demande + chaque lundi (alerte e-mail) |
| `manifest.webmanifest`, `icons/` | Installation sur l'écran d'accueil |
| `tests/calc.test.js` | Tests des calculs |

## Activer GitHub Pages

1. Sur GitHub, ouvrez le dépôt → **Settings** → **Pages**.
2. *Build and deployment* → **Source : Deploy from a branch**.
3. Branche **`main`**, dossier **`/ (root)`** → **Save**.
4. Au bout d'une minute, l'appli est en ligne sur
   `https://<votre-pseudo>.github.io/suivie-pea/`.

> Pour un dépôt privé, GitHub Pages demande un compte payant : rendez le dépôt public
> (aucune donnée personnelle n'y est stockée, tout reste dans le navigateur).

## Installer sur iPhone

1. Ouvrez l'adresse GitHub Pages dans **Safari**.
2. Bouton **Partager** → **Sur l'écran d'accueil** → **Ajouter**.
3. Lancez « Suivi PEA » depuis l'icône : plein écran, fonctionne hors ligne.

## Tests

```bash
node --test tests/*.test.js
```

## Mettre à jour l'appli

Après une modification, incrémentez la version dans `app.js` (`APP_VERSION`),
dans `sw.js` (`VERSION`) **et** dans les `?v=` d'`index.html` (les tests vérifient qu'elles concordent) : les téléphones récupèrent alors la nouvelle version,
et le numéro affiché en haut de l'appli permet de vérifier qu'elle est à jour.

## Cours automatiques

L'appli combine trois sources, de la plus fraîche à la plus sûre :

1. **Euronext, en direct depuis le téléphone** : bouton « ↻ Actualiser le cours » sur chaque titre,
   ticker (`PSP5`) ou ISIN (`FR0011871128`). Pas de clé, pas de proxy : les points d'accès publics
   d'Euronext (recherche + historique CSV) autorisent les appels depuis une page web (CORS).
   Option « Actualiser les cours automatiquement » (onglet PEA → Réglages) : une fois par jour à l'ouverture.
2. **Clôture quotidienne via GitHub** : la GitHub Action « Cours des ETF » récupère chaque soir de
   semaine le cours de clôture et l'historique (Yahoo Finance) dans `data/prices.json`
   (graphique « Valeur et versements » + secours si Euronext ne répond pas).
3. **Saisie manuelle** : toujours possible, même après une récupération automatique.

Pourquoi pas Yahoo ou Stooq directement ? Testé en septembre 2026 : Yahoo refuse les appels depuis
une page web (pas d'en-tête CORS, erreurs 429), Stooq a supprimé son export CSV (404) et les proxys
CORS gratuits (corsproxy.io, allorigins, codetabs…) sont en panne ou demandent une clé payante.

### Limites

- Euronext ne publie pas de quota pour ces points d'accès (ce ne sont pas des API officielles) :
  l'appli n'envoie qu'1 à 2 requêtes par titre et par actualisation, l'une après l'autre.
  En cas d'abus, Euronext répond « 429 » ou « 403 » et l'appli l'affiche clairement.
- Le cours est celui de la dernière séance présente dans l'historique Euronext
  (la date de la séance est affichée à côté du prix, avec la date et l'heure de l'actualisation).
- GitHub Actions : gratuit et illimité pour un dépôt public.

### Si une source tombe en panne

- L'appli ne bloque jamais : le dernier cours connu est conservé, un message explique le problème,
  et la saisie manuelle reste disponible.
- **Diagnostic** : onglet **Actions** → **Diagnostic des cours** → **Run workflow**. Il teste Euronext
  (avec le code de l'appli), Yahoo, puis le site en ligne dans un vrai Chrome. Il tourne aussi
  chaque lundi soir : s'il échoue, GitHub vous envoie un e-mail.
- Réparer : tout le code Euronext est dans la section « 4 bis » de `app.js` (URL et lecture du CSV).
  Plan B si Euronext ferme l'accès : un petit proxy gratuit (Cloudflare Workers, 100 000 requêtes/jour,
  compte gratuit sans carte) qui relaie Yahoo Finance en ajoutant l'en-tête CORS.

Ajouter un ETF à la clôture quotidienne (graphique) : compléter `SYMBOLS` dans `tools/fetch-prices.js`
(ticker → symbole Yahoo, ex. `'PSP5': 'PSP5.PA'`).

Seuls des cours publics sont publiés : vos achats restent sur votre téléphone.
