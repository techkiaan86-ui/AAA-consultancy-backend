require('dotenv').config();
const { sendEmail, sendAppointmentConfirmationEmail, sendInvoiceNotificationEmail, sendVisaChecklist } = require('./src/services/emailService');

async function testAllEmailFlows() {
  const recipient = process.argv[2] || 'client@aaabusinessconsultancy.com';
  console.log('============================================================');
  console.log('Testing ALL Live Email Triggers via Resend');
  console.log(`Target Recipient: ${recipient}`);
  console.log(`RESEND_API_KEY Configured: ${process.env.RESEND_API_KEY ? 'YES (' + process.env.RESEND_API_KEY.substring(0, 10) + '...)' : 'NO'}`);
  console.log('============================================================\n');

  try {
    // 1. Direct Email Test
    console.log('[1/4] Sending General Direct Email...');
    const r1 = await sendEmail({
      to: recipient,
      subject: '🧪 [Test 1/4] General Email Verification',
      html: '<h1>General Test Email</h1><p>Resend direct email sending is working perfectly!</p>'
    });
    console.log('  Result 1:', r1);

    // 2. Appointment Confirmation Email Test
    console.log('\n[2/4] Sending Appointment Confirmation Email...');
    const r2 = await sendAppointmentConfirmationEmail({
      to: recipient,
      firstName: 'Test Client',
      date: '2026-08-05',
      timeSlot: '11:00 AM (UAE)',
      meetingLink: 'https://zoom.us/j/123456789',
      consultationId: 'test-consult-123'
    });
    console.log('  Result 2:', r2);

    // 3. Invoice Notification Email Test
    console.log('\n[3/4] Sending Invoice Notification Email...');
    const r3 = await sendInvoiceNotificationEmail({
      to: recipient,
      clientName: 'Test Client',
      amount: 2000,
      discount: 0,
      netAmount: 2000,
      serviceType: 'Spain Digital Nomad Visa (DNV)',
      checkoutUrl: 'https://aaa-crm-service.netlify.app/#/portal/login',
      portalUrl: 'https://aaa-crm-service.netlify.app/#/portal/login',
      tempPassword: 'TestPassword123'
    });
    console.log('  Result 3:', r3);

    // 4. Visa Document Checklist Email Test
    console.log('\n[4/4] Sending Visa Document Checklist Email...');
    const r4 = await sendVisaChecklist(recipient, 'Test Client', 'Digital Nomad Visa');
    console.log('  Result 4:', r4);

    console.log('\n============================================================');
    console.log('✅ ALL EMAIL FLOWS COMPLETED SUCCESSFULLY!');
    console.log('============================================================');
  } catch (err) {
    console.error('\n❌ EMAIL FLOW TEST FAILED:', err);
  }
}

testAllEmailFlows();
