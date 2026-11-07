/**
 * Lance toute la matrice e2e : 3 moteurs × (PC, téléphone).
 *   chromium → Chrome / Edge (Windows, macOS, Linux) + Chrome Android
 *   webkit   → Safari (macOS) + tous les navigateurs iPhone / iPad (iOS impose WebKit)
 *   firefox  → Firefox (Windows, macOS, Linux, Android)
 *
 *   npm run e2e:all     (prérequis : npx playwright install chromium webkit firefox)
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const runs = [];
for (const browser of ['chromium', 'webkit', 'firefox']) {
  for (const kind of ['smoke', 'mobile']) runs.push({ browser, kind });
}

const results = runs.map(({ browser, kind }) => {
  const label = `${kind === 'smoke' ? 'PC' : 'Téléphone'} · ${browser}`;
  console.log(`\n━━━ ${label} ━━━`);
  const r = spawnSync(process.execPath, [path.join(__dirname, `${kind}.cjs`)], {
    stdio: 'inherit', env: { ...process.env, E2E_BROWSER: browser },
  });
  return { label, ok: r.status === 0 };
});

console.log('\n━━━ Bilan ━━━');
for (const r of results) console.log(`${r.ok ? '✔' : '✘'} ${r.label}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
