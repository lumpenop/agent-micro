const menuButton = document.querySelector('.menu-toggle');
const nav = document.querySelector('.site-nav');

function closeMenu() {
  nav?.classList.remove('is-open');
  document.body.classList.remove('menu-open');
  menuButton?.setAttribute('aria-expanded', 'false');
}

menuButton?.addEventListener('click', () => {
  const open = nav?.classList.toggle('is-open');
  document.body.classList.toggle('menu-open', Boolean(open));
  menuButton.setAttribute('aria-expanded', String(Boolean(open)));
});

document.querySelectorAll('.site-nav a').forEach((link) => link.addEventListener('click', closeMenu));
document.querySelector('#year').textContent = new Date().getFullYear();

const reveals = document.querySelectorAll('.reveal');
if ('IntersectionObserver' in window && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -40px' });
  reveals.forEach((element) => observer.observe(element));
} else {
  reveals.forEach((element) => element.classList.add('is-visible'));
}

const heroVisual = document.querySelector('.hero-visual');
if (heroVisual && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  window.addEventListener('scroll', () => {
    const offset = Math.min(window.scrollY * 0.055, 34);
    heroVisual.style.transform = `translate3d(0, ${offset}px, 0)`;
  }, { passive: true });
}

const downloadButton = document.querySelector('#download-button');
const downloadUrl = String(window.AGENT_MICRO_DOWNLOAD_URL || '').trim();
if (downloadButton && downloadUrl) {
  downloadButton.href = downloadUrl;
  downloadButton.removeAttribute('aria-disabled');
  downloadButton.textContent = 'Download Agent Micro';
  downloadButton.target = '_blank';
  downloadButton.rel = 'noreferrer';
} else {
  // Keep the page useful before a custom DMG URL is configured.
  if (downloadButton) {
    downloadButton.href = 'https://github.com/lumpenop/agent-keyboard/releases/latest';
    downloadButton.target = '_blank';
    downloadButton.rel = 'noreferrer';
    downloadButton.textContent = 'View latest release';
  }
}
