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
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Fichier JSON invalide');
  if (data.app === 'SensiLab') {
    // 1) Tout valider (lève une erreur au moindre défaut)…
    const profile = data.profile ? validateProfile(data.profile) : null;
    const sessions = Array.isArray(data.sessions) ? data.sessions.map(validateSession) : null;
    const calibration = data.calibration ? validateCalibration(data.calibration) : null;
    // 2) … puis tout écrire : un fichier à moitié faux ne corrompt rien (import atomique).
    if (profile) saveProfile(profile);
    if (sessions) write('sessions', sessions);
    if (calibration) saveCalibration(calibration);
    return 'complet';
  }
  saveCalibration(validateCalibration(data.calibration ?? data));
  return 'calibration';
}

/* ---- Validation ----
 * Un fichier importé est une donnée NON FIABLE : ses valeurs finissent dans le
 * DOM. On reconstruit chaque objet champ par champ avec des types vérifiés
 * (liste blanche), au lieu de recopier l'objet tel quel. */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const numOrNull = (v, name) => {
  if (v === null || v === undefined) return null;
  if (!isNum(v)) throw new Error(`Valeur invalide : ${name}`);
  return v;
};
const fail = (msg) => { throw new Error(msg); };

export function validateCalibration(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) fail('Calibration invalide');
  const out = {};
  for (const [id, v] of Object.entries(c)) {
    if (!/^[a-z0-9_-]{1,40}$/i.test(id)) fail(`Identifiant de jeu invalide : "${id.slice(0, 40)}"`);
    if (!Array.isArray(v?.points)) fail(`Calibration invalide pour "${id}"`);
    out[id] = {
      points: v.points.map((p) => {
        if (!isNum(p?.setting) || !isNum(p?.degPerSec) || p.degPerSec <= 0) fail(`Point de calibration invalide pour "${id}"`);
        return { setting: p.setting, degPerSec: p.degPerSec, date: typeof p.date === 'string' ? p.date.slice(0, 40) : null };
      }),
    };
  }
  return out;
}

export function validateProfile(p) {
  if (typeof p !== 'object' || Array.isArray(p)) fail('Profil invalide');
  const dz = numOrNull(p.deadzone, 'zone morte');
  if (dz !== null && (dz < 0 || dz >= 0.5)) fail('Zone morte hors plage');
  let rest = null;
  if (p.rest) {
    rest = {};
    for (const k of ['drift', 'noise', 'maxRadius', 'recommended', 'driftX', 'driftY', 'count']) {
      rest[k] = numOrNull(p.rest[k], `profil.${k}`) ?? 0;
    }
  }
  return { deadzone: dz, rest, bestSens: numOrNull(p.bestSens, 'sensibilité') };
}

const validateEntry = (e, i) => {
  if (!isNum(e?.sens) || !isNum(e?.score)) fail(`Itération ${i + 1} invalide`);
  return {
    sens: e.sens, score: e.score,
    tendency: numOrNull(e.tendency, 'tendance') ?? 0,
    parts: e.parts && typeof e.parts === 'object'
      ? { tracking: numOrNull(e.parts.tracking, 'score') ?? 0, flick: numOrNull(e.parts.flick, 'score') ?? 0, precision: numOrNull(e.parts.precision, 'score') ?? 0 }
      : { tracking: 0, flick: 0, precision: 0 },
    role: typeof e.role === 'string' ? e.role.slice(0, 20) : undefined,
  };
};

export function validateSession(s, i = 0) {
  if (!s || typeof s !== 'object') fail(`Session ${i + 1} invalide`);
  if (!isNum(s.best) || s.best <= 0 || !isNum(s.bestScore)) fail(`Session ${i + 1} : résultat manquant`);
  if (!Array.isArray(s.iterations)) fail(`Session ${i + 1} : itérations manquantes`);
  return {
    id: typeof s.id === 'string' ? s.id.slice(0, 40) : `import${Date.now()}${i}`,
    date: typeof s.date === 'string' ? s.date.slice(0, 40) : new Date().toISOString(),
    deadzone: numOrNull(s.deadzone, 'zone morte'),
    phase: 'done',
    best: s.best,
    bestScore: s.bestScore,
    iterations: s.iterations.map(validateEntry),
    validation: { results: Array.isArray(s.validation?.results) ? s.validation.results.map(validateEntry) : [] },
  };
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
