import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CURVES, applyCurve, gameCurve } from '../js/curves.js';

test('toutes les courbes : f(0)=0, f(1)=1, croissantes', () => {
  for (const [id, c] of Object.entries(CURVES)) {
    assert.equal(c.fn(0), 0, id);
    assert.equal(c.fn(1), 1, id);
    for (let m = 0.05; m <= 1; m += 0.05) assert.ok(c.fn(m) >= c.fn(m - 0.05), id);
  }
});

test('Dynamique CoD plus lente que le linéaire à mi-course', () => {
  assert.ok(CURVES['cod-dynamic'].fn(0.5) < 0.5);
  assert.equal(CURVES['cod-dynamic'].fn(0.5), 0.375);
});

test('applyCurve garde la direction et la vitesse à fond', () => {
  const d = applyCurve({ x: 0.3, y: 0.4 }, 'cod-standard'); // norme 0.5 → 0.25
  assert.ok(Math.abs(Math.hypot(d.x, d.y) - 0.25) < 1e-9);
  assert.ok(Math.abs(d.x / d.y - 0.75) < 1e-9);
  assert.equal(applyCurve({ x: 1, y: 0 }, 'cod-dynamic').x, 1);
  assert.deepEqual(applyCurve({ x: 0, y: 0 }, 'cod-dynamic'), { x: 0, y: 0, mag: 0 });
  assert.equal(applyCurve({ x: 0.5, y: 0 }, 'inconnue').x, 0.5); // repli linéaire
});

test('gameCurve lit games.json', () => {
  assert.equal(gameCurve({ responseCurve: { model: 'cod-dynamic' } }), 'cod-dynamic');
  assert.equal(gameCurve({ responseCurve: { type: 'classic' } }), null);
});
