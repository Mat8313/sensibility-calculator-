/**
 * ui.js — Écrans, navigation à la manette, graphiques et petits utilitaires DOM.
 *
 * Aucune logique métier ici : ce module affiche et transmet des intentions
 * (clic, retour). Les décisions sont prises dans app.js.
 */

import { BTN } from './gamepad.js';

/* ------------------------------------------------------------------ */
/* Utilitaires DOM                                                     */
/* ------------------------------------------------------------------ */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Échappe le HTML : tout texte venant d'un fichier importé passe par ici (anti-XSS). */
export function esc(v) {
  return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function fmtDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'date inconnue' : d.toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
}

/** "1 itération", "3 itérations" */
export const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;

let toastTimer = null;
export function toast(msg, kind = 'info') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

/* ------------------------------------------------------------------ */
/* Gestion des écrans                                                  */
/* ------------------------------------------------------------------ */

export class Screens {
  constructor() {
    this.current = null;
    this.onShow = {};   // callbacks par écran
    this.backTargets = {}; // écran → écran précédent (bouton ◯)
  }

  show(id) {
    for (const s of $$('.screen')) s.classList.toggle('active', s.id === `screen-${id}`);
    this.current = id;
    this.onShow[id]?.();
    // Focus initial : premier élément marqué data-autofocus, sinon premier bouton
    requestAnimationFrame(() => {
      const scr = $(`#screen-${id}`);
      const el = $('[data-autofocus]:not([disabled])', scr) ?? focusables(scr)[0];
      el?.focus({ preventScroll: false });
    });
  }

  back() {
    const target = this.backTargets[this.current];
    if (typeof target === 'function') target();
    else if (target) this.show(target);
  }
}

/* ------------------------------------------------------------------ */
/* Boîte de dialogue (remplace confirm())                              */
/* ------------------------------------------------------------------ */

/**
 * confirm() natif est inutilisable à la manette : la boîte système ne reçoit
 * pas les événements Gamepad et met même en pause la boucle requestAnimationFrame.
 * On affiche donc une modale HTML et on "piège" la navigation dedans.
 */
let modal = null; // { resolve, previousFocus }

export const isModalOpen = () => modal !== null;

export function confirmDialog(message, { ok = 'Confirmer', cancel = 'Annuler', danger = false } = {}) {
  const okBtn = $('#modal-ok'), cancelBtn = $('#modal-cancel');
  $('#modal-text').textContent = message;
  okBtn.textContent = `${ok} ✕`;
  cancelBtn.textContent = `${cancel} ◯`;
  okBtn.classList.toggle('danger-solid', danger);
  return new Promise((resolve) => {
    if (modal) modal.resolve(false);            // une seule modale à la fois
    modal = { resolve, previousFocus: document.activeElement };
    $('#modal').hidden = false;
    // Action destructrice : focus sur "Annuler", un ✕ réflexe ne détruit rien.
    (danger ? cancelBtn : okBtn).focus();
  });
}

export function closeDialog(result) {
  if (!modal) return;
  const { resolve, previousFocus } = modal;
  modal = null;
  $('#modal').hidden = true;
  previousFocus?.focus?.();
  resolve(result);
}

/** Câblage des boutons de la modale (appelé une fois au démarrage). */
export function initDialog() {
  $('#modal-ok').addEventListener('click', () => closeDialog(true));
  $('#modal-cancel').addEventListener('click', () => closeDialog(false));
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeDialog(false); });
}

/** Éléments navigables : la modale si elle est ouverte, sinon l'écran actif. */
export function focusables(root = isModalOpen() ? $('#modal') : $('.screen.active')) {
  if (!root) return [];
  return $$('button:not([disabled]), input:not([disabled]):not([type=file]), [data-nav]', root)
    .filter((el) => el.offsetParent !== null); // visible
}

/* ------------------------------------------------------------------ */
/* Navigation à la manette                                             */
/* ------------------------------------------------------------------ */

const DIRS = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };

/**
 * Navigation SPATIALE : choisit l'élément le plus proche dans la direction
 * demandée, d'après les rectangles à l'écran. Dans une grille de cartes,
 * "bas" descend d'une ligne au lieu de passer à la carte suivante.
 *
 * Score = distance dans l'axe + 2 × décalage latéral : on préfère un voisin
 * bien aligné à un voisin plus proche mais en diagonale.
 * Fonction pure (rectangles en entrée) : testable sans navigateur.
 *
 * @param {{x:number,y:number,w:number,h:number}} from
 * @param {{x:number,y:number,w:number,h:number}[]} rects
 * @param {'up'|'down'|'left'|'right'} dir
 * @returns {number} index du meilleur candidat, -1 si aucun
 */
