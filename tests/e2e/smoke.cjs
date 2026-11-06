/**
 * Test de bout en bout dans un vrai navigateur (Playwright + Chromium).
 * Une manette DualSense virtuelle remplace navigator.getGamepads, et un bot vise
 * réellement les cibles en lisant l'état exposé par ?debug.
 *
 *   npm run e2e        (nécessite Playwright : npm i -D playwright && npx playwright install chromium)
 *
 * Fichier .cjs : le package est en "type": "module", mais l'API Playwright
 * s'utilise ici plus simplement en CommonJS.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '../..');
const OUT = process.env.E2E_OUT || path.join(ROOT, 'tests/e2e/screenshots');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

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

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await serve();
  const base = `http://localhost:${server.address().port}`;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await page.addInitScript(() => {
    const pad = {
      id: 'DualSense Wireless Controller (virtuelle)', index: 0, connected: true, mapping: 'standard',
      axes: [0, 0, 0, 0], buttons: Array.from({ length: 18 }, () => ({ pressed: false, value: 0 })), timestamp: 0,
      vibrationActuator: { playEffect: () => { window.__rumbles = (window.__rumbles || 0) + 1; return Promise.resolve('complete'); } },
    };
    window.__pad = pad;
    navigator.getGamepads = () => [pad];
    window.__press = (i, ms = 80) => {
      pad.buttons[i] = { pressed: true, value: 1 };
      setTimeout(() => { pad.buttons[i] = { pressed: false, value: 0 }; }, ms);
    };
    // Bot : contrôleur proportionnel + bruit, tire quand il est sur la cible
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
  });

  const press = (b) => page.evaluate((x) => window.__press(x), b);
  const screen = () => page.evaluate(() => sensilab.screens.current);
  const wait = (ms) => page.waitForTimeout(ms);
  const BTN = { CROSS: 0, CIRCLE: 1, DOWN: 13, RIGHT: 15 };

  await page.goto(`${base}/?debug&rapide`);
  await wait(400);
  await page.screenshot({ path: `${OUT}/1-connect.png` });
  check('manette détectée', (await page.textContent('#pad-status')) === 'Manette connectée');

  await press(BTN.CROSS); await wait(300);
  check('✕ → écran zone morte', (await screen()) === 'deadzone');

  // Zone morte avec drift simulé de 3 %
  await page.evaluate(() => { __pad.axes[2] = 0.03; __pad.axes[3] = -0.01; });
  await press(BTN.CROSS); await wait(4200);
  const dz = await page.evaluate(() => sensilab.gp.deadzone);
  check('zone morte mesurée > drift', dz > 0.03 && dz < 0.1, `${dz}`);
  await page.screenshot({ path: `${OUT}/2-deadzone.png` });
  await page.evaluate(() => { __pad.axes[2] = 0; __pad.axes[3] = 0; });
  await press(BTN.CROSS); await wait(400);
  check('✕ → menu', (await screen()) === 'menu');

  check('"Reprendre" masqué sans session en cours', await page.evaluate(() => document.querySelector('#btn-resume-session').offsetParent === null));
  // Navigation spatiale : grille 3 colonnes [Nouvelle, Derniers (désactivé), Calibration] / [Historique, Zone morte]
  // → depuis "Nouvelle session", bas doit aller sur la carte JUSTE EN DESSOUS (Historique).
  const firstId = await page.evaluate(() => document.activeElement.id);
  await press(BTN.DOWN); await wait(200);
  const downId = await page.evaluate(() => document.activeElement.id);
  check('navigation spatiale (bas = carte du dessous)', firstId === 'btn-new-session' && downId === 'btn-history', `${firstId} → ${downId}`);
  await press(BTN.RIGHT); await wait(200);
  const rightId = await page.evaluate(() => document.activeElement.id);
  check('navigation spatiale (droite)', rightId === 'btn-deadzone', rightId);
  await page.focus('#btn-new-session');
  await page.screenshot({ path: `${OUT}/3-menu.png` });

  // Session raccourcie : 1 itération + 3 validations
  await press(BTN.CROSS); await wait(400);
  await page.evaluate(() => { const o = sensilab.state.optimizer; o.minIter = 1; o.maxIter = 1; requestAnimationFrame(__bot); });
  let pausedChecked = false, shot = false;
  for (let guard = 0; guard < 400 && (await screen()) !== 'results'; guard++) {
    const scr = await screen();
    if (scr === 'session') {
      const phase = await page.evaluate(() => sensilab.state.runner?.phase);
      if (phase === 'intro') await press(BTN.CROSS);
      if (phase === 'running' && !pausedChecked) {
        await wait(800);
        await page.evaluate(() => window.dispatchEvent(new Event('blur')));
        await wait(100);
        const t1 = await page.evaluate(() => sensilab.state.runner.test.t);
        await wait(500);
        const t2 = await page.evaluate(() => sensilab.state.runner.test.t);
        check('perte de focus → pause, temps gelé', t1 === t2 && (await page.evaluate(() => sensilab.state.runner.phase)) === 'paused');
        await page.screenshot({ path: `${OUT}/4-pause.png` });
        await press(BTN.CROSS);
        pausedChecked = true;
      }
      if (phase === 'running' && pausedChecked && !shot) {
        const name = await page.evaluate(() => sensilab.state.runner.current.key);
        if (name === 'flick') { await wait(1500); await page.screenshot({ path: `${OUT}/5-flick.png` }); shot = true; }
      }
    } else if (scr === 'iteration') {
      const txt = await page.textContent('#it-tendency');
      check(`bilan sans valeur annoncée (${await page.textContent('#it-title')})`, !/Prochaine valeur/.test(txt));
      await page.screenshot({ path: `${OUT}/6-iteration.png` });
      await press(BTN.CROSS);
    }
    await wait(400);
  }
  check('session terminée → résultats', (await screen()) === 'results');
  check('vibration au toucher', (await page.evaluate(() => window.__rumbles || 0)) > 0);
  check('réglage par jeu affiché', (await page.$$('.game')).length === 3);
  await wait(300);
  await page.screenshot({ path: `${OUT}/7-results.png`, fullPage: true });

  // Modale à la manette : ◯ annule, rien n'est supprimé
  await page.evaluate(() => sensilab.screens.show('history'));
  await wait(300);
  await page.click('[data-delete]');
  await wait(200);
  check('modale ouverte, focus sur Annuler', await page.evaluate(() => !document.querySelector('#modal').hidden && document.activeElement.id === 'modal-cancel'));
  await page.screenshot({ path: `${OUT}/8-modal.png` });
  await press(BTN.CIRCLE); await wait(300);
  check('◯ ferme la modale sans supprimer', await page.evaluate(() => document.querySelector('#modal').hidden && JSON.parse(localStorage.getItem('sensilab:sessions')).length === 1));
  check('◯ ne quitte pas l’écran sous la modale', (await screen()) === 'history');

  // Calibration
  await page.evaluate(() => sensilab.screens.show('calibration'));
  await wait(300);
  await page.fill('#calib-setting', '6');
  await page.fill('#calib-time', '6');
  await page.click('#btn-calib-save');
  await wait(300);
  const calib = await page.evaluate(() => JSON.parse(localStorage.getItem('sensilab:calibration')));
  check('calibration 3 tours / 6 s = 180 °/s', calib?.cod?.points?.[0]?.degPerSec === 180);
  await page.screenshot({ path: `${OUT}/9-calibration.png`, fullPage: true });

  // Import piégé : refusé, aucune injection
  const evil = JSON.stringify({ app: 'SensiLab', sessions: [{ best: '<img src=x onerror="window.__xss=1">', bestScore: 1, iterations: [] }] });
  await page.setInputFiles('#calib-file', { name: 'evil.json', mimeType: 'application/json', buffer: Buffer.from(evil) });
  await wait(300);
  await press(BTN.CROSS); await wait(300); // confirme la modale "remplacer"
  await page.evaluate(() => sensilab.screens.show('history'));
  await wait(300);
  check('import piégé refusé (pas de XSS)', !(await page.evaluate(() => window.__xss)) && JSON.parse(await page.evaluate(() => localStorage.getItem('sensilab:sessions'))).length === 1);

  // Mobile
  await page.setViewportSize({ width: 390, height: 844 });
  for (const s of ['menu', 'results', 'calibration']) {
    if (s === 'results') await page.evaluate(() => { sensilab.state.viewedSession = JSON.parse(localStorage.getItem('sensilab:sessions'))[0]; });
    await page.evaluate((x) => sensilab.screens.show(x), s);
    await wait(300);
    check(`mobile sans scroll horizontal (${s})`, !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)));
  }
  await page.screenshot({ path: `${OUT}/10-mobile-results.png`, fullPage: true });

  check('aucune erreur JS', errors.length === 0, errors.join(' | '));
  await browser.close();
  server.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} vérifications OK — captures dans ${OUT}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
