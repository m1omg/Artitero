// Loads the page in a real browser, runs the simulation for a while, and
// fails if anything threw. Not part of the shipped game — a smoke test.
//
//   python3 -m http.server 8899 & node test/browser-check.mjs

import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

// This environment ships a Chromium that may not match the npm package's
// pinned revision, so prefer the one that is actually on disk.
const preinstalled = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const launchOpts = existsSync(preinstalled) ? { executablePath: preinstalled } : {};

const url = process.argv[2] || 'http://localhost:8899/index.html';
const shot = process.argv[3] || '/tmp/planet.png';

const browser = await chromium.launch(launchOpts);
const page = await browser.newPage({ viewport: { width: 1600, height: 980 } });

const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.app && window.app.timeline, null, { timeout: 20000 });

// Run: pick a fine-ish scale, start the clock, let it advance in real time.
await page.click('#play');
await page.waitForTimeout(3500);

// Then fast-forward headlessly, to check that a long run stays sane in the
// browser and to give the screenshot a planet with something living on it.
await page.evaluate((n) => {
  const app = window.app;
  for (let i = 0; i < n && !app.timeline.active.world.ended; i++) app.stepAll(250000);
}, Number(process.env.FAST_STEPS || 0));
await page.waitForTimeout(500);

const state = await page.evaluate(() => {
  const w = window.app.timeline.active.world;
  return {
    steps: w.steps, year: w.year, temp: w.climate.meanTemp, co2: w.climate.co2ppm,
    fingerprint: w.fingerprint(), chronicle: w.chronicle.entries.length,
    ledgerNodes: w.ledger.nodes.size,
  };
});

// Exercise the panels and the branching controls.
for (const tab of ['tools', 'species', 'chronicle', 'branches', 'challenge', 'model']) {
  await page.click('.tab[data-tab="' + tab + '"]');
  await page.waitForTimeout(120);
}
await page.click('#fork');
await page.waitForTimeout(600);
const branches = await page.evaluate(() => window.app.timeline.branches.length);
await page.click('.chip[data-mode="temperature"]');
await page.waitForTimeout(300);
await page.click('.chip[data-mode="plates"]');
await page.waitForTimeout(300);
await page.click('.chip[data-mode="surface"]');
await page.waitForTimeout(600);

await page.screenshot({ path: shot });
await browser.close();

console.log('steps        ', state.steps);
console.log('year         ', (state.year / 1e6).toFixed(2), 'Myr');
console.log('temperature  ', state.temp.toFixed(1), 'C');
console.log('CO2          ', state.co2.toFixed(0), 'ppm');
console.log('ledger nodes ', state.ledgerNodes);
console.log('chronicle    ', state.chronicle);
console.log('branches     ', branches);
console.log('fingerprint  ', state.fingerprint);
console.log('screenshot   ', shot);

if (errors.length) {
  console.error('\nERRORS:');
  for (const e of errors) console.error('  ' + e);
  process.exit(1);
}
if (state.steps < 5) { console.error('\nthe clock did not advance'); process.exit(1); }
if (branches < 2) { console.error('\nforking did not create a branch'); process.exit(1); }
console.log('\nok');
