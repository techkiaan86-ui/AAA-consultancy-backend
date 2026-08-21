const axios = require('axios');
const prisma = require('../config/db');

let cachedAccessToken = null;
let tokenExpiresAt = 0;

/**
 * Checks if Zoho Invoice API is fully configured in environment or DB settings.
 */
const isConfigured = () => {
  const orgId = process.env.ZOHO_ORGANIZATION_ID;
  const clientId = process.env.ZOHO_CLIENT_ID;
  const clientSecret = process.env.ZOHO_CLIENT_SECRET;
  const refreshToken = process.env.ZOHO_REFRESH_TOKEN;

  return !!(
    orgId && orgId !== 'your_zoho_org_id' &&
    clientId && clientId !== 'your_zoho_client_id' &&
    clientSecret && clientSecret !== 'your_zoho_client_secret' &&
    refreshToken && refreshToken !== 'your_zoho_refresh_token'
  );
};

/**
 * Obtains or refreshes the OAuth 2.0 Access Token from Zoho.
 */
const getAccessToken = async () => {
  if (!isConfigured()) {
    console.warn('[Zoho Invoice Service] Credentials not configured. Running in Dry-Run Mode.');
    return null;
  }

  // Return cached token if still valid (with 60-second safety margin)
  if (cachedAccessToken && Date.now() < tokenExpiresAt - 60000) {
    return cachedAccessToken;
  }

  try {
    const accountsUrl = process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com';
    const params = new URLSearchParams({
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      grant_type: 'refresh_token'
    });

    const response = await axios.post(`${accountsUrl}/oauth/v2/token`, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    if (response.data && response.data.access_token) {
      cachedAccessToken = response.data.access_token;
      // Expires in seconds (usually 3600s)
      const expiresInMs = (response.data.expires_in || 3600) * 1000;
      tokenExpiresAt = Date.now() + expiresInMs;
      console.log('[Zoho Invoice Service] Successfully refreshed Zoho OAuth Access Token.');
      return cachedAccessToken;
    } else {
      throw new Error(`OAuth Error: ${JSON.stringify(response.data)}`);
    }
  } catch (err) {
    console.error('[Zoho Invoice Service] Token refresh failed:', err.message);
    return null;
  }
};

/**
 * Searches for an existing Customer Contact in Zoho by email, or creates a new one.
 */
const createOrGetContact = async ({ name, email, phone }) => {
  const token = await getAccessToken();
  const orgId = process.env.ZOHO_ORGANIZATION_ID;
  const apiUrl = process.env.ZOHO_API_URL || 'https://www.zohoapis.com/invoice/v3';

  if (!token || !orgId) {
    return { contactId: `mock-contact-${Date.now()}`, isMock: true };
  }

  try {
    // 1. Search existing contact by email
    const searchRes = await axios.get(`${apiUrl}/contacts`, {
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        'X-com-zoho-invoice-organizationid': orgId
      },
      params: { organization_id: orgId, email: email }
    });

    if (searchRes.data?.contacts && searchRes.data.contacts.length > 0) {
      const existingContact = searchRes.data.contacts[0];
      console.log(`[Zoho Invoice Service] Found existing Zoho contact: ${existingContact.contact_id}`);
      return { contactId: existingContact.contact_id, isMock: false };
    }

    // 2. Create new contact if not found
    const createRes = await axios.post(`${apiUrl}/contacts?organization_id=${orgId}`, {
      contact_name: name || 'Valued Client',
      contact_type: 'customer',
      language_code: 'en',
      contact_persons: [
        {
          first_name: name || 'Valued Client',
          email: email,
          phone: phone || '',
          is_primary_contact: true
        }
      ]
    }, {
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        'X-com-zoho-invoice-organizationid': orgId,
        'Content-Type': 'application/json'
      }
    });

    if (createRes.data?.contact?.contact_id) {
      console.log(`[Zoho Invoice Service] Created new Zoho contact: ${createRes.data.contact.contact_id}`);
      return { contactId: createRes.data.contact.contact_id, isMock: false };
    } else {
      throw new Error(`Failed to create contact: ${JSON.stringify(createRes.data)}`);
    }
  } catch (err) {
    console.error('[Zoho Invoice Service] Error in createOrGetContact:', err.response?.data || err.message);
    return { contactId: `mock-contact-${Date.now()}`, isMock: true };
  }
};

/**
 * Creates an itemized Zoho Invoice for a client and returns the public payment URL.
 */
