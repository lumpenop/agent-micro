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
  }, { threshold: 0.1, rootMargin: '0px 0px -36px' });
  reveals.forEach((element) => observer.observe(element));
} else {
  reveals.forEach((element) => element.classList.add('is-visible'));
}

const downloadButton = document.querySelector('#download-button');
const downloadUrl = String(window.AGENT_MICRO_DOWNLOAD_URL || '').trim();
if (downloadButton) {
  downloadButton.href = downloadUrl || 'https://github.com/lumpenop/agent-micro/releases/download/v1.2.1/Agent.Micro-1.2.1-arm64.dmg';
  downloadButton.target = '_blank';
  downloadButton.rel = 'noreferrer';
}

const languageSwitch = document.querySelector('#language-switch');
const koreanCopy = new WeakMap();

function setCopy(selector, englishValues, english) {
  document.querySelectorAll(selector).forEach((element, index) => {
    if (!koreanCopy.has(element)) koreanCopy.set(element, element.innerHTML);
    element.innerHTML = english
      ? englishValues[index] ?? englishValues[0] ?? element.innerHTML
      : koreanCopy.get(element);
  });
}

function applyLanguage(language) {
  const english = language === 'en';
  document.documentElement.lang = english ? 'en' : 'ko';
  document.title = english
    ? 'Agent Micro — Complex Codex controls, within reach.'
    : 'Agent Micro — Codex를 더 쉽고 빠르게.';

  setCopy('.site-nav > a', ['Controls', 'Settings', 'Usage', 'Git', 'Agents', '<span aria-hidden="true">★</span> GitHub', 'Download'], english);
  setCopy('.product-hero-copy > .eyebrow', ['CODEX CONTROL SURFACE FOR macOS'], english);
  setCopy('.product-hero-copy > h1', ['Complex Codex controls.<br /><span>Right under your fingers.</span>'], english);
  setCopy('.product-hero-copy > .hero-lede', ['Change models, toggle Fast mode, approve or decline, fork conversations, select agents, use Git, and manage usage and resources. Click a button or press a shortcut instead of memorizing commands.'], english);
  setCopy('.product-hero .hero-actions .button', ['Choose a download', 'See everything it can do <span aria-hidden="true">↓</span>'], english);
  setCopy('.product-hero .hero-pills span', ['Buttons + shortcuts', 'Codex CLI', 'Local first', 'Apple silicon'], english);
  setCopy('.controller-sticker > span', ['One button', 'Instant toggle', '6d 10h left'], english);
  setCopy('.controller-stage > .actual-badge', ['<i></i> LIVE APP UI'], english);
  setCopy('.product-hero > .hero-proof span', [
    'Instant agent switching',
    'Model · Fast · approvals',
    'Usage and reset status',
    'From install to commit',
  ], english);

  setCopy('#controls .section-copy > h2', ['Everyday controls.<br /><span>Moved out into the open.</span>'], english);
  setCopy('#controls .section-copy > p:last-child', ['Run commands from the floating pad and configurable shortcuts instead of jumping between terminal commands and configuration files.'], english);
  setCopy('.approval-row button', ['✓ Approve', '× Decline', '↗ Fork'], english);
  setCopy('.control-primary > p', ['Every action goes only to the currently selected Agent.'], english);
  setCopy('.shortcut-card strong', ['Select an Agent', 'Switch models', 'Fast ON / OFF', 'Approve / decline', 'Fork'], english);
  setCopy('.shortcut-card small', [
    'Keep terminal focus and pad state in sync',
    'Open the model picker or switch immediately',
    'Change response speed and reasoning mode',
    'Respond to approval requests from the keyboard',
    'Branch the current conversation into an empty Agent slot',
  ], english);
  setCopy('.feature-marquee span', ['New chat', 'Plan mode', 'Clear input', 'Voice input', 'Review', 'Dev Server', 'Custom icons', 'Hide ⌘⇧M'], english);

  setCopy('#settings .section-copy > h2', ['Stop hunting for config files.<br /><span>Choose it in a window.</span>'], english);
  setCopy('#settings .section-copy > p:last-of-type', ['Manage Codex models, reasoning, sandbox, approval policies, and agent rules in a readable settings window, with backups and restore built in.'], english);
  setCopy('#settings .check-list li', [
    '<i>✓</i> Ask mode and default work mode',
    '<i>✓</i> Automatic model routing by prompt complexity',
    '<i>✓</i> Model, reasoning effort, and response length',
    '<i>✓</i> Sandbox, approval policy, and web search',
    '<i>✓</i> Global, project, and per-Agent rules',
    '<i>✓</i> Backup, restore, and open config.toml',
  ], english);

  setCopy('#usage .section-copy > h2', ['How much you used.<br /><span>When it resets.</span>'], english);
  setCopy('#usage .section-copy > p:last-child', ['See session, daily, and monthly tokens together with plan usage, time until reset, and a recommended daily pace.'], english);
  setCopy('.usage-topline small', ['PLAN USAGE', 'NEXT RESET', 'RECOMMENDED TODAY'], english);
  setCopy('.usage-topline > div:nth-child(3) span', ['On pace'], english);
  setCopy('.usage-progress-landing b', ['Daily target 15%'], english);
  setCopy('.usage-bottomline small', ['Current session', 'Today', 'This month', 'Context'], english);
  setCopy('.menubar-inline h3', ['Keep working.<br />Usage stays visible.'], english);
  setCopy('.menubar-inline p', ['A five-block graph and reset countdown stay visible in the macOS menu bar.'], english);

  setCopy('#resources .section-copy > h2', ['Let it run longer.<br /><span>Set the boundaries first.</span>'], english);
  setCopy('#resources .section-copy > p:last-child', ['Agent Micro cannot stop server billing, but local targets and warnings help you catch excessive usage and runaway work early.'], english);
  setCopy('.resource-card p', [
    'Warn when app memory exceeds the threshold',
    'Limit Agent work that keeps running too long',
    'Choose how many threads can stay open',
    'Experimental token tracking and reminder intervals',
    'Choose when context should compact automatically',
    'Set the maximum wait for each tool call',
  ], english);

  setCopy('.setup-step strong', ['Connect Codex', 'Connect GitHub <em>Optional</em>', 'Choose a project', 'Start your first Agent'], english);
  setCopy('.setup-step small', [
    'Signed in with your ChatGPT account',
    'Quick browser sign-in',
    'Pick the folder Codex should work in',
    'Open a ready-to-use session',
  ], english);
  setCopy('.setup-step button', ['Connect', 'Choose', 'Start'], english);
  setCopy('.setup-card > p', ['GitHub is optional. Skip it and local Git and Codex still work as usual.'], english);
  setCopy('.git-panel-card > p', ['✦ Read the changes and generate a commit message'], english);
  setCopy('#git .section-copy > h2', ['Local Git, ready now.<br /><span>GitHub when you need it.</span>'], english);
  setCopy('#git .section-copy > p:last-of-type', ['Use local Git immediately, then optionally connect GitHub during first run or later in Settings. Manage changed files, staging, Pull, Push, commits, and generated messages inside the app.'], english);
  setCopy('#git .check-list li', [
    '<i>01</i> Detect an existing GitHub login on first run',
    '<i>02</i> See branch, changed files, and staged state',
    '<i>03</i> Stage or unstage files individually or all at once',
    '<i>04</i> Pull, Push, and generate commit messages',
    '<i>05</i> Block dirty, conflicting, or overlapping merges',
  ], english);

  setCopy('#agents .section-copy > h2', ['Up to six when you need them.<br /><span>Without mixing the work.</span>'], english);
  setCopy('#agents .section-copy > p:last-child', ['Multi-agent orchestration is an advanced capability, not the entire product. Agent 1 protects main while Workers run in isolated worktrees.'], english);
  setCopy('#agents .actual-badge', ['LIVE AGENT MANAGER'], english);
  setCopy('.agent-capabilities strong', ['Automatic Worker assignment', 'Stopped-session recovery', 'Dependency merge queue', 'Per-Agent profiles'], english);
  setCopy('.agent-capabilities p', [
    'Create a task, branch, and worktree in the next free slot',
    'Retry safely once without repeated restarts',
    'Wait automatically until prerequisite work is complete',
    'Choose role, model, rules, tools, and working folder',
  ], english);

  setCopy('.everything .section-copy > h2', ['Small on the desktop.<br /><span>Big on control.</span>'], english);
  setCopy('.everything-grid span', [
    'Model picker', 'Automatic model routing', 'Fast mode', 'Plan mode',
    'Approve · decline', 'Conversation fork', 'Agents 1–6', 'Voice input',
    'Git integration', 'MCP management', 'Skills & Plugins', 'Custom roles',
    'Ask mode', 'Usage · reset', 'Daily targets', 'RAM warnings',
    'Maximum runtime', 'Token reminders', 'Auto Continue', 'Prevent sleep',
  ], english);

  setCopy('#download > h2', ['Make Codex easier.<br /><span>And more precise.</span>'], english);
  setCopy('#download > p:not(.eyebrow)', ['Let the app handle the controls and focus on the work in front of you.'], english);
  setCopy('#download-button', ['Download for macOS <small>Apple silicon</small>'], english);
  setCopy('#windows-download-button', ['Download for Windows <small>Agent Micro Setup 1.2.4.exe</small>'], english);
  setCopy('.github-star-link', ['★ Star on GitHub'], english);
  setCopy('.download-meta', ['macOS · Windows · Open source · MIT · Codex CLI'], english);
  setCopy('.download-warning', ['Public beta. Download <strong>Agent Micro Setup 1.2.4.exe</strong> from the GitHub Release.'], english);
  setCopy('.site-footer .footer-shell > p:first-of-type', ['Complex Codex controls, within reach.'], english);

  if (languageSwitch) {
    languageSwitch.textContent = english ? '한국어' : 'English';
    languageSwitch.setAttribute('aria-label', english ? '페이지 언어를 한국어로 변경' : 'Switch page language to English');
  }
  try {
    localStorage.setItem('agent-micro-landing-language', english ? 'en' : 'ko');
  } catch {}
}

let language = 'ko';
try {
  language = localStorage.getItem('agent-micro-landing-language') === 'en' ? 'en' : 'ko';
} catch {}
applyLanguage(language);

languageSwitch?.addEventListener('click', () => {
  language = document.documentElement.lang === 'en' ? 'ko' : 'en';
  applyLanguage(language);
  closeMenu();
});
