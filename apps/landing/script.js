const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/* mobile menu */
const menuButton = $('.menu-btn');
const nav = $('#site-nav');
function setMenu(open) {
  nav.classList.toggle('is-open', open);
  document.body.classList.toggle('menu-open', open);
  menuButton.setAttribute('aria-expanded', String(open));
}
menuButton?.addEventListener('click', () => setMenu(!nav.classList.contains('is-open')));
$$('#site-nav a').forEach((link) => link.addEventListener('click', () => setMenu(false)));
$('#year').textContent = new Date().getFullYear();

/* scroll reveal */
const reveals = $$('.reveal');
if ('IntersectionObserver' in window && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    }
  }, { threshold: 0.08, rootMargin: '0px 0px -30px' });
  reveals.forEach((element) => observer.observe(element));
} else {
  reveals.forEach((element) => element.classList.add('is-visible'));
}

/* download link override (set at build time) */
const downloadButton = $('#download-button');
const downloadUrl = String(window.AGENT_MICRO_DOWNLOAD_URL || '').trim();
if (downloadButton && downloadUrl) downloadButton.href = downloadUrl;

/* interactive controller demo */
const demo = $('#demo');
if (demo) {
  const agentButtons = $$('.seg button', demo);
  agentButtons.forEach((button, index) => button.addEventListener('click', () => {
    agentButtons.forEach((other) => other.setAttribute('aria-pressed', String(other === button)));
    $('#demo-agent').textContent = String(index + 1).padStart(2, '0');
  }));
  const fast = $('#fast');
  fast.addEventListener('click', () => {
    const on = fast.getAttribute('aria-pressed') !== 'true';
    fast.setAttribute('aria-pressed', String(on));
    $('#fast-state').textContent = on ? 'ON' : 'OFF';
  });
}

/* Korean / English */
const languageSwitch = $('#language-switch');
const translatable = $$('[data-en]');
const korean = new Map(translatable.map((element) => [element, element.innerHTML]));
const titles = { ko: 'Agent Micro — Codex를 더 쉽고 빠르게.', en: 'Agent Micro — Complex Codex controls, within reach.' };

function applyLanguage(language) {
  const english = language === 'en';
  document.documentElement.lang = language;
  document.title = titles[language];
  for (const element of translatable) element.innerHTML = english ? element.dataset.en : korean.get(element);
  languageSwitch.textContent = english ? '한국어' : 'English';
  languageSwitch.setAttribute('aria-label', english ? '페이지 언어를 한국어로 변경' : 'Switch page language to English');
  try { localStorage.setItem('agent-micro-landing-language', language); } catch {}
}

let language = 'ko';
try { language = localStorage.getItem('agent-micro-landing-language') === 'en' ? 'en' : 'ko'; } catch {}
if (language === 'en') applyLanguage('en');
languageSwitch?.addEventListener('click', () => {
  language = document.documentElement.lang === 'en' ? 'ko' : 'en';
  applyLanguage(language);
  setMenu(false);
});
