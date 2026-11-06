/**
 * gamepad.js — Accès à la manette via l'API Gamepad du navigateur.
 *
 * Points clés :
 * - L'API Gamepad ne pousse PAS d'événements à chaque mouvement : il faut
 *   "sonder" (poll) l'état à chaque frame avec navigator.getGamepads().
 *   On centralise donc ce poll dans UNE seule boucle (app.js) pour que tous
 *   les consommateurs (navigation, tests) voient le même état sur une frame.
 * - Chrome n'expose la manette qu'après un premier appui sur un bouton
 *   (protection anti-fingerprinting), d'où l'écran "appuie sur un bouton".
 * - Avec mapping === "standard", une DualSense en USB suit la disposition
 *   W3C ci-dessous (Chrome/Edge). Firefox peut renvoyer un mapping vide.
 */

/** Indices des boutons en "standard mapping" (disposition PlayStation). */
export const BTN = Object.freeze({
  CROSS: 0, CIRCLE: 1, SQUARE: 2, TRIANGLE: 3,
  L1: 4, R1: 5, L2: 6, R2: 7,
  SHARE: 8, OPTIONS: 9, L3: 10, R3: 11,
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
  PS: 16, TOUCHPAD: 17,
});

/** Indices des axes en "standard mapping". */
export const AXIS = Object.freeze({ LX: 0, LY: 1, RX: 2, RY: 3 });

/** Seuil de gâchette analogique (R2) considéré comme "tir". */
const TRIGGER_THRESHOLD = 0.5;

/**
 * Zone morte radiale avec remise à l'échelle.
 * Radiale (sur la norme du vecteur) plutôt qu'axiale : une zone morte par axe
 * crée des "rails" horizontaux/verticaux qui faussent la visée en diagonale.
 * La remise à l'échelle évite le "saut" en sortie de zone morte :
 * la sortie part de 0 juste après le seuil et atteint 1 stick à fond.
 *
 * @param {number} x  axe brut [-1, 1]
 * @param {number} y  axe brut [-1, 1]
 * @param {number} dz rayon de zone morte [0, 1)
 * @returns {{x:number, y:number, mag:number}}
 */
export function applyRadialDeadzone(x, y, dz) {
  const mag = Math.hypot(x, y);
  if (mag <= dz || mag === 0) return { x: 0, y: 0, mag: 0 };
  const clamped = Math.min(1, mag);            // un stick physique peut dépasser 1 en diagonale
  const scaled = (clamped - dz) / (1 - dz);
  return { x: (x / mag) * scaled, y: (y / mag) * scaled, mag: scaled };
}

/**
 * Analyse des échantillons du stick au repos (mesure de drift).
 * - drift : position moyenne au repos (un stick neuf est ~0, un stick usé dérive)
 * - noise : écart-type autour de cette moyenne (tremblement du capteur)
 * - maxRadius : plus grande norme observée → c'est elle que la zone morte doit couvrir
 * - recommended : zone morte conseillée = maxRadius + marge, bornée
 *
 * @param {{x:number,y:number}[]} samples
 */
export function analyzeRestSamples(samples) {
  if (!samples.length) {
    return { driftX: 0, driftY: 0, drift: 0, noise: 0, maxRadius: 0, recommended: 0.05, count: 0 };
  }
  let sx = 0, sy = 0, maxR = 0;
  for (const s of samples) {
    sx += s.x; sy += s.y;
    maxR = Math.max(maxR, Math.hypot(s.x, s.y));
  }
  const driftX = sx / samples.length;
  const driftY = sy / samples.length;
  let v = 0;
  for (const s of samples) v += (s.x - driftX) ** 2 + (s.y - driftY) ** 2;
  const noise = Math.sqrt(v / samples.length);
  // Marge de 15 % + 0,01 : le drift varie avec la température et l'usure.
  const recommended = Math.min(0.3, Math.max(0.02, maxR * 1.15 + 0.01));
  return {
    driftX, driftY,
    drift: Math.hypot(driftX, driftY),
    noise, maxRadius: maxR,
    recommended: Math.round(recommended * 1000) / 1000,
    count: samples.length,
  };
}

