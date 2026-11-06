// Tests de storage.js avec un faux localStorage (Node n'en a pas).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
const store = await import('../js/storage.js');

const goodSession = {
  id: 's1', date: '2026-11-06T20:00:00Z', deadzone: 0.05, best: 280, bestScore: 71.2,
  iterations: [{ sens: 300, score: 65, tendency: -0.2, parts: { tracking: 60, flick: 70, precision: 64 } }],
  validation: { results: [{ role: 'meilleure', sens: 280, score: 71.2 }] },
};

beforeEach(() => mem.clear());

test('les clés sont préfixées (pas de collision sur <pseudo>.github.io)', () => {
  store.saveProfile({ deadzone: 0.05 });
  assert.deepEqual([...mem.keys()], ['sensilab:profile']);
});

test('export → import complet : aller-retour sans perte', () => {
  store.saveProfile({ deadzone: 0.05, rest: null, bestSens: 280 });
  store.saveSession(goodSession);
  store.saveCalibration({ cod: { points: [{ setting: 6, degPerSec: 180, date: 'x' }] } });
  const dump = JSON.parse(JSON.stringify(store.exportAll()));
  mem.clear();
  assert.equal(store.importAll(dump), 'complet');
  assert.equal(store.getSessions()[0].best, 280);
  assert.equal(store.getCalibration().cod.points[0].degPerSec, 180);
  assert.equal(store.getProfile().bestSens, 280);
});

test('XSS : une chaîne HTML à la place d’un nombre est refusée', () => {
  const evil = { app: 'SensiLab', sessions: [{ ...goodSession, best: '<img src=x onerror=alert(1)>' }] };
  assert.throws(() => store.importAll(evil), /résultat manquant/);
});

test('import atomique : rien n’est écrit si une partie est invalide', () => {
  store.saveProfile({ deadzone: 0.07, rest: null, bestSens: 300 });
  const bad = {
    app: 'SensiLab',
    profile: { deadzone: 0.02, bestSens: 100 },
    calibration: { cod: { points: [{ setting: 'six', degPerSec: 180 }] } },
  };
  assert.throws(() => store.importAll(bad));
  assert.equal(store.getProfile().deadzone, 0.07, 'le profil existant doit être intact');
});

test('champs inconnus supprimés (liste blanche)', () => {
  store.importAll({ app: 'SensiLab', sessions: [{ ...goodSession, injected: '<script>' }] });
  assert.equal(store.getSessions()[0].injected, undefined);
});

test('import d’un simple fichier de calibration', () => {
  assert.equal(store.importAll({ fortnite: { points: [{ setting: 45, degPerSec: 250 }] } }), 'calibration');
  assert.throws(() => store.importAll({ '<b>': { points: [] } }), /Identifiant/);
  assert.throws(() => store.importAll({ cod: { points: [{ setting: 6, degPerSec: -3 }] } }));
});

test('localStorage indisponible : lecture → valeur par défaut, pas d’exception', () => {
  const saved = globalThis.localStorage;
  globalThis.localStorage = { getItem() { throw new Error('bloqué'); }, setItem() { throw new Error('plein'); } };
  assert.deepEqual(store.getSessions(), []);
  assert.equal(store.saveProfile({}), false);
  globalThis.localStorage = saved;
});
