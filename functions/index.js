const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin  = require('firebase-admin');
const Stripe = require('stripe');

admin.initializeApp();
const db = admin.firestore();

const stripeSecret  = defineSecret('STRIPE_SECRET_KEY');
const webhookSecret = defineSecret('STRIPE_WEBHOOK_SECRET');
const klaviyoKey    = defineSecret('KLAVIYO_PRIVATE_KEY');
const resendKey     = defineSecret('RESEND_API_KEY');

const ADMIN_EMAIL = 'contact@treasureshirt.com';
const ADMIN_EMAIL2 = 'daenen.stan@gmail.com';
const SITE_URL = 'https://treasureshirt.com';

// ── NOTIFY NEW USER ──────────────────────────────────
exports.notifyNewUser = onRequest(
  { secrets: [resendKey], cors: true, invoker: 'public' },
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).end();
    const { name, email } = req.body;
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${resendKey.value()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Treasureshirt <noreply@treasureshirt.com>',
          to: ADMIN_EMAIL,
          subject: `Nieuw account — ${name || email}`,
          html: `
            <div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;color:#222">
              <h2>Nieuw account aangemaakt</h2>
              <p><strong>Naam:</strong> ${name || '—'}</p>
              <p><strong>E-mail:</strong> ${email}</p>
            </div>`,
        }),
      });
    } catch (e) {
      console.error('notifyNewUser mail fout:', e.message);
    }
    res.json({ ok: true });
  }
);

// ── CREATE CHECKOUT ──────────────────────────────────
exports.createCheckout = onRequest(
  { secrets: [stripeSecret], cors: true, invoker: 'public' },
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    try {
      const stripe = Stripe(stripeSecret.value());
      const { items } = req.body;
      if (!items?.length) return res.status(400).json({ error: 'Geen producten' });

      const userId         = req.body.userId         || '';
      const userEmail      = req.body.userEmail      || '';
      const customOrderIds = req.body.customOrderIds || '';
      const sessionParams = {
        payment_method_types: ['card', 'bancontact'],
        line_items: items.map(item => ({
          price_data: {
            currency: 'eur',
            product_data: { name: item.name, ...(item.description ? { description: item.description } : {}) },
            unit_amount: Math.round(item.price * 100),
          },
          quantity: item.quantity,
        })),
        mode: 'payment',
        allow_promotion_codes: true,
        success_url: `${SITE_URL}/success.html`,
        cancel_url:  `${SITE_URL}/cancel.html`,
        metadata: { userId, customOrderIds },
      };
      if (userEmail) sessionParams.customer_email = userEmail;
      const session = await stripe.checkout.sessions.create(sessionParams);

      res.json({ url: session.url });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  }
);

// ── STRIPE WEBHOOK ───────────────────────────────────
exports.stripeWebhook = onRequest(
  { secrets: [stripeSecret, webhookSecret, klaviyoKey, resendKey], cors: false, invoker: 'public' },
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

  const lineItemsResp = await stripe.checkout.sessions.listLineItems(session.id, { limit: 100 });
  const items = lineItemsResp.data.map(i => ({
    name:     i.description,
    quantity: i.quantity,
    price:    (i.amount_total / 100 / i.quantity).toFixed(2),
    subtotal: (i.amount_total / 100).toFixed(2),
  }));

  const customerEmail    = session.customer_details?.email || '';
  const customerName     = session.customer_details?.name  || 'Klant';
  const userId           = session.metadata?.userId        || '';
  const customOrderIds   = session.metadata?.customOrderIds || '';
  const total            = (session.amount_total / 100).toFixed(2);
  const orderNumber      = session.id.slice(-8).toUpperCase();

  // Update custom-orders status naar 'paid'
  if (customOrderIds) {
    const ids = customOrderIds.split(',').filter(Boolean);
    await Promise.all(ids.map(id =>
      db.collection('custom-orders').doc(id).update({ status: 'paid' }).catch(() => {})
    ));
  }

  // Sla betaalde bestelling op in orders collectie
  await db.collection('orders').add({
    orderNumber,
    sessionId:     session.id,
    customerEmail,
    customerName,
    userId,
    customOrderIds,
    items,
    total:         parseFloat(total),
    status:        'nieuw',
    createdAt:     admin.firestore.FieldValue.serverTimestamp(),
  });

  // E-mails via Resend
  try {
    async function sendMail({ to, subject, html }) {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${resendKey.value()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'Treasureshirt <noreply@treasureshirt.com>', to, subject, html }),
      });
      if (!r.ok) console.error('Resend fout:', await r.text());
    }

    const itemsHtml = items.map(i =>
      `<tr><td style="padding:6px 0">${i.name} × ${i.quantity}</td><td style="padding:6px 0;text-align:right">€ ${i.subtotal}</td></tr>`
    ).join('');

    if (customerEmail) {
      await sendMail({
        to: customerEmail,
        subject: `Bestelling bevestigd — #${orderNumber}`,
        html: `
          <div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;color:#222">
            <h2>Bedankt voor je bestelling, ${customerName.split(' ')[0]}!</h2>
            <p>We zijn direct gestart met jouw unieke design. Je ontvangt een update zodra het klaar is.</p>
            <table style="width:100%;border-top:1px solid #ddd;margin:1.5rem 0">${itemsHtml}
              <tr><td colspan="2" style="border-top:1px solid #ddd;padding-top:8px"><strong>Totaal: € ${total}</strong></td></tr>
            </table>
            <p style="color:#888;font-size:.85em">Vragen? Mail ons op <a href="mailto:${ADMIN_EMAIL}">${ADMIN_EMAIL}</a></p>
            <p style="color:#888;font-size:.85em;margin-top:2rem">— Treasureshirt</p>
          </div>`,
      });
    }

    await sendMail({
      to: [ADMIN_EMAIL, ADMIN_EMAIL2],
      subject: `Nieuwe bestelling #${orderNumber} — € ${total}`,
      html: `
        <div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;color:#222">
          <h2>Nieuwe bestelling #${orderNumber}</h2>
          <p><strong>Klant:</strong> ${customerName} (${customerEmail})</p>
          <table style="width:100%;border-top:1px solid #ddd;margin:1.5rem 0">${itemsHtml}
            <tr><td colspan="2" style="border-top:1px solid #ddd;padding-top:8px"><strong>Totaal: € ${total}</strong></td></tr>
          </table>
          ${customOrderIds ? `<p><strong>Firestore IDs:</strong> ${customOrderIds}</p>` : ''}
        </div>`,
    });
  } catch (mailErr) {
    console.error('E-mail fout:', mailErr.message);
  }
}

async function trackKlaviyoEvent(apiKey, { email, firstName, lastName, eventName, properties }) {
  const r = await fetch('https://a.klaviyo.com/api/events/', {
    method: 'POST',
    headers: {
      'Authorization':  `Klaviyo-API-Key ${apiKey}`,
      'Content-Type':   'application/json',
      'revision':       '2024-02-15',
    },
    body: JSON.stringify({
      data: {
        type: 'event',
        attributes: {
          metric: {
            data: { type: 'metric', attributes: { name: eventName } },
          },
          profile: {
            data: {
              type: 'profile',
              attributes: { email, first_name: firstName || '', last_name: lastName || '' },
            },
          },
          properties,
        },
      },
    }),
  });
  if (!r.ok) console.error(`Klaviyo event error (${eventName}):`, await r.text());
}
