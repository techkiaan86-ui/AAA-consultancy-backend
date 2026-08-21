require('dotenv').config();
const { createZohoInvoice } = require('./src/services/zohoInvoiceService');
const { sendPaymentSuccessWhatsApp } = require('./src/services/whatsappService');

async function runTest() {
  const targetPhone = process.argv[2] || '+971509554142';
  console.log('============================================================');
  console.log('Testing Zoho Invoice & WhatsApp Payment Receipt End-to-End');
  console.log(`Target Phone Number: ${targetPhone}`);
  console.log('============================================================\n');

  const ts = Date.now();
  const dummyClient = {
    id: `test-client-id-${ts}`,
    firstName: 'AAA',
    lastName: `Test${ts}`,
    email: `test.${ts}@aaabusinessconsultancy.com`,
    phone: targetPhone,
    clientCode: 'CID 12099',
    serviceType: 'Spain Digital Nomad Visa (DNV)'
  };

  try {
    // 1. Test Zoho Invoice Creation
    console.log('[1/2] Creating Zoho Invoice...');
    const zohoRes = await createZohoInvoice({
      client: dummyClient,
      amount: 250,
      discount: 50,
      netAmount: 200,
      serviceType: dummyClient.serviceType,
      dueDate: new Date()
    });

    console.log('Zoho Invoice Response:', zohoRes);

    // 2. Test WhatsApp Payment Success Dispatch with Zoho Invoice Link
    console.log('\n[2/2] Dispatching WhatsApp Payment Success Receipt...');
    await sendPaymentSuccessWhatsApp({
      client: dummyClient,
      paymentId: `PAY-TEST-${Date.now()}`,
      amount: 200,
      serviceType: dummyClient.serviceType,
      transactionId: `TXN-ZOHO-${Math.floor(100000 + Math.random() * 900000)}`,
      zohoInvoiceUrl: zohoRes.invoiceUrl
    });

    console.log('\n============================================================');
    console.log('✅ TEST COMPLETE: Check WhatsApp inbox for the invoice message!');
    console.log('============================================================');
  } catch (err) {
    console.error('\n❌ TEST FAILED:', err);
  }
}

runTest();
