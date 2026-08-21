const axios = require('axios');

const TAMARA_TOKEN = process.env.TAMARA_TOKEN;
const TAMARA_API_URL = 'https://api.tamara.co';

/**
 * Initiates a Tamara split-checkout session.
 * Fallbacks to mock session URL if credentials are not configured.
 */
exports.createTamaraCheckoutSession = async ({ clientId, amount, email, phone, name }) => {
  if (!TAMARA_TOKEN) {
    console.warn('[Tamara Service] Credentials missing. Running in simulator mode.');
    // Simulated checkout url redirecting back with success query params
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    return {
      isMock: true,
      sessionId: `TAMARA_MOCK_SES_${Date.now()}`,
      checkoutUrl: `${frontendUrl}/#/portal/documents/${clientId}?payment_method=tamara&success=true`
    };
  }

  try {
    const response = await axios.post(`${TAMARA_API_URL}/checkout`, {
      order_reference_id: `ORD_${Date.now()}`,
      total_amount: {
        amount: parseFloat(amount),
        currency: 'AED'
      },
      description: 'Spain Visa Relocation Services',
      country_code: 'AE',
      payment_type: 'PAY_BY_INSTALMENTS',
      locale: 'en_US',
      consumer: {
        first_name: name ? name.split(' ')[0] : 'Valued',
        last_name: (name && name.split(' ').length > 1) ? name.split(' ').slice(1).join(' ') : 'Client',
        phone_number: phone || '',
        email: email || ''
      },
      merchant_url: {
        success: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/#/portal/documents/${clientId}?success=true`,
        cancel: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/#/portal/documents/${clientId}?cancel=true`,
        failure: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/#/portal/documents/${clientId}?failure=true`,
        notification: `${process.env.BACKEND_URL || 'http://localhost:3000'}/api/payments/tamara/webhook`
      }
    }, {
      headers: {
        'Authorization': `Bearer ${TAMARA_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    return {
      isMock: false,
      sessionId: response.data.checkout_id,
      checkoutUrl: response.data.checkout_url
    };
  } catch (err) {
    console.error('[Tamara Service] Session Creation failed:', err.response?.data || err.message);
    throw err;
  }
};