export function pickSpatial(from, rects, dir) {
  const d = DIRS[dir];
  const cx = from.x + from.w / 2, cy = from.y + from.h / 2;
  let best = -1, bestScore = Infinity;
  rects.forEach((r, i) => {
    const dx = r.x + r.w / 2 - cx, dy = r.y + r.h / 2 - cy;
    const along = dx * d.x + dy * d.y;            // progression dans la direction
    if (along <= 4) return;                       // derrière ou au même niveau
    const lateral = Math.abs(dx * d.y) + Math.abs(dy * d.x);
    const score = along + 2 * lateral;
    if (score < bestScore) { bestScore = score; best = i; }
  });
  return best;
}

const rectOf = (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
};

/**
 * D-pad ou stick gauche : déplacer le focus (avec répétition si maintenu).
 * ✕ : activer l'élément focalisé. ◯ : retour (ou annuler la modale).
 * Gauche/droite sur un champ numérique : modifier la valeur ; L1/R1 : pas × 10.
 */
export class GamepadNavigator {
  constructor(screens) {
    this.screens = screens;
    this.enabled = true;
    this.heldDir = null;
    this.nextRepeat = 0;
  }

  direction(gp) {
    const s = gp.state;
    if (!s) return null;
    if (s.pressed[BTN.UP]) return 'up';
    if (s.pressed[BTN.DOWN]) return 'down';
    if (s.pressed[BTN.LEFT]) return 'left';
    if (s.pressed[BTN.RIGHT]) return 'right';
    const { x, y } = gp.leftStickRaw();
    if (Math.hypot(x, y) < 0.6) return null; // seuil élevé : évite les déplacements involontaires
    return Math.abs(x) > Math.abs(y) ? (x > 0 ? 'right' : 'left') : (y > 0 ? 'down' : 'up');
  }

  update(gp, now) {
    if (!this.enabled || !gp.state) return;
    document.body.classList.add('using-gamepad');

    const dir = this.direction(gp);
    if (dir !== this.heldDir) {
      this.heldDir = dir;
      if (dir) { this.move(dir); this.nextRepeat = now + 380; }
    } else if (dir && now >= this.nextRepeat) {
      this.move(dir);
      this.nextRepeat = now + 120;
    }

    if (gp.wasPressed(BTN.R1)) this.bigStep(10);
    if (gp.wasPressed(BTN.L1)) this.bigStep(-10);
    if (gp.wasPressed(BTN.CROSS)) this.activate();
    if (gp.wasPressed(BTN.CIRCLE)) {
      if (isModalOpen()) closeDialog(false); else this.screens.back();
    }
  }

  /** Modifie le champ numérique focalisé de n pas. */
  bigStep(n) {
    const el = document.activeElement;
    if (el?.tagName !== 'INPUT' || el.type !== 'number') return;
    if (n > 0) el.stepUp(n); else el.stepDown(-n);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  move(dir) {
    const el = document.activeElement;
    if (el?.tagName === 'INPUT' && el.type === 'number' && (dir === 'left' || dir === 'right')) {
      if (dir === 'right') el.stepUp(); else el.stepDown();
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    const list = focusables();
    if (!list.length) return;
    let next;
    if (!list.includes(el)) next = list[0];
    else {
      const others = list.filter((x) => x !== el);
      const k = pickSpatial(rectOf(el), others.map(rectOf), dir);
      // Rien dans cette direction : on boucle (début ↔ fin de l'écran).
      next = k !== -1 ? others[k] : list[(dir === 'up' || dir === 'left') ? list.length - 1 : 0];
    }
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  activate() {
    const el = document.activeElement;
    if (!el || !focusables().includes(el)) return focusables()[0]?.focus();
    if (el.tagName === 'BUTTON' || el.hasAttribute('data-nav')) el.click();
  }
}

/* ------------------------------------------------------------------ */
/* Canvas : utilitaires et graphiques                                  */
/* ------------------------------------------------------------------ */

/**
 * Adapte la résolution interne du canvas à sa taille CSS × devicePixelRatio.
 * Sans ça, le canvas est net sur un écran 1× mais flou sur un écran Retina.
 */
export function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const { width, height } = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(width * dpr)), h = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: width, h: height };
}

