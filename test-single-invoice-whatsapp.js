require('dotenv').config();

const { sendInvoiceWhatsApp } = require('./src/services/whatsappService');

async function testSingleInvoiceWhatsApp() {
  console.log('--- Starting Single WhatsApp Invoice Message Test ---');

  const testClient = {
    id: 'test-client-123',
    firstName: 'Jhon',
    lastName: 'Doe',
    email: 'jhon@gmail.com',
    phone: process.env.TEST_PHONE || '+917047687998',
    serviceType: 'dnv'
  };

  const directStripeUrl = 'https://checkout.stripe.com/c/pay/cs_test_a1QIOCryBUbCFX25l5WKpbahSQvheEMoLBSnOFnhjZp3etGgGUEC1GxRI9#fidnandhYHdWcXpyCc';
  const portalUrl = 'https://aaa-crm-service.netlify.app/#/portal/login';
  const tempPassword = '3J@Sg$Cn';

  console.log('\n1. Dispatching Consolidated Single Invoice WhatsApp Message...');
  await sendInvoiceWhatsApp({
    client: testClient,
    amount: 2000,
    discount: 0,
    netAmount: 2000,
    serviceType: testClient.serviceType,
    checkoutUrl: directStripeUrl,
    portalUrl,
    tempPassword
  });

  console.log('\n2. Attempting Immediate Re-dispatch (Deduplication Check)...');
  await sendInvoiceWhatsApp({
    client: testClient,
    amount: 2000,
    discount: 0,
    netAmount: 2000,
    serviceType: testClient.serviceType,
    checkoutUrl: directStripeUrl,
    portalUrl,
    tempPassword
  });

  console.log('\n--- Test Completed Successfully! ---');
  process.exit(0);
}

testSingleInvoiceWhatsApp().catch(err => {
  console.error('Test execution error:', err);
  process.exit(1);
});
