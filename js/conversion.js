/**
 * conversion.js — Conversion °/s ↔ réglage en jeu, et calibration des tables.
 *
 * Module pur (hors loadGames qui utilise fetch) : testable sous Node.
 *
 * Modèle : pour chaque jeu, une table de points (réglage → °/s stick à fond),
 * supposée MONOTONE croissante. Entre deux points on interpole linéairement.
 * On compare les jeux à "stick à fond" car c'est la seule grandeur mesurable
 * simplement (chrono sur 360°) et indépendante de la courbe de réponse.
 */

/** Charge games.json (nécessite un serveur HTTP : fetch ne marche pas en file://). */
export async function loadGames(url = 'data/games.json') {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Impossible de charger ${url} (HTTP ${res.status})`);
  const data = await res.json();
  validateGames(data);
  return data.games;
}

/** Validation minimale : une erreur claire vaut mieux qu'un NaN silencieux. */
export function validateGames(data) {
  if (!data || !Array.isArray(data.games)) throw new Error('games.json : clé "games" manquante');
  for (const g of data.games) {
    if (!g.id || !g.setting || !Array.isArray(g.table) || g.table.length < 2) {
      throw new Error(`games.json : jeu "${g.id ?? '?'}" incomplet (id, setting, table ≥ 2 points)`);
    }
  }
  return true;
}

const sortBySetting = (pts) => [...pts].sort((a, b) => a.setting - b.setting);

/** Interpolation linéaire générique : trouve y pour x dans des points triés par x. */
function interpolate(points, x, kx, ky) {
  const n = points.length;
  // Extrapolation linéaire avec le premier / dernier segment
  let i = 0;
  if (x <= points[0][kx]) i = 0;
  else if (x >= points[n - 1][kx]) i = n - 2;
  else while (i < n - 2 && x > points[i + 1][kx]) i++;
  const a = points[i], b = points[i + 1];
  const t = (x - a[kx]) / (b[kx] - a[kx]);
  return a[ky] + t * (b[ky] - a[ky]);
}

/** Arrondi au pas du réglage (ex : 0.1 pour CoD), en évitant 6.000000001. */
export function roundToStep(value, step, min) {
  const n = Math.round((value - min) / step);
  const decimals = (String(step).split('.')[1] || '').length;
  return Number((min + n * step).toFixed(decimals));
}

/** Réglage en jeu → °/s stick à fond. */
export function settingToDegPerSec(game, setting) {
  return interpolate(sortBySetting(game.table), setting, 'setting', 'degPerSec');
}

/**
 * °/s cible → réglage en jeu le plus proche.
 * Retourne aussi la vitesse réellement obtenue après arrondi au pas,
 * et un drapeau si la cible sort de la plage du jeu.
 */
export function degPerSecToSetting(game, degPerSec) {
  const pts = [...game.table].sort((a, b) => a.degPerSec - b.degPerSec);
  const { min, max, step } = game.setting;
  const raw = interpolate(pts, degPerSec, 'degPerSec', 'setting');
  const clamped = Math.min(max, Math.max(min, raw));
  const setting = roundToStep(clamped, step, min);
  const achieved = settingToDegPerSec(game, setting);
  return {
    setting,
    achievedDegPerSec: Math.round(achieved),
    errorPct: Math.round(((achieved - degPerSec) / degPerSec) * 1000) / 10,
    outOfRange: raw < min ? 'trop-bas' : raw > max ? 'trop-haut' : null,
  };
}

/**
 * Zone morte conseillée dans l'unité du jeu à partir de la mesure (fraction 0–1).
 * Seulement pour les jeux en % : les autres (ex. Apex, Petite/Grande) n'ont
 * pas d'équivalence numérique fiable.
 */
export function recommendDeadzone(game, measured) {
  const dz = game.deadzone;
  if (!dz || dz.unit !== '%') return null;
  // +1 % de marge : la zone morte du jeu est rarement mesurée exactement comme la nôtre.
  const pct = Math.ceil(measured * 100) + 1;
  return Math.min(dz.max, Math.max(dz.min, pct));
}

/* ------------------------------------------------------------------ */
/* Calibration                                                         */
/* ------------------------------------------------------------------ */

/** °/s à partir d'un chrono : N tours de 360° en `seconds`. */
export function degPerSecFromLaps(laps, seconds) {
  if (!(laps > 0) || !(seconds > 0)) throw new Error('Nombre de tours et durée doivent être > 0');
  return (360 * laps) / seconds;
}

/**
 * Ajoute (ou remplace) un point mesuré dans les overrides.
 * overrides = { [gameId]: { points: [{setting, degPerSec, date}] } }
 * Retourne un NOUVEL objet (immutabilité : plus simple à sauvegarder/annuler).
 */
export function addCalibrationPoint(overrides, gameId, setting, degPerSec, date = new Date().toISOString(), scale = null) {
  const prev = overrides[gameId]?.points ?? [];
  const points = prev.filter((p) => p.setting !== setting);
  const point = { setting, degPerSec: Math.round(degPerSec * 10) / 10, date };
  if (scale) point.scale = scale;
  points.push(point);
  return { ...overrides, [gameId]: { ...overrides[gameId], points: sortBySetting(points) } };
}

export function removeCalibrationPoint(overrides, gameId, setting) {
  const points = (overrides[gameId]?.points ?? []).filter((p) => p.setting !== setting);
  return withEntry(overrides, gameId, { ...overrides[gameId], points });
}

/** Remplace l'entrée d'un jeu, ou la supprime si elle ne contient plus rien. */
function withEntry(overrides, gameId, entry) {
  const next = { ...overrides };
  const empty = !entry.points?.length && !Object.keys(entry.feel ?? {}).length;
  if (empty) delete next[gameId];
  else {
    const clean = { points: entry.points ?? [] };
    if (Object.keys(entry.feel ?? {}).length) clean.feel = entry.feel;
    next[gameId] = clean;
  }
  return next;
}

/* ------------------------------------------------------------------ */
/* Correction au ressenti                                              */
/* ------------------------------------------------------------------ */
/*
 * La calibration au chrono mesure la vitesse PHYSIQUE à fond. Mais si la courbe
 * du test diffère de celle du jeu, la même vitesse à fond ne donne pas le même
 * ressenti. Le joueur indique la valeur qu'il préfère vraiment en jeu ; on en
 * tire un coefficient : vitesse(valeur préférée) / optimum SensiLab.
 *
 * Le coefficient dépend de la courbe utilisée pendant les tests (une session en
 * linéaire et une en Dynamique ne se corrigent pas pareil) et de l'échelle du jeu.
 * overrides[gameId].feel = { [curveId]: { ratio, scale, date } }
 */

export function setFeelCorrection(overrides, game, curveId, sessionDegPerSec, preferredSetting, date = new Date().toISOString()) {
  if (!(sessionDegPerSec > 0)) throw new Error('Optimum de session invalide');
  const merged = mergeCalibration(game, overrides);
  const ratio = Math.round((settingToDegPerSec(merged, preferredSetting) / sessionDegPerSec) * 1000) / 1000;
  if (!(ratio > 0)) throw new Error('Valeur préférée hors table');
  const feel = { ...overrides[game.id]?.feel, [curveId]: { ratio, scale: game.setting.scale ?? null, date } };
  return withEntry(overrides, game.id, { ...overrides[game.id], feel });
}

export function clearFeelCorrection(overrides, gameId, curveId) {
  const feel = { ...overrides[gameId]?.feel };
  delete feel[curveId];
  return withEntry(overrides, gameId, { ...overrides[gameId], feel });
}

/** Coefficient applicable (1 si aucun, ou s'il date d'une autre échelle du jeu). */
export function feelRatio(game, overrides, curveId) {
  const f = overrides?.[game.id]?.feel?.[curveId];
  if (!f || (f.scale ?? null) !== (game.setting.scale ?? null)) return 1;
  return f.ratio;
}

/**
 * Fusionne la table par défaut et les mesures de l'utilisateur :
 * - 0 mesure  : table par défaut (estimée, "à calibrer")
 * - 1 mesure  : la table par défaut est mise à l'échelle pour passer par ce point
 *               (on garde la FORME estimée, on corrige le NIVEAU)
 * - ≥ 2 mesures : seules les mesures sont utilisées (forme + niveau réels)
 */
export function mergeCalibration(game, overrides) {
  // Une mesure n'est valable que sur l'échelle où elle a été prise : si le jeu
  // change d'échelle (CoD 1–20 → 0.10–4.00), "6" ne veut plus rien dire.
  const scale = game.setting.scale ?? null;
  const pts = (overrides?.[game.id]?.points ?? []).filter((p) => (p.scale ?? null) === scale);
  if (pts.length === 0) return { ...game, calibrationLevel: 'défaut' };

  if (pts.length === 1) {
    const p = pts[0];
    const ratio = p.degPerSec / settingToDegPerSec(game, p.setting);
    const table = game.table.map((t) => ({ setting: t.setting, degPerSec: Math.round(t.degPerSec * ratio * 10) / 10 }));
    return { ...game, table, calibrated: 'partiel', calibrationLevel: 'partiel (1 mesure)' };
  }

  const table = sortBySetting(pts).map(({ setting, degPerSec }) => ({ setting, degPerSec }));
  return { ...game, table, calibrated: true, calibrationLevel: `calibré (${pts.length} mesures)` };
}

/** Vrai si la table est strictement croissante (sinon l'inversion est ambiguë). */
export function isMonotonic(table) {
  const s = sortBySetting(table);
  return s.every((p, i) => i === 0 || p.degPerSec > s[i - 1].degPerSec);
}

/** Recommandations pour tous les jeux à partir d'une sensibilité en °/s. */
export function recommendAll(games, overrides, degPerSec, measuredDeadzone, curveId = 'linear') {
  return games.map((g) => {
    const merged = mergeCalibration(g, overrides);
    const ratio = feelRatio(g, overrides, curveId);
    return {
      id: g.id,
      name: g.name,
      settingLabel: g.setting.label,
      unit: g.setting.unit ?? '',
      calibrationLevel: merged.calibrationLevel,
      monotonic: isMonotonic(merged.table),
      feelRatio: ratio,
      gameCurve: g.responseCurve?.model ?? null,
      ...degPerSecToSetting(merged, degPerSec * ratio),
      deadzone: measuredDeadzone != null ? recommendDeadzone(g, measuredDeadzone) : null,
      deadzoneLabel: g.deadzone?.label,
      curve: g.responseCurve,
    };
  });
}
