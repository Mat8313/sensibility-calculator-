/**
 * app.js — Point d'entrée : boucle principale et enchaînement des écrans.
 *
 * Architecture :
 *   gamepad.js    → lecture manette (poll unique par frame)
 *   tests.js      → simulation + mesures des tests de visée
 *   optimizer.js  → score, tendance, recherche de la sensibilité
 *   conversion.js → °/s ↔ réglage par jeu, calibration
 *   storage.js    → localStorage, import/export
 *   ui.js         → écrans, navigation manette, graphiques
 *   app.js        → colle le tout (ce fichier)
 */

import { GamepadManager, BTN, analyzeRestSamples } from './gamepad.js';
import { SeriesRunner, Renderer } from './tests.js';
import { SensOptimizer, computeScore, computeTendency, describeTendency, pickValidated } from './optimizer.js';
import {
  loadGames, recommendAll, mergeCalibration, settingToDegPerSec, degPerSecFromLaps,
  addCalibrationPoint, removeCalibrationPoint, isMonotonic,
} from './conversion.js';
import * as store from './storage.js';
import {
  $, esc, fmtDate, plural, toast, Screens, GamepadNavigator, fitCanvas, drawStick, drawScoreChart,
  confirmDialog, closeDialog, isModalOpen, initDialog,
} from './ui.js';

/* ------------------------------------------------------------------ */
/* État global                                                         */
/* ------------------------------------------------------------------ */

const gp = new GamepadManager();
const screens = new Screens();
const nav = new GamepadNavigator(screens);

const state = {
  games: [],
  profile: store.getProfile(),
  session: null,     // session en cours (sérialisable)
  optimizer: null,   // instance SensOptimizer liée à la session
  runner: null,      // SeriesRunner en cours
  renderer: null,
  viewedSession: null,
  dz: { measuring: false, samples: [], start: 0 },
  calib: { gameId: null, chronoStart: null },
};

if (state.profile.deadzone) gp.deadzone = state.profile.deadzone;

/* ------------------------------------------------------------------ */
/* Boucle principale (requestAnimationFrame)                           */
/* ------------------------------------------------------------------ */

let last = performance.now();
function loop(now) {
  const dt = (now - last) / 1000;
  last = now;
  gp.poll();
  updatePadStatus();

  switch (screens.current) {
    case 'connect': frameConnect(); break;
    case 'deadzone': frameDeadzone(now); break;
    case 'session': frameSession(dt); break;
    case 'calibration': frameCalibration(now); break;
  }
  // Pendant un test, la manette pilote la caméra : pas de navigation de menu.
  if (screens.current !== 'session') nav.update(gp, now);

  requestAnimationFrame(loop);
}

let lastPadLabel = '';
function updatePadStatus() {
  const label = gp.connected ? 'Manette connectée' : 'Aucune manette';
  if (label === lastPadLabel) return;
  lastPadLabel = label;
  const pill = $('#pad-status');
  pill.textContent = label;
  pill.className = `pill ${gp.connected ? 'on' : 'off'}`;
}

/* ------------------------------------------------------------------ */
/* 1. Détection                                                        */
/* ------------------------------------------------------------------ */

function frameConnect() {
  drawStick($('#stick-left'), gp.leftStickRaw(), 0, 'Stick gauche');
  drawStick($('#stick-right'), gp.rightStickRaw(), gp.deadzone, 'Stick droit');
  const btn = $('#btn-connect-continue');
  if (gp.connected) {
    $('#pad-info').textContent = gp.state.id;
    const warn = $('#pad-warning');
    const nonStandard = gp.state.mapping !== 'standard';
    warn.hidden = !nonStandard;
    if (nonStandard) warn.textContent = 'Mapping non standard détecté : les boutons peuvent être inversés. Utilise Chrome ou Edge pour une DualSense en USB.';
    if (btn.disabled) { btn.disabled = false; btn.focus(); }
  } else {
    $('#pad-info').textContent = 'En attente… (branche la manette puis appuie sur un bouton)';
    btn.disabled = true;
  }
}

$('#btn-connect-continue').addEventListener('click', () => {
  // Pas encore de zone morte mesurée → on commence par là
  screens.show(state.profile.deadzone ? 'menu' : 'deadzone');
});

