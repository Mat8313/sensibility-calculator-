/**
 * optimizer.js — Score global, tendance (trop lent / trop rapide) et
 * recherche itérative de la sensibilité optimale.
 *
 * Module PUR (aucune dépendance au DOM) : testable sous Node (voir tests/).
 *
 * Pourquoi travailler en ÉCHELLE LOGARITHMIQUE ?
 * La perception d'une sensibilité est relative : passer de 100 à 150 °/s
 * se ressent autant que passer de 400 à 600 °/s (+50 % dans les deux cas).
 * En log, un "pas" a donc la même signification partout dans la plage.
 */

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ------------------------------------------------------------------ */
/* 1. Scores par test (0–100)                                          */
/* ------------------------------------------------------------------ */

/** Tracking : temps sur cible (60 %) + erreur moyenne (40 %). */
export function trackingScore(m) {
  if (!m) return 0;
  return 100 * (0.6 * m.onTargetRatio + 0.4 * Math.exp(-m.meanError / 4));
}

/** Flicks : vitesse d'acquisition, pénalisée par dépassements, ratés et cibles manquées. */
export function flickScore(m) {
  if (!m || m.hits === 0) return 0;
  const speed = Math.exp(-Math.max(0, m.avgHitTime - 0.35) / 1.1);
  const control = 1 - 0.08 * Math.min(5, m.overshootRate + 0.5 * m.correctionRate);
  const accuracy = 1 - 0.5 * m.missRate;
  const completion = m.hits / (m.hits + m.timeouts);
  return 100 * speed * control * accuracy * completion;
}

/** Précision : taux de réussite, stabilisation, erreur au tir, rapidité. */
export function precisionScore(m) {
  if (!m || m.shots === 0) return 0;
  return 100 * (
    0.45 * m.accuracy +
    0.20 * Math.exp(-m.avgStabTime / 0.6) +
    0.15 * Math.exp(-m.avgShotError / 0.4) +
    0.20 * Math.exp(-Math.max(0, m.avgTimeToShot - 0.5) / 1.5)
  );
}

export const SCORE_WEIGHTS = Object.freeze({ tracking: 0.35, flick: 0.35, precision: 0.30 });

/**
 * Score global pondéré d'une série (tracking + flicks + précision).
 * @param {{tracking?:object, flick?:object, precision?:object}} series
 */
export function computeScore(series) {
  const parts = {
    tracking: trackingScore(series.tracking),
    flick: flickScore(series.flick),
    precision: precisionScore(series.precision),
  };
  const total =
    SCORE_WEIGHTS.tracking * parts.tracking +
    SCORE_WEIGHTS.flick * parts.flick +
    SCORE_WEIGHTS.precision * parts.precision;
  return { total: Math.round(total * 10) / 10, parts };
}

/* ------------------------------------------------------------------ */
/* 2. Tendance : faut-il monter ou baisser ?                           */
/* ------------------------------------------------------------------ */

/**
 * Tendance dans [-1, 1] : > 0 → sensibilité trop basse (augmenter),
 * < 0 → trop haute (baisser). Combine plusieurs signaux indépendants pour
 * qu'un seul test raté ne fasse pas basculer la décision.
 *
 * - Retard en tracking (leadLag > 0 : la caméra est derrière la cible) → augmenter
 * - Saturation du stick en flick (stick souvent à fond) → augmenter
 * - Dépassements (overshoot) en flick et en précision → baisser
 * - Arrêts avant la cible (undershoot) → augmenter
 */
/**
 * Seuils "neutres" des signaux. Ce sont des hypothèses raisonnables, pas des
 * vérités : si l'algo te pousse toujours dans le même sens, c'est ici qu'on règle.
 */
export const TENDENCY_TUNING = Object.freeze({
  lagScale: 0.15,        // 15 % du temps "derrière la cible stick à fond" = signal maximal
  utilNeutral: 0.6,      // utilisation moyenne attendue en flick à la bonne sensibilité
  utilScale: 0.25,
  overshootNeutral: 0.3, // dépassements par cible considérés comme normaux
  overshootScale: 0.7,
  undershootNeutral: 0.3,
  undershootScale: 0.7,
});

