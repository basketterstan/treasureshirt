// Shared product catalog helpers. data/products.json is the single source of
// truth for products and prices; the checkout function re-reads the same file
// on the server, so prices can't be changed from the browser.
const Catalog = (() => {
  let cache = null;

  async function load() {
    if (cache) return cache;
    const res = await fetch('data/products.json', { cache: 'no-cache' });
    cache = await res.json();
    return cache;
  }

  // Base price for a product + selected type, plus the name option if used.
  function priceFor(p, sel = {}) {
    let price = Number(p.price);
    if (p.types && p.types.length) {
      const t = p.types.find(t => t.id === sel.type) || p.types[0];
      price = Number(t.price);
    }
    if (sel.personalName && p.personalize) price += Number(p.personalize.price || 0);
    return Math.round(price * 100) / 100;
  }

  function fromPrice(p) {
    if (p.types && p.types.length) return Math.min(...p.types.map(t => Number(t.price)));
    return Number(p.price);
  }

  function imageFor(p, type, color) {
    const imgs = p.images || {};
    const t = type || (p.types && p.types[0] && p.types[0].id) || '';
    return imgs[`${t}|${color}`] || imgs[`|${color}`]
      || Object.entries(imgs).find(([k]) => k.startsWith(t + '|'))?.[1]
      || Object.values(imgs)[0] || '';
  }

  // Types that actually have images (so we never show a type that can't be made)
  function typesFor(p) { return p.types || []; }

  function euro(n) {
    const v = Number(n);
    return '€ ' + (Number.isInteger(v) ? v : v.toFixed(2).replace('.', ','));
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  return { load, priceFor, fromPrice, imageFor, typesFor, euro, esc };
})();
