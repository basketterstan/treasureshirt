// Mobile nav
const toggle = document.getElementById('navToggle');
const navLinks = document.getElementById('navLinks');
toggle?.addEventListener('click', () => {
  const open = navLinks.classList.toggle('open');
  toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
});

// Highlight the current page in the nav
(() => {
  const here = location.pathname.split('/').pop() || 'index.html';
  const isKerst = new URLSearchParams(location.search).get('c') === 'kerst';
  document.querySelectorAll('.nav-links a').forEach(a => {
    const [file, q] = a.getAttribute('href').split('?');
    if (file === here && !a.classList.contains('nav-kerst') && !(isKerst && file === 'shop.html')) a.classList.add('active');
    if (q && isKerst && a.classList.contains('nav-kerst')) a.setAttribute('aria-current', 'page');
  });
})();

// Contact form: the site has no mail backend for this form, so open the
// visitor's mail app with the message filled in instead of pretending to send.
document.getElementById('contactForm')?.addEventListener('submit', e => {
  e.preventDefault();
  const v = id => (document.getElementById(id)?.value || '').trim();
  const subject = v('subject') || 'Vraag via treasureshirt.com';
  const body = `${v('message')}\n\n— ${v('name')} (${v('email')})`;
  window.location.href = `mailto:contact@treasureshirt.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  showToast('Je mailprogramma opent met je bericht — druk daar op verzenden.');
});

function showToast(msg) {
  const toast = document.getElementById('toast') || document.getElementById('cartToast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 4000);
}
