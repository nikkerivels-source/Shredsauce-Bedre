/**
 * The logotype.
 *
 * Drawn, not set. Every glyph below is a hand-built outline on a 100-unit cap
 * height with a 22-unit stem and 17-unit horizontals — the horizontals are
 * lighter than the stems because optically they have to be, which is the whole
 * reason you draw a wordmark instead of reaching for `letter-spacing` and a
 * system font. Bowls are elliptical half-arcs sprung straight off the stem, and
 * the sidebearings are tight so the word reads as one solid block.
 *
 * Counters are separate subpaths and the whole thing fills `evenodd`.
 */

const NS = 'http://www.w3.org/2000/svg';

interface Glyph {
  /** Advance width at cap height 100. */
  w: number;
  d: string;
}

const GLYPHS: Record<string, Glyph> = {
  B: {
    w: 64,
    d:
      'M0 0 H22 A38 24.5 0 0 1 22 49 A42 25.5 0 0 1 22 100 H0 Z' +
      'M22 17 A21 7.5 0 0 1 22 32 Z' +
      'M22 66 A25 8.5 0 0 1 22 83 Z',
  },
  L: { w: 52, d: 'M0 0 H22 V83 H52 V100 H0 Z' },
  U: {
    w: 62,
    d: 'M0 0 H22 V64 A9 17 0 0 0 40 64 V0 H62 V64 A31 36 0 0 1 0 64 Z',
  },
  E: { w: 56, d: 'M0 0 H56 V17 H22 V41 H50 V58 H22 V83 H56 V100 H0 Z' },
  I: { w: 22, d: 'M0 0 H22 V100 H0 Z' },
  R: {
    w: 62,
    d:
      'M0 0 H24 A36 26 0 0 1 24 52 H40 L62 100 H36 L22 62 V100 H0 Z' +
      'M22 17 A20 9 0 0 1 22 35 Z',
  },
  D: {
    w: 66,
    d: 'M0 0 H26 A40 50 0 0 1 26 100 H0 Z' + 'M22 17 A27 33 0 0 1 22 83 Z',
  },
};

/** Optical corrections, in cap-height units, applied before the named glyph. */
const KERN: Record<string, number> = { LU: -2, RD: -1 };

const TRACK = 9;

/**
 * Builds the wordmark as a single SVG.
 *
 * `word` is looked up glyph by glyph, so this stays honest — there is no
 * fallback to live text hiding behind it. Anything without an outline is
 * skipped rather than silently rendered in the UI font.
 */
export function wordmark(word = 'BLUEBIRD'): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'wordmark');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', word);

  let x = 0;
  let prev = '';
  for (const ch of word.toUpperCase()) {
    const glyph = GLYPHS[ch];
    if (!glyph) continue;
    if (prev) x += TRACK + (KERN[prev + ch] ?? 0);
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', glyph.d);
    path.setAttribute('transform', `translate(${x} 0)`);
    path.setAttribute('fill-rule', 'evenodd');
    svg.append(path);
    x += glyph.w;
    prev = ch;
  }

  svg.setAttribute('viewBox', `0 0 ${x} 100`);
  return svg;
}