export function computeTendency(series) {
  const K = TENDENCY_TUNING;
  const signals = [];
  const t = series.tracking, f = series.flick, p = series.precision;

  // Le retard brut est biaisé (temps de réaction humain) : on ne compte que le
  // retard quand le stick est à fond, seul cas où la sensibilité est en cause.
  if (t) signals.push({ key: 'lag', w: 0.25, v: clamp(t.satLagRatio / K.lagScale, 0, 1) });
  if (f) {
    if (f.utilization !== null && f.utilization !== undefined) {
      signals.push({ key: 'utilization', w: 0.30, v: clamp((f.utilization - K.utilNeutral) / K.utilScale, -1, 1) });
    }
    signals.push({ key: 'undershoot', w: 0.10, v: clamp((f.undershootRate - K.undershootNeutral) / K.undershootScale, -1, 1) });
  }
  const overs = [f?.overshootRate, p?.overshootRate].filter((x) => x !== undefined);
  if (overs.length) {
    const avg = overs.reduce((a, b) => a + b, 0) / overs.length;
    signals.push({ key: 'overshoot', w: 0.35, v: -clamp((avg - K.overshootNeutral) / K.overshootScale, -1, 1) });
  }
  const wSum = signals.reduce((a, s) => a + s.w, 0) || 1;
  const value = clamp(signals.reduce((a, s) => a + s.w * s.v, 0) / wSum, -1, 1);
  return { value: Math.round(value * 1000) / 1000, signals };
}

/** Phrase explicative de la tendance, pour l'interface. */
export function describeTendency(tendency) {
  const v = tendency.value;
  const main = [...tendency.signals].sort((a, b) => Math.abs(b.w * b.v) - Math.abs(a.w * a.v))[0];
  const reasons = {
    lag: v > 0 ? 'en tracking, tu es en retard même stick à fond' : 'aucun retard en tracking',
    utilization: v > 0 ? 'en flick, ton stick est presque toujours à fond' : 'en flick, tu n\'utilises qu\'une partie de l\'amplitude du stick',
    undershoot: v > 0 ? 'tu t\'arrêtes avant la cible' : 'peu d\'arrêts avant la cible',
    overshoot: v < 0 ? 'tu dépasses souvent la cible' : 'peu de dépassements',
  };
  const why = main ? reasons[main.key] : '';
  if (v > 0.12) return `Trop lent → on augmente (${why}).`;
  if (v < -0.12) return `Trop rapide → on baisse (${why}).`;
  return 'Équilibré → on affine autour de cette valeur.';
}

/* ------------------------------------------------------------------ */
/* 3. Régression quadratique (moindres carrés)                          */
/* ------------------------------------------------------------------ */

/**
 * Ajuste y = a·u² + b·u + c (u centré pour la stabilité numérique).
 * Retourne null si moins de 3 abscisses distinctes ou système singulier.
 */
export function fitQuadratic(points) {
  const distinct = new Set(points.map((p) => p.u.toFixed(4)));
  if (distinct.size < 3) return null;
  const n = points.length;
  const mean = points.reduce((s, p) => s + p.u, 0) / n;
  // Sommes pour les équations normales
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0;
  for (const p of points) {
    const x = p.u - mean, y = p.y;
    s0 += 1; s1 += x; s2 += x * x; s3 += x ** 3; s4 += x ** 4;
    t0 += y; t1 += x * y; t2 += x * x * y;
  }
  // Système [s4 s3 s2; s3 s2 s1; s2 s1 s0] · [a b c] = [t2 t1 t0] (Cramer)
  const det3 = (m) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const M = [[s4, s3, s2], [s3, s2, s1], [s2, s1, s0]];
  const D = det3(M);
  if (Math.abs(D) < 1e-12) return null;
  const R = [t2, t1, t0];
  const col = (k) => M.map((row, i) => row.map((v, j) => (j === k ? R[i] : v)));
  const a = det3(col(0)) / D, b = det3(col(1)) / D, c = det3(col(2)) / D;
  return {
    a, b, c, mean,
    concave: a < 0,
    vertex: a < 0 ? mean - b / (2 * a) : null,          // en u (non centré)
    predict: (u) => a * (u - mean) ** 2 + b * (u - mean) + c,
  };
}

