const axios = require('axios');

const TABBY_PUBLIC_KEY = process.env.TABBY_PUBLIC_KEY;
const TABBY_SECRET_KEY = process.env.TABBY_SECRET_KEY;
const TABBY_API_URL = 'https://api.tabby.ai/api/v2';

/**
 * Initiates a Tabby instalment checkout session.
 * Fallbacks to mock session URL if credentials are not configured.
 */
exports.createTabbyCheckoutSession = async ({ clientId, amount, email, phone, name }) => {
  if (!TABBY_PUBLIC_KEY || !TABBY_SECRET_KEY) {
    console.warn('[Tabby Service] Credentials missing. Running in simulator mode.');
    // Simulated checkout url redirecting back with success query params
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    return {
      isMock: true,
      sessionId: `TABBY_MOCK_SES_${Date.now()}`,
      checkoutUrl: `${frontendUrl}/#/portal/documents/${clientId}?payment_method=tabby&success=true`
    };
  }

  try {
    const response = await axios.post(`${TABBY_API_URL}/checkout`, {
      payment: {
        amount: parseFloat(amount).toFixed(2),
        currency: 'AED', // UAE standard currency
        buyer: {
          phone: phone || '',
          email: email || '',
          name: name || 'Valued Client'
        },
        shipping_address: {
          city: 'Dubai',
          address: 'Deira Office',
          zip: '00000'
        }
      },
      lang: 'en',
      merchant_urls: {
        success: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/#/portal/documents/${clientId}?success=true`,
        cancel: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/#/portal/documents/${clientId}?cancel=true`,
        failure: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/#/portal/documents/${clientId}?failure=true`
      }
    }, {
      headers: {
        'Authorization': `Bearer ${TABBY_SECRET_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const installments = response.data.configuration?.available_products?.installments;
    const checkoutUrl = (installments && installments.length > 0)
      ? installments[0].web_url
      : (response.data.configuration?.available_products?.checkout_url || response.data.web_url);

    return {
      isMock: false,
      sessionId: response.data.id,
      checkoutUrl
    };
  } catch (err) {
    console.error('[Tabby Service] Session Creation failed:', err.response?.data || err.message);
    throw err;
  }
};
