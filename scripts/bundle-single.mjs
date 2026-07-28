/**
 * Builds the whole game into one self-contained HTML file.
 *
 * The normal `dist/` output is a static site: separate script and stylesheet
 * files that a browser fetches over HTTP. Opened straight off disk it does
 * nothing, because `file://` refuses cross-origin module fetches — which makes
 * it useless as "a file I can download and open".
 *
 * This produces a single document with the stylesheet and every module inlined.
 * An *inline* module script has nothing to fetch, so double-clicking it works.
 *
 *   node scripts/bundle-single.mjs [out.html]
 */

import { build } from 'vite';
import { readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] ?? join(root, 'bluebird.html');
const tmp = join(root, '.single-build');

await rm(tmp, { recursive: true, force: true });

await build({
  root,
  base: './',
  logLevel: 'warn',
  // Do not merge vite.config.ts: its manualChunks split is exactly what has to
  // not happen here, and rollup rejects it outright next to inlineDynamicImports.
  configFile: false,
  build: {
    target: 'es2022',
    outDir: tmp,
    emptyOutDir: true,
    // One chunk, no sourcemap, no asset splitting: everything has to end up
    // inline, and a chunk that imports another chunk cannot.
    sourcemap: false,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        manualChunks: undefined,
        entryFileNames: 'app.js',
        assetFileNames: 'app[extname]',
      },
    },
  },
});

let html = await readFile(join(tmp, 'index.html'), 'utf8');
const js = await readFile(join(tmp, 'app.js'), 'utf8');
let css = '';
try {
  css = await readFile(join(tmp, 'app.css'), 'utf8');
} catch {
  // A build with no emitted stylesheet is a bug, not something to paper over.
  throw new Error('no stylesheet was emitted — refusing to ship a half-styled file');
}

// Swap the tags that point at files for the contents of those files.
//
// Both replacements pass a *function*, and that is not a style choice. A string
// replacement expands `$&`, `$1` and friends — and minified three.js contains
// `$&` in ordinary expressions like `fogExp2:!!$&&$.isFogExp2`, which quietly
// re-injected the whole original `<script src>` tag into the middle of the
// bundle. A function replacement is taken literally.
//
// The closing-tag escape matters for the same class of reason: a literal
// "</script>" inside the bundle would end the element early and truncate the
// game.
const inlineJs = `<script type="module">\n${js.replace(/<\/script>/gi, '<\\/script>')}\n</script>`;
const inlineCss = `<style>\n${css}\n</style>`;
html = html
  .replace(/<link[^>]+rel="stylesheet"[^>]*>/i, () => inlineCss)
  .replace(/<script[^>]*src="[^"]*app\.js"[^>]*><\/script>/i, () => inlineJs);

if (html.includes('app.js') || html.includes('app.css')) {
  throw new Error('a file reference survived inlining — the output would not run offline');
}

await writeFile(out, html, 'utf8');
await rm(tmp, { recursive: true, force: true });

const { size } = await stat(out);
console.log(`${out}  ${(size / 1024 / 1024).toFixed(2)} MB`);
