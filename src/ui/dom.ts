/** Small DOM helpers. The UI is plain elements — no framework, no build step. */

type Attrs = Record<string, string | number | boolean | EventListener | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: Array<Node | string | null | undefined> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === 'class') {
      node.className = String(value);
    } else if (key === 'text') {
      node.textContent = String(value);
    } else if (key === 'html') {
      node.innerHTML = String(value);
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function button(label: string, onClick: () => void, cls = 'btn'): HTMLButtonElement {
  return el('button', { class: cls, type: 'button', onclick: onClick }, [label]);
}

export interface SliderOptions {
  min: number;
  max: number;
  step: number;
  value: number;
  format?: (v: number) => string;
  onInput: (v: number) => void;
}

/**
 * A slider that is still a real `input[type=range]` — keyboard, screen reader
 * and touch behaviour all come for free — but reports its own fill fraction on
 * `--fill` so the track can be drawn instead of inherited from the OS. The
 * native thumb and track are hidden in CSS; a stock range control is the single
 * most obvious sign that nobody styled a panel.
 */
export function slider(label: string, opts: SliderOptions): HTMLElement {
  const readout = el('span', { class: 'slider-value' }, [
    opts.format ? opts.format(opts.value) : opts.value.toFixed(2),
  ]);
  const fraction = (v: number) => (v - opts.min) / Math.max(1e-6, opts.max - opts.min);
  const input = el('input', {
    type: 'range',
    min: opts.min,
    max: opts.max,
    step: opts.step,
    value: opts.value,
    oninput: (e: Event) => {
      const v = Number((e.target as HTMLInputElement).value);
      readout.textContent = opts.format ? opts.format(v) : v.toFixed(2);
      track.style.setProperty('--fill', fraction(v).toFixed(4));
      opts.onInput(v);
    },
  });
  const track = el('div', { class: 'slider-track' }, [input]);
  track.style.setProperty('--fill', fraction(opts.value).toFixed(4));
  return el('label', { class: 'slider' }, [
    el('span', { class: 'slider-label' }, [label]),
    track,
    readout,
  ]);
}

/** Checkbox drawn as a switch. Same reasoning as the slider. */
export function toggle(label: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
  const input = el('input', {
    type: 'checkbox',
    checked: value,
    onchange: (e: Event) => onChange((e.target as HTMLInputElement).checked),
  });
  return el('label', { class: 'toggle' }, [
    input,
    el('span', { class: 'toggle-switch', 'aria-hidden': 'true' }),
    el('span', { class: 'toggle-label' }, [label]),
  ]);
}

export function segmented<T extends string>(
  options: Array<{ value: T; label: string }>,
  current: T,
  onPick: (v: T) => void,
): HTMLElement {
  const wrap = el('div', { class: 'segmented' });
  for (const option of options) {
    const b = button(option.label, () => {
      for (const child of Array.from(wrap.children)) child.classList.remove('on');
      b.classList.add('on');
      onPick(option.value);
    }, 'seg');
    if (option.value === current) b.classList.add('on');
    wrap.append(b);
  }
  return wrap;
}

export function colorField(label: string, value: string, onChange: (v: string) => void): HTMLElement {
  return el('label', { class: 'colorfield' }, [
    el('span', {}, [label]),
    el('input', {
      type: 'color',
      value,
      oninput: (e: Event) => onChange((e.target as HTMLInputElement).value),
    }),
  ]);
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '--:--';
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(1).padStart(4, '0')}`;
}

export function formatScore(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}
