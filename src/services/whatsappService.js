const twilio = require('twilio');
const prisma = require('../config/db');

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM;

const isConfigured = !!(
  TWILIO_ACCOUNT_SID &&
  TWILIO_ACCOUNT_SID.startsWith('AC') &&
  TWILIO_AUTH_TOKEN &&
  TWILIO_AUTH_TOKEN !== 'your_twilio_auth_token_here' &&
  TWILIO_WHATSAPP_FROM
);

/**
 * Utility function to clean and normalize international phone numbers.
 * Converts local formats (e.g. 050..., 00971...) into clean E.164 (+97150...) format.
 */
const formatPhoneNumber = (phone) => {
  if (!phone) return null;
  let clean = String(phone).trim();
  if (clean.startsWith('whatsapp:')) {
    clean = clean.substring(9);
  }
  // Remove spaces, hyphens, brackets, special non-digits (except leading +)
  clean = clean.replace(/[^\d+]/g, '');

  // If starts with 00, convert to +
  if (clean.startsWith('00')) {
    clean = '+' + clean.substring(2);
  }

  // If phone doesn't start with '+', add '+'
  if (!clean.startsWith('+')) {
    // Check if leading 0 (like UAE 050... or 052... or 055...)
    if (clean.startsWith('0')) {
      clean = clean.substring(1);
    }
    // Default country code fallback if number is local 9 digits (e.g., 501234567 -> UAE +971501234567)
    if (clean.length === 9 && (clean.startsWith('50') || clean.startsWith('52') || clean.startsWith('54') || clean.startsWith('55') || clean.startsWith('56') || clean.startsWith('58'))) {
      clean = '971' + clean;
    }
    clean = '+' + clean;
  }

  if (clean === '+' || clean.length < 8) return null;
  return clean;
};
exports.formatPhoneNumber = formatPhoneNumber;

if (isConfigured) {
  console.log(`WhatsApp Service: Twilio WhatsApp API configured with Sender: ${TWILIO_WHATSAPP_FROM}`);
} else {
  console.warn('WhatsApp Service: Twilio credentials not configured (or using placeholders). Running in local DRY-RUN/Sandbox mode.');
}

/**
 * Sends a WhatsApp message using Twilio or logs it in Dry-Run mode.
 * Matches CRM template placeholders (e.g. {{1}}, {{2}}) with parameters in components.
 * 
 * @param {Object} options - Sending options
 * @param {string} options.to - Recipient phone number (e.g., "+971509554142" or "919876543210")
 * @param {string} options.templateName - Registered template ID/name (e.g., "automated_first_response")
 * @param {string} [options.languageCode='en'] - Template language code (legacy parameter for compatibility)
 * @param {Array} [options.components=[]] - Template components containing parameters (header, body, buttons)
 * @returns {Promise<{success: boolean, messageId?: string, dryRun?: boolean}>}
 */
