/**
 * Test e2e "téléphone + manette" : émulation d'un Android (écran tactile, DPR 2.6),
 * DualSense virtuelle, rotation portrait ↔ paysage pendant une session.
 *
 *   npm run e2e:mobile
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium, devices } = require('playwright');
const { ROOT, serve, padInitScript, checker } = require('./helpers.cjs');

const OUT = process.env.E2E_OUT || path.join(ROOT, 'tests/e2e/screenshots');
const { check, summary } = checker();
const PORTRAIT = { width: 412, height: 915 };
const LANDSCAPE = { width: 915, height: 412 };

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await serve();
  const base = `http://localhost:${server.address().port}`;
  const browser = await chromium.launch();
  const context = await browser.newContext({ ...devices['Pixel 7'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await page.addInitScript(padInitScript);
  // Espions : verrou d'écran et verrouillage d'orientation
  await page.addInitScript(() => {
    window.__wake = { requested: 0, released: 0 };
    Object.defineProperty(navigator, 'wakeLock', {
      value: {
        request: async () => {
          window.__wake.requested++;
          return { release: async () => { window.__wake.released++; }, addEventListener() {} };
        },
      },
    });
    window.__orientationLocks = [];
    if (screen.orientation) screen.orientation.lock = async (o) => { window.__orientationLocks.push(o); };
  });

  const press = (b) => page.evaluate((x) => window.__press(x), b);
  const screenId = () => page.evaluate(() => sensilab.screens.current);
  const phase = () => page.evaluate(() => sensilab.state.runner?.phase);
  const wait = (ms) => page.waitForTimeout(ms);
  const noHScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  const CROSS = 0, CIRCLE = 1;
  // Simule une rotation. Chromium ne redimensionne pas une fenêtre en plein écran :
  // on quitte d'abord le plein écran (sur un vrai téléphone, la rotation le conserve).
  const rotate = async (vp) => {
    await page.evaluate(() => document.fullscreenElement && document.exitFullscreen());
    await wait(150);
    await page.setViewportSize(vp);
  };

  // --- Fichiers d'installation (écran d'accueil) ---
  for (const f of ['manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/icon.svg']) {
    const res = await page.request.get(`${base}/${f}`);
    check(`${f} servi`, res.ok());
  }

  // --- Accueil en portrait ---
  await page.goto(`${base}/?debug&rapide`);
  await wait(400);
  check('accueil : pas de scroll horizontal (portrait)', await noHScroll());
  check('aide "Sur téléphone" présente', await page.isVisible('.phone-help summary'));
  await page.tap('.phone-help summary');
  await wait(200);
  await page.screenshot({ path: `${OUT}/m1-connect-portrait.png`, fullPage: true });

  await press(CROSS); await wait(300);             // "réveille" la manette (le bouton Continuer s'active)
  await page.tap('#btn-connect-continue'); await wait(300);
  check('zone morte atteinte au toucher', (await screenId()) === 'deadzone');
  await press(CROSS); await wait(4200);           // mesure zone morte
  await press(CROSS); await wait(400);             // continuer
  check('menu atteint', (await screenId()) === 'menu');
  await page.screenshot({ path: `${OUT}/m2-menu-portrait.png`, fullPage: true });

  // --- Session lancée au toucher, téléphone en portrait ---
  await page.tap('#btn-new-session');
  await wait(400);
  await page.evaluate(() => { const o = sensilab.state.optimizer; o.minIter = 1; o.maxIter = 1; });
  check('écran de test affiché', (await screenId()) === 'session');
  check('verrou "écran allumé" demandé', (await page.evaluate(() => window.__wake.requested)) >= 1);
  check('plein écran activé au toucher', await page.evaluate(() => !!document.fullscreenElement));
  check('paysage demandé au toucher', (await page.evaluate(() => window.__orientationLocks)).includes('landscape'));
  await press(CROSS); await wait(300);
  check('portrait : le test ne démarre pas', (await phase()) === 'intro');
  await page.screenshot({ path: `${OUT}/m3-session-portrait.png` });

  // --- Paysage : démarrage au toucher de l'écran ---
  await rotate(LANDSCAPE);
  await wait(300);
  await page.screenshot({ path: `${OUT}/m4-intro-landscape.png` });
  await page.tap('#game-canvas');
  await wait(200);
  check('toucher l’écran = ✕ (compte à rebours)', (await phase()) === 'countdown');
  await page.evaluate(() => requestAnimationFrame(__bot));
  await wait(3600);
  check('test en cours en paysage', (await phase()) === 'running');
  await wait(800);
  await page.screenshot({ path: `${OUT}/m5-tracking-landscape.png` });

  // --- Rotation en plein test : pause, puis reprise ---
  await rotate(PORTRAIT);
  await wait(300);
  const t1 = await page.evaluate(() => sensilab.state.runner.test.t);
  await wait(500);
  const t2 = await page.evaluate(() => sensilab.state.runner.test.t);
  check('rotation en portrait → pause, temps gelé', (await phase()) === 'paused' && t1 === t2);
  await page.screenshot({ path: `${OUT}/m6-rotate-prompt.png` });
  await rotate(LANDSCAPE);
  await wait(300);
  check('retour en paysage → "Prêt ?"', (await page.evaluate(() => sensilab.state.runner.pauseReason)) === 'Prêt ?');
  await page.tap('#game-canvas');
  await wait(2400);
  check('reprise après toucher', (await phase()) === 'running');

  // --- Fin de session (1 itération + 3 validations) ---
  for (let guard = 0; guard < 400 && (await screenId()) !== 'results'; guard++) {
    const s = await screenId();
    if (s === 'session' && (await phase()) === 'intro') await press(CROSS);
    if (s === 'iteration') {
      if (!(await noHScroll())) check('bilan : pas de scroll horizontal', false);
      await page.screenshot({ path: `${OUT}/m7-iteration-landscape.png`, fullPage: true });
      await press(CROSS);
    }
    await wait(400);
  }
  check('session terminée sur téléphone', (await screenId()) === 'results');
  check('verrou "écran allumé" relâché hors test', (await page.evaluate(() => window.__wake.released)) >= 1);
  await wait(300);
  await page.screenshot({ path: `${OUT}/m8-results-landscape.png`, fullPage: true });

  // --- Tous les écrans, dans les deux orientations ---
  for (const vp of [LANDSCAPE, PORTRAIT]) {
    await rotate(vp);
    for (const id of ['connect', 'deadzone', 'menu', 'iteration', 'results', 'calibration', 'history']) {
      await page.evaluate((x) => sensilab.screens.show(x), id);
      await wait(150);
      check(`${id} sans scroll horizontal (${vp.width > vp.height ? 'paysage' : 'portrait'})`, await noHScroll());
    }
  }
  await page.evaluate(() => sensilab.screens.show('calibration'));
  await wait(200);
  await page.screenshot({ path: `${OUT}/m9-calibration-portrait.png`, fullPage: true });

  // Cibles tactiles assez grandes (recommandation ≥ 40 px de haut)
  const small = await page.evaluate(() => [...document.querySelectorAll('#screen-calibration button')]
    .filter((b) => b.offsetParent && b.getBoundingClientRect().height < 32).map((b) => b.textContent.trim()));
  check('boutons tactiles ≥ 32 px', small.length === 0, small.join(', '));

  check('aucune erreur JS', errors.length === 0, errors.join(' | '));
  await browser.close();
  server.close();
  process.exit(summary(OUT) ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
