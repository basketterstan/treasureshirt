const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin  = require('firebase-admin');
const Stripe = require('stripe');

admin.initializeApp();
const db = admin.firestore();

const stripeSecret  = defineSecret('STRIPE_SECRET_KEY');
const webhookSecret = defineSecret('STRIPE_WEBHOOK_SECRET');
const resendKey     = defineSecret('RESEND_API_KEY');

const ADMIN_EMAIL  = 'contact@treasureshirt.com';
const ADMIN_EMAIL2 = 'daenen.stan@gmail.com';
const SITE_URL     = 'https://treasureshirt.com';
const FROM         = 'Treasureshirt <noreply@treasureshirt.com>';

const SHIPPING = { 'verzending': 7, 'verzending-nl': 14.99 };
const SHIP_NAME = { 'verzending': 'Verzending België', 'verzending-nl': 'Verzending Nederland' };
// Last moment customers can choose pickup at the Landen Christmas market.
const PICKUP_UNTIL = new Date('2026-12-13T18:00:00+01:00');
const LEVERING = {
  'afhalen-kerstmarkt': 'Afhalen op de kerstmarkt van Landen (11–13 december)',
  'verzending':         'Verzending in België',
  'verzending-nl':      'Verzending naar Nederland',
};

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clean = (s, max) => String(s ?? '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

// ── CATALOG ──────────────────────────────────────────
// Prices come from the live site's data/products.json, never from the browser.
let catalogCache = { at: 0, data: null };
async function getCatalog() {
  if (catalogCache.data && Date.now() - catalogCache.at < 5 * 60 * 1000) return catalogCache.data;
  const r = await fetch(`${SITE_URL}/data/products.json`, { headers: { 'Cache-Control': 'no-cache' } });
  if (!r.ok) throw new Error('Catalogus niet bereikbaar');
  catalogCache = { at: Date.now(), data: await r.json() };
  return catalogCache.data;
}

function priceLine(p, item) {
  const type  = p.types && p.types.length ? p.types.find(t => t.id === item.variantType) : null;
  if (p.types && p.types.length && !type) throw new Error(`Kies een geldige soort voor ${p.name}`);
  const color = p.colors && p.colors.length ? p.colors.find(c => c.id === item.color) : null;
  if (p.colors && p.colors.length && !color) throw new Error(`Kies een geldige kleur voor ${p.name}`);
  const sizes = (type && type.sizes) || p.sizes || [];
  if (sizes.length && !sizes.includes(item.size)) throw new Error(`Kies een geldige maat voor ${p.name}`);

  const personalName = p.personalize ? clean(item.personalName, p.personalize.maxLength || 14) : '';
  let price = Number(type ? type.price : p.price);
  if (personalName) price += Number(p.personalize.price || 0);

  const meta = [type?.label, p.colors && p.colors.length > 1 ? color?.label : '', sizes.length ? item.size : '',
    personalName ? `Naam: “${personalName}”` : ''].filter(Boolean).join(' · ');
  return {
    name: meta ? `${p.name} — ${meta}` : p.name,
    unit_amount: Math.round(price * 100),
  };
}

// ── NOTIFY NEW USER ──────────────────────────────────
exports.notifyNewUser = onRequest(
  { secrets: [resendKey], cors: true, invoker: 'public' },
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).end();
    const name = clean(req.body?.name, 80);
    const email = clean(req.body?.email, 120);
    try {
      await sendMail({
        to: ADMIN_EMAIL,
        subject: `Nieuw account — ${name || email}`,
        html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#222">
          <h2>Nieuw account aangemaakt</h2><p><strong>Naam:</strong> ${esc(name) || '—'}</p><p><strong>E-mail:</strong> ${esc(email)}</p></div>`,
      });
    } catch (e) { console.error('notifyNewUser mail fout:', e.message); }
    res.json({ ok: true });
  }
);

// ── CREATE CHECKOUT ──────────────────────────────────
exports.createCheckout = onRequest(
  { secrets: [stripeSecret], cors: true, invoker: 'public' },
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    try {
      const body  = req.body || {};
      const items = Array.isArray(body.items) ? body.items.filter(i => i.id !== 'shipping-be' && !/^Verzending /.test(String(i.name || ''))) : [];
      if (!items.length || items.length > 50) return res.status(400).json({ error: 'Geen producten' });

      let levering = body.levering in LEVERING ? body.levering : 'verzending';
      if (levering === 'afhalen-kerstmarkt' && new Date() > PICKUP_UNTIL) {
        return res.status(400).json({ error: 'Afhalen op de kerstmarkt is niet meer mogelijk. Kies verzending.' });
      }

      const catalog = await getCatalog();
      const line_items = [];
      const customIds = [];
      const stockLines = [];

      for (const item of items) {
        const quantity = Math.min(Math.max(parseInt(item.quantity, 10) || 1, 1), 20);
        let line;
        if (item.customOrderId) {
          const snap = await db.collection('custom-orders').doc(String(item.customOrderId)).get();
          if (!snap.exists) throw new Error('Op-maat bestelling niet gevonden. Maak ze opnieuw aan.');
          const o = snap.data();
          if (o.status && o.status !== 'pending_payment') throw new Error('Deze op-maat bestelling is al betaald.');
          const type = o.typeKleding === 'hoodie' ? 'Hoodie' : 'T-Shirt';
          line = { name: clean(`Op maat ${type} (${o.maat || ''}) — ${o.thema || ''}`, 200), unit_amount: Math.round(Number(o.totaalprijs) * 100) };
          customIds.push(snap.id);
          line_items.push({ price_data: { currency: 'eur', product_data: { name: line.name }, unit_amount: line.unit_amount }, quantity: 1 });
          continue;
        }
        const p = catalog.find(x => String(x.id) === String(item.id));
        if (!p) throw new Error('Een product in je winkelwagen bestaat niet meer. Verwijder het en probeer opnieuw.');
        line = priceLine(p, item);
        const sk = stockKey(p, item);
        if (sk) stockLines.push({ ...sk, qty: quantity, label: line.name });
        line_items.push({ price_data: { currency: 'eur', product_data: { name: line.name }, unit_amount: line.unit_amount }, quantity });
      }
      if (SHIPPING[levering]) {
        line_items.push({ price_data: { currency: 'eur', product_data: { name: SHIP_NAME[levering] }, unit_amount: Math.round(SHIPPING[levering] * 100) }, quantity: 1 });
      }

      const contact = body.contact || {};
      const email = clean(contact.email || body.userEmail, 120);
      const metadata = {
        userId:         clean(body.userId, 128),
        customOrderIds: customIds.join(',').slice(0, 500),
        levering,
        naam:           clean(contact.naam, 80),
        telefoon:       clean(contact.telefoon, 30),
        adres:          SHIPPING[levering] ? clean(body.adres, 300) : '',
        opmerking:      clean(body.opmerking, 300),
      };
      if (SHIPPING[levering] && !metadata.adres) throw new Error('Vul je adres in voor verzending.');
      if (!metadata.naam || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || metadata.telefoon.replace(/[^0-9]/g, '').length < 8) {
        throw new Error('Vul je naam, e-mailadres en telefoonnummer in.');
      }

      // Genoeg voorraad?
      if (stockLines.length) {
        const cs = await db.doc('kassa_shop/catalog').get();
        const prods = cs.exists ? (cs.data().products || []) : [];
        const need = {};
        stockLines.forEach(l => { const k = l.id + '§' + l.key; need[k] = (need[k] || 0) + l.qty; });
        for (const l of stockLines) {
          const p = prods.find(x => x.id === l.id); const v = p && p.stock ? p.stock[l.key] : undefined;
          if (v !== undefined && v !== null && Number(v) < need[l.id + '§' + l.key]) {
            throw new Error(Number(v) <= 0 ? `${l.label} is uitverkocht.` : `Van ${l.label} hebben we er nog maar ${v}.`);
          }
        }
      }
      const stripe = Stripe(stripeSecret.value());
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card', 'bancontact'],
        line_items,
        mode: 'payment',
        allow_promotion_codes: true,
        locale: 'nl',
        success_url: `${SITE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url:  `${SITE_URL}/cancel.html`,
        metadata,
        ...(email ? { customer_email: email } : {}),
      });
      if (stockLines.length) await db.doc(`pending_stock/${session.id}`).set({ lines: stockLines.map(({ id, key, qty }) => ({ id, key, qty })), createdAt: Date.now() });
      res.json({ url: session.url });
    } catch (err) {
      console.error(err);
      res.status(400).json({ error: err.message });
    }
  }
);

