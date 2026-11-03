const Cart = (() => {
  const KEY = 'ts_cart';

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function euro(n) { return '€ ' + Number(n).toFixed(2).replace('.', ',').replace(',00', ''); }

  function get() {
    let items;
    try { items = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { items = []; }
    if (!Array.isArray(items)) items = [];
    // Older versions of the site stored items without a key (e.g. old "Op maat"
    // items), which made them impossible to remove. Give every item a key.
    let changed = false;
    items.forEach((i, n) => {
      if (!i.cartKey && !i.id) { i.cartKey = 'oud-' + n + '-' + Date.now(); changed = true; }
      if (!i.quantity || i.quantity < 1) { i.quantity = 1; changed = true; }
    });
    if (changed) localStorage.setItem(KEY, JSON.stringify(items));
    return items;
  }
  function save(items) { localStorage.setItem(KEY, JSON.stringify(items)); updateBadge(); render(); }

  function keyFor(p) {
    return [p.id, p.type || '', p.color || '', p.size || '', (p.personalName || '').trim().toLowerCase()].join('__');
  }

  function metaLine(i) {
    return [i.typeLabel, i.colorLabel, i.size, i.personalName ? `Naam: “${i.personalName}”` : '']
      .filter(Boolean).join(' · ');
  }

  function add(product) {
    const items = get();
    if (product.type === 'custom') {
      items.push(product);
      save(items); flashBadge(); showAddedToast(product.name);
      return;
    }
    const key = keyFor(product);
    const existing = items.find(i => (i.cartKey || i.id) === key);
    if (existing) existing.quantity++;
    else items.push({
      cartKey: key, id: product.id, name: product.name, price: product.price,
      image: product.image || '', emoji: product.emoji || '👕',
      type: product.variantType || '', typeLabel: product.typeLabel || '',
      color: product.color || '', colorLabel: product.colorLabel || '',
      size: product.size || '', personalName: product.personalName || '',
      quantity: 1,
    });
    save(items); flashBadge(); showAddedToast(product.name);
  }

  function remove(key) { save(get().filter(i => (i.cartKey || i.id) !== key)); }

  function updateQty(key, qty) {
    if (qty <= 0) { remove(key); return; }
    const items = get();
    const item = items.find(i => (i.cartKey || i.id) === key);
    if (item) { item.quantity = Math.min(qty, 20); save(items); }
  }

  function total() { return get().reduce((s, i) => s + i.price * (i.quantity || 1), 0); }
  function count() { return get().reduce((s, i) => s + (i.quantity || 1), 0); }
  function clear() { localStorage.removeItem(KEY); updateBadge(); render(); }

  function updateBadge() {
    const n = count();
    const badge = document.getElementById('cartCount');
    if (!badge) return;
    badge.textContent = n;
    badge.style.display = n > 0 ? 'flex' : 'none';
  }

  function flashBadge() {
    const badge = document.getElementById('cartCount');
    if (!badge) return;
    badge.classList.remove('bounce'); void badge.offsetWidth; badge.classList.add('bounce');
  }

  function render() {
    const items = get();
    const itemsEl = document.getElementById('cartItems');
    const totalEl = document.getElementById('cartTotal');
    const checkBtn = document.getElementById('checkoutBtn');
    if (!itemsEl) return;

    if (!items.length) {
      itemsEl.innerHTML = '<p class="cart-empty">Je winkelwagen is leeg.</p>';
      if (totalEl) totalEl.textContent = '€ 0';
      if (checkBtn) checkBtn.disabled = true;
      return;
    }
    if (checkBtn) checkBtn.disabled = false;

    itemsEl.innerHTML = items.map(item => {
      const key = esc(item.cartKey || item.id);
      const thumb = item.image ? `<img src="${esc(item.image)}" alt="">` : esc(item.emoji || '👕');
      if (item.type === 'custom') {
        return `
          <div class="cart-item">
            <div class="cart-item-emoji">${thumb}</div>
            <div class="cart-item-info">
              <p class="cart-item-name">${esc(item.name)}</p>
              <p class="cart-item-brief">${esc(item.brief || '')}</p>
              <p class="cart-item-price">${euro(item.price)}</p>
            </div>
            <div class="cart-item-controls"><button class="remove-btn" data-key="${key}" aria-label="Verwijderen">✕</button></div>
          </div>`;
      }
      return `
        <div class="cart-item">
          <div class="cart-item-emoji">${thumb}</div>
          <div class="cart-item-info">
            <p class="cart-item-name">${esc(item.name)}</p>
            ${metaLine(item) ? `<p class="cart-item-meta">${esc(metaLine(item))}</p>` : ''}
            <p class="cart-item-price">${euro(item.price)}</p>
          </div>
          <div class="cart-item-controls">
            <button class="qty-btn" data-action="dec" data-key="${key}" aria-label="Minder">−</button>
            <span class="qty-num">${item.quantity}</span>
            <button class="qty-btn" data-action="inc" data-key="${key}" aria-label="Meer">+</button>
            <button class="remove-btn" data-key="${key}" aria-label="Verwijderen">✕</button>
          </div>
        </div>`;
    }).join('');

    if (totalEl) totalEl.textContent = euro(total());

    itemsEl.querySelectorAll('.qty-btn').forEach(btn => btn.addEventListener('click', () => {
      const cur = get().find(i => (i.cartKey || i.id) === btn.dataset.key);
      if (cur) updateQty(btn.dataset.key, cur.quantity + (btn.dataset.action === 'inc' ? 1 : -1));
    }));
    itemsEl.querySelectorAll('.remove-btn').forEach(btn => btn.addEventListener('click', () => remove(btn.dataset.key)));
  }

  function open() { document.getElementById('cartOverlay')?.classList.add('open'); render(); }
  function close() { document.getElementById('cartOverlay')?.classList.remove('open'); }
  function checkout() { if (get().length) window.location.href = 'checkout.html'; }

  function showAddedToast(name) {
    const t = document.getElementById('cartToast');
    if (!t) return;
    t.textContent = `✓ ${name} toegevoegd`;
    t.classList.add('show');
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2500);
  }

  function init() {
    updateBadge();
    document.getElementById('cartBtn')?.addEventListener('click', open);
    document.getElementById('cartClose')?.addEventListener('click', close);
    document.getElementById('cartOverlay')?.addEventListener('click', e => { if (e.target === e.currentTarget) close(); });
    document.getElementById('checkoutBtn')?.addEventListener('click', checkout);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  }

  return { add, remove, updateQty, open, close, checkout, get, clear, total, metaLine, init };
})();

document.addEventListener('DOMContentLoaded', () => Cart.init());