/** Visualisation d'un stick : position brute + anneau de zone morte. */
export function drawStick(canvas, pos, deadzone = 0, label = '') {
  const { ctx, w, h } = fitCanvas(canvas);
  const r = Math.min(w, h) / 2 - 8, cx = w / 2, cy = h / 2;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = '#2a3150'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy); ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r);
  ctx.strokeStyle = '#1b2038'; ctx.stroke();
  if (deadzone > 0) {
    ctx.fillStyle = 'rgba(255,61,127,0.18)';
    ctx.beginPath(); ctx.arc(cx, cy, r * deadzone, 0, Math.PI * 2); ctx.fill();
  }
  const px = cx + pos.x * r, py = cy + pos.y * r;
  ctx.fillStyle = '#00e5ff';
  ctx.shadowColor = '#00e5ff'; ctx.shadowBlur = 12;
  ctx.beginPath(); ctx.arc(px, py, 7, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;
  if (label) {
    ctx.fillStyle = '#9aa4c7'; ctx.font = '12px system-ui, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(label, cx, h - 2); ctx.textAlign = 'left';
  }
}

/**
 * Courbe de progression du score par itération.
 * @param {{score:number, sens:number, kind?:'search'|'validation'}[]} points
 */
export function drawScoreChart(canvas, points) {
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const pad = { l: 40, r: 34, t: 16, b: 40 };
  const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
  if (!points.length) {
    ctx.fillStyle = '#9aa4c7'; ctx.font = '14px system-ui, sans-serif';
    ctx.fillText('Pas encore de données', pad.l, h / 2);
    return;
  }
  const scores = points.map((p) => p.score);
  const yMin = Math.max(0, Math.floor((Math.min(...scores) - 10) / 10) * 10);
  const yMax = Math.min(100, Math.ceil((Math.max(...scores) + 10) / 10) * 10);
  const X = (i) => pad.l + (points.length === 1 ? pw / 2 : (i / (points.length - 1)) * pw);
  const Y = (s) => pad.t + ph - ((s - yMin) / (yMax - yMin || 1)) * ph;

  // Axes et graduations
  ctx.font = '11px system-ui, sans-serif';
  for (let s = yMin; s <= yMax; s += 10) {
    ctx.strokeStyle = '#1b2038'; ctx.beginPath(); ctx.moveTo(pad.l, Y(s)); ctx.lineTo(w - pad.r, Y(s)); ctx.stroke();
    ctx.fillStyle = '#6b7499'; ctx.fillText(String(s), 8, Y(s) + 4);
  }

  // Séparateur recherche / validation
  const firstVal = points.findIndex((p) => p.kind === 'validation');
  if (firstVal > 0) {
    const x = (X(firstVal - 1) + X(firstVal)) / 2;
    ctx.setLineDash([4, 4]); ctx.strokeStyle = '#3a4270';
    ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + ph); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#6b7499'; ctx.fillText('validation', x + 4, pad.t + 10);
  }

  // Ligne de la phase de recherche
  const search = points.map((p, i) => ({ ...p, i })).filter((p) => p.kind !== 'validation');
  ctx.strokeStyle = '#00e5ff'; ctx.lineWidth = 2;
  ctx.beginPath();
  search.forEach((p, k) => (k ? ctx.lineTo(X(p.i), Y(p.score)) : ctx.moveTo(X(p.i), Y(p.score))));
  ctx.stroke();

  // Points + étiquettes (score au-dessus, °/s en dessous)
  points.forEach((p, i) => {
    const color = p.kind === 'validation' ? '#b388ff' : '#00e5ff';
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(X(i), Y(p.score), 5, 0, Math.PI * 2); ctx.fill();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#e8ecff'; ctx.fillText(p.score.toFixed(0), X(i), Y(p.score) - 9);
    ctx.fillStyle = '#9aa4c7'; ctx.fillText(`${p.sens}°/s`, X(i), h - pad.b + 18);
    ctx.fillStyle = '#6b7499'; ctx.fillText(p.kind === 'validation' ? `V${i - firstVal + 1}` : `#${i + 1}`, X(i), h - pad.b + 32);
    ctx.textAlign = 'left';
  });
  ctx.lineWidth = 1;
}
