require('dotenv').config();

const { createZohoInvoice } = require('./src/services/zohoInvoiceService');
const { sendInvoiceWhatsApp } = require('./src/services/whatsappService');

async function sendLiveZohoWhatsApp() {
  console.log('--- Generating Live Zoho Invoice & Dispatching WhatsApp ---');

  const testClient = {
    id: 'test-live-zoho-client',
    firstName: 'Shon',
    lastName: 'Sor',
    email: 'sanjukiaan@gmail.com',
    phone: process.env.TEST_PHONE || '+917047687998',
    serviceType: 'spain_golden_visa'
  };

  console.log('1. Creating Live Zoho Invoice...');
  const zohoRes = await createZohoInvoice({
    client: testClient,
    amount: 1500,
    discount: 0,
    netAmount: 1500,
    serviceType: testClient.serviceType
  });

  console.log('Zoho Live Creation Output:', zohoRes);

  if (!zohoRes || !zohoRes.paymentUrl) {
    throw new Error('Could not obtain live Zoho invoice payment URL');
  }

  console.log('\n2. Dispatching Consolidated Single WhatsApp Message to +917047687998...');
  await sendInvoiceWhatsApp({
    client: testClient,
    amount: 1500,
    discount: 0,
    netAmount: 1500,
    serviceType: testClient.serviceType,
    checkoutUrl: zohoRes.paymentUrl,
    tempPassword: '3J@Sg$Cn'
  });

  console.log('\n--- Live Dispatch Completed! ---');
  process.exit(0);
}

sendLiveZohoWhatsApp().catch(err => {
  console.error('Error dispatching live test:', err);
  process.exit(1);
});