/**
 * Zéro de la régression linéaire tendance = α + β·u.
 * Retourne null si la pente n'est pas négative (tendance incohérente :
 * plus on monte, plus les signaux devraient dire "baisse").
 */
export function tendencyRoot(history) {
  const n = history.length;
  if (n < 2) return null;
  const mu = history.reduce((s, h) => s + h.u, 0) / n;
  const mt = history.reduce((s, h) => s + h.tendency, 0) / n;
  let sxy = 0, sxx = 0;
  for (const h of history) { sxy += (h.u - mu) * (h.tendency - mt); sxx += (h.u - mu) ** 2; }
  if (sxx < 1e-9) return null;
  const beta = sxy / sxx;
  if (beta >= 0) return null;
  return mu - mt / beta;
}

/* ------------------------------------------------------------------ */
/* 4. Optimiseur : dichotomie pondérée + modèle quadratique            */
/* ------------------------------------------------------------------ */

/**
 * Principe :
 * 1. La TENDANCE donne la direction (monter/baisser) et son intensité module
 *    la longueur du pas ("dichotomie pondérée").
 * 2. Quand la direction s'inverse, on a encadré l'optimum : le pas est divisé
 *    par 2, comme une dichotomie classique.
 * 3. Dès 3 points, une parabole score = f(log sens) est ajustée ; si elle est
 *    concave, son sommet attire la prochaine valeur (moyenne avec la direction).
 *    C'est une version très simplifiée de l'optimisation bayésienne : un modèle
 *    de substitution guide l'échantillonnage.
 * 4. Arrêt : entre minIter et maxIter, quand le pas devient < 6 %.
 */
export class SensOptimizer {
  constructor({ min = 90, max = 900, start = 300, minIter = 5, maxIter = 8, initialStep = 1.45 } = {}) {
    this.min = min;
    this.max = max;
    this.minIter = minIter;
    this.maxIter = maxIter;
    this.u = Math.log(start);
    this.step = Math.log(initialStep);  // pas initial : ×1,45
    this.prevDir = 0;
    /** @type {{sens:number, u:number, score:number, tendency:number}[]} */
    this.history = [];
    this.done = false;
  }

  /** Sensibilité (°/s) à tester maintenant, arrondie à l'unité. */
  get current() { return Math.round(Math.exp(this.u)); }

  get iteration() { return this.history.length; }

  /**
   * Enregistre le résultat de la série courante et calcule la suivante.
   * @param {number} score    score global 0–100
   * @param {number} tendency [-1, 1], > 0 = augmenter
   */
  report(score, tendency) {
    if (this.done) return { done: true, next: null };
    const u = Math.log(this.current);
    this.history.push({ sens: this.current, u, score, tendency });

    const dir = Math.abs(tendency) < 0.12 ? 0 : Math.sign(tendency);
    if (dir === 0) this.step *= 0.7;                                  // zone "équilibrée" : on resserre
    else if (this.prevDir !== 0 && dir !== this.prevDir) this.step *= 0.5;  // inversion : optimum encadré
    if (dir !== 0) this.prevDir = dir;

    // Pas pondéré par l'intensité de la tendance (entre 50 % et 100 % du pas)
    let candidate = u + dir * this.step * (0.5 + 0.5 * Math.min(1, Math.abs(tendency) / 0.5));

    const us = this.history.map((h) => h.u);
    const quad = fitQuadratic(this.history.map((h) => ({ u: h.u, y: h.score })));
    if (quad && quad.concave) {
      const v = clamp(quad.vertex, Math.min(...us) - this.step, Math.max(...us) + this.step);
      candidate = dir === 0 ? v : 0.5 * candidate + 0.5 * v;
    } else if (dir === 0) {
      // Pas de direction ni de modèle : sans exploration, on retesterait la même
      // valeur indéfiniment. On sonde le côté qui manque de points.
      const hasAbove = us.some((x) => x > u + this.step / 2);
      const hasBelow = us.some((x) => x < u - this.step / 2);
      const side = !hasAbove ? 1 : !hasBelow ? -1 : (this.history.length % 2 ? 1 : -1);
      candidate = u + side * this.step;
    }

    this.u = clamp(candidate, Math.log(this.min), Math.log(this.max));

    const n = this.history.length;
    this.done = n >= this.maxIter || (n >= this.minIter && this.step < Math.log(1.06));
    return { done: this.done, next: this.done ? null : this.current };
  }

