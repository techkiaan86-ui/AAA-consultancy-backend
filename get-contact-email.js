require('dotenv').config();
const axios = require('axios');
const { getAccessToken } = require('./src/services/zohoInvoiceService');

async function run() {
  const token = await getAccessToken();
  const orgId = process.env.ZOHO_ORGANIZATION_ID;
  const apiUrl = 'https://www.zohoapis.com/invoice/v3';

  const r = await axios.get(`${apiUrl}/contacts/1062579000000158001`, {
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      'X-com-zoho-invoice-organizationid': orgId
    },
    params: { organization_id: orgId }
  });

  const contact = r.data.contact;
  console.log('Contact Name:', contact.contact_name);
  console.log('Email:', contact.email || contact.contact_persons?.[0]?.email || 'N/A');
  console.log('All contact persons:', JSON.stringify(contact.contact_persons, null, 2));
  process.exit(0);
}

run().catch(e => { console.error(e.message); process.exit(1); });
