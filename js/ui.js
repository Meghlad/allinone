/**
 * ui.js — page behaviour.
 *
 *   • sticky nav state and scroll-spy on the section links
 *   • reveal-on-scroll for .reveal elements
 *   • the Computer Vision / Robotics project tab switcher
 */
(function () {
  'use strict';

  const SECTION_IDS = ['about', 'skills', 'projects', 'timeline', 'contact'];

  /* ------------------------------------------------------------------ *
   * Sticky nav + scroll-spy
   * ------------------------------------------------------------------ */

  function initNav() {
    const nav = document.getElementById('nav');
    if (!nav) return;

    window.addEventListener('scroll', () => {
      nav.classList.toggle('is-stuck', window.scrollY > 10);
    }, { passive: true });

    // map "#skills" -> the <a> that points at it
    const linkFor = {};
    nav.querySelectorAll('a[href^="#"]').forEach((link) => {
      linkFor[link.getAttribute('href').slice(1)] = link;
    });

    if (!('IntersectionObserver' in window)) return;

    const spy = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        // marks the section being read: greens its label dot, lights its nav link
        entry.target.classList.toggle('is-inview', entry.isIntersecting);

        const link = linkFor[entry.target.id];
        if (link) link.classList.toggle('is-active', entry.isIntersecting);
      });
    }, { rootMargin: '-45% 0px -50% 0px' });

    SECTION_IDS.forEach((id) => {
      const section = document.getElementById(id);
      if (section) spy.observe(section);
    });
  }

  /* ------------------------------------------------------------------ *
   * Reveal on scroll
   * ------------------------------------------------------------------ */

  function initReveal() {
    const targets = document.querySelectorAll('.reveal');

    if (!('IntersectionObserver' in window)) {
      targets.forEach((el) => el.classList.add('is-visible'));
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -10% 0px', threshold: 0.1 });

    targets.forEach((el) => observer.observe(el));
  }

  /* ------------------------------------------------------------------ *
   * Project tabs
   * ------------------------------------------------------------------ */

  function initTabs() {
    const tabs = Array.from(document.querySelectorAll('.tab'));
    if (!tabs.length) return;

    /** Show the panel owned by `tab` and hide the others. */
    function select(tab) {
      tabs.forEach((candidate) => {
        const isSelected = candidate === tab;
        candidate.setAttribute('aria-selected', String(isSelected));
        candidate.tabIndex = isSelected ? 0 : -1;

        const panel = document.getElementById(candidate.getAttribute('aria-controls'));
        if (!panel) return;

        panel.hidden = !isSelected;

        // a panel revealed after its observer fired would stay invisible
        if (isSelected) {
          panel.querySelectorAll('.reveal').forEach((el) => el.classList.add('is-visible'));
        }
      });
    }

    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => select(tab));

      tab.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
        event.preventDefault();

        const step = event.key === 'ArrowRight' ? 1 : tabs.length - 1;
        const next = tabs[(index + step) % tabs.length];
        next.focus();
        select(next);
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */

  initNav();
  initReveal();
  initTabs();
})();
