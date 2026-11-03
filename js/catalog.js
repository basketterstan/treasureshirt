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

  // Photo of a person wearing this variant, if we have one.
  function modelFor(p, type, color) {
    const m = p.models || {};
    return m[`${type || (p.types && p.types[0] && p.types[0].id) || ''}|${color}`] || '';
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

  return { load, priceFor, fromPrice, imageFor, modelFor, typesFor, euro, esc };
})();

// Voorraad: één lijst voor webshop én kassa (Firestore public/stock, bijgehouden door admin,
// kassa en de betaal-webhook). Een maat/kleur zonder getal = onbeperkt.
const Stock = (() => {
  let cache = null;
  async function load() {
    if (cache) return cache;
    try {
      const r = await fetch('https://firestore.googleapis.com/v1/projects/treasureshirt-68b83/databases/(default)/documents/public/stock', { cache: 'no-cache' });
      const j = await r.json();
      cache = JSON.parse(j.fields?.json?.stringValue || '{}');
    } catch { cache = {}; }
    return cache;
  }
  // Which stock entry a webshop choice uses: [kassa product id, "maat|kleur"]
  function keyFor(p, sel) {
    const t = (p.types || []).find(t => t.id === sel.type);
    const id = (t && t.stockId) || p.stockId;
    if (!id) return null;
    const size = sel.size || ((p.types || []).length && !(p.sizes || []).length ? sel.type : 'One size');
    return [id, `${size}|${sel.color || ''}`];
  }
  // Number left, or null when unlimited / unknown.
  function left(stock, p, sel) {
    const k = keyFor(p, sel); if (!k || !stock) return null;
    const v = stock[k[0]]?.[k[1]];
    return v === undefined || v === null ? null : Number(v);
  }
  return { load, keyFor, left };
})();
