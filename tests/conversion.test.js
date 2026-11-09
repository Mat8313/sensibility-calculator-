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
  assert.equal(settingToDegPerSec(cod, 1.6), 165);
  assert.equal(Math.round(settingToDegPerSec(cod, 2.0) * 10) / 10, 240); // milieu 1.9–2.1
});

test('inversion : °/s → réglage arrondi au pas', () => {
  const r = degPerSecToSetting(cod, 240);
  assert.equal(r.setting, 2);
  assert.equal(r.outOfRange, null);
  assert.equal(degPerSecToSetting(cod, 140).setting, 1.4); // 115 + 0.5*50 = 140
});

test('hors plage → borné et signalé', () => {
  assert.equal(degPerSecToSetting(cod, 900).setting, 4);
  assert.equal(degPerSecToSetting(cod, 900).outOfRange, 'trop-haut');
  assert.equal(degPerSecToSetting(cod, 2).outOfRange, 'trop-bas');
  assert.equal(degPerSecToSetting(cod, 2).setting, 0.1);
});

test('roundToStep sans erreurs flottantes', () => {
  assert.equal(roundToStep(6.04999, 0.1, 1), 6);
  assert.equal(roundToStep(6.06, 0.1, 1), 6.1);
  assert.equal(roundToStep(1.6049, 0.01, 0.1), 1.6);
  assert.equal(roundToStep(1.656, 0.01, 0.1), 1.66);
});

test('chrono : 3 tours en 4 s = 270 °/s', () => {
  assert.equal(degPerSecFromLaps(3, 4), 270);
  assert.throws(() => degPerSecFromLaps(0, 4));
});

test('calibration 1 point : mise à l’échelle de la table', () => {
  const ov = addCalibrationPoint({}, 'cod', 1.6, 198, undefined, cod.setting.scale); // 198 / 165 = ×1.2
  const m = mergeCalibration(cod, ov);
  assert.equal(m.calibrated, 'partiel');
  assert.equal(settingToDegPerSec(m, 2.1), 318);
});

test('calibration ≥ 2 points : seules les mesures comptent', () => {
  const sc = cod.setting.scale;
  let ov = addCalibrationPoint({}, 'cod', 1, 150, undefined, sc);
  ov = addCalibrationPoint(ov, 'cod', 2, 300, undefined, sc);
  ov = addCalibrationPoint(ov, 'cod', 2, 280, undefined, sc); // remplace la mesure au même réglage
  const m = mergeCalibration(cod, ov);
  assert.equal(m.table.length, 2);
  assert.equal(degPerSecToSetting(m, 215).setting, 1.5);
  assert.deepEqual(removeCalibrationPoint(removeCalibrationPoint(ov, 'cod', 1), 'cod', 2), {});
});

test('mesures de l’ancienne échelle CoD (1–20, sans tag) ignorées', () => {
  let ov = addCalibrationPoint({}, 'cod', 6, 165);
  ov = addCalibrationPoint(ov, 'cod', 2, 65);
  const m = mergeCalibration(cod, ov);
  assert.equal(m.calibrationLevel, 'défaut');
  assert.equal(settingToDegPerSec(m, 1.6), 165);
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
