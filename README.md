# Suivi PEA

Petite PWA (HTML/CSS/JS vanilla, sans build) pour suivre un PEA en DCA :
achats, cours automatique (clôture Euronext), plus-value, PRU, rendement annualisé (TRI),
courbe valeur / versements, calculateur « prochain achat », versements et cash,
simulateur d'intérêts composés, compteur des 5 ans et plafond de 150 000 €.
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

Après une modification, incrémentez la version dans `app.js` (`APP_VERSION`)
**et** dans `sw.js` (`VERSION`) : les téléphones récupèrent alors la nouvelle version,
et le numéro affiché en haut de l'appli permet de vérifier qu'elle est à jour.

## Cours automatiques

La GitHub Action **« Cours des ETF »** tourne chaque soir de semaine (vers 19 h 45, heure de Paris),
récupère le cours de clôture et l'historique sur 5 ans, et les enregistre dans `data/prices.json`.
L'appli lit ce fichier à l'ouverture. Un cours saisi à la main le jour même reste prioritaire.

- Premier lancement : onglet **Actions** du dépôt → **Cours des ETF** → **Run workflow**.
- Ajouter un ETF : compléter `SYMBOLS` dans `tools/fetch-prices.js` (ticker → symbole Yahoo, ex. `'PAEEM': 'PAEEM.PA'`).
- Autre source de cours : voir la section *Fournisseurs de cours* dans `app.js`.

Seuls des cours publics sont publiés : vos achats restent sur votre téléphone.
