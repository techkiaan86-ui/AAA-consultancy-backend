require('dotenv').config();
const { sendWhatsAppMessage } = require('./src/services/whatsappService');

async function test() {
  const args = process.argv.slice(2);
  const phoneNumber = args[0];
  const templateName = args[1] || 'hello_world';

  if (!phoneNumber) {
    console.error('Please provide a phone number with country code. Example: node test-whatsapp.js 919876543210 [template_name]');
    process.exit(1);
  }

  console.log(`Sending test WhatsApp message to ${phoneNumber} using template "${templateName}"...`);
  try {
    const languageCode = templateName === 'hello_world' ? 'en_US' : 'en';
    const components = templateName === 'hello_world' ? [] : [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'Test User' }
        ]
      }
    ];

    const result = await sendWhatsAppMessage({
      to: phoneNumber,
      templateName,
      languageCode,
      components
    });
    console.log('WhatsApp test result:', result);
  } catch (error) {
    console.error('WhatsApp test failed:', error.message);
  }
}

test();
