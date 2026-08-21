require('dotenv').config();
const { sendEmail } = require('./src/services/emailService');

async function test() {
  const toEmail = process.argv[2] || 'client@aaabusinessconsultancy.com';
  console.log('------------------------------------------------------------');
  console.log(`Starting Email Delivery Test`);
  console.log(`Target Recipient: ${toEmail}`);
  console.log('------------------------------------------------------------');
  
  try {
    const result = await sendEmail({
      to: toEmail,
      subject: 'Email Setup Test - AAA Visa CRM',
      html: '<h3>Email System Test Success!</h3><p>If you see this email, your email configuration (Resend or SMTP) is working correctly.</p>'
    });
    console.log('Email delivery function resolved.');
    console.log('Result:', result);
    console.log('------------------------------------------------------------');
  } catch (error) {
    console.error('Email delivery failed:');
    console.error(error);
    console.log('------------------------------------------------------------');
  }
}

test();
