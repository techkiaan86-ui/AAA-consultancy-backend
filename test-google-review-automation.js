require('dotenv').config();

const { sendGoogleReviewRequestWhatsApp } = require('./src/services/whatsappService');

async function testGoogleReviewAutomation() {
  console.log('--- Starting Google Review WhatsApp Automation Test ---');

  const testPhone = process.env.TEST_PHONE || '+917047687998';
  const testClientName = 'Test Automated Client';

  // Test Dispatch Immediately After Consultation
  console.log('\n1. Testing Immediate Post-Consultation Dispatch...');
  const result1 = await sendGoogleReviewRequestWhatsApp({
    phone: testPhone,
    clientName: testClientName
  });
  console.log('Result:', result1);

  if (!result1.success) {
    console.error('❌ FAILED: Immediate dispatch failed.');
    process.exit(1);
  }
  console.log('✅ PASSED: Immediate Google Review WhatsApp message dispatched successfully.');

  console.log('\n--- All Google Review WhatsApp Automation Unit Tests Passed! ---');
  process.exit(0);
}

testGoogleReviewAutomation().catch(err => {
  console.error('Test execution error:', err);
  process.exit(1);
});
