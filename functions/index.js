const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin  = require('firebase-admin');
const Stripe = require('stripe');

admin.initializeApp();
const db = admin.firestore();

const stripeSecret  = defineSecret('STRIPE_SECRET_KEY');
const webhookSecret = defineSecret('STRIPE_WEBHOOK_SECRET');
const resendKey     = defineSecret('RESEND_API_KEY');

const ADMIN_EMAIL = 'contact@hoopsatlas.com';
const SITE_URL    = 'https://basketterstan.github.io/treasureshirt';

// ── CREATE CHECKOUT ──────────────────────────────────
exports.createCheckout = onRequest(
  { secrets: [stripeSecret], cors: true, invoker: 'public' },
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    try {
      const stripe = Stripe(stripeSecret.value());
      const { items } = req.body;
      if (!items?.length) return res.status(400).json({ error: 'Geen producten' });

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: items.map(item => ({
          price_data: {
            currency: 'eur',
            product_data: { name: item.name, description: item.description || '' },
            unit_amount: Math.round(item.price * 100),
          },
          quantity: item.quantity,
        })),
        mode: 'payment',
        shipping_address_collection: { allowed_countries: ['BE', 'NL', 'DE', 'FR', 'GB'] },
        customer_email: undefined,
        success_url: `${SITE_URL}/success.html`,
        cancel_url:  `${SITE_URL}/cancel.html`,
      });

      res.json({ url: session.url });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  }
);

// ── STRIPE WEBHOOK ───────────────────────────────────
exports.stripeWebhook = onRequest(
  { secrets: [stripeSecret, webhookSecret, resendKey], cors: false, invoker: 'public' },
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).end();

    const sig = req.headers['stripe-signature'];
    let event;

    try {
      const stripe = Stripe(stripeSecret.value());
      event = stripe.webhooks.constructEvent(req.rawBody, sig, webhookSecret.value());
    } catch (err) {
      console.error('Webhook error:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
      await handleOrderComplete(event.data.object);
    }

    res.json({ received: true });
  }
);

async function handleOrderComplete(session) {
  const stripe = Stripe(stripeSecret.value());

  // Haal bestelde items op
  const lineItemsResp = await stripe.checkout.sessions.listLineItems(session.id, { limit: 100 });
  const items = lineItemsResp.data.map(i => ({
    name:     i.description,
    quantity: i.quantity,
    price:    (i.amount_total / 100 / i.quantity).toFixed(2),
    subtotal: (i.amount_total / 100).toFixed(2),
  }));

  const customerEmail = session.customer_details?.email || '';
  const customerName  = session.customer_details?.name  || 'Klant';
  const address       = session.customer_details?.address || {};
  const total         = (session.amount_total / 100).toFixed(2);
  const orderNumber   = session.id.slice(-8).toUpperCase();

  // Sla bestelling op in Firestore
  await db.collection('orders').add({
    orderNumber,
    sessionId:     session.id,
    customerEmail,
    customerName,
    items,
    total:         parseFloat(total),
    shippingAddress: address,
    status:        'nieuw',
    createdAt:     admin.firestore.FieldValue.serverTimestamp(),
  });

  const apiKey = resendKey.value();

  // E-mail aan klant
  await sendEmail(apiKey, {
    to:      customerEmail,
    subject: `Bestelling #${orderNumber} bevestigd — Treasureshirt`,
    html:    customerEmailHtml(customerName, orderNumber, items, total, address),
  });

  // E-mail aan admin
  await sendEmail(apiKey, {
    to:      ADMIN_EMAIL,
    subject: `🛍 Nieuwe bestelling #${orderNumber} — €${total}`,
    html:    adminEmailHtml(orderNumber, customerName, customerEmail, items, total, address),
  });
}

async function sendEmail(apiKey, { to, subject, html }) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'Treasureshirt <onboarding@resend.dev>', to: [to], subject, html }),
  });
  if (!r.ok) console.error('Email error:', await r.text());
}

