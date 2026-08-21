require('dotenv').config();

async function testStripe() {
  console.log('--- Starting Stripe Integration Test ---');
  const stripeKey = process.env.STRIPE_SECRET_KEY;

  if (!stripeKey || stripeKey.includes('your_stripe')) {
    console.log('⚠️ STRIPE_SECRET_KEY is not configured in .env (or contains placeholder).');
    console.log('Running in Safe Mock Mode.');
    process.exit(0);
  }

  try {
    const stripe = require('stripe')(stripeKey);
    console.log('Testing Stripe API Connection...');
    console.log(`Stripe Key length: ${stripeKey.length}`);
    
    // Retrieve account details to verify credentials
    const balance = await stripe.balance.retrieve();
    console.log('✅ Stripe Connection Successful! Account Balance details:');
    console.log(JSON.stringify(balance, null, 2));

    console.log('\n--- Creating Test Checkout Session ---');
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: 'Integration Test Package',
            description: 'Stripe Connection Test'
          },
          unit_amount: 1000 // €10.00
        },
        quantity: 1
      }],
      mode: 'payment',
      success_url: 'http://localhost:5173/#/portal/login?test=success',
      cancel_url: 'http://localhost:5173/#/portal/login?test=cancel'
    });

    console.log('✅ Test Checkout Session Created Successfully!');
    console.log('Session ID:', session.id);
    console.log('Checkout URL:', session.url);
  } catch (error) {
    console.error('❌ Stripe Integration Test Failed:', error.message);
  }
}

testStripe();
