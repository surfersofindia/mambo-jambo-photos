/* Small, dependency-free motion layer. Never hides content pending JavaScript. */
(() => {
  'use strict';
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
  const toggle = document.getElementById('motionToggle');
  const header = document.querySelector('.header');
  const hero = document.querySelector('.hero-photo');
  const progress = document.querySelector('.reading-progress');
  const running = new Set();
  let paused = false;
  try { paused = localStorage.getItem('mj-motion-paused') === 'true'; } catch { /* Storage is optional. */ }
  const enabled = () => !paused && !reduced.matches;
  // Sections are pre-hidden by CSS (html.soi-reveal … :not(.is-revealed)) only while motion is on and this browser
  // can actually reveal them; otherwise nothing is ever hidden pending JavaScript.
  const canReveal = 'IntersectionObserver' in window && 'animate' in Element.prototype;
  function animate(element, frames, options = {}) {
    if (!element || !enabled() || !element.animate) return;
    const animation = element.animate(frames, { duration: 650, easing: 'cubic-bezier(.22,1,.36,1)', ...options });
    running.add(animation);
    const cleanup = () => running.delete(animation);
    animation.addEventListener('finish', cleanup, { once: true });
    animation.addEventListener('cancel', cleanup, { once: true });
  }
  function applyPreference() {
    document.body.classList.toggle('motion-enabled', enabled());
    document.body.classList.toggle('motion-paused', !enabled());
    document.documentElement.classList.toggle('soi-reveal', enabled() && canReveal);
    if (toggle) {
      toggle.hidden = reduced.matches;
      toggle.setAttribute('aria-pressed', String(paused));
      toggle.replaceChildren(document.createTextNode(paused ? 'Resume motion ' : 'Pause motion '));
      const icon = document.createElement('span'); icon.setAttribute('aria-hidden', 'true'); icon.textContent = paused ? '▷' : 'Ⅱ'; toggle.append(icon);
    }
    if (!enabled()) {
      running.forEach(animation => animation.cancel());
      hero?.style.removeProperty('--photo-drift');
    }
  }
  toggle?.addEventListener('click', () => {
    paused = !paused;
    try { localStorage.setItem('mj-motion-paused', String(paused)); } catch { /* Optional preference. */ }
    applyPreference();
  });
  reduced.addEventListener('change', applyPreference);
  applyPreference();
  const rise = [{ opacity: 0, transform: 'translateY(22px)' }, { opacity: 1, transform: 'translateY(0)' }];
  document.querySelectorAll('.hero-line').forEach((line, index) => animate(line, rise, { duration: 1000, delay: index * 100, fill: 'backwards' }));
  animate(document.querySelector('.hero .intro'), rise, { delay: 240, fill: 'backwards' });
  animate(hero, [{ opacity: .35, transform: 'scale(1.04)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 1400 });
  animate(document.querySelector('.hero-wordmark'), [{ opacity: 0, transform: 'translateY(15px) scale(.97)' }, { opacity: 1, transform: 'translateY(0) scale(1)' }], { duration: 1100 });
  const revealed = new WeakSet();
  const observer = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      observer.unobserve(entry.target);
      if (revealed.has(entry.target)) return;
      revealed.add(entry.target);
      // Mark before animating: the class lifts the CSS pre-hide, fill:'backwards' keeps opacity 0 until the first frame.
      entry.target.classList.add('is-revealed'); animate(entry.target, rise, { duration: 850, fill: 'backwards' });
    });
  }, { threshold: .12 }) : null;
  function observeSections() {
    document.querySelectorAll('.section-copy,.finder-card,.section-title,.how-grid article,.session-card,.privacy>div').forEach(element => {
      if (!revealed.has(element)) observer?.observe(element);
    });
  }
  observeSections();
  document.addEventListener('mj:sessions', observeSections);
  document.addEventListener('mj:stage', event => animate(document.getElementById(`${event.detail}Stage`), [{ opacity: .35, transform: 'translateY(9px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 400 }));
  const lightboxImage = document.getElementById('lightboxImage');
  document.addEventListener('mj:photo', () => {
    if (!lightboxImage) return;
    lightboxImage.getAnimations().forEach(animation => animation.cancel());
    animate(lightboxImage, [{ opacity: .2, transform: 'scale(.985)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 420 });
  });
  const lightbox = document.getElementById('lightbox');
  lightbox?.addEventListener('click', event => { if (event.target === lightbox) lightbox.close(); });
  let scheduled = false;
  function updateScroll() {
    scheduled = false;
    header?.classList.toggle('is-scrolled', window.scrollY > 20);
    if (!enabled()) return;
    const distance = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    progress?.style.setProperty('--read', Math.min(1, Math.max(0, window.scrollY / distance)));
    if (finePointer.matches && window.scrollY < 900) hero?.style.setProperty('--photo-drift', `${Math.min(30, window.scrollY * .045)}px`);
  }
  window.addEventListener('scroll', () => { if (!scheduled) { scheduled = true; requestAnimationFrame(updateScroll); } }, { passive: true });
  window.addEventListener('resize', updateScroll, { passive: true });
  updateScroll();
  // Highlight the section currently under the sticky navigation.
  if ('IntersectionObserver' in window) {
    const navObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        const link = document.querySelector(`nav a[href="#${entry.target.id}"]`);
        if (!link) return;
        if (entry.isIntersecting) link.setAttribute('aria-current', 'location'); else link.removeAttribute('aria-current');
      });
    }, { rootMargin: '-20% 0px -45% 0px', threshold: 0 });
    document.querySelectorAll('#finder,#how-it-works,#sessions').forEach(section => navObserver.observe(section));
  }
})();
