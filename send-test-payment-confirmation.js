require('dotenv').config();
const { sendPaymentSuccessWhatsApp } = require('./src/services/whatsappService');
const { sendPaymentSuccessEmail } = require('./src/services/emailService');

async function testPaymentConfirmation() {
  const targetPhone = process.argv[2] || '+917693091260';
  const targetEmail = process.argv[3] || 'client@aaabusinessconsultancy.com';

  console.log('============================================================');
  console.log('Testing Payment Confirmation Dispatch (WhatsApp & Email)');
  console.log(`Target Phone: ${targetPhone}`);
  console.log(`Target Email: ${targetEmail}`);
  console.log('============================================================\n');

  const ts = Date.now();
  const dummyClient = {
    id: `test-client-${ts}`,
    firstName: 'Valued',
    lastName: 'Client',
    email: targetEmail,
    phone: targetPhone,
    clientCode: 'CID 12099',
    serviceType: 'Spain Digital Nomad Visa (DNV)',
    isTemporaryPassword: true
  };

  try {
    // 1. WhatsApp Payment Confirmation
    console.log('[1/2] Dispatching WhatsApp payment confirmation...');
    await sendPaymentSuccessWhatsApp({
      client: dummyClient,
      paymentId: `PAY-TEST-${ts}`,
      amount: 250,
      serviceType: dummyClient.serviceType,
      transactionId: `TXN-${Math.floor(100000 + Math.random() * 900000)}`,
      generatedPassword: 'TempPassword2026!'
    });
    console.log('✅ WhatsApp payment confirmation function executed!');

    // 2. Email Payment Confirmation
    console.log('\n[2/2] Dispatching Email payment confirmation...');
    const emailRes = await sendPaymentSuccessEmail({
      to: targetEmail,
      clientName: `${dummyClient.firstName} ${dummyClient.lastName}`,
      customerId: dummyClient.clientCode,
      serviceType: dummyClient.serviceType,
      amount: 250,
      tempPassword: 'TempPassword2026!'
    });
    console.log('✅ Email payment confirmation function executed! Result:', emailRes);

    console.log('\n============================================================');
    console.log('✅ TEST DISPATCH COMPLETE');
    console.log('============================================================');
  } catch (err) {
    console.error('\n❌ Test Dispatch Error:', err);
  }
}

testPaymentConfirmation();
