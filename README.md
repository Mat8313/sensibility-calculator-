# SensiLab 🎯

Trouve ta **sensibilité manette optimale** (DualSense en USB sur PC) grâce à des tests de visée répétés, puis convertis-la pour **Call of Duty**, **Fortnite**, **Apex Legends**… et n'importe quel jeu ajouté dans `data/games.json`.

Application 100 % statique (HTML / CSS / JavaScript vanilla, modules ES), sans backend. Toutes les données restent dans ton navigateur (`localStorage`).

---

## Démarrage rapide

```bash
# Les modules ES et fetch('data/games.json') ne fonctionnent PAS en file:// → il faut un serveur HTTP
python3 -m http.server 8000
# puis ouvre http://localhost:8000 dans Chrome ou Edge
```

1. Branche la manette en USB, appuie sur un bouton (le navigateur n'expose la manette qu'après un appui).
2. Mesure la zone morte (stick droit au repos pendant 3 s).
3. Lance une **Nouvelle session** : 5 à 8 séries de 3 tests + 3 séries de validation (~10 min).
4. Lis les réglages recommandés par jeu, puis **calibre** tes jeux pour fiabiliser la conversion.

Navigation : **✕** valider · **◯** retour · croix directionnelle / stick gauche pour se déplacer. Clavier et souris fonctionnent aussi (Échap = retour).

Options d'URL : `?rapide` raccourcit les tests (5–6 s, pour développer) · `?debug` expose `window.sensilab` dans la console.

## Déploiement sur GitHub Pages

1. Pousse le dépôt sur GitHub (les fichiers sont à la racine : `index.html`, `css/`, `js/`, `data/`).
2. **Settings → Pages → Build and deployment → Source : Deploy from a branch**.
3. Choisis la branche (`main`) et le dossier **`/ (root)`**, puis **Save**.
4. Après ~1 min, l'app est en ligne sur `https://<ton-pseudo>.github.io/<nom-du-repo>/`.

Le fichier `.nojekyll` désactive le traitement Jekyll (inutile ici). Tous les chemins sont **relatifs** (`js/app.js`, `data/games.json`), donc l'app fonctionne dans un sous-dossier `/<nom-du-repo>/` sans configuration.

> ⚠️ `localStorage` est partagé par **origine** : tous tes projets sur `<pseudo>.github.io` partagent le même espace. C'est pour ça que toutes les clés sont préfixées `sensilab:`.

## Architecture

```
index.html          écrans (sections .screen), un seul point d'entrée JS
css/style.css       thème sombre, variables CSS, responsive
data/games.json     tables réglage → °/s par jeu (extensible)
js/
  app.js            boucle principale + enchaînement des écrans (orchestration)
  gamepad.js        API Gamepad : poll par frame, fronts montants, zone morte radiale, analyse du drift
  tests.js          caméra FPS simulée, rendu canvas, tests Tracking / Flicks / Précision, SeriesRunner
  optimizer.js      scores, tendance (trop lent / trop rapide), optimiseur itératif   ← pur, testé sous Node
  conversion.js     interpolation °/s ↔ réglage, calibration, fusion des tables        ← pur, testé sous Node
  storage.js        localStorage, import / export JSON
  ui.js             gestion des écrans, navigation manette, graphiques canvas
tests/              tests Node (node --test) : optimiseur, conversion, zone morte, bot qui joue les vrais tests
```

**Une seule boucle `requestAnimationFrame`** dans `app.js` appelle `gamepad.poll()` une fois par frame, puis distribue l'état. L'API Gamepad ne pousse pas d'événements d'axes : si chaque module sondait la manette de son côté, les fronts « vient d'être pressé » seraient consommés de façon incohérente.

La logique (optimiseur, conversion, mesures) est **séparée du DOM** : c'est ce qui permet de la tester sous Node.

```bash
npm test     # = node --test tests/*.test.js
```

## La méthode

### 1. Sensibilité interne : °/s stick à fond

La caméra simulée tourne à `stick × sens` degrés par seconde (réponse linéaire, après zone morte radiale). On compare les jeux **à stick à fond** : c'est la seule grandeur mesurable simplement (un chrono sur 360°) et elle ne dépend pas de la courbe de réponse, qui ne change que les petites inclinaisons.

### 2. Les tests (vue FPS, champ de vision 90°)

| Test | Durée | Mesures |
|---|---|---|
| **Tracking** | 15 s | % du temps sur la cible, erreur moyenne (°), retard *stick à fond* |
| **Flicks** | 30 s | temps pour toucher (R2), dépassements, corrections, arrêts avant la cible, utilisation du stick, tirs ratés |
| **Précision** | 30 s | réussite (1 tir par cible), temps de stabilisation, erreur au tir, dépassements |

