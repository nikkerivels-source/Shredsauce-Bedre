/**
 * Drives the render bench.
 *
 * Builds `tools/` as its own tiny site, serves it, opens it in Chromium and
 * captures a screenshot plus a frame-time report for each requested shot. Every
 * shot is named, and the name is the filename, so a before and an after are the
 * same command run on two commits.
 *
 *   node scripts/bench.mjs --out shots/before --shots gate,treeline,rider
 *   node scripts/bench.mjs --out shots/after  --shots gate --preset medium
 *
 * A caveat that belongs in every number this prints: there is no GPU here. The
 * container runs Chromium on SwiftShader, a software rasteriser. Frame times are
 * therefore useful as a *ratio* between two builds of the same scene and useless
 * as an absolute against the 16.6 ms device budget. The script says so in its own
 * output rather than leaving it to be discovered.
 */

import { build } from 'vite';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const outArg = arg('out', 'shots/bench');
const outDir = outArg.startsWith('/') ? outArg : join(root, outArg);
const shots = arg('shots', 'gate').split(',');
const preset = arg('preset', 'high');
const level = arg('level', 'superpark');
const weather = arg('weather', 'clear');
const frames = arg('frames', '120');
// Appearance overrides, passed straight through to the page: --jacket, --pants,
// --gloves, --boots and so on, one flag per slot.
const LOOK_KEYS = ['jacket', 'pants', 'helmet', 'goggles', 'gloves', 'boots', 'board', 'skin'];
const look = LOOK_KEYS.map((k) => [k, arg(k, '')]).filter(([, v]) => v);
const width = Number(arg('w', 1920));
const height = Number(arg('h', 1080));
// A private build directory per run. Two benches sharing one would race on the
// same files and each would silently measure the other's bundle.
const tmp = join(root, `.bench-build-${process.pid}`);

await rm(tmp, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

await build({
  root: join(root, 'tools'),
  base: './',
  logLevel: 'error',
  configFile: false,
  build: { target: 'es2022', outDir: tmp, emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 4000 },
});

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    const file = join(tmp, rel === '/' ? 'index.html' : rel);
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium',
  args: [
    '--use-gl=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
    // Otherwise requestAnimationFrame is pinned to 60 Hz and every scene that
    // fits in the budget measures as exactly the budget.
    '--disable-gpu-vsync',
    '--disable-frame-rate-limit',
  ],
});

const reports = [];
for (const shot of shots) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('requestfailed', (r) => errors.push(`request failed ${r.url()}`));
  page.on('response', (r) => {
    if (r.status() >= 400 && !r.url().includes('favicon')) errors.push(`${r.status()} ${r.url()}`);
  });
  page.on('console', (m) => {
    // "Failed to load resource" carries no URL, and Chromium asks every page
    // for a favicon the bench does not ship. The response handler above sees the
    // URL, so real 404s are still caught there.
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text());
  });

  // Cache-bust: Chromium's disk cache outlives the browser process, and a stale
  // bundle would quietly benchmark the previous commit.
  const url =
    `${base}?preset=${preset}&level=${level}&view=${shot}&weather=${weather}` +
    `&frames=${frames}&w=${width}&h=${height}` +
    look.map(([k, v]) => `&${k}=${encodeURIComponent(v)}`).join('') +
    `&cb=${Date.now()}`;
  await page.goto(url, { waitUntil: 'load' });
  const report = await page.evaluate(() => window.benchReady, { timeout: 180_000 });
  if (errors.length > 0) throw new Error(`${shot}: ${errors.join(' | ')}`);

  const file = join(outDir, `${shot}-${preset}-${weather}.png`);
  // The spin capture builds its own frames off-screen; everything else is a
  // straight screenshot of the last rendered frame.
  const strip = await page.evaluate(() => window.benchFrames ?? null);
  if (strip && strip.length > 0) {
    for (let i = 0; i < strip.length; i++) {
      const png = Buffer.from(strip[i].split(',')[1], 'base64');
      await writeFile(join(outDir, `${shot}-${String(i).padStart(2, '0')}.png`), png);
    }
    console.log(`${shot.padEnd(9)} wrote ${strip.length} rider frames`);
    await page.close();
    reports.push({ shot, file, ...report });
    continue;
  }
  await page.screenshot({ path: file });
  reports.push({ shot, file, ...report });
  console.log(
    `${shot.padEnd(9)} ${preset.padEnd(6)} ${weather.padEnd(8)} ` +
      `median ${report.median.toFixed(2)} ms  p95 ${report.p95.toFixed(2)} ms  ` +
      `${report.drawCalls} calls  ${report.triangles.toLocaleString()} tris`,
  );
  await page.close();
}

await writeFile(join(outDir, `report-${preset}-${weather}.json`), JSON.stringify(reports, null, 2));
await browser.close();
server.close();
await rm(tmp, { recursive: true, force: true });
console.log(`\nwrote ${reports.length} shot(s) to ${outDir}`);
console.log('frame times are SwiftShader (software) — compare ratios between builds, not against 16.6 ms');
// Chromium leaves a handle behind often enough that the process would sit here
// for minutes after the work is done, which is indistinguishable from a hang.
process.exit(0);