function customerEmailHtml(name, orderNumber, items, total, address) {
  const addr = address.line1
    ? `${address.line1}, ${address.postal_code} ${address.city}, ${address.country}`
    : '';
  const rows = items.map(i => `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #1a1a1a;color:#fff">${i.name}</td>
      <td style="padding:10px 0;border-bottom:1px solid #1a1a1a;text-align:center;color:#888">${i.quantity}×</td>
      <td style="padding:10px 0;border-bottom:1px solid #1a1a1a;text-align:right;color:#c9a84c">€ ${i.subtotal}</td>
    </tr>`).join('');

  return `<!DOCTYPE html><html><body style="margin:0;background:#0a0a0a">
  <div style="max-width:560px;margin:0 auto;padding:40px 24px;font-family:Georgia,serif;color:#fff">
    <p style="color:#c9a84c;letter-spacing:4px;text-transform:uppercase;font-size:13px;margin-bottom:4px">Treasureshirt</p>
    <h1 style="font-size:22px;font-weight:300;letter-spacing:2px;margin-bottom:4px">Bestelling bevestigd</h1>
    <p style="color:#888;font-size:12px;letter-spacing:2px;margin-bottom:32px">#${orderNumber}</p>

    <p>Beste ${name},</p>
    <p style="color:#888;line-height:1.9;margin-bottom:28px">Bedankt voor je bestelling bij Treasureshirt! We gaan er meteen mee aan de slag en laten je weten zodra je pakket verzonden is.</p>

    <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
      <thead><tr>
        <th style="text-align:left;font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#888;padding-bottom:8px;border-bottom:1px solid #333">Product</th>
        <th style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#888;padding-bottom:8px;border-bottom:1px solid #333">Aantal</th>
        <th style="text-align:right;font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#888;padding-bottom:8px;border-bottom:1px solid #333">Prijs</th>
      </tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr>
        <td colspan="2" style="padding:14px 0;font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#888">Totaal</td>
        <td style="padding:14px 0;text-align:right;color:#c9a84c;font-size:20px;font-weight:300">€ ${total}</td>
      </tr></tfoot>
    </table>

    ${addr ? `<p style="color:#888;font-size:12px;line-height:1.8"><strong style="color:#fff;letter-spacing:2px;text-transform:uppercase;font-size:10px">Leveradres</strong><br>${addr}</p>` : ''}

    <div style="margin-top:40px;padding-top:24px;border-top:1px solid #1a1a1a">
      <p style="color:#555;font-size:11px">© 2025 Treasureshirt · Vragen? Stuur een mail naar contact@treasureshirt.com</p>
    </div>
  </div></body></html>`;
}

function adminEmailHtml(orderNumber, name, email, items, total, address) {
  const addr = address.line1
    ? `${address.line1}, ${address.postal_code} ${address.city}, ${address.country}`
    : '—';
  const itemList = items.map(i => `${i.quantity}× ${i.name} — €${i.subtotal}`).join('<br>');

  return `<!DOCTYPE html><html><body style="margin:0;background:#0a0a0a">
  <div style="max-width:560px;margin:0 auto;padding:40px 24px;font-family:Georgia,serif;color:#fff">
    <p style="color:#c9a84c;letter-spacing:4px;text-transform:uppercase;font-size:13px">Treasureshirt Admin</p>
    <h1 style="font-size:22px;font-weight:300;letter-spacing:2px;margin-bottom:24px">Nieuwe Bestelling #${orderNumber}</h1>

    <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
      <tr><td style="padding:8px 0;color:#888;font-size:12px;letter-spacing:1px;width:120px">Klant</td><td style="padding:8px 0">${name}</td></tr>
      <tr><td style="padding:8px 0;color:#888;font-size:12px;letter-spacing:1px">E-mail</td><td style="padding:8px 0">${email}</td></tr>
      <tr><td style="padding:8px 0;color:#888;font-size:12px;letter-spacing:1px">Adres</td><td style="padding:8px 0">${addr}</td></tr>
      <tr><td style="padding:8px 0;color:#888;font-size:12px;letter-spacing:1px;vertical-align:top">Producten</td><td style="padding:8px 0;line-height:1.8">${itemList}</td></tr>
      <tr><td style="padding:8px 0;color:#888;font-size:12px;letter-spacing:1px">Totaal</td><td style="padding:8px 0;color:#c9a84c;font-size:20px">€ ${total}</td></tr>
    </table>

    <a href="${SITE_URL}/admin.html" style="display:inline-block;background:#c9a84c;color:#000;padding:12px 24px;text-decoration:none;font-size:11px;letter-spacing:3px;text-transform:uppercase">Bekijk in Admin →</a>
  </div></body></html>`;
}
