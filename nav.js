(() => {
  'use strict';
  const toggle = document.getElementById('navToggle');
  const nav = document.getElementById('primaryNav');
  if (!toggle || !nav) return;
  const close = () => { nav.classList.remove('is-open'); toggle.setAttribute('aria-expanded', 'false'); };
  toggle.addEventListener('click', () => {
    const open = nav.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', String(open));
  });
  nav.addEventListener('click', event => { if (event.target.tagName === 'A') close(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
  document.addEventListener('click', event => { if (!nav.contains(event.target) && !toggle.contains(event.target)) close(); });
  window.matchMedia('(min-width: 651px)').addEventListener('change', event => { if (event.matches) close(); });
})();
