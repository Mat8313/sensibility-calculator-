/**
 * storage.js — Persistance localStorage (profil, sessions, calibrations).
 *
 * Tout passe par try/catch : localStorage peut être indisponible (navigation
 * privée stricte, quota plein) et l'app doit rester utilisable sans lui.
 * Clés préfixées "sensilab:" pour ne pas entrer en collision avec d'autres
 * projets hébergés sur le même domaine github.io (même origine = même stockage !).
 */

const PREFIX = 'sensilab:';
export const SCHEMA_VERSION = 1;

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.warn('SensiLab : sauvegarde impossible', e);
    return false;
  }
}

/* Profil : zone morte mesurée, dernière sensibilité retenue */
export const getProfile = () => read('profile', { deadzone: null, rest: null, bestSens: null });
export const saveProfile = (p) => write('profile', p);

/* Sessions : historique complet */
export const getSessions = () => read('sessions', []);
export function saveSession(session) {
  const all = getSessions().filter((s) => s.id !== session.id);
  all.unshift(session);
  return write('sessions', all.slice(0, 50)); // borne : localStorage ≈ 5 Mo par origine
}
export function deleteSession(id) {
  return write('sessions', getSessions().filter((s) => s.id !== id));
}

/* Session en cours : permet de reprendre après un rechargement de page */
export const getActiveSession = () => read('active', null);
export const saveActiveSession = (s) => write('active', s);
export function clearActiveSession() {
  try { localStorage.removeItem(PREFIX + 'active'); } catch { /* ignoré */ }
}

/* Calibrations : { [gameId]: { points: [...] } } */
export const getCalibration = () => read('calibration', {});
export const saveCalibration = (c) => write('calibration', c);

/** Export complet (profil + sessions + calibrations) en JSON. */
export function exportAll() {
  return {
    app: 'SensiLab',
    schema: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    profile: getProfile(),
    sessions: getSessions(),
    calibration: getCalibration(),
  };
}

/**
 * Import : accepte un export complet OU un simple fichier de calibration.
 * On valide la forme avant d'écrire pour ne jamais corrompre les données existantes.
 */
export function importAll(data) {
  if (!data || typeof data !== 'object') throw new Error('Fichier JSON invalide');
  if (data.app === 'SensiLab') {
    if (data.profile) saveProfile(data.profile);
    if (Array.isArray(data.sessions)) write('sessions', data.sessions);
    if (data.calibration) saveCalibration(validateCalibration(data.calibration));
    return 'complet';
  }
  saveCalibration(validateCalibration(data.calibration ?? data));
  return 'calibration';
}

function validateCalibration(c) {
  for (const [id, v] of Object.entries(c)) {
    if (!Array.isArray(v?.points) || !v.points.every((p) => Number.isFinite(p.setting) && Number.isFinite(p.degPerSec))) {
      throw new Error(`Calibration invalide pour "${id}"`);
    }
  }
  return c;
}

/** Déclenche le téléchargement d'un objet en fichier .json. */
export function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url); // libère la mémoire du Blob
}