/* ------------------------------------------------------------------ */
/* 2. Zone morte                                                       */
/* ------------------------------------------------------------------ */

const DZ_DURATION = 3000;

function frameDeadzone(now) {
  const raw = gp.rightStickRaw();
  drawStick($('#stick-dz'), { x: raw.x * 4, y: raw.y * 4 }, Math.min(1, gp.deadzone * 4), 'zoom ×4');
  const m = state.dz;
  if (!m.measuring) return;
  if (!gp.connected) { m.measuring = false; return toast('Manette déconnectée', 'error'); }
  // Si l'utilisateur touche le stick, la mesure du repos est faussée : on annule.
  if (Math.hypot(raw.x, raw.y) > 0.35) {
    m.measuring = false;
    $('#dz-progress').style.width = '0';
    return toast('Stick touché pendant la mesure, recommence sans y toucher.', 'error');
  }
  m.samples.push(raw);
  const p = Math.min(1, (now - m.start) / DZ_DURATION);
  $('#dz-progress').style.width = `${p * 100}%`;
  if (p >= 1) finishDeadzone();
}

function finishDeadzone() {
  state.dz.measuring = false;
  const a = analyzeRestSamples(state.dz.samples);
  gp.deadzone = a.recommended;
  state.profile = { ...state.profile, deadzone: a.recommended, rest: { ...a, date: new Date().toISOString() } };
  store.saveProfile(state.profile);
  renderDeadzoneResult(a);
  $('#btn-dz-continue').disabled = false;
  $('#btn-dz-continue').focus();
  toast('Zone morte enregistrée', 'ok');
}

function renderDeadzoneResult(a) {
  const pct = (v) => `${(v * 100).toFixed(1)} %`;
  $('#dz-result').innerHTML = `
    <div><dt>Drift (décalage moyen)</dt><dd>${pct(a.drift)}</dd></div>
    <div><dt>Bruit du capteur</dt><dd>${pct(a.noise)}</dd></div>
    <div><dt>Écart max au repos</dt><dd>${pct(a.maxRadius)}</dd></div>
    <div><dt>Zone morte conseillée</dt><dd style="color:var(--accent)">${pct(a.recommended)}</dd></div>`;
}

$('#btn-dz-measure').addEventListener('click', () => {
  if (!gp.connected) return toast('Branche la manette d\'abord', 'error');
  // Petit délai : le ✕ qui lance la mesure fait bouger la manette.
  toast('Ne touche plus à rien…');
  setTimeout(() => {
    Object.assign(state.dz, { measuring: true, samples: [], start: performance.now() });
  }, 600);
});
$('#btn-dz-continue').addEventListener('click', () => screens.show('menu'));

screens.onShow.deadzone = () => {
  if (state.profile.rest) { renderDeadzoneResult(state.profile.rest); $('#btn-dz-continue').disabled = false; }
};

/* ------------------------------------------------------------------ */
/* 3. Menu                                                             */
/* ------------------------------------------------------------------ */

screens.onShow.menu = () => {
  const p = state.profile;
  const parts = [];
  if (p.deadzone) parts.push(`Zone morte : ${(p.deadzone * 100).toFixed(1)} %`);
  if (p.bestSens) parts.push(`Dernière sensibilité optimale : ${p.bestSens} °/s`);
  $('#menu-summary').textContent = parts.join(' · ') || 'Aucune session pour l\'instant.';
  const active = store.getActiveSession();
  $('#btn-resume-session').hidden = !active;
  if (active) $('#resume-info').textContent = `${active.iterations.length} série(s) faite(s) — ${fmtDate(active.date)}`;
  $('#btn-last-results').disabled = !store.getSessions().length;
};

$('#btn-new-session').addEventListener('click', async () => {
  if (store.getActiveSession()
    && !(await confirmDialog('Une session est en cours. La remplacer par une nouvelle ?', { ok: 'Remplacer', danger: true }))) return;
  startSession();
});
$('#btn-resume-session').addEventListener('click', resumeSession);
$('#btn-last-results').addEventListener('click', () => showResults(store.getSessions()[0]));
$('#btn-calibration').addEventListener('click', () => screens.show('calibration'));
$('#btn-history').addEventListener('click', () => screens.show('history'));
$('#btn-deadzone').addEventListener('click', () => screens.show('deadzone'));