  /**
   * Meilleure estimation : sommet de la parabole s'il tombe DANS la plage
   * testée (pas d'extrapolation hasardeuse), sinon meilleur point observé.
   */
  bestEstimate() {
    if (!this.history.length) return this.current;
    const us = this.history.map((h) => h.u);
    const lo = Math.min(...us), hi = Math.max(...us);
    const inRange = (u) => u !== null && u >= lo && u <= hi;
    const estimates = [];

    // Estimateur 1 : sommet de la parabole des scores
    const quad = fitQuadratic(this.history.map((h) => ({ u: h.u, y: h.score })));
    if (quad && quad.concave && inRange(quad.vertex)) estimates.push(quad.vertex);

    // Estimateur 2 : zéro de la tendance (régression linéaire tendance = α + β·u)
    const root = tendencyRoot(this.history);
    if (inRange(root)) estimates.push(root);

    // Moyenner deux estimateurs dont les erreurs sont peu corrélées réduit le bruit.
    if (estimates.length) {
      return Math.round(Math.exp(estimates.reduce((a, b) => a + b, 0) / estimates.length));
    }
    return this.history.reduce((a, b) => (b.score > a.score ? b : a)).sens;
  }

  /**
   * Valeurs du test de validation : meilleure valeur et deux voisines (±10 %),
   * dans un ordre aléatoire pour éviter le biais "je sais laquelle est la bonne".
   */
  validationSet(rng = Math.random) {
    const best = this.bestEstimate();
    const set = [
      { role: 'basse', sens: Math.round(clamp(best / 1.1, this.min, this.max)) },
      { role: 'meilleure', sens: best },
      { role: 'haute', sens: Math.round(clamp(best * 1.1, this.min, this.max)) },
    ];
    for (let i = set.length - 1; i > 0; i--) {            // Fisher–Yates
      const j = Math.floor(rng() * (i + 1));
      [set[i], set[j]] = [set[j], set[i]];
    }
    return set;
  }

  toJSON() {
    return {
      min: this.min, max: this.max, minIter: this.minIter, maxIter: this.maxIter,
      u: this.u, step: this.step, prevDir: this.prevDir, history: this.history, done: this.done,
    };
  }

  static fromJSON(o) {
    const opt = new SensOptimizer({ min: o.min, max: o.max, minIter: o.minIter, maxIter: o.maxIter });
    Object.assign(opt, { u: o.u, step: o.step, prevDir: o.prevDir, history: o.history, done: o.done });
    return opt;
  }
}

/**
 * Choix final après validation : la valeur qui obtient le meilleur score.
 * En cas de quasi-égalité (< 2 points), on garde la "meilleure" estimée,
 * car un écart aussi faible est dans le bruit de mesure.
 */
export function pickValidated(results) {
  const sorted = [...results].sort((a, b) => b.score - a.score);
  const estimated = results.find((r) => r.role === 'meilleure');
  if (estimated && sorted[0].score - estimated.score < 2) return estimated;
  return sorted[0];
}
