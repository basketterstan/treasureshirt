const functions = require('firebase-functions');
const cors      = require('cors')({ origin: true });
const Stripe    = require('stripe');

exports.createCheckout = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
      const stripe = Stripe(functions.config().stripe.secret);
      const { items } = req.body;

      if (!items || !items.length) {
        return res.status(400).json({ error: 'Geen producten in winkelwagen' });
      }

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card', 'ideal', 'bancontact'],
        line_items: items.map(item => ({
          price_data: {
            currency: 'eur',
            product_data: {
              name: item.name,
              description: item.description || '',
            },
            unit_amount: Math.round(item.price * 100),
          },
          quantity: item.quantity,
        })),
        mode: 'payment',
        shipping_address_collection: {
          allowed_countries: ['BE', 'NL', 'DE', 'FR', 'GB'],
        },
        success_url: 'https://basketterstan.github.io/treasureshirt/success.html',
        cancel_url:  'https://basketterstan.github.io/treasureshirt/cancel.html',
      });

      res.json({ url: session.url });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });
});