/* ------------------------------------------------------------------ */
/* 4. Session : recherche itérative puis validation                     */
/* ------------------------------------------------------------------ */

function startSession() {
  state.optimizer = new SensOptimizer();
  state.session = {
    id: `s${Date.now()}`,
    date: new Date().toISOString(),
    deadzone: gp.deadzone,
    phase: 'search',              // search → validation → done
    iterations: [],
    validation: { set: [], results: [] },
    optimizer: state.optimizer.toJSON(),
  };
  persistActive();
  nextSeries();
}

function resumeSession() {
  const s = store.getActiveSession();
  if (!s) return;
  state.session = s;
  state.optimizer = SensOptimizer.fromJSON(s.optimizer);
  nextSeries();
}

function persistActive() {
  state.session.optimizer = state.optimizer.toJSON();
  store.saveActiveSession(state.session);
}

/** Lance la prochaine série selon la phase. */
function nextSeries() {
  const s = state.session;
  if (s.phase === 'search') {
    runSeries(state.optimizer.current, `Itération ${s.iterations.length + 1}`);
  } else if (s.phase === 'validation') {
    const i = s.validation.results.length;
    // On n'affiche pas la valeur testée : comparaison "à l'aveugle".
    runSeries(s.validation.set[i].sens, `Validation ${i + 1}/3`);
  }
}

function runSeries(sens, label) {
  state.runner = new SeriesRunner(sens, { label });
  screens.show('session');
  const canvas = $('#game-canvas');
  const { ctx, w, h } = fitCanvas(canvas);
  state.renderer = new Renderer(ctx, w, h);
}

function frameSession(dt) {
  const r = state.runner;
  if (!r) return;
  // Redimensionnement éventuel (rotation mobile, plein écran…)
  const canvas = $('#game-canvas');
  const { ctx, w, h } = fitCanvas(canvas);
  if (w !== state.renderer.w || h !== state.renderer.h) state.renderer.resize(w, h);
  state.renderer.ctx = ctx;

  // ◯ en plein test met en pause (un appui accidentel ne fait pas perdre la série) ;
  // ◯ depuis la pause ou l'intro quitte.
  if (gp.wasPressed(BTN.CIRCLE)) {
    if (r.phase === 'running' || r.phase === 'resuming') r.pause('Pause');
    else return abortSeries();
  }
  if (gp.wasPressed(BTN.OPTIONS)) r.pause('Pause');
  if (!gp.connected) r.pause('Manette déconnectée');
  const test = r.test, hitsBefore = hitCount(test); // référence capturée : r.test peut passer à null pendant frame()
  r.frame(dt, {
    stick: gp.rightStick(),
    fire: !!gp.state?.firePressed,
    confirm: gp.wasPressed(BTN.CROSS),
  });
  if (hitCount(test) > hitsBefore) gp.rumble();
  r.draw(state.renderer);
  if (r.done) onSeriesDone(r);
}

/** Nombre de cibles touchées d'un test (Flicks / Précision), 0 pour le tracking. */
const hitCount = (t) => (t?.records ? t.records.reduce((n, x) => n + (x.hit ? 1 : 0), 0) : 0);

/**
 * Quand la fenêtre perd le focus, Chrome cesse de mettre à jour la manette :
 * le dernier état reste figé. Un stick incliné à ce moment ferait tourner la
 * caméra toute seule et fausserait les mesures → on met en pause.
 */
function pauseOnFocusLoss(reason) {
  if (screens.current === 'session' && state.runner) state.runner.pause(reason);
}
window.addEventListener('blur', () => pauseOnFocusLoss('Fenêtre quittée'));
document.addEventListener('visibilitychange', () => document.hidden && pauseOnFocusLoss('Onglet masqué'));

function abortSeries() {
  state.runner = null;
  toast('Série interrompue : elle sera rejouée en reprenant la session.');
  screens.show('menu');
}

