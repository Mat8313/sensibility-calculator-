/**
 * Outils communs aux tests e2e : mini serveur statique, manette virtuelle, bot.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
};

/** Mini serveur statique (refuse toute sortie du dossier du projet). */
function serve() {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const file = path.normalize(path.join(ROOT, url === '/' ? 'index.html' : url));
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((ok) => server.listen(0, () => ok(server)));
}

/**
 * Script injecté dans la page : remplace navigator.getGamepads par une DualSense
 * virtuelle et fournit un bot (__bot) qui vise réellement les cibles via ?debug.
 */
function padInitScript() {
  const pad = {
    id: 'DualSense Wireless Controller (virtuelle)', index: 0, connected: true, mapping: 'standard',
    axes: [0, 0, 0, 0], buttons: Array.from({ length: 18 }, () => ({ pressed: false, value: 0 })), timestamp: 0,
    vibrationActuator: { playEffect: () => { window.__rumbles = (window.__rumbles || 0) + 1; return Promise.resolve('complete'); } },
  };
  window.__pad = pad;
  navigator.getGamepads = () => [pad];
  // 160 ms ≈ un appui humain ; plus court, un appui peut tomber entre deux images
  // si le moteur de test marque une pause (WebKit headless : jusqu’à ~110 ms).
  window.__press = (i, ms = 160) => {
    pad.buttons[i] = { pressed: true, value: 1 };
    setTimeout(() => { pad.buttons[i] = { pressed: false, value: 0 }; }, ms);
  };
  window.__bot = () => {
    const test = window.sensilab?.state.runner?.test;
    const running = window.sensilab?.state.runner?.phase === 'running';
    const tg = test && (test.targetAt ? test.targetAt(test.t) : test.tracker?.target);
    if (running && tg) {
      const e = test.cam.errorTo(tg);
      let sx = (e.x * 6) / test.cam.sens, sy = (-e.y * 6) / test.cam.sens;
      const m = Math.hypot(sx, sy); if (m > 1) { sx /= m; sy /= m; }
      pad.axes[2] = sx + (Math.random() - 0.5) * 0.04;
      pad.axes[3] = sy + (Math.random() - 0.5) * 0.04;
      pad.buttons[7] = test.tracker?.inside && Math.random() < 0.3 ? { pressed: true, value: 1 } : { pressed: false, value: 0 };
    } else { pad.axes[2] = pad.axes[3] = 0; pad.buttons[7] = { pressed: false, value: 0 }; }
    requestAnimationFrame(window.__bot);
  };
}

function checker() {
  const results = [];
  const check = (name, cond, detail = '') => {
    results.push({ name, ok: !!cond });
    console.log(`${cond ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`);
  };
  const summary = (out) => {
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} vérifications OK — captures dans ${out}`);
    return failed;
  };
  return { check, summary };
}

/**
 * Moteur choisi par E2E_BROWSER : chromium (Chrome/Edge/Android), webkit
 * (Safari macOS + tous les navigateurs iPhone/iPad), firefox (Gecko).
 */
function browserType() {
  const name = process.env.E2E_BROWSER || 'chromium';
  const pw = require('playwright');
  if (!pw[name]) throw new Error(`E2E_BROWSER inconnu : ${name}`);
  return { name, type: pw[name] };
}

/**
 * Reproduit les limites de Safari sur iPhone, que WebKit pour Linux n'a pas :
 * pas de plein écran pour une page, pas de verrouillage d'orientation,
 * pas de vibration de manette. (Wake Lock existe depuis iOS 16.4.)
 */
function iosLimitsInitScript() {
  for (const p of ['fullscreenEnabled', 'webkitFullscreenEnabled']) {
    Object.defineProperty(Document.prototype, p, { get: () => false, configurable: true });
  }
  Element.prototype.requestFullscreen = () => Promise.reject(new TypeError('non supporté sur iPhone'));
  if (screen.orientation) screen.orientation.lock = () => Promise.reject(new DOMException('non supporté', 'NotSupportedError'));
  window.__ios = true;
}

module.exports = { ROOT, serve, padInitScript, checker, browserType, iosLimitsInitScript };