exports.sendWhatsAppMessage = async ({ to, templateName, contentSid: customContentSid = null, languageCode = 'en', components = [], externalProviderId = null, nameOverride = null }) => {
  // Clean phone number format for Twilio: must start with '+' and be prefixed with 'whatsapp:'
  let cleanTo = to.trim();
  if (cleanTo.startsWith('whatsapp:')) {
    cleanTo = cleanTo.substring(9);
  }
  cleanTo = cleanTo.replace(/[^\d+]/g, ''); // Keep only digits and '+'
  if (!cleanTo.startsWith('+')) {
    cleanTo = '+' + cleanTo;
  }

  // Sandbox Mode Whitelist Filter (Defaults to INACTIVE in production unless explicitly set)
  const isTestMode = process.env.TEST_MODE === 'true'; // FIX: Defaults to false
  if (isTestMode) {
    const whitelistStr = process.env.TEST_PHONES || '+917047687998,+971524350123,+971524360123,+971566952566';
    const testPhones = whitelistStr.split(',').map(p => p.trim());
    if (!testPhones.includes(cleanTo)) {
      console.log(`[TEST MODE] Blocked automated template "${templateName}" to ${cleanTo} (not whitelisted)`);
      return { success: true, messageId: 'blocked-sandbox', dryRun: true }; // Drop
    }
  }

  const twilioTo = `whatsapp:${cleanTo}`;

  // Twilio Content Template SIDs — maps template names to approved WhatsApp template SIDs
  const TEMPLATE_CONTENT_SIDS = {
    payment_reminder_2h: 'HX02a8475f06ded5fb55382c41dcc12e03',
    payment_reminder_24h: 'HX58d9dc8fcb2379bc8fd07c62f5d6f08c',
    payment_reminder_48h: 'HXdf389214c0d680e13b1ac350963136ae',
    google_review: 'HXceaff82353f36a4766549d38d53825bf',
    aaa_meeting_reminder_24h: 'HX2f47579af995ae8f89e0995030cd7d75',
    aaa_meeting_reminder_1h: 'HX745752fa78cb0a8a2675e376fe385330',
    aaa_greeting: 'HX6b1ea0ace7653a738bfe260ff6077194',
    t1: 'HX6b1ea0ace7653a738bfe260ff6077194',
    greet: 'HX6b1ea0ace7653a738bfe260ff6077194',
    // --- REQUIRED NEW TEMPLATES FOR NOTIFICATION FLOW ---
    // If these are missing in Twilio, Twilio will reject the fallback text outside 24h window
    meeting_cancelled: process.env.TWILIO_TEMPLATE_MEETING_CANCELLED || null,
    meeting_booked: process.env.TWILIO_TEMPLATE_MEETING_BOOKED || null,
    meeting_rescheduled: process.env.TWILIO_TEMPLATE_MEETING_RESCHEDULED || null
  };

  if (isConfigured) {
    try {
      const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

      // 1. Attempt to fetch template from CRM database
      let templateText = null;
      try {
        const template = await prisma.template.findUnique({
          where: { id: templateName }
        });
        if (template && template.body) {
          templateText = template.body;
        }
      } catch (dbError) {
        console.warn(`Could not fetch template "${templateName}" from database, using hardcoded fallback:`, dbError.message);
      }

      // 2. Default fallback values for CRM system templates
      if (!templateText) {
        const fallbacks = {
          meeting_booked: `✈️ *Spain Visa Consultation Confirmed!*

Dear *{{1}}*,

Your Free Spain Visa Eligibility Assessment with AAA Business Consultancy has been scheduled successfully! 🎉

📅 *Date:* {{2}}
⏰ *Time:* {{3}} (UAE)
🔗 *Meeting Join Link:* {{4}}

─────────────
👇 *Quick Action Links:*
• 🔄 *Reschedule Booking:* {{5}}
• ❌ *Cancel Booking:* {{6}}
• 📦 *View Visa Packages:* https://aaabusinessconsultancy.com/services-and-packages/

_Note: Please join within 10 minutes of appointment time to avoid automatic cancellation._`,
          automated_first_response: 'Thank you for contacting AAA Business Consultancy regarding Spain Visa & Residency Services. To Book Your Free Eligibility Assessment & Verification Please Contact Us on Whatsapp: https://wa.me/971509554142?text=I%20want%20to%20book%20an%20assessment%20from%20TikTok',
          consultation_scheduled_confirmation: 'Hello {{1}}, your Spain Visa Consultation is scheduled on {{2}} at {{3}} (UAE). Join Zoom Meeting: {{4}}',
          consultation_no_show_cancelled: 'Hello {{1}}, your Free Eligibility Assessment has been cancelled because you did not join within 10 minutes of the scheduled time. Due to high demand, missed appointments cannot be rescheduled.',
          payment_pending_reminder: 'Hi {{1}}, this is a reminder that payment is pending for Invoice #{{2}}.',
          payment_drip_discount: 'Hello {{1}}, use discount code CEO24H to complete your payment for Invoice #{{2}} with a special discount! Valid for 24 hours only.',
          google_review: 'Hello, \n\nWe hope your consultation with AAA Business Consultancy was helpful! 🇪🇸\n\nIf you enjoyed your experience with our advisors, could you please spare 30 seconds to share your feedback on Google? Your review means the world to us and helps others find us.\n\n⭐ Leave your Google Review here:\nhttps://g.page/r/CXugL6bqOJCXEAI/review\n\nThank you so much for your support!',
          aaa_greeting: 'Hello👋 \n\nWelcome to AAA Business Consultancy Services! \n\nWe’re here to help you with your Spain Visa, Residency & Relocation requirements. \n\nReply Hi to get started.',
          t1: 'Hello👋 \n\nWelcome to AAA Business Consultancy Services! \n\nWe’re here to help you with your Spain Visa, Residency & Relocation requirements. \n\nReply Hi to get started.',
          greet: 'Hello👋 \n\nWelcome to AAA Business Consultancy Services! \n\nWe’re here to help you with your Spain Visa, Residency & Relocation requirements. \n\nReply Hi to get started.',
          aaa_meeting_reminder_24h: 'Hello {{1}},\n\nThis is a reminder that your Free 20-Minute Spain Visa Eligibility Assessment is scheduled for tomorrow:\n\n📅 Date & Time: {{2}}\n🔗 Zoom Meeting Link: {{3}}\n\nPlease ensure you join on time.\n\nBest regards,\nAAA Business Consultancy Team',
          aaa_meeting_reminder_1h: 'Hello {{1}},\n\nYour Free 20-Minute Spain Visa Eligibility Assessment starts in 1 HOUR:\n\n📅 Date & Time: {{2}}\n🔗 Zoom Meeting Link: {{3}}\n\nPlease be ready to join 5 minutes before start time.\n\nBest regards,\nAAA Business Consultancy Team',
          payment_reminder_2h: 'Hello {{1}},\n\nWe noticed that you started setting up your Spain Visa / Relocation application but haven\'t completed the payment yet.\n\nTo secure your assigned immigration specialist and begin processing today, please complete your payment:\n\n🔗 Payment Link: {{2}}\n\nIf you have any questions, please reply directly. We are here to help!\n\nBest regards,\nAAA Business Consultancy Team',
          payment_reminder_24h: 'Hello {{1}},\n\nThis is a gentle reminder that your relocation package invoice is still pending. It has been 24 hours since your account initialization.\n\nTo avoid losing your slot and priority file review, please finalize your payment using the link below:\n\n🔗 Complete Payment: {{2}}\n\nOur team is ready to begin your visa submission steps as soon as payment is confirmed.\n\nBest regards,\nAAA Business Consultancy Team',
          payment_reminder_48h: 'Hello {{1}},\n\nWe would like to remind you that your invoice has been pending for 2 days.\n\nIf you are ready to relocate or secure your Spanish visa/residency, please complete the final steps of your application fee payment:\n\n🔗 Final Payment Link: {{2}}\n\nBest regards,\nAAA Business Consultancy Team',
          meeting_cancelled: `❌ *Spain Visa Consultation Cancelled*

Dear *{{1}}*,

Your Free Spain Visa Eligibility Assessment scheduled for *{{2}}* at *{{3}}* (UAE) has been cancelled.

If you would like to reschedule your consultation, please click the link below to select a new date and time slot:

🔗 *Rebook Consultation:* {{4}}

─────────────
*AAA Business Consultancy*`,
          meeting_rescheduled: `🔄 *Spain Visa Consultation Rescheduled*

Dear *{{1}}*,

Your Free Spain Visa Eligibility Assessment has been rescheduled successfully!

📅 *New Date:* {{2}}
⏰ *New Time:* {{3}} (UAE)
🔗 *Meeting Join Link:* {{4}}

─────────────
*AAA Business Consultancy*`
        };
        templateText = fallbacks[templateName] || `Template: ${templateName}`;
      }

      // 3. Extract parameter values from 'components' structure
      const bodyComponents = components.find(c => c.type === 'body')?.parameters || [];

      // 4. Interpolate variables (replace {{1}} with param 1, {{2}} with param 2, etc.)
      let resolvedBody = templateText;
      bodyComponents.forEach((param, index) => {
        const placeholder = `{{${index + 1}}}`;
        const replacement = param.text || '';
        resolvedBody = resolvedBody.replaceAll(placeholder, replacement);
      });

      // 5. Send message via Twilio API
      let deliveryStatus = 'SENT';
      let failureReason = null;
      let msgSid = null;

      try {
        const contentSid = customContentSid || TEMPLATE_CONTENT_SIDS[templateName];

        let fromNum = TWILIO_WHATSAPP_FROM;
        if (fromNum && !fromNum.startsWith('whatsapp:')) {
          fromNum = `whatsapp:${fromNum}`;
        }

        if (contentSid) {
          // Use official Twilio Content Template API (contentSid + contentVariables)
          // This is required for outbound messages outside the 24-hour WhatsApp window
          const contentVars = {};
          // Only send contentVariables if the template definition contains placeholders like {{1}}
          if (templateText && templateText.includes('{{1}}')) {
            bodyComponents.forEach((param, index) => {
              contentVars[String(index + 1)] = param.text || '';
            });
          }

          const msgOptions = {
            to: twilioTo,
            contentSid: contentSid
          };
          if (process.env.TWILIO_MESSAGING_SERVICE_SID) {
            msgOptions.messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
          } else if (fromNum) {
            msgOptions.from = fromNum;
          }

          if (Object.keys(contentVars).length > 0) {
            msgOptions.contentVariables = JSON.stringify(contentVars);
          }

          const message = await client.messages.create(msgOptions);
          msgSid = message.sid;
          console.log(`[WhatsApp] ✅ Sent template "${templateName}" via Content SID ${contentSid} to ${twilioTo}. SID: ${message.sid}`);
        } else {
          // Send as plain body text (for custom DB templates or templates without Content SID)
          const message = await client.messages.create({
            body: resolvedBody,
            from: fromNum,
            to: twilioTo
          });
          msgSid = message.sid;
          console.log(`[WhatsApp] ✅ Sent template "${templateName}" via custom body text to ${twilioTo}. SID: ${message.sid}`);
        }
      } catch (twilioErr) {
        console.error(`[WhatsApp] ❌ Failed to send "${templateName}" to ${twilioTo}:`, twilioErr.message);
        deliveryStatus = 'FAILED';
        failureReason = twilioErr.message;
      }

      // Log in CommunicationLog
      try {
        const numberPart = cleanTo.replace('+', '');
        const clientRecord = await prisma.client.findFirst({
          where: { phone: { contains: numberPart } }
        });

        await prisma.communicationLog.create({
          data: {
            clientId: clientRecord ? clientRecord.id : null,
            phone: cleanTo,
            name: nameOverride || (clientRecord ? `${clientRecord.firstName} ${clientRecord.lastName}`.trim() : 'Client'),
            channel: 'WHATSAPP',
            direction: 'OUTBOUND',
            externalProviderId: externalProviderId || templateName,
            content: resolvedBody,
            deliveryStatus: deliveryStatus,
            failureReason: failureReason
          }
        });
      } catch (logErr) {
        console.warn(`Could not log template "${templateName}" to CommunicationLog:`, logErr.message);
      }

      if (deliveryStatus === 'FAILED') {
        throw new Error(failureReason);
      }
      return { success: true, messageId: msgSid, dryRun: false };
    } catch (error) {
      console.error(`[WhatsApp] Failed in sendWhatsAppMessage wrapper for ${twilioTo}:`, error.message);
      throw new Error(`Twilio API Error: ${error.message}`);
    }
  } else {
    // Sandbox / Dry-Run Mode
    const contentSid = TEMPLATE_CONTENT_SIDS[templateName];
    console.log('------------------------------------------------------------');
    console.log(`[TWILIO WHATSAPP DRY-RUN]`);
    console.log(`To:       ${twilioTo}`);
    console.log(`Template: ${templateName}`);
    console.log(`ContentSID: ${contentSid || 'N/A (body fallback)'}`);
    console.log(`Components: ${JSON.stringify(components, null, 2)}`);
    console.log('------------------------------------------------------------');

    try {
      let templateText = null;
      try {
        const template = await prisma.template.findUnique({
          where: { id: templateName }
        });
        if (template && template.body) {
          templateText = template.body;
        }
      } catch (_) { }

      if (!templateText) {
        const fallbacks = {
          automated_first_response: 'Thank you for contacting AAA Business Consultancy regarding Spain Visa & Residency Services. To Book Your Free Eligibility Assessment & Verification Please Contact Us on Whatsapp: https://wa.me/971509554142?text=I%20want%20to%20book%20an%20assessment%20from%20TikTok',
          consultation_scheduled_confirmation: 'Hello {{1}}, your Spain Visa Consultation is scheduled on {{2}} at {{3}} (UAE). Join Zoom Meeting: {{4}}',
          consultation_no_show_cancelled: 'Hello {{1}}, your Free Eligibility Assessment has been cancelled because you did not join within 10 minutes of the scheduled time. Due to high demand, missed appointments cannot be rescheduled.',
          payment_pending_reminder: 'Hi {{1}}, this is a reminder that payment is pending for Invoice #{{2}}.',
          payment_drip_discount: 'Hello {{1}}, use discount code CEO24H to complete your payment for Invoice #{{2}} with a special discount! Valid for 24 hours only.',
          google_review: 'We hope your consultation with AAA Business Consultancy was helpful! 🇪🇸\n\nIf you enjoyed your experience with our advisors, could you please spare 30 seconds to share your feedback on Google? Your review means the world to us and helps others find us.\n\n⭐ Leave your Google Review here:\nhttps://g.page/r/CXugL6bqOJCXEAI/review\n\nThank you so much for your support!',
          payment_reminder_2h: 'Hello {{1}},\n\nWe noticed that you started setting up your Spain Visa / Relocation application but haven\'t completed the payment yet.\n\nTo secure your assigned immigration specialist and begin processing today, please complete your payment:\n\n🔗 Payment Link: {{2}}\n\nIf you have any questions, please reply directly. We are here to help!\n\nBest regards,\nAAA Business Consultancy Team',
          payment_reminder_24h: 'Hello {{1}},\n\nThis is a gentle reminder that your relocation package invoice is still pending. It has been 24 hours since your account initialization.\n\nTo avoid losing your slot and priority file review, please finalize your payment using the link below:\n\n🔗 Complete Payment: {{2}}\n\nOur team is ready to begin your visa submission steps as soon as payment is confirmed.\n\nBest regards,\nAAA Business Consultancy Team',
          payment_reminder_48h: 'Hello {{1}},\n\nWe would like to remind you that your invoice has been pending for 2 days.\n\nIf you are ready to relocate or secure your Spanish visa/residency, please complete the final steps of your application fee payment:\n\n🔗 Final Payment Link: {{2}}\n\nBest regards,\nAAA Business Consultancy Team'
        };
        templateText = fallbacks[templateName] || `Template: ${templateName}`;
      }

      const bodyComponents = components.find(c => c.type === 'body')?.parameters || [];
      let resolvedBody = templateText;
      bodyComponents.forEach((param, index) => {
        const placeholder = `{{${index + 1}}}`;
        const replacement = param.text || '';
        resolvedBody = resolvedBody.replaceAll(placeholder, replacement);
      });

      const numberPart = cleanTo.replace('+', '');
      const clientRecord = await prisma.client.findFirst({
        where: { phone: { contains: numberPart } }
      });

      await prisma.communicationLog.create({
        data: {
          clientId: clientRecord ? clientRecord.id : null,
          phone: cleanTo,
          name: clientRecord ? `${clientRecord.firstName} ${clientRecord.lastName}`.trim() : 'Client',
          channel: 'WHATSAPP',
          direction: 'OUTBOUND',
          externalProviderId: templateName,
          content: resolvedBody,
          deliveryStatus: 'LOGGED',
          failureReason: 'DRY_RUN'
        }
      });
    } catch (logErr) {
      console.warn(`Could not log dry-run template "${templateName}" to CommunicationLog:`, logErr.message);
    }

    return { success: true, messageId: `twilio-dryrun-${Date.now()}`, dryRun: true };
  }
};

