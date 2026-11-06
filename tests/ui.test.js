import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickSpatial, plural, esc } from '../js/ui.js';

// Grille 2×2 de cartes 100×50, espacées de 20 px
const grid = [
  { x: 0, y: 0, w: 100, h: 50 }, { x: 120, y: 0, w: 100, h: 50 },
  { x: 0, y: 70, w: 100, h: 50 }, { x: 120, y: 70, w: 100, h: 50 },
];

test('navigation spatiale : bas descend d’une ligne (pas la carte suivante)', () => {
  assert.equal(pickSpatial(grid[0], grid, 'down'), 2);
  assert.equal(pickSpatial(grid[0], grid, 'right'), 1);
  assert.equal(pickSpatial(grid[3], grid, 'up'), 1);
  assert.equal(pickSpatial(grid[3], grid, 'left'), 2);
});

test('navigation spatiale : rien dans la direction → -1', () => {
  assert.equal(pickSpatial(grid[0], grid, 'up'), -1);
  assert.equal(pickSpatial(grid[1], grid, 'right'), -1);
});

test('navigation spatiale : préfère un voisin aligné à un voisin en diagonale', () => {
  const from = { x: 0, y: 0, w: 100, h: 40 };
  const rects = [{ x: 300, y: 60, w: 100, h: 40 }, { x: 0, y: 140, w: 100, h: 40 }];
  assert.equal(pickSpatial(from, rects, 'down'), 1);
});

test('plural et esc', () => {
  assert.equal(plural(1, 'itération'), '1 itération');
  assert.equal(plural(3, 'itération'), '3 itérations');
  assert.equal(esc('<img onerror=x>'), '&lt;img onerror=x&gt;');
});