const createZohoInvoice = async ({ client, amount, discount, netAmount, serviceType, dueDate, isPaid = false, couponCode, discountPercent }) => {
  const token = await getAccessToken();
  const orgId = process.env.ZOHO_ORGANIZATION_ID;
  const apiUrl = process.env.ZOHO_API_URL || 'https://www.zohoapis.com/invoice/v3';

  const clientName = client ? `${client.firstName} ${client.lastName}`.trim() : 'Valued Client';
  const email = client?.email || 'client@example.com';
  const phone = client?.phone || '';
  const finalAmount = Number(netAmount || (amount ? amount - (discount || 0) : 0));

  // If not configured, return fault-tolerant Dry-Run URL
  if (!token || !orgId) {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const mockInvoiceUrl = `${frontendUrl}/#/portal/login?zoho_mock_invoice=${Date.now()}`;
    console.log(`[Zoho Invoice Service DRY-RUN] Generated fallback Invoice URL for ${email}: ${mockInvoiceUrl}`);
    return {
      invoiceId: `zoho-mock-inv-${Date.now()}`,
      invoiceNumber: `INV-MOCK-${Math.floor(1000 + Math.random() * 9000)}`,
      invoiceUrl: mockInvoiceUrl,
      paymentUrl: mockInvoiceUrl,
      isMock: true
    };
  }

  try {
    // Step 1: Ensure Contact exists in Zoho
    const { contactId } = await createOrGetContact({ name: clientName, email, phone });

    // Step 2: Formulate invoice payload
    const formattedDueDate = dueDate ? new Date(dueDate).toISOString().split('T')[0] : new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const clientCodeDisplay = client?.clientCode || null;
    const itemRate = Number(amount) || finalAmount + (Number(discount) || 0);

    const invoicePayload = {
      customer_id: contactId,
      date: new Date().toISOString().split('T')[0],
      due_date: formattedDueDate,
      line_items: [
        {
          name: serviceType || 'Spain Relocation & Visa Package',
          description: `Relocation Legal Package for ${clientName}${couponCode ? ` (Coupon ${couponCode} applied: ${discountPercent || ''}% OFF)` : ''}`,
          rate: itemRate,
          quantity: 1
        }
      ],
      discount: Number(discount) || 0,
      notes: clientCodeDisplay
        ? `Customer ID: ${clientCodeDisplay}${couponCode ? `\nApplied Coupon: ${couponCode} (-€${discount})` : ''}\nThank you for choosing AAA Business Consultancy!`
        : `Thank you for choosing AAA Business Consultancy!${couponCode ? ` (Coupon Applied: ${couponCode})` : ''}`,
      terms: 'Payment is due upon receipt.'
    };

    const response = await axios.post(`${apiUrl}/invoices?organization_id=${orgId}&send=true`, invoicePayload, {
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        'X-com-zoho-invoice-organizationid': orgId,
        'Content-Type': 'application/json'
      }
    });

    if (response.data?.invoice) {
      const inv = response.data.invoice;

      // Mark invoice as SENT in Zoho so the public payment link is instantly active and openable by client
      try {
        await axios.post(`${apiUrl}/invoices/${inv.invoice_id}/status/sent?organization_id=${orgId}`, {}, {
          headers: {
            Authorization: `Zoho-oauthtoken ${token}`,
            'X-com-zoho-invoice-organizationid': orgId
          }
        });
        console.log(`[Zoho Invoice Service] Marked Zoho Invoice ${inv.invoice_number} as SENT.`);
      } catch (sentErr) {
        console.warn('[Zoho Invoice Status Sent Warning]:', sentErr.response?.data || sentErr.message);
      }

      // If payment is completed, record payment in Zoho so invoice is marked as PAID
      if (isPaid && inv.invoice_id) {
        try {
          await axios.post(`${apiUrl}/customerpayments?organization_id=${orgId}`, {
            customer_id: contactId,
            payment_mode: 'Stripe',
            amount: finalAmount,
            date: new Date().toISOString().split('T')[0],
            invoices: [
              {
                invoice_id: inv.invoice_id,
                amount_applied: finalAmount
              }
            ]
          }, {
            headers: {
              Authorization: `Zoho-oauthtoken ${token}`,
              'X-com-zoho-invoice-organizationid': orgId,
              'Content-Type': 'application/json'
            }
          });
          console.log(`[Zoho Invoice Service] Recorded payment of €${finalAmount} for Zoho Invoice ${inv.invoice_number}. Status: PAID.`);
        } catch (payErr) {
          console.warn('[Zoho Payment Record Warning]:', payErr.response?.data || payErr.message);
        }
      }

      // Zoho public payment URL
      const invoiceUrl = inv.invoice_url || inv.payment_options?.payment_gateways?.[0]?.payment_url || `${apiUrl}/invoices/${inv.invoice_id}`;
      
      console.log(`[Zoho Invoice Service] Created Zoho Invoice ${inv.invoice_number} (ID: ${inv.invoice_id}). URL: ${invoiceUrl}`);
      return {
        invoiceId: inv.invoice_id,
        invoiceNumber: inv.invoice_number,
        invoiceUrl: invoiceUrl,
        paymentUrl: invoiceUrl,
        isMock: false
      };
    } else {
      throw new Error(`Zoho Invoice creation error: ${JSON.stringify(response.data)}`);
    }
  } catch (err) {
    console.error('[Zoho Invoice Service] Error creating Zoho invoice:', err.response?.data || err.message);
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const fallbackUrl = `${frontendUrl}/#/portal/login?zoho_fallback=true`;
    return {
      invoiceId: `zoho-err-inv-${Date.now()}`,
      invoiceNumber: `INV-ERR-${Date.now()}`,
      invoiceUrl: fallbackUrl,
      paymentUrl: fallbackUrl,
      isMock: true,
      error: err.message
    };
  }
};

