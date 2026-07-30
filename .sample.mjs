/** Samples the most-saturated purple pixel in a shot and reports the delta. */
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
const file = process.argv[2], target = process.argv[3];
const b64 = (await readFile(file)).toString('base64');
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const page = await browser.newPage();
const res = await page.evaluate(async ({ b64, target }) => {
  const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  const t = [parseInt(target.slice(1,3),16), parseInt(target.slice(3,5),16), parseInt(target.slice(5,7),16)];
  // The lit side of the jacket is the brightest pixel whose hue is closest to
  // the target; search for minimum hue error among reasonably bright pixels.
  const hue = (r,g,bl) => { const mx=Math.max(r,g,bl), mn=Math.min(r,g,bl); if (mx===mn) return -1;
    const dd=mx-mn; let h; if(mx===r) h=((g-bl)/dd)%6; else if(mx===g) h=(bl-r)/dd+2; else h=(r-g)/dd+4;
    return (h*60+360)%360; };
  const th = hue(t[0],t[1],t[2]);
  let best = null, bestLum = -1;
  for (let i = 0; i < d.length; i += 4) {
    const r=d[i], g=d[i+1], bl=d[i+2];
    // Near-white pixels have unstable hue and will happily masquerade as any
    // colour; require real chroma before believing the hue at all.
    if (Math.max(r,g,bl) - Math.min(r,g,bl) < 45) continue;
    const h = hue(r,g,bl); if (h < 0) continue;
    let dh = Math.abs(h - th); if (dh > 180) dh = 360 - dh;
    if (dh > 12) continue;
    const lum = 0.2126*r + 0.7152*g + 0.0722*bl;
    if (lum > bestLum) { bestLum = lum; best = [r,g,bl]; }
  }
  if (!best) return { found: false };
  const err = Math.max(...best.map((v,i)=>Math.abs(v-t[i]))) / 255 * 100;
  const hex = '#' + best.map(v=>v.toString(16).padStart(2,'0')).join('');
  return { found: true, hex, target, errPct: err };
}, { b64, target });
console.log(res.found ? `brightest ${target} pixel = ${res.hex}  (max channel error ${res.errPct.toFixed(1)}%)` : 'no matching hue found');
await browser.close();
