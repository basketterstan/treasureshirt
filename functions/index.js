const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin  = require('firebase-admin');
const Stripe = require('stripe');

admin.initializeApp();
const db = admin.firestore();

const stripeSecret  = defineSecret('STRIPE_SECRET_KEY');
const webhookSecret = defineSecret('STRIPE_WEBHOOK_SECRET');
const klaviyoKey    = defineSecret('KLAVIYO_PRIVATE_KEY');

const ADMIN_EMAIL = 'admin@treasureshirt.com';
const SITE_URL    = 'https://treasureshirt.com'; // v2

// ── CREATE CHECKOUT ──────────────────────────────────
exports.createCheckout = onRequest(
  { secrets: [stripeSecret], cors: true, invoker: 'public' },
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    try {
      const stripe = Stripe(stripeSecret.value());
      const { items } = req.body;
      if (!items?.length) return res.status(400).json({ error: 'Geen producten' });

      const userId = req.body.userId || '';
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
        success_url: `${SITE_URL}/success.html`,
        cancel_url:  `${SITE_URL}/cancel.html`,
        metadata: { userId },
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
  { secrets: [stripeSecret, webhookSecret, klaviyoKey], cors: false, invoker: 'public' },
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

  const customerEmail = session.customer_details?.email || '';
  const customerName  = session.customer_details?.name  || 'Klant';
  const address       = session.customer_details?.address || {};
  const userId        = session.metadata?.userId || '';
  const total         = (session.amount_total / 100).toFixed(2);
  const orderNumber   = session.id.slice(-8).toUpperCase();

  const shippingAddress = address.line1
    ? `${address.line1}, ${address.postal_code} ${address.city}, ${address.country}`
    : '';

  // Sla bestelling op in Firestore
  await db.collection('orders').add({
    orderNumber,
    sessionId:     session.id,
    customerEmail,
    customerName,
    userId,
    items,
    total:         parseFloat(total),
    shippingAddress: address,
    status:        'nieuw',
    createdAt:     admin.firestore.FieldValue.serverTimestamp(),
  });

  const apiKey = klaviyoKey.value();
  const eventProps = {
    order_number:     orderNumber,
    customer_name:    customerName,
    customer_email:   customerEmail,
    items,
    total,
    shipping_address: shippingAddress,
  };

  // Klant e-mail via Klaviyo Flow (event: "Order Placed")
  await trackKlaviyoEvent(apiKey, {
    email:     customerEmail,
    firstName: customerName.split(' ')[0],
    lastName:  customerName.split(' ').slice(1).join(' '),
    eventName: 'Order Placed',
    properties: eventProps,
  });

  // Admin notificatie via Klaviyo Flow (event: "New Order Admin")
  await trackKlaviyoEvent(apiKey, {
    email:     ADMIN_EMAIL,
    firstName: 'Admin',
    eventName: 'New Order Admin',
    properties: eventProps,
  });
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