// ── VOORRAAD ─────────────────────────────────────────
// Eén voorraadlijst voor webshop en kassa: kassa_shop/catalog (products[].stock, "maat|kleur" → aantal).
// public/stock is een leesbare kopie voor de webshop. Geen getal = onbeperkt.
function stockKey(p, item) {
  const t = (p.types || []).find(t => t.id === item.variantType);
  const id = (t && t.stockId) || p.stockId;
  if (!id) return null;
  const size = item.size || ((p.types || []).length && !(p.sizes || []).length ? item.variantType : 'One size');
  return { id, key: `${size}|${item.color || ''}` };
}
function publicStock(cat) {
  const out = {};
  (cat.products || []).forEach(p => { if (p.stock && Object.keys(p.stock).length) out[p.id] = p.stock; });
  return { json: JSON.stringify(out), updatedAt: Date.now() };
}
// Decrease stock for sold items ([{id, key, qty}]). Entries without a number stay unlimited.
async function takeStock(lines) {
  if (!lines.length) return;
  const ref = db.doc('kassa_shop/catalog');
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const cat = snap.data();
    lines.forEach(l => {
      const p = (cat.products || []).find(x => x.id === l.id);
      if (p && p.stock && l.key in p.stock) p.stock[l.key] = Math.max(0, Number(p.stock[l.key]) - l.qty);
    });
    tx.set(ref, cat);
    tx.set(db.doc('public/stock'), publicStock(cat));
  });
}

