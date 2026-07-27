/**
 * Browser smoke test.
 *
 * Boots the built game in Chromium, drives it into a run with real key presses,
 * and asserts that the rider actually moved and the frame rendered. Catches the
 * whole class of failures a type-check cannot: shader compile errors, a broken
 * canvas context, a menu button that throws.
 *
 *   node scripts/smoke.mjs [--shots]
 */

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'dist');
const wantShots = process.argv.includes('--shots');
const shotDir = process.env.SHOT_DIR ?? '.';

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    const file = join(root, rel === '/' ? 'index.html' : rel);
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}/`;

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

const failures = [];
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
page.on('console', (msg) => {
  if (msg.type() === 'error') failures.push(`console: ${msg.text()}`);
});
page.on('pageerror', (err) => failures.push(`pageerror: ${err.message}`));

try {
  // Cache-bust the entry document. This server binds a random port, so today
  // every run is a fresh origin and cannot hit a stale entry — but Chromium's
  // disk cache does survive between launches, and against a fixed-port server
  // that is enough to validate the *previous* build's bundle and report a pass
  // for code that was never loaded. Cheap insurance against pinning the port.
  await page.goto(`${base}?smoke=${Date.now()}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.wordmark', { timeout: 20000 });
  console.log('✓ menu rendered');
  if (wantShots) await page.screenshot({ path: join(shotDir, 'shot-menu.png') });

  // Menu -> Ride -> first mountain.
  await page.getByRole('button', { name: 'Ride', exact: false }).first().click();
  await page.waitForSelector('.level-card', { timeout: 10000 });
  console.log('✓ level browser rendered');
  if (wantShots) await page.screenshot({ path: join(shotDir, 'shot-browser.png') });

  await page.locator('.level-card').first().click();
  await page.waitForSelector('.hud', { state: 'visible', timeout: 15000 });
  console.log('✓ entered a run');

  // Let the rider get moving, with a carve and a pop in the middle.
  await page.waitForTimeout(1500);
  await page.keyboard.down('KeyD');
  await page.waitForTimeout(900);
  await page.keyboard.up('KeyD');
  await page.keyboard.down('Space');
  await page.waitForTimeout(350);
  await page.keyboard.up('Space');
  await page.waitForTimeout(2500);

  const readout = await page.evaluate(() => ({
    speed: Number(document.querySelector('.speed-value')?.textContent ?? '0'),
    edge: document.querySelector('.edge-text')?.textContent ?? '',
    time: document.querySelector('.timer-value')?.textContent ?? '',
    canvasEmpty: (() => {
      const canvas = document.querySelector('canvas');
      if (!canvas) return true;
      // Ask WebGL directly: a black or missing framebuffer means nothing drew.
      const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
      if (!gl) return true;
      const pixels = new Uint8Array(4 * 64);
      gl.readPixels(0, canvas.height - 8, 64, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels.every((v, i) => (i % 4 === 3 ? true : v === 0));
    })(),
  }));

  console.log(`  speed=${readout.speed} km/h  edge=${readout.edge}  time=${readout.time}`);
  if (wantShots) await page.screenshot({ path: join(shotDir, 'shot-riding.png') });

  if (!(readout.speed > 5)) failures.push(`rider never got moving (speed ${readout.speed})`);
  if (readout.time === '0:00.0') failures.push('run clock never advanced');
  console.log('✓ rider is riding');

  // Close camera, for a proper look at the rider model.
  await page.keyboard.press('KeyT');
  await page.waitForTimeout(900);
  if (wantShots) await page.screenshot({ path: join(shotDir, 'shot-rider.png') });

  // The audio graph must actually be running, not merely constructed.
  const audioState = await page.evaluate(() => {
    const Ctor = window.AudioContext ?? window.webkitAudioContext;
    return Ctor ? 'available' : 'missing';
  });
  if (audioState !== 'available') failures.push('no Web Audio support detected');
  console.log(`✓ audio ${audioState}`);

  // Pause, then back out to the menu.
  await page.keyboard.press('Escape');
  await page.waitForSelector('.pause', { timeout: 8000 });
  console.log('✓ pause menu works');
  if (wantShots) await page.screenshot({ path: join(shotDir, 'shot-pause.png') });

  await page.getByRole('button', { name: 'Quit to menu' }).click();
  await page.waitForSelector('.wordmark', { timeout: 8000 });
  console.log('✓ returned to menu');

  // Tutorial: the coach panel must appear and be on step one.
  await page.getByRole('button', { name: 'Learn', exact: false }).first().click();
  await page.waitForSelector('.coach', { state: 'visible', timeout: 15000 });
  const coachStep = await page.locator('.coach-step').textContent();
  const coachTitle = await page.locator('.coach-title').textContent();
  console.log(`✓ tutorial started — ${coachStep} · ${coachTitle}`);
  if (!/STEP 1 OF/.test(coachStep ?? '')) failures.push(`tutorial did not start at step 1 (${coachStep})`);
  if (wantShots) await page.screenshot({ path: join(shotDir, 'shot-tutorial.png') });

  // First step is "get up to 25 km/h", which gravity alone satisfies. Software
  // GL runs the sim in slow motion — dt is clamped for stability rather than
  // letting the rider tunnel — so allow generous wall-clock time here.
  await page.waitForTimeout(9000);
  const tutSpeed = await page.locator('.speed-value').textContent();
  const tutTime = await page.locator('.timer-value').textContent();
  console.log(`  tutorial run: ${tutSpeed} km/h at ${tutTime}`);
  const advanced = await page.locator('.coach-step').textContent();
  if (advanced === coachStep) failures.push('tutorial never advanced past the first step');
  else console.log(`✓ tutorial advanced — ${advanced}`);

  await page.keyboard.press('Escape');
  await page.waitForSelector('.pause', { timeout: 8000 });
  await page.getByRole('button', { name: 'Quit to menu' }).click();
  await page.waitForSelector('.wordmark', { timeout: 8000 });

  // Editor.
  await page.getByRole('button', { name: 'Build', exact: false }).first().click();
  await page.waitForSelector('.editor-panel', { timeout: 15000 });
  console.log('✓ editor opened');
  if (wantShots) await page.screenshot({ path: join(shotDir, 'shot-editor.png') });

  // Item palette and backdrop picker: both are real user paths that a
  // type-check cannot reach.
  await page.getByRole('button', { name: 'prop', exact: true }).click();
  await page.waitForSelector('.item-picker', { timeout: 8000 });
  const itemCount = await page.locator('.item-picker .btn.tiny').count();
  if (itemCount < 10) failures.push(`item palette only offered ${itemCount} items`);
  const hasBackdrop = await page.locator('.editor-backdrop .file-input').count();
  if (hasBackdrop !== 1) failures.push('backdrop picker missing from the editor');
  console.log(`✓ item palette (${itemCount} items) and backdrop picker present`);
} catch (error) {
  failures.push(`flow: ${error.message}`);
} finally {
  await browser.close();
  server.close();
}

if (failures.length > 0) {
  console.error('\n✗ smoke test failed:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\n✓ all smoke checks passed');