function onSeriesDone(runner) {
  state.runner = null;
  const s = state.session;
  const score = computeScore(runner.results);
  const tendency = computeTendency(runner.results);
  const entry = {
    sens: runner.sens, score: score.total, parts: score.parts,
    tendency: tendency.value, explanation: describeTendency(tendency), metrics: runner.results,
  };

  if (s.phase === 'search') {
    s.iterations.push(entry);
    const { done } = state.optimizer.report(score.total, tendency.value);
    if (done) {
      s.phase = 'validation';
      s.validation.set = state.optimizer.validationSet();
      s.estimate = state.optimizer.bestEstimate();
    }
    persistActive();
    showIteration(entry, done);
  } else {
    const v = s.validation.set[s.validation.results.length];
    s.validation.results.push({ ...entry, role: v.role });
    persistActive();
    if (s.validation.results.length >= s.validation.set.length) finishSession();
    else showIteration(entry, false, true);
  }
}

function showIteration(entry, searchDone, isValidation = false) {
  const s = state.session;
  $('#it-title').textContent = isValidation
    ? `Validation ${s.validation.results.length}/3 terminée`
    : `Itération ${s.iterations.length} terminée — ${entry.sens} °/s`;
  $('#it-score').textContent = entry.score.toFixed(1);
  $('#it-tracking').textContent = entry.parts.tracking.toFixed(0);
  $('#it-flick').textContent = entry.parts.flick.toFixed(0);
  $('#it-precision').textContent = entry.parts.precision.toFixed(0);
  $('#it-tendency').textContent = isValidation
    ? 'Valeur masquée pour une comparaison à l\'aveugle.'
    : searchDone
      ? `Recherche terminée : meilleure estimation ${s.estimate} °/s. Place au test de validation (3 séries : la meilleure valeur et deux voisines, dans un ordre aléatoire).`
      : `${entry.explanation} ${nextHint(entry.sens, state.optimizer.current)}`;
  $('#it-details').innerHTML = metricsTable(entry.metrics);
  $('#btn-it-continue').textContent = searchDone ? 'Lancer la validation ✕' : 'Série suivante ✕';
  screens.show('iteration');
  drawScoreChart($('#it-chart'), chartPoints(s, isValidation));
}

/**
 * On annonce le SENS du changement, pas la valeur : connaître le chiffre exact
 * avant de jouer influence la perception ("300, c'est censé être rapide").
 */
function nextHint(prev, next) {
  const r = next / prev;
  if (r > 1.03) return 'La prochaine série sera plus rapide.';
  if (r < 0.97) return 'La prochaine série sera plus lente.';
  return 'La prochaine série sera très proche.';
}

/** Points du graphique ; pendant la validation, les valeurs testées sont masquées (aveugle). */
function chartPoints(s, hideValidation = false) {
  const pts = s.iterations.map((i) => ({ score: i.score, sens: i.sens, kind: 'search' }));
  for (const v of s.validation?.results ?? []) {
    pts.push({ score: v.score, sens: hideValidation ? '?' : v.sens, kind: 'validation' });
  }
  return pts;
}

function metricsTable(m) {
  const pct = (v) => `${(100 * v).toFixed(0)} %`;
  const n = (v, d = 2) => (v === null || v === undefined ? '–' : Number(v).toFixed(d));
  const rows = [];
  if (m.tracking) rows.push(
    ['Tracking', 'Temps sur cible', pct(m.tracking.onTargetRatio)],
    ['', 'Erreur moyenne', `${n(m.tracking.meanError, 1)}°`],
    ['', 'Retard stick à fond', pct(m.tracking.satLagRatio)],
  );
  if (m.flick) rows.push(
    ['Flicks', 'Cibles touchées', `${m.flick.hits}/${m.flick.targets}`],
    ['', 'Temps moyen pour toucher', `${n(m.flick.avgHitTime)} s`],
    ['', 'Dépassements / cible', n(m.flick.overshootRate)],
    ['', 'Corrections / cible', n(m.flick.correctionRate)],
    ['', 'Arrêts avant la cible / cible', n(m.flick.undershootRate)],
    ['', 'Utilisation du stick', m.flick.utilization === null ? '–' : pct(m.flick.utilization)],
    ['', 'Tirs ratés', pct(m.flick.missRate)],
  );
  if (m.precision) rows.push(
    ['Précision', 'Réussite', `${m.precision.hits}/${m.precision.targets} cibles (${pct(m.precision.accuracy)})`],
    ['', 'Temps de stabilisation', `${n(m.precision.avgStabTime)} s`],
    ['', 'Erreur au tir', `${n(m.precision.avgShotError)}°`],
    ['', 'Dépassements / cible', n(m.precision.overshootRate)],
  );
  return `<table>${rows.map((r) => `<tr><th>${r[0]}</th><td>${r[1]}</td><td>${r[2]}</td></tr>`).join('')}</table>`;
}

