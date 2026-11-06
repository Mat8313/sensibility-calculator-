// Tests de l'optimiseur avec un joueur simulé dont on connaît l'optimum.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SensOptimizer, fitQuadratic, computeScore, computeTendency, pickValidated } from '../js/optimizer.js';

/** Générateur pseudo-aléatoire déterministe (mulberry32) : tests reproductibles. */
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());

/** Joueur simulé : score parabolique en log, tendance proportionnelle à l'écart. */
function simulate(target, seed, noise = 3) {
  const r = rng(seed);
  const opt = new SensOptimizer();
  while (!opt.done) {
    const d = Math.log(opt.current / target);
    const score = 85 - 60 * d * d + noise * gauss(r);
    const tendency = Math.max(-1, Math.min(1, -1.5 * d + 0.12 * gauss(r)));
    opt.report(score, tendency);
  }
  return opt;
}

test('fitQuadratic retrouve une parabole exacte', () => {
  const pts = [-1, 0, 1, 2].map((u) => ({ u, y: -2 * (u - 0.5) ** 2 + 3 }));
  const q = fitQuadratic(pts);
  assert.ok(q.concave);
  assert.ok(Math.abs(q.vertex - 0.5) < 1e-9);
});

test('fitQuadratic refuse moins de 3 abscisses distinctes', () => {
  assert.equal(fitQuadratic([{ u: 1, y: 1 }, { u: 1, y: 2 }, { u: 2, y: 3 }]), null);
});

test('converge en 5 à 8 itérations', () => {
  for (let s = 1; s <= 50; s++) {
    const opt = simulate(150 + (s * 37) % 450, s);
    assert.ok(opt.iteration >= 5 && opt.iteration <= 8, `itérations = ${opt.iteration}`);
  }
});

test('estimation à ±15 % de l’optimum dans ≥ 90 % des cas (bruit réaliste)', () => {
  let ok = 0, n = 200, errs = [];
  for (let s = 1; s <= n; s++) {
    const target = 130 + ((s * 53) % 520);
    const best = simulate(target, s * 7).bestEstimate();
    const err = Math.abs(Math.log(best / target));
    errs.push(err);
    if (err < Math.log(1.15)) ok++;
  }
  const mean = errs.reduce((a, b) => a + b, 0) / n;
  console.log(`  réussite ${ok}/${n}, erreur moyenne ${(100 * (Math.exp(mean) - 1)).toFixed(1)} %`);
  assert.ok(ok / n >= 0.9);
});

test('reste dans les bornes', () => {
  const opt = simulate(2000, 3);          // optimum hors plage → plafonné à max
  assert.ok(opt.bestEstimate() <= 900);
  for (const h of opt.history) assert.ok(h.sens >= 90 && h.sens <= 900);
});

test('validationSet : meilleure valeur ± 10 %, ordre mélangé', () => {
  const opt = simulate(300, 11);
  const set = opt.validationSet(rng(1));
  const best = set.find((v) => v.role === 'meilleure').sens;
  assert.equal(set.length, 3);
  assert.ok(Math.abs(set.find((v) => v.role === 'haute').sens / best - 1.1) < 0.01);
});

test('pickValidated garde la meilleure estimée en cas de quasi-égalité', () => {
  const r = [{ role: 'basse', sens: 270, score: 71 }, { role: 'meilleure', sens: 300, score: 70 }, { role: 'haute', sens: 330, score: 60 }];
  assert.equal(pickValidated(r).sens, 300);
  r[0].score = 80;
  assert.equal(pickValidated(r).sens, 270);
});

test('tendance : overshoot → négatif, retard + saturation → positif', () => {
  const tooFast = computeTendency({
    tracking: { satLagRatio: 0, onTargetRatio: 0.4, meanError: 3 },
    flick: { utilization: 0.3, undershootRate: 0, overshootRate: 1.5 },
    precision: { overshootRate: 1.2 },
  });
  const tooSlow = computeTendency({
    tracking: { satLagRatio: 0.2, onTargetRatio: 0.4, meanError: 3 },
    flick: { utilization: 0.9, undershootRate: 1, overshootRate: 0.05 },
    precision: { overshootRate: 0 },
  });
  assert.ok(tooFast.value < -0.5, `trop rapide: ${tooFast.value}`);
  assert.ok(tooSlow.value > 0.5, `trop lent: ${tooSlow.value}`);
});

test('computeScore borné 0–100', () => {
  const perfect = computeScore({
    tracking: { onTargetRatio: 1, meanError: 0 },
    flick: { hits: 10, timeouts: 0, avgHitTime: 0.3, overshootRate: 0, correctionRate: 0, missRate: 0 },
    precision: { shots: 10, accuracy: 1, avgStabTime: 0, avgShotError: 0, avgTimeToShot: 0.4 },
  });
  assert.equal(perfect.total, 100);
  assert.equal(computeScore({}).total, 0);
});

test('zone neutre persistante : explore au lieu de retester la même valeur', () => {
  const opt = new SensOptimizer();
  while (!opt.done) opt.report(50 + Math.random(), -0.05);   // tendance toujours "équilibrée"
  const distinct = new Set(opt.history.map((h) => h.sens));
  assert.ok(distinct.size >= 3, `valeurs testées : ${[...distinct]}`);
});
