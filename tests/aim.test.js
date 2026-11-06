// Test d'intégration : un bot "humain" joue les vrais tests de visée.
// Bot = contrôleur proportionnel avec temps de réaction + bruit moteur du pouce.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TrackingTest, FlickTest, PrecisionTest, wrapDeg } from '../js/tests.js';
import { computeScore, computeTendency, SensOptimizer } from '../js/optimizer.js';

const gauss = () => Math.sqrt(-2 * Math.log(Math.random() + 1e-12)) * Math.cos(2 * Math.PI * Math.random());

function makeBot(test, { gain = 7, delay = 0.15, noise = 0.05 } = {}) {
  const buf = [];             // erreurs perçues, retardées de `delay`
  let lastFire = false;
  return (dt) => {
    let target = null;
    if (test.targetAt) target = test.targetAt(test.t);
    else if (test.tracker) target = test.tracker.target;
    const e = target ? test.cam.errorTo(target) : { x: 0, y: 0 };
    buf.push({ t: test.t, e });
    while (buf.length > 1 && buf[1].t <= test.t - delay) buf.shift();
    const seen = buf[0].e;
    // Vitesse voulue ∝ erreur perçue, convertie en inclinaison de stick
    let sx = (seen.x * gain) / test.cam.sens, sy = -(seen.y * gain) / test.cam.sens;
    const m = Math.hypot(sx, sy);
    if (m > 1) { sx /= m; sy /= m; }
    // Bruit moteur proportionnel à l'inclinaison + tremblement de base
    sx += gauss() * (noise * Math.abs(sx) + 0.01); sy += gauss() * (noise * Math.abs(sy) + 0.01);
    const mag = Math.min(1, Math.hypot(sx, sy));
    const inside = test.tracker?.inside && !test.tracker?.over;
    const fire = !!inside && !lastFire && Math.random() < 0.25;
    lastFire = fire;
    return { stick: { x: sx, y: sy, mag }, fire };
  };
}

function runSeries(sens) {
  const out = {};
  for (const [k, T] of [['tracking', TrackingTest], ['flick', FlickTest], ['precision', PrecisionTest]]) {
    const t = new T(sens);
    const bot = makeBot(t);
    while (!t.done) t.step(1 / 60, bot(1 / 60));
    out[k] = t.results();
  }
  return out;
}

test('wrapDeg', () => {
  assert.equal(wrapDeg(190), -170);
  assert.equal(wrapDeg(-190), 170);
  assert.equal(wrapDeg(360), 0);
});

test('les métriques réagissent dans le bon sens', () => {
  const avg = (sens, fn, n = 4) => { let s = 0; for (let i = 0; i < n; i++) s += fn(runSeries(sens)); return s / n; };
  const lowUtil = avg(100, (r) => r.flick.utilization);
  const highUtil = avg(800, (r) => r.flick.utilization);
  const lowTend = avg(100, (r) => computeTendency(r).value);
  const highTend = avg(800, (r) => computeTendency(r).value);
  console.log(`  utilisation 100→${lowUtil.toFixed(2)} 800→${highUtil.toFixed(2)} | tendance 100→${lowTend.toFixed(2)} 800→${highTend.toFixed(2)}`);
  assert.ok(lowUtil > highUtil);
  assert.ok(lowTend > 0, 'à 100 °/s il faut augmenter');
  assert.ok(highTend < lowTend);
});

test('boucle complète : l’optimiseur trouve une valeur intermédiaire', () => {
  const scores = {};
  for (const s of [100, 200, 300, 450, 700]) scores[s] = computeScore(runSeries(s)).total.toFixed(1);
  console.log('  score par sens :', JSON.stringify(scores));
  const opt = new SensOptimizer();
  while (!opt.done) {
    const r = runSeries(opt.current);
    opt.report(computeScore(r).total, computeTendency(r).value);
  }
  console.log('  parcours :', opt.history.map((h) => `${h.sens}(${h.score.toFixed(0)}, ${h.tendency.toFixed(2)})`).join(' → '), '⇒', opt.bestEstimate());
  assert.ok(opt.iteration >= 5 && opt.iteration <= 8);
  assert.ok(opt.bestEstimate() > 100 && opt.bestEstimate() < 900);
});

test('SeriesRunner : la pause gèle le temps du test, ✕ reprend après un compte à rebours', async () => {
  const { SeriesRunner } = await import('../js/tests.js');
  const r = new SeriesRunner(300);
  const idle = { stick: { x: 0, y: 0, mag: 0 }, fire: false, confirm: false };
  r.frame(0.016, { ...idle, confirm: true });         // intro → countdown
  for (let i = 0; i < 200; i++) r.frame(0.016, idle);  // countdown → running
  assert.equal(r.phase, 'running');
  const t0 = r.test.t, yaw0 = r.test.cam.yaw;
  r.pause('Fenêtre quittée');
  // Stick figé à fond (état gelé par le navigateur) : ni le temps ni la caméra ne doivent bouger
  for (let i = 0; i < 100; i++) r.frame(0.016, { ...idle, stick: { x: 1, y: 0, mag: 1 } });
  assert.equal(r.test.t, t0);
  assert.equal(r.test.cam.yaw, yaw0);
  r.frame(0.016, { ...idle, confirm: true });
  assert.equal(r.phase, 'resuming');
  for (let i = 0; i < 130; i++) r.frame(0.016, idle);   // 2 s de reprise puis le test repart
  assert.equal(r.phase, 'running');
  assert.ok(r.test.t > t0);
});

test('SeriesRunner : pause pendant le compte à rebours → retour à l’intro', async () => {
  const { SeriesRunner } = await import('../js/tests.js');
  const r = new SeriesRunner(300);
  r.frame(0.016, { stick: { x: 0, y: 0, mag: 0 }, fire: false, confirm: true });
  r.pause();
  assert.equal(r.phase, 'intro');
});