/**
 * Sends automated Payment Successful WhatsApp message with receipt details, delivery notice, and portal credentials.
 * Supports fallbacks across client.phone, client.lead.phone, lead.phone, and explicit phone arguments.
 */
exports.sendPaymentSuccessWhatsApp = async ({ client, lead, phone, paymentId, amount, serviceType, transactionId, generatedPassword, zohoInvoiceUrl, invoiceId }) => {
  try {
    const rawPhone = phone || client?.phone || client?.lead?.phone || lead?.phone;
    const cleanPhone = formatPhoneNumber(rawPhone);

    if (!cleanPhone) {
      console.warn('[Payment Success WhatsApp] Missing or invalid recipient phone number. Skipping.');
      return;
    }

    const receiptId = paymentId ? `#${paymentId.substring(0, 8)}` : `#PAY-${Date.now()}`;
    const dedupeKey = paymentId ? `PAYMENT_SUCCESS_${paymentId}` : null;

    // Deduplication check: Only skip if an existing message was SUCCESSFULLY sent
    if (dedupeKey && (client?.id || lead?.id)) {
      try {
        const existingLog = await prisma.communicationLog.findFirst({
          where: {
            OR: [
              { externalProviderId: dedupeKey },
              { messageId: dedupeKey }
            ],
            deliveryStatus: 'SENT'
          }
        });
        if (existingLog) {
          console.log(`[Payment Success WA] Receipt already delivered for ${dedupeKey}. Skipping duplicate.`);
          return;
        }
      } catch (dedupErr) {
        console.warn('[Payment Success WA] Deduplication check warning:', dedupErr.message);
      }
    }

    const dayjs = require('dayjs');
    const frontendUrl = process.env.FRONTEND_URL || 'https://aaa-crm-service.netlify.app';
    const backendUrl = process.env.BACKEND_URL || 'https://aaa-crm-service-production.up.railway.app';
    const portalUrl = `${frontendUrl}/#/portal/login`;

    const clientName = `${client?.firstName || lead?.firstName || ''} ${client?.lastName || lead?.lastName || ''}`.trim() || 'Valued Client';
    const clientCode = client?.clientCode || (client?.id ? `CID-${12000 + parseInt(client.id.replace(/\D/g, '').slice(-3) || '1')}` : 'CID-12001');
    const formattedAmount = Number(amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const formattedDate = dayjs().format('DD/MM/YYYY hh:mm A');
    const email = client?.email || lead?.email || 'N/A';
    const password = generatedPassword || (client?.plainTempPassword ? client.plainTempPassword : (client?.isTemporaryPassword ? 'Sent via Email / Set at Registration' : 'Your registered password'));

    const resolvePackageTitle = (rawService, packageId) => {
      const pkgMap = {
        'option_a': 'Option A: Professional Case Assessment (€250)',
        'option_b': 'Option B: Full Processing Package (End to End Service)',
        'option_c': 'Option C: Premium Package (End to End Service + Administrative Relocation)',
        'option_d': 'Option D: Administrative Relocation Package',
        'full_process': 'Full Processing Package (End to End Service)',
        'premium': 'Premium Package (End to End Service + Administrative Relocation)',
        'case_assessment': 'Professional Case Assessment (€250)'
      };
      if (packageId && pkgMap[packageId.toLowerCase()]) return pkgMap[packageId.toLowerCase()];
      if (rawService && pkgMap[rawService.toLowerCase()]) return pkgMap[rawService.toLowerCase()];

      const sMap = {
        'dnv': 'Digital Nomad Visa (DNV)',
        'nlv': 'Non-Lucrative Visa (NLV)',
        'golden_visa': 'Golden Visa (Property Investment)',
        'study_visa': 'Spain Study Visa',
        'tourist_visa': 'Spain Tourist Visa (Schengen)',
        'self_employed': 'Spain Self-Employed / Business Visa'
      };
      if (rawService && sMap[rawService.toLowerCase()]) return sMap[rawService.toLowerCase()];
      if (packageId && sMap[packageId.toLowerCase()]) return sMap[packageId.toLowerCase()];

      if (rawService && !rawService.startsWith('pkg_') && !rawService.startsWith('a5459021')) {
        return rawService;
      }
      return 'Spain Visa & Residency Service';
    };

    const displayService = resolvePackageTitle(serviceType || client?.serviceType || lead?.serviceType, client?.packageId);

    let credsSection = '';
    if (generatedPassword || (client && client.isTemporaryPassword)) {
      credsSection = `\n🔑 *Portal Login Credentials:*\n👤 *Username:* ${email}\n🔑 *Temp Password:* ${password}\n`;
    }

    const pdfDirectUrl = invoiceId ? `${backendUrl}/api/v1/payments/zoho-pdf/${invoiceId}.pdf` : null;

    let zohoSection = '';
    if (pdfDirectUrl) {
      zohoSection = `\n📄 *Download Tax Invoice PDF:* ${pdfDirectUrl}\n`;
    } else if (zohoInvoiceUrl) {
      zohoSection = `\n📄 *Official Tax Invoice:* ${zohoInvoiceUrl}\n`;
    }

    const messageBody = `🎉 *Payment Confirmed - AAA Business Consultancy*

Dear *${clientName}*,

Thank you! We have successfully received your payment. Here are your receipt details:

📋 *Receipt Summary:*
• 👤 *Client ID:* ${clientCode}
• 💳 *Amount Paid:* €${formattedAmount}
• 📦 *Package / Service:* ${displayService}
• 📅 *Date:* ${formattedDate}
${credsSection}${zohoSection}
🚀 *Next Steps:*
Your Client Portal is active. Log in to upload your required documents and track your application progress:
🔗 *Client Portal:* ${portalUrl}

Thank you for choosing AAA Business Consultancy! 🇪🇸`;

    const twilioTo = `whatsapp:${cleanPhone}`;
    let deliveryStatus = 'SENT';
    let failureReason = null;

    if (isConfigured) {
      try {
        const clientTwilio = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
        await clientTwilio.messages.create({
          body: messageBody,
          from: TWILIO_WHATSAPP_FROM,
          to: twilioTo
        });
        console.log(`[Payment Success WA Sent] Dispatched receipt to ${cleanPhone} for ${clientCode}`);
      } catch (err) {
        console.error(`[Payment Success WA Error] Twilio send failed to ${twilioTo}:`, err.message);
        deliveryStatus = 'FAILED';
        failureReason = err.message;
      }
    } else {
      console.log('------------------------------------------------------------');
      console.log(`[PAYMENT SUCCESS WHATSAPP DRY-RUN]`);
      console.log(`To: ${twilioTo}`);
      console.log(`Body:\n${messageBody}`);
      console.log('------------------------------------------------------------');
    }

    // Record deduplication & communication log in DB
    try {
      let validClientId = null;
      if (client?.id) {
        const checkClient = await prisma.client.findUnique({ where: { id: client.id }, select: { id: true } }).catch(() => null);
        if (checkClient) validClientId = checkClient.id;
      }

      await prisma.communicationLog.create({
        data: {
          clientId: validClientId,
          phone: cleanPhone,
          name: clientName,
          channel: 'WHATSAPP',
          direction: 'OUTBOUND',
          messageId: dedupeKey || `PAY_${Date.now()}`,
          externalProviderId: dedupeKey,
          content: messageBody,
          deliveryStatus: deliveryStatus,
          failureReason: failureReason
        }
      });
    } catch (logErr) {
      console.warn('[Payment Success WA Log Warning]:', logErr.message);
    }
  } catch (err) {
    console.error('[Payment Success WA Exception]:', err.message);
  }
};

/**
 * Sends automated Invoice & Portal Account WhatsApp message.
 */
exports.sendInvoiceWhatsApp = async ({ client, amount, discount, netAmount, serviceType, checkoutUrl, portalUrl, tempPassword, note, notes }) => {
  try {
    if (!client || !client.phone) {
      console.warn('[Invoice WhatsApp] client or client.phone is missing');
      return;
    }

    let cleanPh = String(client.phone || '').trim();
    if (cleanPh.startsWith('whatsapp:')) cleanPh = cleanPh.substring(9);
    cleanPh = cleanPh.replace(/[^\d+]/g, '');
    if (!cleanPh.startsWith('+')) cleanPh = '+' + cleanPh;

    const digitsOnly = cleanPh.replace(/[^\d]/g, '');
    const searchDigits = digitsOnly.length > 8 ? digitsOnly.slice(-8) : digitsOnly;

    // Deduplication guard: Suppress sending duplicate invoice WhatsApp within 60 seconds
    try {
      const oneMinuteAgo = new Date(Date.now() - 60 * 1000);
      const recentLog = await prisma.communicationLog.findFirst({
        where: {
          phone: { contains: searchDigits },
          createdAt: { gte: oneMinuteAgo },
          content: { contains: 'welcome to AAA Business Consultancy' }
        }
      });

      if (recentLog) {
        console.log(`[Invoice WhatsApp] Suppressed duplicate invoice notification for ${cleanPh} (already sent in last 60s).`);
        return;
      }
    } catch (dedupErr) {
      console.warn('[Invoice WhatsApp] Deduplication check warning:', dedupErr.message);
    }

    let activeTempPassword = tempPassword;
    if (!activeTempPassword && client && client.id) {
      try {
        const bcrypt = require('bcrypt');
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%';
        let plainPass = '';
        for (let i = 0; i < 8; i++) plainPass += chars.charAt(Math.floor(Math.random() * chars.length));

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(plainPass, salt);

        await prisma.client.update({
          where: { id: client.id },
          data: {
            password: hashedPassword,
            isTemporaryPassword: true
          }
        });

        activeTempPassword = plainPass;
        console.log(`[Invoice WhatsApp] Generated fresh temporary password for client ${client.id}`);
      } catch (passErr) {
        console.warn('[Invoice WhatsApp] Could not auto-generate temp password:', passErr.message);
      }
    }

    if (!activeTempPassword) {
      activeTempPassword = 'Check registered email';
    }

    const { sendCustomWhatsApp } = require('./chatbotService');
    const loginUrl = portalUrl || `${process.env.FRONTEND_URL || 'http://localhost:5173'}/#/portal/login`;
    const clientName = `${client.firstName} ${client.lastName}`.trim();

    const activeNote = (note || notes || client.notes || client.profileSummary || '').trim();
    const noteSection = activeNote ? `\n\n📝 *Note:* ${activeNote}` : '';

    const message = `Hello *${clientName}*, welcome to AAA Business Consultancy! 🇪🇸

Your Spain Relocation profile has been initialized. 🎉

🔑 *Client Portal Login Credentials:*
🔗 *Login URL:* ${loginUrl}
👤 *Username:* ${client.email}
🔑 *Temp Password:* ${activeTempPassword}

📦 *Service Packages:*
You can log in to your Client Portal using the link above to view all residency packages, select the package that best fits your needs, and complete your payment.${noteSection}

📅 *Need to book another consultation?*
Simply reply with "rebook" in this chat, and we'll send you a new meeting booking link.

Thank you for choosing AAA Business Consultancy!`;

    await sendCustomWhatsApp(client.phone, message);
    console.log(`[Invoice WhatsApp] Dispatched single clean credentials notification to ${client.phone}`);
  } catch (err) {
    console.error('[Invoice WhatsApp] Error dispatching WhatsApp notification:', err.message);
  }
};

/**
 * Sends automated Google Review invitation WhatsApp message post-consultation.
 * Enforces a 14-day phone-number-based deduplication guard using CommunicationLog.
 */
exports.sendGoogleReviewRequestWhatsApp = async ({ phone, clientName, clientId, leadId, triggerStage = 'POST_CONSULTATION' }) => {
  try {
    if (!phone) {
      console.warn('[Google Review WhatsApp] Missing phone number. Skipping.');
      return { success: false, reason: 'MISSING_PHONE' };
    }

    // Clean phone number format
    let cleanPh = String(phone || '').trim();
    if (cleanPh.startsWith('whatsapp:')) cleanPh = cleanPh.substring(9);
    cleanPh = cleanPh.replace(/[^\d+]/g, '');
    if (!cleanPh.startsWith('+')) cleanPh = '+' + cleanPh;

    if (!cleanPh || cleanPh === '+') {
      console.warn('[Google Review WhatsApp] Phone number is invalid:', phone);
      return { success: false, reason: 'INVALID_PHONE' };
    }

    // 0. Check if Client has already submitted a Google Review in DB
    let targetClientId = clientId || null;
    if (!targetClientId && leadId) {
      const lead = await prisma.lead.findUnique({
        where: { id: leadId },
        select: { clientId: true }
      });
      if (lead) targetClientId = lead.clientId;
    }

    if (targetClientId) {
      const clientRecord = await prisma.client.findUnique({
        where: { id: targetClientId },
        select: { googleReviewSubmitted: true }
      });
      if (clientRecord && clientRecord.googleReviewSubmitted) {
        console.log(`[Google Review WhatsApp] Client ${targetClientId} already submitted review. Skipping.`);
        return { success: true, skipped: true, reason: 'REVIEW_ALREADY_SUBMITTED' };
      }
    }

    // 1. Enforce Stage-Based 24-hour Deduplication Guard via CommunicationLog
    try {
      const numberPart = cleanPh.replace('+', '');
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const recentLog = await prisma.communicationLog.findFirst({
        where: {
          phone: { contains: numberPart },
          externalProviderId: { in: ['GOOGLE_REVIEW_REQUEST', 'google_review', `google_review_${triggerStage}`] },
          createdAt: { gte: oneDayAgo },
          deliveryStatus: { in: ['SENT', 'LOGGED'] }
        }
      });

      if (recentLog && (recentLog.externalProviderId === `google_review_${triggerStage}` || recentLog.externalProviderId === 'google_review')) {
        console.log(`[Google Review WhatsApp] Blocked duplicate ${triggerStage} message to ${cleanPh} (Sent ${recentLog.createdAt})`);
        return { success: true, skipped: true, reason: 'DEDUPLICATED_24H' };
      }
    } catch (dedupErr) {
      console.warn('[Google Review WhatsApp] Deduplication check warning:', dedupErr.message);
    }

    // 2. Delegate sending to sendWhatsAppMessage using registered template 'google_review'
    const targetName = clientName || 'Client';
    const result = await exports.sendWhatsAppMessage({
      to: cleanPh,
      templateName: 'google_review',
      languageCode: 'en',
      externalProviderId: `google_review_${triggerStage}`,
      nameOverride: targetName,
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: targetName }
          ]
        }
      ]
    });

    console.log(`[Google Review WhatsApp] Successfully dispatched ${triggerStage} review request template to ${cleanPh}`);
    return result;
  } catch (err) {
    console.error('[Google Review WhatsApp Error]:', err.message);
    return { success: false, error: err.message };
  }
};

