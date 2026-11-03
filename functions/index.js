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

const SHIPPING_BE  = 7;
// Last moment customers can choose pickup at the Landen Christmas market.
const PICKUP_UNTIL = new Date('2026-12-13T18:00:00+01:00');
const LEVERING = {
  'afhalen-kerstmarkt': 'Afhalen op de kerstmarkt van Landen (11–13 december)',
  'verzending':         'Verzending in België',
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
  if (p.sizes && p.sizes.length && !p.sizes.includes(item.size)) throw new Error(`Kies een geldige maat voor ${p.name}`);

  const personalName = p.personalize ? clean(item.personalName, p.personalize.maxLength || 14) : '';
  let price = Number(type ? type.price : p.price);
  if (personalName) price += Number(p.personalize.price || 0);

  const meta = [type?.label, p.colors && p.colors.length > 1 ? color?.label : '', p.sizes && p.sizes.length ? item.size : '',
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
      const items = Array.isArray(body.items) ? body.items.filter(i => i.id !== 'shipping-be' && i.name !== 'Verzending België') : [];
      if (!items.length || items.length > 50) return res.status(400).json({ error: 'Geen producten' });

      let levering = body.levering in LEVERING ? body.levering : 'verzending';
      if (levering === 'afhalen-kerstmarkt' && new Date() > PICKUP_UNTIL) {
        return res.status(400).json({ error: 'Afhalen op de kerstmarkt is niet meer mogelijk. Kies verzending.' });
      }

      const catalog = await getCatalog();
      const line_items = [];
      const customIds = [];

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
        line_items.push({ price_data: { currency: 'eur', product_data: { name: line.name }, unit_amount: line.unit_amount }, quantity });
      }
      if (levering === 'verzending') {
        line_items.push({ price_data: { currency: 'eur', product_data: { name: 'Verzending België' }, unit_amount: SHIPPING_BE * 100 }, quantity: 1 });
      }

      const contact = body.contact || {};
      const email = clean(contact.email || body.userEmail, 120);
      const metadata = {
        userId:         clean(body.userId, 128),
        customOrderIds: customIds.join(',').slice(0, 500),
        levering,
        naam:           clean(contact.naam, 80),
        telefoon:       clean(contact.telefoon, 30),
        adres:          levering === 'verzending' ? clean(body.adres, 300) : '',
        opmerking:      clean(body.opmerking, 300),
      };
      if (levering === 'verzending' && !metadata.adres) throw new Error('Vul je adres in voor verzending.');

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
      res.json({ url: session.url });
    } catch (err) {
      console.error(err);
      res.status(400).json({ error: err.message });
    }
  }
);

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
    if (event.type === 'checkout.session.completed') await handleOrderComplete(event.data.object);
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
