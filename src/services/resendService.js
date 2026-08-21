
const { Resend } = require('resend');

// Initialize Resend client
const apiKey = process.env.RESEND_API_KEY;
let resend = null;

if (apiKey && apiKey !== 'your_resend_api_key_here') {
  resend = new Resend(apiKey);
} else {
  console.warn('RESEND_API_KEY is not configured. Emails will be logged to console instead.');
}

/**
 * Sends a booking form link email to a new lead.
 * @param {string} toEmail 
 * @param {string} firstName 
 */
const sendBookingLinkEmail = async (toEmail, firstName) => {
  const name = firstName || 'there';
  const encodedEmail = encodeURIComponent(toEmail);
  const encodedName = encodeURIComponent(name);
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const bookingUrl = `${frontendUrl}/#/public/lead-form?email=${encodedEmail}&firstName=${encodedName}`;

  const subject = '🇪🇸 Complete Your Registration & Book Your Assessment';
  
  const htmlContent = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>AAA Business Consultancy</title>
        <style>
          body {
            font-family: 'Outfit', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background-color: #f8fafc;
            color: #1e293b;
            margin: 0;
            padding: 0;
            -webkit-font-smoothing: antialiased;
          }
          .container {
            max-width: 600px;
            margin: 40px auto;
            background: #ffffff;
            border-radius: 16px;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.04);
            border: 1px solid #e2e8f0;
            overflow: hidden;
          }
          .header {
            background: linear-gradient(135deg, #1e3a8a 0%, #0d9488 100%);
            padding: 40px 20px;
            text-align: center;
            color: #ffffff;
          }
          .logo {
            font-size: 32px;
            font-weight: 800;
            letter-spacing: -1px;
            margin-bottom: 8px;
          }
          .logo span {
            color: #38bdf8;
          }
          .header h1 {
            margin: 0;
            font-size: 20px;
            font-weight: 500;
            opacity: 0.9;
          }
          .content {
            padding: 40px 30px;
            line-height: 1.6;
          }
          .greeting {
            font-size: 22px;
            font-weight: 700;
            color: #0f172a;
            margin-top: 0;
            margin-bottom: 16px;
          }
          p {
            font-size: 16px;
            color: #475569;
            margin-bottom: 24px;
          }
          .btn-container {
            text-align: center;
            margin: 32px 0;
          }
          .btn {
            display: inline-block;
            background-color: #0d9488;
            color: #ffffff !important;
            text-decoration: none;
            padding: 16px 32px;
            border-radius: 8px;
            font-weight: 700;
            font-size: 16px;
            transition: background-color 0.2s;
            box-shadow: 0 4px 12px rgba(13, 148, 136, 0.2);
          }
          .btn:hover {
            background-color: #0f766e;
          }
          .features {
            background: #f1f5f9;
            border-radius: 12px;
            padding: 24px;
            margin-bottom: 24px;
          }
          .features-title {
            font-weight: 700;
            font-size: 15px;
            color: #1e293b;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 12px;
            margin-top: 0;
          }
          .feature-item {
            display: flex;
            align-items: center;
            font-size: 14px;
            color: #475569;
            margin-bottom: 8px;
          }
          .feature-icon {
            margin-right: 8px;
            color: #0d9488;
          }
          .footer {
            background: #f8fafc;
            border-top: 1px solid #e2e8f0;
            padding: 24px;
            text-align: center;
            font-size: 12px;
            color: #94a3b8;
          }
          .footer a {
            color: #0d9488;
            text-decoration: none;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="logo">A³<span>Consultancy</span></div>
            <h1>Spain Visa & Relocation Services</h1>
          </div>
          <div class="content">
            <div class="greeting">Hi ${name},</div>
            <p>We received your inquiry regarding Spain relocation and visa services. To help us understand your goals and assign the best agent to your profile, please complete your details and book your free consultation time slot.</p>
            
            <div class="btn-container">
              <a href="${bookingUrl}" class="btn">Book Free Eligibility Assessment</a>
            </div>

            <div class="features">
              <div class="features-title">What happens next:</div>
              <div class="feature-item">
                <span class="feature-icon">✓</span> Free 20-minute eligibility review with a Spain specialist.
              </div>
              <div class="feature-item">
                <span class="feature-icon">✓</span> Personalized requirements checklist for your program.
              </div>
              <div class="feature-item">
                <span class="feature-icon">✓</span> Direct access to your secure client portal.
              </div>
            </div>
            
            <p>If you have any questions, feel free to reply directly to this email.</p>
            <p>Best regards,<br><strong>AAA Business Consultancy Team</strong></p>
          </div>
          <div class="footer">
            © 2026 AAA Business Consultancy LLC. All rights reserved.<br>
            Business Village, Block B, 4th Floor, Office F09, Deira, Dubai, UAE<br>
            <a href="https://aaabusinessconsultancy.com">Visit our website</a>
          </div>
        </div>
      </body>
    </html>
  `;

  if (resend) {
    try {
      const data = await resend.emails.send({
        from: 'AAA Business Consultancy <onboarding@resend.dev>',
        to: toEmail,
        subject: subject,
        html: htmlContent,
      });
      console.log(`Email successfully sent via Resend to ${toEmail}. Response ID: ${data.id}`);
      return data;
    } catch (error) {
      console.error(`Error sending email via Resend to ${toEmail}:`, error);
      throw error;
    }
  } else {
    console.log('\n--- [MOCK EMAIL SENT (RESEND NOT CONFIGURED)] ---');
    console.log(`To: ${toEmail}`);
    console.log(`Subject: ${subject}`);
    console.log(`Link: ${bookingUrl}`);
    console.log('-------------------------------------------------\n');
    return { id: `mock-email-${Date.now()}` };
  }
};

module.exports = {
  sendBookingLinkEmail
};