/**
 * Sends an automated WhatsApp Invoice / Payment Checkout link to client.
 */
exports.sendInvoiceWhatsApp = async ({ client, amount, discount, netAmount, serviceType, checkoutUrl }) => {
  try {
    const phone = client?.phone;
    if (!phone) return;

    const { sendCustomWhatsApp } = require('./chatbotService');
    const clientName = `${client?.firstName || ''} ${client?.lastName || ''}`.trim() || 'Valued Client';
    const formattedAmount = Number(netAmount || amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const displayService = serviceType || client?.serviceType || 'Spain Visa / Relocation Service';

    const messageBody = `📄 *Invoice & Payment Request - AAA Business Consultancy*

Dear *${clientName}*,

An invoice has been generated for your application. Please find the details below:

📋 *Invoice Details:*
• 📦 *Service:* ${displayService}
• 💳 *Total Amount:* €${formattedAmount}
${checkoutUrl ? `• 🔗 *Complete Payment / View Invoice:* ${checkoutUrl}` : ''}

If you have any questions, feel free to reply directly to this message.

Best regards,
*AAA Business Consultancy Team* 🇪🇸`;

    await sendCustomWhatsApp(phone, messageBody);
  } catch (err) {
    console.error('[Invoice WA Error]:', err.message);
  }
};





