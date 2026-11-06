import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  validateGames, settingToDegPerSec, degPerSecToSetting, roundToStep, degPerSecFromLaps,
  addCalibrationPoint, removeCalibrationPoint, mergeCalibration, isMonotonic, recommendAll, recommendDeadzone,
} from '../js/conversion.js';

const data = JSON.parse(readFileSync(new URL('../data/games.json', import.meta.url)));
const cod = data.games.find((g) => g.id === 'cod');

test('games.json valide et tables monotones', () => {
  assert.ok(validateGames(data));
  for (const g of data.games) assert.ok(isMonotonic(g.table), g.id);
});

test('interpolation exacte sur les points et au milieu', () => {
  assert.equal(settingToDegPerSec(cod, 6), 165);
  assert.equal(settingToDegPerSec(cod, 7), 190);
});

test('inversion : °/s → réglage arrondi au pas', () => {
  const r = degPerSecToSetting(cod, 190);
  assert.equal(r.setting, 7);
  assert.equal(r.outOfRange, null);
  assert.equal(degPerSecToSetting(cod, 177).setting, 6.5); // 165 + 0.5*25 = 177.5
});

test('hors plage → borné et signalé', () => {
  assert.equal(degPerSecToSetting(cod, 900).setting, 20);
  assert.equal(degPerSecToSetting(cod, 900).outOfRange, 'trop-haut');
  assert.equal(degPerSecToSetting(cod, 10).outOfRange, 'trop-bas');
});

test('roundToStep sans erreurs flottantes', () => {
  assert.equal(roundToStep(6.04999, 0.1, 1), 6);
  assert.equal(roundToStep(6.06, 0.1, 1), 6.1);
});

test('chrono : 3 tours en 4 s = 270 °/s', () => {
  assert.equal(degPerSecFromLaps(3, 4), 270);
  assert.throws(() => degPerSecFromLaps(0, 4));
});

test('calibration 1 point : mise à l’échelle de la table', () => {
  const ov = addCalibrationPoint({}, 'cod', 6, 198); // 198 / 165 = ×1.2
  const m = mergeCalibration(cod, ov);
  assert.equal(m.calibrated, 'partiel');
  assert.equal(settingToDegPerSec(m, 10), 318);
});

test('calibration ≥ 2 points : seules les mesures comptent', () => {
  let ov = addCalibrationPoint({}, 'cod', 5, 150);
  ov = addCalibrationPoint(ov, 'cod', 10, 300);
  ov = addCalibrationPoint(ov, 'cod', 10, 280); // remplace la mesure au même réglage
  const m = mergeCalibration(cod, ov);
  assert.equal(m.table.length, 2);
  assert.equal(degPerSecToSetting(m, 215).setting, 7.5);
  assert.deepEqual(removeCalibrationPoint(removeCalibrationPoint(ov, 'cod', 5), 'cod', 10), {});
});

test('zone morte conseillée en %', () => {
  assert.equal(recommendDeadzone(cod, 0.042), 6);
  assert.equal(recommendDeadzone(data.games.find((g) => g.id === 'apex'), 0.04), null);
});

test('recommendAll couvre tous les jeux', () => {
  const r = recommendAll(data.games, {}, 250, 0.05);
  assert.equal(r.length, data.games.length);
  for (const x of r) assert.ok(Number.isFinite(x.setting));
});
