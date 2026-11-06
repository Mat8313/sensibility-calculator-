/**
 * tests.js — Tests de visée sur canvas 2D (vue FPS simulée).
 *
 * Modèle de caméra : le stick droit pilote une VITESSE angulaire
 *   yaw   += stick.x × sens × dt     (sens en °/s stick à fond, réponse linéaire)
 *   pitch -= stick.y × sens × dt     (axe Y du stick : haut = négatif)
 * Les cibles vivent dans l'espace angulaire (yaw, pitch) du monde, comme dans
 * un vrai FPS : la cible ne bouge pas quand tu tournes, c'est la vue qui tourne.
 *
 * Chaque test expose step(dt, input), draw(r) et results() : la mesure est
 * séparée du score (optimizer.js) pour pouvoir ajuster la notation sans
 * toucher à la simulation.
 */

export const FOV = 90; // champ de vision horizontal (°), proche des FPS console

/** Durées (s). ?rapide dans l'URL les raccourcit pour développer/tester. */
const QUICK = typeof location !== 'undefined' && new URLSearchParams(location.search).has('rapide');
export const DURATIONS = QUICK
  ? { tracking: 5, flick: 6, precision: 6 }
  : { tracking: 15, flick: 30, precision: 30 };

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const rand = (a, b) => a + Math.random() * (b - a);

/** Ramène un angle dans ]-180, 180]. */
export function wrapDeg(a) {
  return ((((a + 180) % 360) + 360) % 360) - 180;
}

/** Caméra pilotée en vitesse angulaire. */
export class Camera {
  constructor(sens) { this.sens = sens; this.yaw = 0; this.pitch = 0; }
  update(stick, dt) {
    this.yaw = wrapDeg(this.yaw + stick.x * this.sens * dt);
    this.pitch = clamp(this.pitch - stick.y * this.sens * dt, -80, 80);
  }
  /** Vecteur d'erreur (°) caméra → point du monde. */
  errorTo(p) { return { x: wrapDeg(p.yaw - this.yaw), y: p.pitch - this.pitch }; }
}

const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

/* ------------------------------------------------------------------ */
/* Rendu                                                               */
/* ------------------------------------------------------------------ */

/** Dessine la scène : grille angulaire, cibles, réticule, HUD. */
export class Renderer {
  constructor(ctx, width, height) {
    this.ctx = ctx;
    this.resize(width, height);
  }

  resize(w, h) {
    this.w = w; this.h = h;
    // Focale d'une projection rectilinéaire : x = f·tan(angle)
    this.f = (w / 2) / Math.tan((FOV / 2) * Math.PI / 180);
  }

  /** Angle relatif (°) → position écran ; null si derrière / hors champ. */
  project(dx, dy) {
    if (Math.abs(dx) >= 89 || Math.abs(dy) >= 89) return null;
    const r = Math.PI / 180;
    return { x: this.w / 2 + this.f * Math.tan(dx * r), y: this.h / 2 - this.f * Math.tan(dy * r) };
  }

  radiusPx(deg) { return this.f * Math.tan(deg * Math.PI / 180); }

  background(cam) {
    const { ctx, w, h } = this;
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#0b1020'); g.addColorStop(1, '#05060c');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // Grille tous les 10° : elle donne la sensation de rotation (repères fixes du monde)
    ctx.lineWidth = 1;
    for (let a = -180; a < 180; a += 10) {
      const dx = wrapDeg(a - cam.yaw);
      if (Math.abs(dx) > FOV / 2 + 5) continue;
      const p = this.project(dx, 0);
      if (!p) continue;
      const major = a % 90 === 0;
      ctx.strokeStyle = major ? 'rgba(0,229,255,0.35)' : 'rgba(120,140,200,0.12)';
      ctx.beginPath(); ctx.moveTo(p.x, 0); ctx.lineTo(p.x, h); ctx.stroke();
      if (major) {
        ctx.fillStyle = 'rgba(0,229,255,0.6)';
        ctx.font = '12px system-ui, sans-serif';
        ctx.fillText(`${(a + 360) % 360}°`, p.x + 4, 16);
      }
    }
    for (let a = -80; a <= 80; a += 10) {
      const dy = a - cam.pitch;
      if (Math.abs(dy) > 70) continue;
      const p = this.project(0, dy);
      if (!p) continue;
      ctx.strokeStyle = a === 0 ? 'rgba(255,61,127,0.35)' : 'rgba(120,140,200,0.10)';
      ctx.beginPath(); ctx.moveTo(0, p.y); ctx.lineTo(w, p.y); ctx.stroke();
    }
  }