// ── KASSA: "bestelling klaar"-mail vanuit kassa.html ─────
// Only the admin (verified Firebase ID token) may send, and only from our domain.
const ADMIN_EMAILS = ['daenen.stan@gmail.com', 'contact@treasureshirt.com'];
exports.sendKassaMail = onRequest(
  { secrets: [resendKey], cors: true, invoker: 'public' },
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    try {
      const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const user = await admin.auth().verifyIdToken(token);
      if (!ADMIN_EMAILS.includes(String(user.email || '').toLowerCase())) return res.status(403).json({ error: 'Geen toegang' });
      const b = req.body || {};
      const to = Array.isArray(b.to) ? b.to[0] : b.to;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(to || ''))) return res.status(400).json({ error: 'Ongeldig e-mailadres' });
      const from = /@treasureshirt\.com>?\s*$/i.test(String(b.from || '')) ? String(b.from) : 'Treasureshirt <bestelling@treasureshirt.com>';
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${resendKey.value()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject: clean(b.subject, 200), text: String(b.text || '').slice(0, 5000), html: String(b.html || '').slice(0, 20000), reply_to: ADMIN_EMAIL }),
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(502).json({ error: out.message || 'Resend fout' });
      res.json({ ok: true, id: out.id });
    } catch (e) {
      res.status(401).json({ error: 'Niet ingelogd' });
    }
  }
);

