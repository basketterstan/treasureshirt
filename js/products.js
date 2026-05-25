const STORAGE_KEY = 'ts_products';

async function loadProducts() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) return JSON.parse(saved);
  try {
    const base = document.querySelector('base')?.href || window.location.origin + window.location.pathname.replace(/\/[^/]*$/, '/');
    const res = await fetch(base.replace(/\/$/, '') + '/data/products.json');
    const data = await res.json();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    return data;
  } catch {
    return [];
  }
}

function saveProducts(products) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(products));
}

function renderProductCards(products, containerId, limit = null) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const list = limit ? products.slice(0, limit) : products;
  container.innerHTML = list.map(p => `
    <div class="product-card">
      <div class="product-image">
        ${p.badge ? `<span class="product-badge">${p.badge}</span>` : ''}
        ${p.emoji || '👕'}
      </div>
      <div class="product-info">
        <h3 class="product-name">${p.name}</h3>
        <p class="product-desc">${p.description}</p>
        <p class="product-price">€ ${p.price}</p>
      </div>
    </div>
  `).join('');

  // re-trigger fade-in
  container.querySelectorAll('.product-card').forEach(el => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(20px)';
    el.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
    setTimeout(() => { el.style.opacity = '1'; el.style.transform = 'translateY(0)'; }, 50);
  });
}