/**
 * Gestionnaire de manette : sonde l'état une fois par frame et calcule les
 * fronts montants (bouton "vient d'être pressé") pour la navigation et le tir.
 */
export class GamepadManager extends EventTarget {
  constructor() {
    super();
    /** @type {number|null} index de la manette suivie */
    this.index = null;
    this.state = null;
    this._prevPressed = [];
    this._prevTrigger = false;
    this.deadzone = 0.05;

    window.addEventListener('gamepadconnected', (e) => {
      if (this.index === null) this.index = e.gamepad.index;
      this.dispatchEvent(new CustomEvent('connected', { detail: e.gamepad }));
    });
    window.addEventListener('gamepaddisconnected', (e) => {
      if (e.gamepad.index === this.index) {
        this.index = null;
        this.state = null;
        this.dispatchEvent(new CustomEvent('disconnected', { detail: e.gamepad }));
      }
    });
  }

  /** Retourne la manette active (ou la première connectée). */
  _findPad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    if (this.index !== null && pads[this.index]) return pads[this.index];
    for (const p of pads) {
      if (p && p.connected) { this.index = p.index; return p; }
    }
    return null;
  }

  /**
   * À appeler UNE fois par frame. Copie l'état (l'objet Gamepad de Chrome est
   * un instantané : il faut le relire à chaque frame, pas le garder).
   */
  poll() {
    const gp = this._findPad();
    if (!gp) { this.state = null; this._prevPressed = []; return null; }

    const pressed = gp.buttons.map((b) => b.pressed);
    const values = gp.buttons.map((b) => b.value);
    // Premier poll après (re)connexion : le bouton qui a "réveillé" la manette
    // ne doit pas compter comme un appui, sinon il validerait l'écran suivant.
    const firstPoll = this._prevPressed.length === 0;
    const justPressed = pressed.map((p, i) => p && !firstPoll && !this._prevPressed[i]);
    this._prevPressed = pressed;

    // R2 : on applique notre propre seuil sur la valeur analogique,
    // le seuil "pressed" du navigateur varie selon l'OS.
    const r2Down = (values[BTN.R2] ?? 0) > TRIGGER_THRESHOLD;
    const firePressed = r2Down && !this._prevTrigger;
    this._prevTrigger = r2Down;

    this._pad = gp; // gardé uniquement pour la vibration (l'état, lui, est copié)
    this.state = {
      id: gp.id,
      mapping: gp.mapping,
      axes: Array.from(gp.axes),
      pressed, values, justPressed,
      firePressed,
    };
    return this.state;
  }

  get connected() { return this.state !== null; }

  /** Stick droit brut (sans zone morte), pour la mesure de drift. */
  rightStickRaw() {
    if (!this.state) return { x: 0, y: 0 };
    return { x: this.state.axes[AXIS.RX] ?? 0, y: this.state.axes[AXIS.RY] ?? 0 };
  }

  leftStickRaw() {
    if (!this.state) return { x: 0, y: 0 };
    return { x: this.state.axes[AXIS.LX] ?? 0, y: this.state.axes[AXIS.LY] ?? 0 };
  }

  /** Stick droit après zone morte radiale. */
  rightStick() {
    const r = this.rightStickRaw();
    return applyRadialDeadzone(r.x, r.y, this.deadzone);
  }

  /**
   * Vibration courte (retour de tir). Chrome/Edge exposent "dual-rumble" sur
   * DualSense ; ailleurs l'appel est simplement ignoré. playEffect renvoie une
   * promesse qu'on ne doit pas laisser échouer bruyamment.
   */
  rumble(duration = 40, strong = 0.2, weak = 0.6) {
    const act = this._pad?.vibrationActuator;
    if (!this.state || !act?.playEffect) return;
    act.playEffect('dual-rumble', { duration, strongMagnitude: strong, weakMagnitude: weak }).catch(() => {});
  }

  wasPressed(btn) { return !!this.state?.justPressed[btn]; }
  isDown(btn) { return !!this.state?.pressed[btn]; }
  anyPressed() { return !!this.state?.justPressed.some(Boolean); }
}
