/* soi-fx.js — Surfers of India micro-interactions, no deps, ≤6 KB. window.SOI = { version, haptic, splash, underline }.
   Deferred before app.js / admin.js; each entry point swallows its own errors, so old browsers get no-ops. */
(() => {
  'use strict';
  const SOI = window.SOI = window.SOI || {};
  SOI.version = '1';
  const R = Math.random, EASE = 'cubic-bezier(.22,1,.36,1)'; // = --ease-out
  const INK = ['terracotta', 'slate-deep', 'coral-deep', 'ochre']; // --soi-* colours, cycled
  const still = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches || !Element.prototype.animate; } catch { return true; } };
  const svgEl = tag => document.createElementNS('http://www.w3.org/2000/svg', tag);

  // haptic: desktop Chrome exposes vibrate() too, so gate on "last pointer was a finger" AND a hover-less device
  let touched = false;
  addEventListener('pointerdown', e => { touched = e.pointerType === 'touch'; }, { capture: true, passive: true });
  SOI.haptic = (pattern = [15]) => {
    try { return !!(touched && matchMedia('(hover:none)').matches && navigator.vibrate(pattern)); } catch { return false; }
  };

  // splash: linocut stamps burst from an Element (measured a frame later, after a smooth scroll settles) or viewport {x,y}.
  // Nothing outside the top layer paints over an open dialog, so the layer goes inside it (absolute: a transform would misplace fixed).
  const tr = (x, y, r, s) => `translate(${x}px,${y}px) rotate(${r}deg) scale(${s})`;
  function burst({ at, symbol = 'stamp-sunburst', count = 10, color, spread = 90, duration = 900 }, resolve) {
    let x, y, r, host = document.querySelector('dialog[open]');
    if (at?.getBoundingClientRect) { r = at.getBoundingClientRect(); x = r.left + r.width / 2; y = r.top + r.height / 2; }
    else if (typeof at?.x === 'number') { x = at.x; y = at.y; }
    else { x = innerWidth / 2; y = innerHeight / 2; }
    const layer = document.createElement('div');
    layer.className = 'soi-splash'; layer.setAttribute('aria-hidden', 'true');
    if (host) { r = host.getBoundingClientRect(); x += host.scrollLeft - r.left - host.clientLeft; y += host.scrollTop - r.top - host.clientTop; layer.style.position = 'absolute'; }
    else host = document.body;
    let left = count;
    const done = () => { if (--left <= 0 && layer.parentNode) { layer.remove(); resolve(); } };
    for (let i = 0; i < count; i++) {
      const size = 14 + Math.round(R() * 12), s = svgEl('svg'), u = svgEl('use');
      const a = i / count * Math.PI * 2 + (R() - .5) * .7, d = spread * (.55 + R() * .65);
      const dx = Math.cos(a) * d, dy = Math.sin(a) * d, rot = R() * 240 - 120;
      u.setAttribute('href', `soi-stamps.svg#${symbol}`); s.appendChild(u);
      s.style.cssText = `left:${x - size / 2}px;top:${y - size / 2}px;width:${size}px;height:${size}px;color:${color || `var(--soi-${INK[i % 4]})`}`;
      layer.appendChild(s);
      // lifts a little on the way out, then sags: thrown, not radiated
      const anim = s.animate([{ transform: tr(0, 0, 0, .4), opacity: 1 }, { transform: tr(dx * .72, dy * .72 - 12, rot * .6, 1), opacity: 1, offset: .45 }, { transform: tr(dx, dy + 16, rot, .8), opacity: 0 }],
        { duration, delay: R() * 120, easing: EASE, fill: 'forwards' });
      anim.onfinish = anim.oncancel = done;
    }
    host.appendChild(layer);
    setTimeout(() => { left = 0; done(); }, duration + 400); // hidden tabs pause WAAPI
  }
  SOI.splash = (o = {}) => new Promise(resolve => {
    if (still()) return resolve();
    requestAnimationFrame(() => { try { burst(o, resolve); } catch { resolve(); } });
  });

  // underline: a hand-drawn stroke under a label. Wobble is seeded from the text (FNV → LCG) so a word keeps its line
  // across resizes. Px path, no viewBox: the stroke never scales.
  const lines = [];
  let timer;
  function draw(e, animate) {
    const el = e.el, w = el.getBoundingClientRect().width, t = el.textContent || '';
    if (!w || w === e.w) return; // hidden or unchanged
    e.w = w;
    let s = 2166136261, i;
    for (i = 0; i < t.length; i++) { s ^= t.charCodeAt(i); s = Math.imul(s, 16777619); }
    const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
    const segs = 3 + (rnd() > .5 ? 1 : 0), pts = [];
    for (i = 0; i <= segs; i++) pts.push([(w / segs) * i + (i && i < segs ? (rnd() - .5) * w * .08 : 0), 5 + (rnd() - .5) * 5]);
    let d = `M${pts[0]}`;
    for (i = 1; i <= segs; i++) d += `Q${(pts[i - 1][0] + pts[i][0]) / 2},${5 + (rnd() - .5) * 8} ${pts[i]}`;
    if (!e.svg) {
      e.svg = svgEl('svg'); e.path = svgEl('path');
      e.svg.setAttribute('class', 'soi-underline-svg'); e.svg.setAttribute('aria-hidden', 'true');
      e.svg.appendChild(e.path); el.appendChild(e.svg);
    }
    e.path.setAttribute('d', d);
    if (e.color) e.path.style.stroke = e.color;
    const len = e.path.getTotalLength();
    e.path.style.strokeDasharray = len; e.path.style.strokeDashoffset = 0;
    if (!animate || !len || still()) return;
    // fill:backwards hides the stroke through the delay; then the inline 0 takes over
    e.path.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: 600, delay: e.delay, easing: EASE, fill: 'backwards' });
  }
  SOI.underline = (el, { color, delay = 0 } = {}) => {
    try {
      let e = el._soiLine;
      if (!e) lines.push(e = el._soiLine = { el, w: 0 });
      e.color = color; e.delay = delay;
      el.classList.add('soi-underline');
      draw(e, true);
      return e.svg;
    } catch { return null; }
  };
  const redraw = () => { clearTimeout(timer); timer = setTimeout(() => lines.forEach(e => { try { draw(e, false); } catch {} }), 150); };
  function init() {
    try {
      document.querySelectorAll('.soi-underline').forEach((el, i) => { if (!el._soiLine) SOI.underline(el, { delay: i * 90 }); });
      addEventListener('resize', redraw);
      if (document.fonts) document.fonts.ready.then(redraw); // web fonts shift widths
    } catch {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
