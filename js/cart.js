const Cart = (() => {
  const KEY = 'ts_cart';

  function get() { return JSON.parse(localStorage.getItem(KEY) || '[]'); }
  function save(items) { localStorage.setItem(KEY, JSON.stringify(items)); updateBadge(); render(); }

  function cartKey(id, size) { return size ? `${id}__${size}` : id; }

  function add(product) {
    const items = get();
    const key = cartKey(product.id, product.size);
    const existing = items.find(i => (i.cartKey || i.id) === key);
    if (existing) existing.quantity++;
    else items.push({
      cartKey: key, id: product.id, name: product.name,
      price: product.price, description: product.description,
      emoji: product.emoji || '👕', size: product.size || '',
      quantity: 1,
    });
    save(items);
    flashBadge();
    showAddedToast(product.name + (product.size ? ` — ${product.size}` : ''));
  }

  function remove(key) { save(get().filter(i => (i.cartKey || i.id) !== key)); }

  function updateQty(key, qty) {
    if (qty <= 0) { remove(key); return; }
    const items = get();
    const item = items.find(i => (i.cartKey || i.id) === key);
    if (item) { item.quantity = qty; save(items); }
  }

  function total() { return get().reduce((s, i) => s + i.price * i.quantity, 0); }
  function count() { return get().reduce((s, i) => s + i.quantity, 0); }

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
    badge.classList.remove('bounce');
    void badge.offsetWidth;
    badge.classList.add('bounce');
  }

  function render() {
    const items    = get();
    const itemsEl  = document.getElementById('cartItems');
    const totalEl  = document.getElementById('cartTotal');
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
      const key = item.cartKey || item.id;
      return `
        <div class="cart-item" data-key="${key}">
          <div class="cart-item-emoji">${item.emoji}</div>
          <div class="cart-item-info">
            <p class="cart-item-name">${item.name}${item.size ? `<span class="cart-item-size">${item.size}</span>` : ''}</p>
            <p class="cart-item-price">€ ${item.price}</p>
          </div>
          <div class="cart-item-controls">
            <button class="qty-btn" data-action="dec" data-key="${key}">−</button>
            <span class="qty-num">${item.quantity}</span>
            <button class="qty-btn" data-action="inc" data-key="${key}">+</button>
            <button class="remove-btn" data-key="${key}">✕</button>
          </div>
        </div>`;
    }).join('');

    if (totalEl) totalEl.textContent = `€ ${total().toFixed(2).replace('.', ',')}`;

    itemsEl.querySelectorAll('.qty-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.key;
        const cur = get().find(i => (i.cartKey || i.id) === key);
        if (!cur) return;
        updateQty(key, cur.quantity + (btn.dataset.action === 'inc' ? 1 : -1));
      });
    });

    itemsEl.querySelectorAll('.remove-btn').forEach(btn => {
      btn.addEventListener('click', () => remove(btn.dataset.key));
    });
  }

  function open() { document.getElementById('cartOverlay')?.classList.add('open'); render(); }
  function close() { document.getElementById('cartOverlay')?.classList.remove('open'); }

  async function checkout() {
    const items = get();
    if (!items.length) return;
    const btn = document.getElementById('checkoutBtn');
    if (btn) { btn.textContent = 'Laden...'; btn.disabled = true; }
    try {
      const res = await fetch('https://createcheckout-kelvdlqp7a-uc.a.run.app', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: items.map(i => ({
          ...i,
          name: i.size ? `${i.name} (${i.size})` : i.name,
        })) }),
      });
      const { url, error } = await res.json();
      if (error) throw new Error(error);
      window.location.href = url;
    } catch (err) {
      alert('Betalingsfout: ' + err.message);
      if (btn) { btn.textContent = 'Afrekenen met Stripe'; btn.disabled = false; }
    }
  }

  function showAddedToast(name) {
    const t = document.getElementById('cartToast');
    if (!t) return;
    t.textContent = `${name} toegevoegd`;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2500);
  }

  function init() {
    updateBadge();
    document.getElementById('cartBtn')?.addEventListener('click', open);
    document.getElementById('cartClose')?.addEventListener('click', close);
    document.getElementById('cartOverlay')?.addEventListener('click', e => {
      if (e.target === e.currentTarget) close();
    });
    document.getElementById('checkoutBtn')?.addEventListener('click', checkout);
  }

  return { add, remove, updateQty, open, close, checkout, get, init };
})();

document.addEventListener('DOMContentLoaded', () => Cart.init());
