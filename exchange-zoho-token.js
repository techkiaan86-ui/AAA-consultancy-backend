const axios = require('axios');
const fs = require('fs');
const path = require('path');

async function exchangeTokenFinal() {
  const clientId = '1000.1J1IB3UF7CH85NZ5QN4LB1W9L6CFWY';
  const clientSecret = '23ace4b6f8b62f03fc41739ecf1884468ae05685bc';
  const code = '1000.436b5f4670102f72ecbf57af64a3ba52.1daa5dc9bdd1a268fa9ed0699d712f15';
  const orgId = '928304133';

  console.log('1. Exchanging code for Permanent Refresh Token...');
  try {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      code: code,
      redirect_uri: 'https://api-console.zoho.com/'
    });

    const res = await axios.post('https://accounts.zoho.com/oauth/v2/token', params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    console.log('\n--- Exchange Result ---');
    console.log(JSON.stringify(res.data, null, 2));

    if (res.data.refresh_token) {
      console.log('\n✅ PERMANENT REFRESH TOKEN:', res.data.refresh_token);

      // Write variables to backend/.env
      const envPath = path.join(__dirname, '.env');
      let envContent = '';
      if (fs.existsSync(envPath)) {
        envContent = fs.readFileSync(envPath, 'utf8');
      }

      const newVars = `
# Zoho Invoice API Integration
ZOHO_ORGANIZATION_ID=${orgId}
ZOHO_CLIENT_ID=${clientId}
ZOHO_CLIENT_SECRET=${clientSecret}
ZOHO_REFRESH_TOKEN=${res.data.refresh_token}
ZOHO_ACCOUNTS_URL=https://accounts.zoho.com
ZOHO_API_URL=https://www.zohoapis.com/invoice/v3
`;

      if (!envContent.includes('ZOHO_ORGANIZATION_ID')) {
        envContent += newVars;
        fs.writeFileSync(envPath, envContent, 'utf8');
        console.log('[.env Updated] Saved Zoho Invoice API keys to .env');
      }
    }
  } catch (err) {
    console.error('Exchange error:', err.response?.data || err.message);
  }
}

exchangeTokenFinal();