$('#btn-it-continue').addEventListener('click', nextSeries);
$('#btn-it-menu').addEventListener('click', () => screens.show('menu'));

function finishSession() {
  const s = state.session;
  const chosen = pickValidated(s.validation.results);
  s.best = chosen.sens;
  s.bestScore = chosen.score;
  s.phase = 'done';
  s.recommendations = recommendAll(state.games, store.getCalibration(), s.best, s.deadzone);
  delete s.optimizer;
  store.saveSession(s);
  store.clearActiveSession();
  state.profile = { ...state.profile, bestSens: s.best };
  store.saveProfile(state.profile);
  state.session = null;
  showResults(s);
}

/* ------------------------------------------------------------------ */
/* 5. Résultats                                                        */
/* ------------------------------------------------------------------ */

function showResults(session) {
  if (!session) return;
  state.viewedSession = session;
  screens.show('results');
}

screens.onShow.results = () => {
  const s = state.viewedSession;
  $('#res-date').textContent = `Session du ${fmtDate(s.date)} · ${plural(s.iterations.length, "itération")}`;
  $('#res-sens').textContent = `${s.best} °/s`;
  $('#res-sub').textContent = `soit un 360° en ${(360 / s.best).toFixed(2)} s · score de validation ${s.bestScore.toFixed(1)}`;

  // Recalculé à l'affichage : une calibration faite APRÈS la session est prise en compte.
  const recos = recommendAll(state.games, store.getCalibration(), s.best, s.deadzone);
  $('#res-games').innerHTML = recos.map((r) => {
    const badge = r.calibrationLevel === 'défaut'
      ? '<span class="badge todo">À calibrer</span>'
      : r.calibrationLevel.startsWith('partiel') ? '<span class="badge partial">Partiel</span>' : '<span class="badge ok">Calibré</span>';
    const range = r.outOfRange ? ` · ⚠ hors plage (${r.outOfRange === 'trop-haut' ? 'max atteint' : 'min atteint'})` : '';
    const dz = r.deadzone !== null ? ` · ${esc(r.deadzoneLabel)} : ${r.deadzone} %` : '';
    return `<div class="game">
      <span class="game-name">${esc(r.name)}${badge}</span>
      <span class="game-setting">${r.setting}${esc(r.unit)}</span>
      <span class="game-meta">${esc(r.settingLabel)} → ${r.achievedDegPerSec} °/s (écart ${r.errorPct > 0 ? '+' : ''}${r.errorPct} %)${range}${dz}<br>${esc(r.curve?.label ?? '')}${r.monotonic ? '' : ' · ⚠ table non monotone, vérifie tes mesures'}</span>
    </div>`;
  }).join('');

  const v = s.validation?.results ?? [];
  $('#res-validation').innerHTML = v.length ? `<h3>Test de validation</h3><table class="table">
    <tr><th>Valeur</th><th>°/s</th><th>Score</th></tr>
    ${v.map((x) => `<tr><td>${esc(x.role)}${x.sens === s.best ? ' ✔' : ''}</td><td>${x.sens}</td><td>${x.score.toFixed(1)}</td></tr>`).join('')}
  </table>` : '';
  requestAnimationFrame(() => drawScoreChart($('#res-chart'), chartPoints(s)));
};

$('#btn-res-menu').addEventListener('click', () => screens.show('menu'));
$('#btn-res-calib').addEventListener('click', () => screens.show('calibration'));

/* ------------------------------------------------------------------ */
/* 6. Calibration                                                      */
/* ------------------------------------------------------------------ */

const calibGame = () => state.games.find((g) => g.id === state.calib.gameId) ?? state.games[0];

screens.onShow.calibration = () => {
  if (!state.calib.gameId && state.games[0]) state.calib.gameId = state.games[0].id;
  renderCalibration();
};

