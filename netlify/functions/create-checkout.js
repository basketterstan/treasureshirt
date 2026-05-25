const Stripe = require('stripe');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const { items } = JSON.parse(event.body);

  if (!items || !items.length) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Geen producten in winkelwagen' }) };
  }

  const baseUrl = process.env.URL || 'https://basketterstan.github.io/treasureshirt';

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
    shipping_address_collection: { allowed_countries: ['BE', 'NL', 'DE', 'FR', 'GB'] },
    success_url: `${baseUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/cancel.html`,
  });

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: session.url }),
  };
};
