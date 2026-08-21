require('dotenv').config();

const { createZohoInvoice, isConfigured } = require('./src/services/zohoInvoiceService');
const { sendInvoiceWhatsApp } = require('./src/services/whatsappService');

async function testZohoInvoiceIntegration() {
  console.log('--- Starting Zoho Invoice API Integration Test ---');

  console.log('\n1. Checking Zoho Credentials Configuration...');
  const configured = isConfigured();
  console.log(`Zoho API Fully Configured: ${configured ? 'YES (Live API Mode)' : 'NO (Running in Dry-Run / Fallback Mode)'}`);

  const mockClient = {
    id: 'client-zoho-test-101',
    firstName: 'Marcus',
    lastName: 'Vance',
    email: 'marcus@example.com',
    phone: process.env.TEST_PHONE || '+917047687998',
    serviceType: 'spain_residency'
  };

  console.log('\n2. Testing Zoho Invoice Creation for Client...');
  const zohoResult = await createZohoInvoice({
    client: mockClient,
    amount: 1500,
    discount: 0,
    netAmount: 1500,
    serviceType: mockClient.serviceType
  });

  console.log('Zoho Result:', zohoResult);

  if (!zohoResult || !zohoResult.paymentUrl) {
    throw new Error('Failed to obtain Zoho payment URL');
  }

  console.log('\n3. Dispatching Single WhatsApp Notification with Zoho Invoice Link...');
  await sendInvoiceWhatsApp({
    client: mockClient,
    amount: 1500,
    discount: 0,
    netAmount: 1500,
    serviceType: mockClient.serviceType,
    checkoutUrl: zohoResult.paymentUrl,
    tempPassword: '3J@Sg$Cn'
  });

  console.log('\n--- All Zoho Invoice Integration Tests Passed! ---');
  process.exit(0);
}

testZohoInvoiceIntegration().catch(err => {
  console.error('Test execution error:', err);
  process.exit(1);
});