function renderCalibration() {
  const g = calibGame();
  if (!g) return;
  $('#calib-games').innerHTML = state.games.map((x) =>
    `<button class="seg ${x.id === g.id ? 'active' : ''}" data-game="${esc(x.id)}">${esc(x.name)}</button>`).join('');

  const input = $('#calib-setting');
  if (input.dataset.game !== g.id) {
    Object.assign(input, { min: g.setting.min, max: g.setting.max, step: g.setting.step, value: g.setting.default });
    input.dataset.game = g.id;
  }
  $('#calib-setting-label').textContent = `(${g.setting.label}, ${g.setting.min}–${g.setting.max})`;

  const merged = mergeCalibration(g, store.getCalibration());
  $('#calib-status').innerHTML = merged.calibrationLevel === 'défaut'
    ? `<span class="badge todo">À calibrer</span> ${esc(g.status ?? 'Valeurs estimées')}`
    : `<span class="badge ${merged.calibrated === true ? 'ok' : 'partial'}">${esc(merged.calibrationLevel)}</span>`;

  const measured = store.getCalibration()[g.id]?.points ?? [];
  const rows = merged.table.map((p) => {
    const m = measured.find((x) => x.setting === p.setting);
    return `<tr><td>${p.setting}</td><td>${Math.round(p.degPerSec)}</td><td>${(360 / p.degPerSec).toFixed(2)} s</td>
      <td>${m ? `mesuré <button class="btn small danger" data-del="${p.setting}">Suppr.</button>` : 'estimé'}</td></tr>`;
  }).join('');
  $('#calib-table').innerHTML = `<table class="table"><tr><th>Réglage</th><th>°/s</th><th>360° en</th><th>Source</th></tr>${rows}</table>
    ${isMonotonic(merged.table) ? '' : '<p class="warning">La table n\'est pas croissante : une mesure est sans doute erronée.</p>'}`;
  updateCalibResult();
}

function updateCalibResult() {
  const g = calibGame();
  const setting = parseFloat($('#calib-setting').value);
  const laps = parseFloat($('#calib-laps').value);
  const time = parseFloat($('#calib-time').value);
  const el = $('#calib-result');
  const btn = $('#btn-calib-save');
  if (!(laps > 0 && time > 0 && Number.isFinite(setting))) {
    el.textContent = 'Saisis un réglage, un nombre de tours et une durée.';
    btn.disabled = true;
    return;
  }
  const dps = degPerSecFromLaps(laps, time);
  const expected = settingToDegPerSec(mergeCalibration(g, store.getCalibration()), setting);
  el.textContent = `Mesure : ${dps.toFixed(1)} °/s (360° en ${(360 / dps).toFixed(2)} s) · la table actuelle prévoit ${expected.toFixed(0)} °/s pour ${setting}.`;
  btn.disabled = setting < g.setting.min || setting > g.setting.max;
}

function frameCalibration(now) {
  if (state.calib.chronoStart !== null) {
    $('#calib-chrono').textContent = `${((now - state.calib.chronoStart) / 1000).toFixed(2)} s`;
  }
}

$('#calib-games').addEventListener('click', (e) => {
  const b = e.target.closest('[data-game]');
  if (!b) return;
  state.calib.gameId = b.dataset.game;
  renderCalibration();
  $(`[data-game="${CSS.escape(b.dataset.game)}"]`)?.focus();
});
for (const id of ['#calib-setting', '#calib-laps', '#calib-time']) $(id).addEventListener('input', updateCalibResult);

$('#btn-chrono').addEventListener('click', () => {
  const c = state.calib;
  if (c.chronoStart === null) {
    c.chronoStart = performance.now();
    $('#btn-chrono').textContent = 'Arrêter le chrono ✕';
    $('.chrono').classList.add('running');
  } else {
    const t = (performance.now() - c.chronoStart) / 1000;
    c.chronoStart = null;
    $('#calib-time').value = t.toFixed(2);
    $('#btn-chrono').textContent = 'Démarrer le chrono ✕';
    $('.chrono').classList.remove('running');
    updateCalibResult();
  }
});

$('#btn-calib-save').addEventListener('click', () => {
  const g = calibGame();
  const setting = parseFloat($('#calib-setting').value);
  const dps = degPerSecFromLaps(parseFloat($('#calib-laps').value), parseFloat($('#calib-time').value));
  store.saveCalibration(addCalibrationPoint(store.getCalibration(), g.id, setting, dps));
  toast(`Mesure enregistrée : ${g.name} ${setting} → ${dps.toFixed(1)} °/s`, 'ok');
  $('#calib-time').value = '';
  renderCalibration();
});