const getZohoInvoicePdfBuffer = async (invoiceId) => {
  const token = await getAccessToken();
  const orgId = process.env.ZOHO_ORGANIZATION_ID;
  const apiUrl = process.env.ZOHO_API_URL || 'https://www.zohoapis.com/invoice/v3';

  if (!token || !orgId || !invoiceId) return null;

  try {
    const response = await axios.get(`${apiUrl}/invoices/${invoiceId}?organization_id=${orgId}&accept=pdf`, {
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        'X-com-zoho-invoice-organizationid': orgId
      },
      responseType: 'arraybuffer'
    });
    return response.data;
  } catch (err) {
    console.error(`[Zoho Invoice Service] Failed to fetch PDF buffer for ${invoiceId}:`, err.message);
    return null;
  }
};

/**
 * Marks an existing Zoho Invoice as PAID by recording a customer payment in Zoho Books.
 */
const markZohoInvoiceAsPaid = async ({ invoiceId, amount, email, name, phone }) => {
  const token = await getAccessToken();
  const orgId = process.env.ZOHO_ORGANIZATION_ID;
  const apiUrl = process.env.ZOHO_API_URL || 'https://www.zohoapis.com/invoice/v3';

  if (!token || !orgId || !invoiceId || String(invoiceId).startsWith('zoho-mock-') || String(invoiceId).startsWith('zoho-err-')) {
    console.log(`[Zoho Invoice Service] Skipping live payment record for mock/invalid invoiceId: ${invoiceId}`);
    return { success: true, isMock: true };
  }

  try {
    const { contactId } = await createOrGetContact({ name, email, phone });
    let finalAmount = Number(amount || 0);

    try {
      const invDetailRes = await axios.get(`${apiUrl}/invoices/${invoiceId}`, {
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          'X-com-zoho-invoice-organizationid': orgId
        },
        params: { organization_id: orgId }
      });
      if (invDetailRes.data?.invoice) {
        const inv = invDetailRes.data.invoice;
        finalAmount = (typeof inv.balance === 'number' && inv.balance > 0) ? inv.balance : (inv.total || finalAmount);
        console.log(`[Zoho Invoice Service] Invoice ${inv.invoice_number} fetched. Balance Due: ${inv.balance}, Total: ${inv.total}`);
      }
    } catch (fetchErr) {
      console.warn('[Zoho Fetch Invoice Detail Warning]:', fetchErr.response?.data || fetchErr.message);
    }

    try {
      await axios.post(`${apiUrl}/invoices/${invoiceId}/status/sent?organization_id=${orgId}`, {}, {
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          'X-com-zoho-invoice-organizationid': orgId
        }
      });
    } catch (sentErr) {
      // Ignore if already sent
    }

    const payRes = await axios.post(`${apiUrl}/customerpayments?organization_id=${orgId}`, {
      customer_id: contactId,
      payment_mode: 'Stripe',
      amount: finalAmount,
      date: new Date().toISOString().split('T')[0],
      invoices: [
        {
          invoice_id: invoiceId,
          amount_applied: finalAmount
        }
      ]
    }, {
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        'X-com-zoho-invoice-organizationid': orgId,
        'Content-Type': 'application/json'
      }
    });

    console.log(`[Zoho Invoice Service] Recorded payment of ${finalAmount} for Zoho Invoice ID ${invoiceId}. Status: PAID.`);
    return { success: true, paymentId: payRes.data?.payment?.payment_id };
  } catch (err) {
    console.error('[Zoho Invoice Service] Error marking Zoho invoice as paid:', err.response?.data || err.message);
    return { success: false, error: err.message };
  }
};

module.exports = {
  isConfigured,
  getAccessToken,
  createOrGetContact,
  createZohoInvoice,
  markZohoInvoiceAsPaid,
  getZohoInvoicePdfBuffer
};
