import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRadialDeadzone, analyzeRestSamples } from '../js/gamepad.js';

test('zone morte : 0 sous le seuil, continu au-dessus, 1 à fond', () => {
  assert.equal(applyRadialDeadzone(0.03, 0.02, 0.05).mag, 0);
  assert.ok(applyRadialDeadzone(0.051, 0, 0.05).mag < 0.01);   // pas de saut en sortie
  assert.equal(applyRadialDeadzone(1, 0, 0.05).mag, 1);
  const d = applyRadialDeadzone(0.9, 0.9, 0.05);                // diagonale > 1 bornée
  assert.ok(Math.abs(d.mag - 1) < 1e-9);
  assert.ok(Math.abs(d.x - d.y) < 1e-9);                         // direction conservée
});

test('analyse du drift au repos', () => {
  const samples = Array.from({ length: 200 }, (_, i) => ({ x: 0.03 + 0.005 * Math.sin(i), y: -0.01 }));
  const a = analyzeRestSamples(samples);
  assert.ok(Math.abs(a.driftX - 0.03) < 0.002);
  assert.ok(a.recommended > a.maxRadius);
  assert.ok(a.recommended >= 0.02 && a.recommended <= 0.3);
});