$('#calib-table').addEventListener('click', (e) => {
  const b = e.target.closest('[data-del]');
  if (!b) return;
  store.saveCalibration(removeCalibrationPoint(store.getCalibration(), calibGame().id, parseFloat(b.dataset.del)));
  renderCalibration();
});

$('#btn-calib-reset').addEventListener('click', async () => {
  const g = calibGame();
  if (!(await confirmDialog(`Supprimer toutes les mesures de ${g.name} ?`, { ok: 'Supprimer', danger: true }))) return;
  const c = store.getCalibration();
  delete c[g.id];
  store.saveCalibration(c);
  renderCalibration();
});

$('#btn-calib-export').addEventListener('click', () => {
  store.downloadJSON(store.exportAll(), `sensilab-${new Date().toISOString().slice(0, 10)}.json`);
});
$('#btn-calib-import').addEventListener('click', () => $('#calib-file').click());
$('#calib-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = ''; // permet de réimporter le même fichier
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data?.app === 'SensiLab' && !(await confirmDialog(
      'Ce fichier est un export complet : il remplacera ton profil, ton historique et tes calibrations.',
      { ok: 'Remplacer', danger: true }))) return;
    const kind = store.importAll(data);
    state.profile = store.getProfile();
    toast(kind === 'complet' ? 'Profil, sessions et calibrations importés' : 'Calibrations importées', 'ok');
    renderCalibration();
  } catch (err) {
    toast(`Import impossible : ${err.message}`, 'error');
  }
});

/* ------------------------------------------------------------------ */
/* 7. Historique                                                       */
/* ------------------------------------------------------------------ */

screens.onShow.history = () => {
  const list = store.getSessions();
  $('#history-list').innerHTML = list.length ? list.map((s) => `
    <div class="history-item">
      <div><strong>${Number(s.best)} °/s</strong> <span class="muted small">· ${esc(fmtDate(s.date))} · ${plural(s.iterations.length, 'itération')} · score ${Number(s.bestScore).toFixed(1)}</span></div>
      <div class="actions">
        <button class="btn small" data-view="${esc(s.id)}">Voir</button>
        <button class="btn small danger" data-delete="${esc(s.id)}">Suppr.</button>
      </div>
    </div>`).join('') : '<p class="muted">Aucune session terminée.</p>';
};

$('#history-list').addEventListener('click', async (e) => {
  const view = e.target.closest('[data-view]');
  const del = e.target.closest('[data-delete]');
  if (view) showResults(store.getSessions().find((s) => s.id === view.dataset.view));
  if (del && await confirmDialog('Supprimer cette session de l\'historique ?', { ok: 'Supprimer', danger: true })) {
    store.deleteSession(del.dataset.delete);
    screens.onShow.history();
  }
});
$('#btn-history-back').addEventListener('click', () => screens.show('menu'));

/* ------------------------------------------------------------------ */
/* Retour (◯ / Échap) et démarrage                                     */
/* ------------------------------------------------------------------ */

Object.assign(screens.backTargets, {
  deadzone: () => state.profile.deadzone && screens.show('menu'),
  iteration: 'menu',
  results: 'menu',
  calibration: 'menu',
  history: 'menu',
  menu: 'connect',
});

document.addEventListener('keydown', (e) => {
  document.body.classList.remove('using-gamepad');
  if (e.key === 'Escape') {
    if (isModalOpen()) closeDialog(false);
    else if (screens.current === 'session') {
      const r = state.runner;
      if (r && (r.phase === 'running' || r.phase === 'resuming')) r.pause('Pause'); else abortSeries();
    }
    else screens.back();
  }
});
initDialog();
document.addEventListener('pointerdown', () => document.body.classList.remove('using-gamepad'));

// ?debug : expose l'état pour inspecter dans la console (et pour les tests automatisés).
if (new URLSearchParams(location.search).has('debug')) window.sensilab = { state, gp, screens };

async function init() {
  try {
    state.games = await loadGames();
  } catch (err) {
    console.error(err);
    toast('games.json introuvable : lance l\'app via un serveur HTTP (voir README).', 'error');
  }
  screens.show('connect');
  requestAnimationFrame(loop);
}

init();
