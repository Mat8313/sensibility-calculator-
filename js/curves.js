/**
 * curves.js — Courbes de réponse du stick, pour que les tests "ressentent" comme le jeu.
 *
 * Pourquoi : la conversion compare la vitesse STICK À FOND. Elle n'est juste que si
 * le test et le jeu transforment l'inclinaison de la même façon. Avec un test
 * linéaire et BO7 en Dynamique, à 50 % d'inclinaison BO7 tourne bien moins vite :
 * la valeur convertie paraît trop lente en jeu.
 *
 * Les formules des jeux ne sont pas publiées : ce sont des APPROXIMATIONS.
 * La "correction au ressenti" (conversion.js) rattrape l'écart restant.
 *
 * f : inclinaison [0, 1] (après zone morte) → fraction de la vitesse max [0, 1],
 * avec f(0) = 0 et f(1) = 1 : la vitesse à fond ne change pas, la table reste valable.
 */

export const CURVES = Object.freeze({
  linear: {
    label: 'Linéaire',
    // 1:1 — l'ancien comportement de SensiLab.
    fn: (m) => m,
  },
  'cod-dynamic': {
    label: 'CoD Dynamique (approx.)',
    // Activision : "hybride entre Standard et Linéaire". Moyenne des deux.
    fn: (m) => 0.5 * m + 0.5 * m * m,
  },
  'cod-standard': {
    label: 'CoD Standard (approx.)',
    // Activision : "simple courbe de puissance".
    fn: (m) => m * m,
  },
  'fortnite-exp': {
    label: 'Fortnite Exponentielle (approx.)',
    fn: (m) => m * m,
  },
});

export const CURVE_IDS = Object.keys(CURVES);
export const curveLabel = (id) => CURVES[id]?.label ?? CURVES.linear.label;

/**
 * Applique la courbe au vecteur du stick en gardant sa DIRECTION :
 * on ne transforme que la norme (sinon les diagonales seraient déformées).
 */
export function applyCurve(stick, id = 'linear') {
  const f = CURVES[id]?.fn ?? CURVES.linear.fn;
  const mag = Math.hypot(stick.x, stick.y);
  if (mag === 0) return { x: 0, y: 0, mag: 0 };
  const m = Math.min(1, mag);
  const k = f(m) / mag;
  return { x: stick.x * k, y: stick.y * k, mag: f(m) };
}

/** Courbe à proposer par défaut pour un jeu (champ responseCurve.model de games.json). */
export const gameCurve = (game) => (CURVES[game?.responseCurve?.model] ? game.responseCurve.model : null);