La valeur testée n'est **jamais affichée pendant les tests**, et la validation se fait à l'aveugle : connaître la valeur biaise le joueur.

### 3. Score global et tendance

- **Score** (0–100) = 35 % tracking + 35 % flicks + 30 % précision.
- **Tendance** (−1 → +1) : *dépassements fréquents → baisser* ; *retard en tracking stick à fond, stick presque toujours à fond en flick, arrêts avant la cible → augmenter*.
  Le retard brut en tracking n'est **pas** utilisé : le temps de réaction humain (~150–200 ms) place toujours la caméra derrière la cible, ce qui pousserait toujours à augmenter. Les seuils sont regroupés dans `TENDENCY_TUNING` (`optimizer.js`).

### 4. Optimisation : dichotomie pondérée + modèle quadratique

Recherche en **échelle logarithmique** (passer de 100 à 150 °/s se ressent comme passer de 400 à 600 °/s), de 90 à 900 °/s, départ à 300 °/s :

1. La tendance donne la direction ; son intensité module la longueur du pas.
2. Si la direction s'inverse, l'optimum est encadré : pas ÷ 2 (dichotomie).
3. Dès 3 points, une parabole `score = f(log sens)` est ajustée par moindres carrés ; son sommet attire la valeur suivante (c'est une version très simplifiée de l'optimisation bayésienne, avec un modèle de substitution).
4. En zone neutre sans modèle exploitable, on explore le côté encore inconnu.
5. Arrêt entre 5 et 8 itérations, quand le pas devient inférieur à 6 %.

**Estimation finale** = moyenne de deux estimateurs indépendants : le sommet de la parabole et le zéro de la régression linéaire de la tendance. **Validation** : la meilleure valeur et ses voisines à ±10 %, dans un ordre aléatoire. On garde celle qui obtient le meilleur score, sauf quasi-égalité (< 2 points, c'est du bruit).

Sur un joueur simulé bruité, l'optimiseur tombe à ±15 % de l'optimum dans 97 % des cas (erreur moyenne ≈ 4 %), voir `tests/optimizer.test.js`.

### 5. Conversion et calibration

`data/games.json` décrit chaque jeu :

```json
{
  "id": "cod", "name": "Call of Duty", "calibrated": false,
  "setting":  { "label": "Sensibilité stick horizontale", "min": 1, "max": 20, "step": 0.1, "default": 6 },
  "deadzone": { "label": "Zone morte min.", "min": 0, "max": 99, "step": 1, "unit": "%", "default": 5 },
  "responseCurve": { "type": "dynamic", "label": "…", "note": "…" },
  "table": [ { "setting": 1, "degPerSec": 40 }, { "setting": 20, "degPerSec": 500 } ]
}
```

> ⚠️ **Toutes les tables fournies sont des estimations marquées « À CALIBRER ».** Calibre tes jeux avant de te fier aux réglages.

On passe des °/s au réglage par **interpolation linéaire inverse** entre les points de la table, puis on arrondit au pas du jeu. L'app affiche la vitesse réellement obtenue et l'écart.

**Mode Calibration**, pour chaque mesure :
1. Dans le jeu, choisis un réglage, pousse le stick droit à fond.
2. Démarre le chrono au **premier passage** d'un repère, une fois la rotation lancée (ça exclut l'accélération de départ), puis compte 3 à 5 tours.
3. Saisis réglage, nombre de tours et durée : °/s = 360 × tours / durée.

Le navigateur ne lit pas la manette quand le jeu a le focus : chronomètre avec ton téléphone ou filme l'écran. Désactive aussi les « boosts de rotation » pendant la mesure.

Fusion des mesures : 1 mesure → la table estimée est **mise à l'échelle** pour passer par ce point ; 2 mesures ou plus → seules tes mesures sont utilisées. Mesure par exemple le réglage minimum, le défaut et un réglage élevé. Tout se sauvegarde en `localStorage` et s'exporte ou s'importe en JSON.

### Ajouter un jeu

Ajoute un objet dans `data/games.json` (au moins 2 points dans `table`, croissants). Il apparaît automatiquement dans les résultats et la calibration.

## Compatibilité

- **Chrome / Edge** recommandés : DualSense USB en `mapping: "standard"`. Firefox peut renvoyer un mapping non standard (un avertissement s'affiche).
- La zone morte de l'app est radiale. La zone morte conseillée pour le jeu (mesure + 1 %) n'est qu'un point de départ, car chaque jeu la calcule à sa façon.
