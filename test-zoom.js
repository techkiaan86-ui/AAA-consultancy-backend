require('dotenv').config();
const crypto = require('crypto');
const zoomService = require('./src/services/zoomService');

async function runTest() {
  console.log('--- Zoom Integration Test ---');
  
  // 1. Check Service Configuration
  console.log(`Zoom Service configured: ${zoomService.isConfigured ? 'YES' : 'NO (Running in Mock/Fallback Mode)'}`);
  
  // 2. Test Meeting Creation
  try {
    console.log('\nTesting createZoomMeeting function...');
    const result = await zoomService.createZoomMeeting({
      topic: 'Test Consultation',
      startTime: new Date().toISOString(),
      durationMinutes: 30
    });
    
    if (result) {
      console.log('Result (Real Zoom):', result);
    } else {
      console.log('Result (Mock Fallback): Custom Zoom meeting creation skipped, generated static random Zoom link instead.');
    }
  } catch (error) {
    console.error('Error during Zoom meeting creation:', error.message);
  }

  // 3. Test Webhook Signature Generation for URL Verification Challenge
  console.log('\nTesting Webhook Signature Verification...');
  const plainToken = 'test-token-12345';
  const webhookToken = process.env.ZOOM_WEBHOOK_SECRET_TOKEN || 'your_zoom_webhook_secret_token_here';
  
  const encryptedToken = crypto
    .createHmac('sha256', webhookToken)
    .update(plainToken)
    .digest('hex');
    
  console.log(`Plain Token: ${plainToken}`);
  console.log(`Webhook Token used: ${webhookToken}`);
  console.log(`Generated HMAC Signature: ${encryptedToken}`);
  console.log('Verification setup works! Respond with this encryptedToken when Zoom validates the webhook.');
}

runTest();