// ── KASSA: Bancontact-QR op het klantscherm ──────────
// POST (admin, Bearer ID token) {amount, items}   → maakt een Bancontact-betaling via Stripe en geeft
//      {id, bcUrl}: de Bancontact-betaalpagina met QR (scannen met de Bancontact- of Payconiq-app).
//      Lukt dat niet, dan een Stripe Checkout met {id, qr} (scannen met de camera).
// GET  ?status=<id> (admin, Bearer ID token)      → {status: 'open' | 'paid' | 'failed' | 'expired'}
// GET  ?go=<id>     (publiek, vanuit de QR-code)  → stuurt de klant door naar de Stripe-betaalpagina
// De QR-code verwijst naar ?go= zodat ze kort en goed scanbaar blijft.
const KASSA_URL = 'https://kassapayment-kelvdlqp7a-uc.a.run.app';
exports.kassaPayment = onRequest(
  { secrets: [stripeSecret], cors: true, invoker: 'public' },
  async (req, res) => {
    const stripe = Stripe(stripeSecret.value());
    try {
      const go = String(req.query.go || '');
      if (req.method === 'GET' && go) {
        if (!/^cs_[A-Za-z0-9_]+$/.test(go)) return res.status(400).send('Ongeldige betaling');
        const s = await stripe.checkout.sessions.retrieve(go);
        if (!s.metadata || s.metadata.bron !== 'kassa') return res.status(404).send('Onbekende betaling');
        if (s.status === 'open' && s.url) return res.redirect(302, s.url);
        res.set('Content-Type', 'text/html; charset=utf-8');
        return res.send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;text-align:center;padding:3rem 1rem"><h1>${s.payment_status === 'paid' ? '✅ Al betaald — dank je!' : 'Deze betaling is verlopen'}</h1><p>Treasureshirt</p></body>`);
      }

      const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const user = await admin.auth().verifyIdToken(token);
      if (!ADMIN_EMAILS.includes(String(user.email || '').toLowerCase())) return res.status(403).json({ error: 'Geen toegang' });

      const id = String(req.query.status || '');
      if (req.method === 'GET' && id) {
        if (/^pi_[A-Za-z0-9_]+$/.test(id)) {
          const pi = await stripe.paymentIntents.retrieve(id);
          if (!pi.metadata || pi.metadata.bron !== 'kassa') return res.status(404).json({ error: 'Onbekende betaling' });
          const st = pi.status === 'succeeded' ? 'paid'
            : pi.status === 'canceled' ? 'expired'
            : (pi.status === 'requires_payment_method' && pi.last_payment_error) ? 'failed' : 'open';
          return res.json({ status: st });
        }
        if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return res.status(400).json({ error: 'Ongeldige betaling' });
        const s = await stripe.checkout.sessions.retrieve(id);
        if (!s.metadata || s.metadata.bron !== 'kassa') return res.status(404).json({ error: 'Onbekende betaling' });
        return res.json({ status: s.payment_status === 'paid' ? 'paid' : (s.status === 'expired' ? 'expired' : 'open') });
      }

      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const b = req.body || {};
      const cents = Math.round(Number(b.amount) * 100);
      if (!Number.isFinite(cents) || cents < 50 || cents > 200000) return res.status(400).json({ error: 'Ongeldig bedrag' });
      const desc = clean(Array.isArray(b.items) ? b.items.join(', ') : 'Aankoop kerstmarkt', 300) || 'Aankoop kerstmarkt';
      // Eerst: rechtstreeks Bancontact. Stripe geeft de Bancontact-pagina met QR terug.
      try {
        const pi = await stripe.paymentIntents.create({
          amount: cents, currency: 'eur',
          payment_method_types: ['bancontact'],
          payment_method_data: { type: 'bancontact', billing_details: { name: 'Klant kerstmarkt Landen' } },
          confirm: true,
          return_url: `${SITE_URL}/kassa.html#klant`,
          description: `Treasureshirt kerstmarkt — ${desc}`.slice(0, 1000),
          metadata: { bron: 'kassa' },
        });
        const bcUrl = pi.next_action && pi.next_action.redirect_to_url && pi.next_action.redirect_to_url.url;
        if (bcUrl) return res.json({ id: pi.id, bcUrl });
      } catch (e) { console.error('Bancontact rechtstreeks mislukt, val terug op Checkout:', e.message); }
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['bancontact', 'card'],
        line_items: [{ price_data: { currency: 'eur', product_data: { name: 'Treasureshirt — kerstmarkt', description: desc }, unit_amount: cents }, quantity: 1 }],
        locale: 'nl',
        success_url: `${SITE_URL}/bedankt.html`,
        cancel_url:  `${SITE_URL}/bedankt.html?geannuleerd=1`,
        expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
        metadata: { bron: 'kassa' },
      });
      res.json({ id: session.id, qr: `${KASSA_URL}/?go=${session.id}` });
    } catch (err) {
      console.error(err);
      res.status(400).json({ error: err.message });
    }
  }
);

// ── STRIPE WEBHOOK ───────────────────────────────────
exports.stripeWebhook = onRequest(
  { secrets: [stripeSecret, webhookSecret, resendKey], cors: false, invoker: 'public' },
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).end();
    let event;
    try {
      const stripe = Stripe(stripeSecret.value());
      event = stripe.webhooks.constructEvent(req.rawBody, req.headers['stripe-signature'], webhookSecret.value());
    } catch (err) {
      console.error('Webhook error:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    if (event.type === 'checkout.session.completed') {
      const obj = event.data.object;
      // Kassa payments (QR on the market iPad) are booked in the kassa itself, not as webshop orders.
      if (obj.metadata && obj.metadata.bron === 'kassa') return res.json({ received: true });
      await handleOrderComplete(obj);
    }
    res.json({ received: true });
  }
);

async function sendMail({ to, subject, html, replyTo }) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${resendKey.value()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to, subject, html, ...(replyTo ? { reply_to: replyTo } : {}) }),
  });
  if (!r.ok) console.error('Resend fout:', await r.text());
}

