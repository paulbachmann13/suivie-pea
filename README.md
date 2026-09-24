# Suivi PEA

Petite PWA (HTML/CSS/JS vanilla, sans build) pour suivre un PEA en DCA :
achats, cours actuel, plus-value, PRU, simulateur d'intérêts composés,
compteur des 5 ans et plafond de 150 000 €.
Les données restent **sur le téléphone** (localStorage) ; export/import JSON pour les sauvegarder.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | Structure des 4 onglets (Bilan, Achats, Simulateur, PEA) |
| `style.css` | Thème sombre (clair en option), mobile-first |
| `app.js` | Calculs, stockage, graphiques SVG, interface |
| `sw.js` | Service worker (hors ligne) |
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

Après une modification, incrémentez `CACHE` dans `sw.js` (`suivi-pea-v2`…)
pour que les téléphones récupèrent la nouvelle version.

## Brancher une API de cours

Voir la section *Fournisseurs de cours* dans `app.js` : ajoutez un objet
`{ id, label, auto: true, async getQuote(ticker) }` et pointez `ACTIVE_PROVIDER` dessus.
Un bouton « Actualiser les cours » apparaîtra automatiquement.