  target(cam, t, radiusDeg, color = '#ff3d7f', active = false) {
    const e = cam.errorTo(t);
    const p = this.project(e.x, e.y);
    const { ctx } = this;
    if (!p || p.x < -50 || p.x > this.w + 50 || p.y < -50 || p.y > this.h + 50) {
      this.offscreenArrow(e, color);
      return;
    }
    const r = Math.max(3, this.radiusPx(radiusDeg));
    ctx.save();
    ctx.shadowColor = color; ctx.shadowBlur = active ? 25 : 12;
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(p.x, p.y, r * 0.45, 0, Math.PI * 2); ctx.stroke();
  }

  /** Flèche au bord de l'écran vers une cible hors champ. */
  offscreenArrow(e, color) {
    const { ctx, w, h } = this;
    const ang = Math.atan2(-e.y, e.x);
    const R = Math.min(w, h) / 2 - 30;
    const x = w / 2 + Math.cos(ang) * R, y = h / 2 + Math.sin(ang) * R;
    ctx.save();
    ctx.translate(x, y); ctx.rotate(ang);
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.moveTo(14, 0); ctx.lineTo(-8, -9); ctx.lineTo(-8, 9); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  crosshair(onTarget) {
    const { ctx, w, h } = this;
    const c = onTarget ? '#39ff88' : '#ffffff';
    ctx.strokeStyle = c; ctx.lineWidth = 2;
    const cx = w / 2, cy = h / 2;
    ctx.beginPath();
    ctx.moveTo(cx - 12, cy); ctx.lineTo(cx - 4, cy);
    ctx.moveTo(cx + 4, cy); ctx.lineTo(cx + 12, cy);
    ctx.moveTo(cx, cy - 12); ctx.lineTo(cx, cy - 4);
    ctx.moveTo(cx, cy + 4); ctx.lineTo(cx, cy + 12);
    ctx.stroke();
    ctx.fillStyle = c; ctx.fillRect(cx - 1, cy - 1, 2, 2);
  }

  hud(title, timeLeft, duration, info) {
    const { ctx, w } = this;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, w, 44);
    ctx.fillStyle = '#e8ecff';
    ctx.font = '600 16px system-ui, sans-serif';
    ctx.fillText(title, 16, 28);
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.max(0, timeLeft).toFixed(1)} s`, w - 16, 28);
    ctx.font = '14px system-ui, sans-serif';
    ctx.fillStyle = '#9aa4c7';
    if (info) ctx.fillText(info, w - 90, 28);
    ctx.textAlign = 'left';
    // Barre de temps
    ctx.fillStyle = '#00e5ff';
    ctx.fillRect(0, 42, w * clamp(timeLeft / duration, 0, 1), 2);
  }

  overlay(lines) {
    const { ctx, w, h } = this;
    ctx.fillStyle = 'rgba(5,6,12,0.72)';
    ctx.fillRect(0, 0, w, h);
    ctx.textAlign = 'center';
    lines.forEach((l, i) => {
      ctx.fillStyle = l.color ?? '#e8ecff';
      ctx.font = l.font ?? '16px system-ui, sans-serif';
      ctx.fillText(l.text, w / 2, h / 2 - (lines.length * 18) + i * 36);
    });
    ctx.textAlign = 'left';
  }
}

/* ------------------------------------------------------------------ */
/* Base commune                                                        */
/* ------------------------------------------------------------------ */

class AimTest {
  constructor(sens, duration) {
    this.cam = new Camera(sens);
    this.duration = duration;
    this.t = 0;
    this.done = false;
    this.moveTime = 0;   // temps avec stick incliné (> 10 %)
    this.satTime = 0;    // temps avec stick à fond (> 95 %)
  }

  get timeLeft() { return this.duration - this.t; }

  step(dt, input) {
    if (this.done) return;
    dt = Math.min(dt, 0.05); // une frame lente (onglet en arrière-plan) ne doit pas "téléporter" la caméra
    this.t += dt;
    this.cam.update(input.stick, dt);
    if (input.stick.mag > 0.1) {
      this.moveTime += dt;
      if (input.stick.mag > 0.95) this.satTime += dt;
    }
    this.onStep(dt, input);
    if (this.t >= this.duration) this.done = true;
  }

  get saturation() { return this.moveTime > 0 ? this.satTime / this.moveTime : 0; }
}

/**
 * Suivi d'une cible vers laquelle on vise, utilisé par Flick et Précision :
 * détecte dépassements (overshoot), corrections et arrêts prématurés.
 */
class TargetTracker {
  constructor(cam, target, radius, t0) {
    this.target = target;
    this.radius = radius;
    this.t0 = t0;
    const e = cam.errorTo(target);
    this.d0 = Math.hypot(e.x, e.y);
    this.u = { x: e.x / this.d0, y: e.y / this.d0 };  // direction initiale de l'approche
    this.inside = false;
    this.over = false;
    this.entries = 0;
    this.overshoots = 0;
    this.maxOvershoot = 0;
    this.stalls = 0;
    this.stillTime = 0;
    this.stalled = false;
    this.moveStart = null;
    this.reachTime = null;
    this.firstEnter = null;
    this.insideSince = null;
    this.stabilizedAt = null;
  }

  update(cam, t, stickMag, dt) {
    const e = cam.errorTo(this.target);
    const dist = Math.hypot(e.x, e.y);
    const along = e.x * this.u.x + e.y * this.u.y; // > 0 : cible encore devant ; < 0 : dépassée
    const inside = dist < this.radius;

    if (this.moveStart === null && stickMag > 0.2) this.moveStart = t;

    if (inside && !this.inside) {
      this.entries++;
      if (this.firstEnter === null) { this.firstEnter = t; this.reachTime = t - this.t0; }
      this.insideSince = t;
    }
    if (!inside) this.insideSince = null;
    if (inside && this.stabilizedAt === null && t - this.insideSince >= 0.25) this.stabilizedAt = t;
    this.inside = inside;

    // Overshoot : la visée passe au-delà de la cible, dans le sens de l'approche
    const over = along < -this.radius;
    if (over && !this.over) this.overshoots++;
    if (over) this.maxOvershoot = Math.max(this.maxOvershoot, -along);
    this.over = over;

    // Undershoot : arrêt du stick avant d'avoir atteint la cible
    if (this.firstEnter === null && this.moveStart !== null && along > 2 * this.radius) {
      if (stickMag < 0.15) {
        this.stillTime += dt;
        if (this.stillTime > 0.12 && !this.stalled) { this.stalls++; this.stalled = true; }
      } else { this.stillTime = 0; this.stalled = false; }
    }
    return { dist, inside };
  }
}

/* ------------------------------------------------------------------ */
/* 1. Tracking                                                         */
/* ------------------------------------------------------------------ */

export class TrackingTest extends AimTest {
  static title = 'Tracking';
  static instructions = 'Garde le réticule sur la cible qui se déplace.';

  constructor(sens, duration = DURATIONS.tracking) {
    super(sens, duration);
    this.radius = 2.5;
    // Somme de sinusoïdes à phases aléatoires : trajectoire fluide mais imprévisible.
    // Vitesse max ≈ 40·0,9 + 25·2,1 ≈ 88 °/s en lacet.
    const p = () => rand(0, Math.PI * 2);
    this.params = { p1: p(), p2: p(), p3: p(), p4: p(), dir: Math.random() < 0.5 ? 1 : -1 };
    this.origin = this.path(0);
    this.onTime = 0; this.errSum = 0;
    this.satLagTime = 0; this.aheadTime = 0;
    this.lastOn = false;
  }

  path(t) {
    const { p1, p2, p3, p4, dir } = this.params;
    return {
      yaw: dir * (40 * Math.sin(0.9 * t + p1) + 25 * Math.sin(2.1 * t + p2)),
      pitch: 8 * Math.sin(1.3 * t + p3) + 4 * Math.sin(2.7 * t + p4),
    };
  }

  /** Position monde : la trajectoire démarre sous le réticule. */
  targetAt(t) {
    const p = this.path(t);
    return { yaw: wrapDeg(p.yaw - this.origin.yaw), pitch: p.pitch - this.origin.pitch };
  }

  onStep(dt, input) {
    const tg = this.targetAt(this.t);
    const e = this.cam.errorTo(tg);
    const dist = Math.hypot(e.x, e.y);
    this.lastOn = dist < this.radius;
    if (this.lastOn) this.onTime += dt;
    this.errSum += dist * dt;

    // Vitesse de la cible (dérivée numérique) pour savoir si on est devant ou derrière
    const a = this.targetAt(this.t - 0.02), b = this.targetAt(this.t + 0.02);
    const vx = wrapDeg(b.yaw - a.yaw) / 0.04, vy = (b.pitch - a.pitch) / 0.04;
    const speed = Math.hypot(vx, vy);
    if (speed > 10) {
      const along = (e.x * vx + e.y * vy) / speed; // > 0 : cible devant (retard)
      // Retard + stick à fond = la sensibilité limite le joueur (signal fiable).
      if (along > this.radius && input.stick.mag > 0.95) this.satLagTime += dt;
      if (along < -this.radius) this.aheadTime += dt;
    }
  }

  draw(r) {
    r.background(this.cam);
    r.target(this.cam, this.targetAt(this.t), this.radius, this.lastOn ? '#39ff88' : '#ff3d7f', this.lastOn);
    r.crosshair(this.lastOn);
    r.hud(TrackingTest.title, this.timeLeft, this.duration, `${Math.round(100 * this.onTime / Math.max(this.t, 1e-3))} % sur cible`);
  }

  results() {
    const T = Math.max(this.t, 1e-3);
    return {
      onTargetRatio: this.onTime / T,
      meanError: this.errSum / T,
      satLagRatio: this.satLagTime / T,
      aheadRatio: this.aheadTime / T,
      saturation: this.saturation,
    };
  }
}

/* ------------------------------------------------------------------ */
/* 2. Flicks                                                           */
/* ------------------------------------------------------------------ */

export class FlickTest extends AimTest {
  static title = 'Flicks';
  static instructions = 'Vise la cible le plus vite possible et tire avec R2.';

  constructor(sens, duration = DURATIONS.flick) {
    super(sens, duration);
    this.radius = 3;
    this.timeout = 4;
    this.records = [];
    this.missShots = 0;
    this.shots = 0;
    this.gap = 0.25;     // pause entre deux cibles
    this.waitUntil = 0;
    this.tracker = null;
  }

  spawn() {
    // Angle aléatoire entre 25° et 100°, étalé surtout à l'horizontale (comme en jeu)
    const d = rand(25, 100), th = rand(0, Math.PI * 2);
    const target = {
      yaw: wrapDeg(this.cam.yaw + d * Math.cos(th)),
      pitch: clamp(this.cam.pitch + clamp(d * Math.sin(th) * 0.35, -30, 30), -60, 60),
    };
    this.tracker = new TargetTracker(this.cam, target, this.radius, this.t);
  }

  finish(hit) {
    const k = this.tracker;
    const moveDur = k.reachTime !== null && k.moveStart !== null ? k.firstEnter - k.moveStart : null;
    this.records.push({
      hit, distance: k.d0,
      hitTime: hit ? this.t - k.t0 : null,
      reachTime: k.reachTime,
      // Utilisation : vitesse moyenne réelle / vitesse max possible (1 = stick à fond tout le trajet)
      utilization: moveDur > 0.05 ? clamp((k.d0 - this.radius) / moveDur / this.cam.sens, 0, 1) : null,
      overshoots: k.overshoots,
      corrections: Math.max(0, k.entries - 1),
      stalls: k.stalls,
    });
    this.tracker = null;
    this.waitUntil = this.t + this.gap;
  }

  onStep(dt, input) {
    if (!this.tracker) {
      if (this.t >= this.waitUntil) this.spawn();
      return;
    }
    const { inside } = this.tracker.update(this.cam, this.t, input.stick.mag, dt);
    if (input.fire) {
      this.shots++;
      if (inside) return this.finish(true);
      this.missShots++;
    }
    if (this.t - this.tracker.t0 > this.timeout) this.finish(false);
  }

  draw(r) {
    r.background(this.cam);
    const on = this.tracker?.inside;
    if (this.tracker) r.target(this.cam, this.tracker.target, this.radius, on ? '#39ff88' : '#ffb020', on);
    r.crosshair(on);
    r.hud(FlickTest.title, this.timeLeft, this.duration, `${this.records.filter((x) => x.hit).length} touchées`);
  }

  results() {
    const hits = this.records.filter((r) => r.hit);
    const n = Math.max(1, this.records.length);
    const utils = this.records.map((r) => r.utilization).filter((u) => u !== null);
    return {
      targets: this.records.length,
      hits: hits.length,
      timeouts: this.records.length - hits.length,
      shots: this.shots,
      missRate: this.shots ? this.missShots / this.shots : 0,
      avgHitTime: mean(hits.map((r) => r.hitTime)),
      avgReachTime: mean(this.records.filter((r) => r.reachTime !== null).map((r) => r.reachTime)),
      overshootRate: this.records.reduce((a, r) => a + r.overshoots, 0) / n,
      correctionRate: this.records.reduce((a, r) => a + r.corrections, 0) / n,
      undershootRate: this.records.reduce((a, r) => a + r.stalls, 0) / n,
      utilization: utils.length ? mean(utils) : null,
      saturation: this.saturation,
    };
  }
}

/* ------------------------------------------------------------------ */
/* 3. Précision                                                        */
/* ------------------------------------------------------------------ */

export class PrecisionTest extends AimTest {
  static title = 'Précision';
  static instructions = 'Petites cibles : stabilise-toi dessus, puis tire avec R2 (1 tir par cible).';

  constructor(sens, duration = DURATIONS.precision) {
    super(sens, duration);
    this.radius = 0.8;
    this.timeout = 5;
    this.records = [];
    this.tracker = null;
    this.waitUntil = 0;
  }

  spawn() {
    const d = rand(4, 15), th = rand(0, Math.PI * 2);
    const target = {
      yaw: wrapDeg(this.cam.yaw + d * Math.cos(th)),
      pitch: clamp(this.cam.pitch + d * Math.sin(th) * 0.6, -60, 60),
    };
    this.tracker = new TargetTracker(this.cam, target, this.radius, this.t);
  }

  finish(shot, dist) {
    const k = this.tracker;
    const end = this.t;
    let stab;
    if (k.firstEnter === null) stab = end - k.t0;                       // jamais atteinte
    else if (k.stabilizedAt !== null) stab = k.stabilizedAt - 0.25 - k.firstEnter;
    else stab = end - k.firstEnter;                                      // jamais stabilisée
    this.records.push({
      shot, hit: shot && dist < this.radius, error: dist,
      timeToShot: end - k.t0, stabTime: Math.max(0, stab), overshoots: k.overshoots,
    });
    this.tracker = null;
    this.waitUntil = this.t + 0.3;
  }

  onStep(dt, input) {
    if (!this.tracker) {
      if (this.t >= this.waitUntil) this.spawn();
      return;
    }
    const { dist } = this.tracker.update(this.cam, this.t, input.stick.mag, dt);
    if (input.fire) return this.finish(true, dist);
    if (this.t - this.tracker.t0 > this.timeout) this.finish(false, dist);
  }

  draw(r) {
    r.background(this.cam);
    const on = this.tracker?.inside;
    if (this.tracker) r.target(this.cam, this.tracker.target, this.radius, on ? '#39ff88' : '#b388ff', on);
    r.crosshair(on);
    const hits = this.records.filter((x) => x.hit).length;
    r.hud(PrecisionTest.title, this.timeLeft, this.duration, `${hits}/${this.records.length}`);
  }

  results() {
    const shots = this.records.filter((r) => r.shot);
    const n = Math.max(1, this.records.length);
    return {
      targets: this.records.length,
      shots: shots.length,
      hits: shots.filter((r) => r.hit).length,
      // Les cibles expirées comptent comme ratées : sinon ne tirer qu'"à coup sûr" donnerait 100 %.
      accuracy: this.records.length ? shots.filter((r) => r.hit).length / this.records.length : 0,
      timeouts: this.records.length - shots.length,
      avgStabTime: mean(this.records.map((r) => r.stabTime)),
      avgShotError: mean(shots.map((r) => r.error)),
      avgTimeToShot: mean(shots.map((r) => r.timeToShot)),
      overshootRate: this.records.reduce((a, r) => a + r.overshoots, 0) / n,
      saturation: this.saturation,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Série = Tracking → Flicks → Précision, avec écrans de transition    */
/* ------------------------------------------------------------------ */

export const SERIES = [
  { key: 'tracking', Test: TrackingTest },
  { key: 'flick', Test: FlickTest },
  { key: 'precision', Test: PrecisionTest },
];

/**
 * Enchaîne les 3 tests pour UNE sensibilité.
 * Phases : intro (attend ✕) → countdown (3 s) → running → (test suivant) → done.
 * La sensibilité n'est PAS affichée pendant les tests : connaître la valeur
 * biaise le joueur ("c'est censé être trop rapide").
 */
export class SeriesRunner {
  constructor(sens, { label = '' } = {}) {
    this.sens = sens;
    this.label = label;
    this.index = 0;
    this.phase = 'intro';     // intro | countdown | running | paused | resuming | done
    this.countdown = 3;
    this.test = null;
    this.results = {};
    this.done = false;
    this.pauseReason = '';
    this.idleCam = new Camera(sens); // évite d'allouer une caméra par frame sur les écrans d'intro
  }

  get current() { return SERIES[this.index]; }

  /**
   * Met le test en pause (fenêtre quittée, manette déconnectée, bouton Options).
   * Le temps du test ne s'écoule plus : les mesures restent valides.
   * Une pause pendant le compte à rebours ramène simplement à l'intro.
   */
  pause(reason = 'Pause') {
    if (this.phase === 'running' || this.phase === 'resuming') {
      this.phase = 'paused';
      this.pauseReason = reason;
    } else if (this.phase === 'countdown') {
      this.phase = 'intro';
    }
  }

  get paused() { return this.phase === 'paused'; }

  frame(dt, input) {
    if (this.done) return;
    switch (this.phase) {
      case 'intro':
        if (input.confirm) { this.phase = 'countdown'; this.countdown = 3; }
        break;
      case 'countdown':
        this.countdown -= dt;
        if (this.countdown <= 0) { this.phase = 'running'; this.test = new this.current.Test(this.sens); }
        break;
      case 'paused':
        // Reprise avec un court compte à rebours : le joueur replace son pouce avant que le temps reparte.
        if (input.confirm) { this.phase = 'resuming'; this.countdown = 2; }
        break;
      case 'resuming':
        this.countdown -= dt;
        if (this.countdown <= 0) this.phase = 'running';
        break;
      case 'running':
        this.test.step(dt, input);
        if (this.test.done) {
          this.results[this.current.key] = this.test.results();
          this.index++;
          if (this.index >= SERIES.length) { this.done = true; this.phase = 'done'; }
          else { this.phase = 'intro'; this.test = null; }
        }
        break;
    }
  }

  draw(r) {
    const { Test } = this.current ?? SERIES[SERIES.length - 1];
    if (this.test && ['running', 'paused', 'resuming'].includes(this.phase)) {
      this.test.draw(r);
      if (this.phase === 'paused') {
        r.overlay([
          { text: this.pauseReason, font: '700 28px system-ui, sans-serif' },
          { text: 'Le chrono du test est arrêté, tes mesures sont conservées.', color: '#c3c9e6' },
          { text: 'Appuie sur ✕ pour reprendre · ◯ pour quitter', color: '#39ff88', font: '600 18px system-ui, sans-serif' },
        ]);
      } else if (this.phase === 'resuming') {
        r.overlay([{ text: String(Math.ceil(this.countdown)), color: '#00e5ff', font: '800 64px system-ui, sans-serif' }]);
      }
      return;
    }
    // Fond figé derrière les overlays
    r.background(this.test?.cam ?? this.idleCam);
    r.crosshair(false);
    if (this.done) return;
    const step = `Test ${this.index + 1}/${SERIES.length}${this.label ? ' — ' + this.label : ''}`;
    if (this.phase === 'intro') {
      r.overlay([
        { text: step, color: '#00e5ff', font: '600 14px system-ui, sans-serif' },
        { text: Test.title, font: '700 30px system-ui, sans-serif' },
        { text: Test.instructions, color: '#c3c9e6' },
        { text: `Durée : ${DURATIONS[this.current.key]} s`, color: '#9aa4c7', font: '14px system-ui, sans-serif' },
        { text: 'Appuie sur ✕ pour commencer', color: '#39ff88', font: '600 18px system-ui, sans-serif' },
      ]);
    } else if (this.phase === 'countdown') {
      r.overlay([
        { text: Test.title, font: '700 24px system-ui, sans-serif' },
        { text: String(Math.ceil(this.countdown)), color: '#00e5ff', font: '800 64px system-ui, sans-serif' },
      ]);
    }
  }
}