async function handleOrderComplete(session) {
  // Stripe can deliver the same event twice; only handle a session once.
  const existing = await db.collection('orders').where('sessionId', '==', session.id).limit(1).get();
  if (!existing.empty) return;

  try {
    const ps = await db.doc(`pending_stock/${session.id}`).get();
    if (ps.exists) { await takeStock(ps.data().lines || []); await ps.ref.delete(); }
  } catch (e) { console.error('Voorraad bijwerken mislukt:', e); }

  const stripe = Stripe(stripeSecret.value());
  const lineItemsResp = await stripe.checkout.sessions.listLineItems(session.id, { limit: 100 });
  const items = lineItemsResp.data.map(i => ({
    name:     i.description,
    quantity: i.quantity,
    price:    (i.amount_total / 100 / i.quantity).toFixed(2),
    subtotal: (i.amount_total / 100).toFixed(2),
  }));

  const m              = session.metadata || {};
  const customerEmail  = session.customer_details?.email || '';
  const customerName   = m.naam || session.customer_details?.name || 'Klant';
  const levering       = m.levering || 'verzending';
  const total          = (session.amount_total / 100).toFixed(2);
  const orderNumber    = session.id.slice(-8).toUpperCase();
  const customOrderIds = m.customOrderIds || '';

  if (customOrderIds) {
    await Promise.all(customOrderIds.split(',').filter(Boolean).map(id =>
      db.collection('custom-orders').doc(id).update({ status: 'betaald', orderNumber }).catch(() => {})));
  }

  await db.collection('orders').add({
    orderNumber, sessionId: session.id, customerEmail, customerName,
    telefoon: m.telefoon || '', userId: m.userId || '', customOrderIds,
    levering, adres: m.adres || '', opmerking: m.opmerking || '',
    items, total: parseFloat(total), status: 'nieuw',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const itemsHtml = items.map(i =>
    `<tr><td style="padding:6px 0">${esc(i.name)} × ${i.quantity}</td><td style="padding:6px 0;text-align:right;white-space:nowrap">€ ${i.subtotal}</td></tr>`).join('');
  const leveringHtml = levering === 'afhalen-kerstmarkt'
    ? `<p><strong>Afhalen op de kerstmarkt van Landen</strong> (11, 12 of 13 december) in onze chalet. We mailen je zodra je bestelling klaarligt. Zeg bij het afhalen je bestelnummer: <strong>#${orderNumber}</strong>.</p>`
    : `<p><strong>Verzending naar:</strong> ${esc(m.adres)}</p><p>We maken je bestelling en laten je weten wanneer ze vertrekt.</p>`;

  try {
    if (customerEmail) {
      await sendMail({
        to: customerEmail,
        replyTo: ADMIN_EMAIL,
        subject: `Bestelling bevestigd — #${orderNumber}`,
        html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#222;line-height:1.5">
          <h2>Bedankt voor je bestelling, ${esc(customerName.split(' ')[0])}!</h2>
          <p>Je bestelnummer is <strong>#${orderNumber}</strong>.</p>
          ${leveringHtml}
          <table style="width:100%;border-top:1px solid #ddd;margin:1.25rem 0">${itemsHtml}
            <tr><td colspan="2" style="border-top:1px solid #ddd;padding-top:8px"><strong>Totaal: € ${total}</strong></td></tr>
          </table>
          <p style="color:#888;font-size:.85em">Vragen? Antwoord gewoon op deze mail of mail naar <a href="mailto:${ADMIN_EMAIL}">${ADMIN_EMAIL}</a>.</p>
          <p style="color:#888;font-size:.85em;margin-top:2rem">— Treasureshirt</p>
        </div>`,
      });
    }
    await sendMail({
      to: [ADMIN_EMAIL, ADMIN_EMAIL2],
      replyTo: customerEmail || undefined,
      subject: `${levering === 'afhalen-kerstmarkt' ? '🎄 Afhalen' : '📦 Verzenden'} — bestelling #${orderNumber} — € ${total}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#222;line-height:1.5">
        <h2>Nieuwe bestelling #${orderNumber}</h2>
        <p><strong>Levering:</strong> ${esc(LEVERING[levering] || levering)}</p>
        <p><strong>Klant:</strong> ${esc(customerName)} — ${esc(customerEmail)}${m.telefoon ? ` — ${esc(m.telefoon)}` : ''}</p>
        ${m.adres ? `<p><strong>Adres:</strong> ${esc(m.adres)}</p>` : ''}
        ${m.opmerking ? `<p><strong>Opmerking:</strong> ${esc(m.opmerking)}</p>` : ''}
        <table style="width:100%;border-top:1px solid #ddd;margin:1.25rem 0">${itemsHtml}
          <tr><td colspan="2" style="border-top:1px solid #ddd;padding-top:8px"><strong>Totaal: € ${total}</strong></td></tr>
        </table>
        ${customOrderIds ? `<p><strong>Op-maat IDs:</strong> ${esc(customOrderIds)}</p>` : ''}
        <p><a href="${SITE_URL}/admin.html">Open de admin</a></p>
      </div>`,
    });
  } catch (mailErr) {
    console.error('E-mail fout:', mailErr.message);
  }
}
