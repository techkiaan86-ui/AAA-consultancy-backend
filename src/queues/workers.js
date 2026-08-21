const { Worker } = require('bullmq');
const { connection } = require('./connection');
const { failedJobsQueue } = require('./queueSetup');
const { sendEmail } = require('../services/emailService');
const { sendWhatsAppMessage } = require('../services/whatsappService');

// Helper to handle DLQ (Dead Letter Queue) mechanism
const handleJobFailure = async (job, err) => {
  if (job.attemptsMade >= job.opts.attempts) {
    console.error(`Job ${job.id} of type ${job.name} in queue ${job.queueName} failed permanently. Moving to DLQ.`);
    await failedJobsQueue.add(`dlq-${job.queueName}-${job.name}`, {
      originalJob: job.asJSON(),
      error: err.message,
      stack: err.stack
    }, {
      jobId: `failed-${job.id}` // Prevent duplicate DLQ entries
    });
  }
};

const setupWorkers = () => {
  if (process.env.DISABLE_REDIS === 'true' || !process.env.REDIS_URL) {
    console.log('BullMQ Workers are disabled (no REDIS_URL or DISABLE_REDIS=true). Skipping worker initialization.');
    return;
  }

  // Communications Worker
  const communicationsWorker = new Worker('communications', async (job) => {
    console.log(`Processing communication job ${job.id} of type: ${job.name}`);
    const { phone, email, name, message, messageId } = job.data;
    
    // Auto-reply logic for Meta/WhatsApp Click ads or website forms
    if (job.name === 'process-meta-message' || job.name === 'process-twilio-message' || job.name === 'process-tiktok-lead' || job.name === 'process-telegram-message') {
      try {
        if (job.name === 'process-telegram-message') {
          const { chatId, name, message: msgText } = job.data;
          console.log(`[Telegram Worker] Processing message from Telegram user: ${name}`);
          
          const telegramService = require('../services/telegramService');
          const lowerText = (msgText || '').toLowerCase();
          let responseText = `Hi ${name || 'there'}! Thanks for messaging our Telegram Bot. 🇪🇸\n\nFor Spain Visa & Relocation services details, type /spain.\nFor booking a Free Eligibility Assessment, type /book.`;
          
          if (lowerText.includes('/spain') || lowerText.includes('visa')) {
            responseText = `<b>Spain Relocation Pathways</b> ✈️\n\nWe specialize in:\n• Digital Nomad Visa (DNV)\n• Non-Lucrative Visa (NLV)\n• Golden Visa (Property Investment)\n• Student & Schengen Visas\n\nReply /book to secure an intake slot with our advisors.`;
          } else if (lowerText.includes('/book') || lowerText.includes('book') || lowerText.includes('assess')) {
            responseText = `<b>Book Assessment</b> 📅\n\nPlease secure your consultation call using this link: https://aaabusinessconsultancy.com/book-assessment`;
          }
          
          await telegramService.sendTelegramMessage(chatId, responseText);
        } else if (job.name === 'process-meta-message' || job.name === 'process-twilio-message') {
          // Process inbound user message via the Chatbot
          const chatbotService = require('../services/chatbotService');
          await chatbotService.handleChatbotMessage(job.data.phone, job.data.name || 'Applicant', job.data.message || '', job.data.messageId, job.data.mediaUrl);
        } else {
          // For process-tiktok-lead (external lead form submission)
          if (phone) {
            // Send automatic first response on WhatsApp
            await sendWhatsAppMessage({
              to: phone,
              templateName: 'automated_first_response',
              languageCode: 'en',
              components: [
                {
                  type: 'body',
                  parameters: [
                    { type: 'text', text: name || 'Applicant' }
                  ]
                }
              ]
            });
          }
          
          if (email) {
            // Send automated confirmation email
            await sendEmail({
              to: email,
              subject: 'Spain Visa & Residency Services - Next Steps',
              html: `<h3>Thank you for contacting AAA Business Consultancy, ${name || 'Applicant'}!</h3>
                     <p>We received your inquiry regarding Spain Visa & Residency Services.</p>
                     <p>To book your Free Eligibility Assessment, please click the link below:</p>
                     <p><a href="https://aaabusinessconsultancy.com/book-assessment">Book Free Assessment</a></p>`
            });
          }
        }
      } catch (err) {
        console.error('Failed to process incoming communications webhook job:', err);
        throw err;
      }
    } else if (job.name === 'process-meta-comment') {
      try {
        const { commentId, senderName, message, platform } = job.data;
        console.log(`[Worker] Processing comment from ${senderName} on ${platform}: ${message}`);
        
        // Simulates checking if comment is asking for info
        const lowerMsg = (message || '').toLowerCase();
        const asksForInfo = ['visa', 'spain', 'info', 'price', 'how', 'eligible', 'help', 'cost'].some(kw => lowerMsg.includes(kw));
        
        if (asksForInfo) {
          console.log(`[Worker] Comment matching criteria for auto-reply on ${platform}. Sending simulated public reply.`);
          // In production, we call Facebook Graph API to reply:
          // await axios.post(`https://graph.facebook.com/v17.0/${commentId}/comments`, { message: ... })
          
          // Log reply simulation
          console.log(`[Auto-Reply Simulated] "Hi @${senderName}, thank you for reaching out! We've sent you a DM to get started, or you can book an assessment directly here: https://aaabusinessconsultancy.com/book-assessment"`);
        }
      } catch (err) {
        console.error('Failed to process meta comment auto-reply job:', err);
        throw err;
      }
    }
  }, { connection });

  communicationsWorker.on('failed', handleJobFailure);

  // Reminders Worker
  const remindersWorker = new Worker('reminders', async (job) => {
    console.log(`Processing reminder job ${job.id} - ${job.name}`);
    
    if (job.name === 'daily-missing-documents-check') {
      const prisma = require('../config/db');
      const { sendCustomWhatsApp } = require('../services/chatbotService');

      try {
        // Fetch all clients in "Document Preparation" status
        const clients = await prisma.client.findMany({
          where: {
            visaStatus: 'Document Preparation',
            isBlocked: false
          },
          include: {
            documents: true
          }
        });

        console.log(`[Cron Missing Docs] Scanning ${clients.length} clients in Document Preparation status.`);

        for (const client of clients) {
          const serviceTypeLower = (client.serviceType || '').toLowerCase();
          
          // Define expected document categories for this service type
          let requiredCategories = ['Passport']; // Passport is always required
          
          if (serviceTypeLower.includes('dnv') || serviceTypeLower.includes('digital nomad')) {
            requiredCategories.push('Employment Verification Letter', 'Remote Income Bank Statements', 'Social Security Certificate');
          } else if (serviceTypeLower.includes('nlv') || serviceTypeLower.includes('non-lucrative') || serviceTypeLower.includes('non lucrative')) {
            requiredCategories.push('Spanish Health Insurance Policy', 'Clean Criminal Record Certificate', 'Savings Bank Statements');
          } else if (serviceTypeLower.includes('study') || serviceTypeLower.includes('student')) {
            requiredCategories.push('Complutense Admission Letter', 'Medical Certificate', 'Sufficient Funds Guarantee');
          } else if (serviceTypeLower.includes('property') || serviceTypeLower.includes('golden') || serviceTypeLower.includes('investment')) {
            requiredCategories.push('Property Purchase Escrow Registry', 'Spanish Bank Account Certificate');
          }

          // Map client's uploaded documents categories
          const uploadedCategories = client.documents.map(d => d.category);

          // Find missing categories
          const missing = requiredCategories.filter(reqCat => {
            // Check if any uploaded document matches this category
            return !uploadedCategories.some(upCat => upCat.toLowerCase().includes(reqCat.toLowerCase()) || reqCat.toLowerCase().includes(upCat.toLowerCase()));
          });

          if (missing.length > 0) {
            const clientName = `${client.firstName} ${client.lastName}`;
            const portalUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/#/portal/documents/${client.id}`;
            const missingListText = missing.map(m => `- ${m}`).join('\n');
            const missingListHtml = missing.map(m => `<li>${m}</li>`).join('');

            // Send WhatsApp reminder
            const waMsg = `Hello *${clientName}*,\n\nThis is a friendly reminder from AAA Business Consultancy. We notice you have pending documents required to proceed with your Spain ${client.serviceType || 'Visa'} application:\n\n${missingListText}\n\nPlease upload them directly to your client portal to avoid processing delays:\n🔗 ${portalUrl}`;
            await sendCustomWhatsApp(client.phone, waMsg).catch(err => console.error(`[Cron Missing Docs] WA failed for client ${client.id}:`, err.message));

            // Send Email reminder
            await sendEmail({
              to: client.email,
              subject: `⚠️ Action Required: Missing Documents for Spain ${client.serviceType || 'Visa'} Application`,
              html: `
                <h3>Hello ${client.firstName},</h3>
                <p>We are reviewing your residency file and noticed that you have outstanding required documents:</p>
                <ul>
                  ${missingListHtml}
                </ul>
                <p>Please upload these files securely via your Client Portal to proceed with processing:</p>
                <p><a href="${portalUrl}" style="background-color: #dc3545; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block; font-weight: bold;">Upload Missing Documents</a></p>
                <p>Thank you!</p>
              `
            }).catch(err => console.error(`[Cron Missing Docs] Email failed for client ${client.id}:`, err.message));

            console.log(`[Cron Missing Docs] Sent reminder to client ${client.email} for ${missing.length} missing files.`);
          }
        }
      } catch (cronErr) {
        console.error('[Cron Missing Docs] Error scanning clients for missing documents:', cronErr.message);
        throw cronErr;
      }
      return;
    }

    if (job.name === 'cancelled-rebook-reminder') {
      const { leadId, email, phone, firstName, lastName } = job.data;
      const prisma = require('../config/db');
      
      try {
        const lead = await prisma.lead.findUnique({
          where: { id: leadId }
        });
        
        if (lead && lead.status === 'Cancelled') {
          const clientName = `${lead.firstName} ${lead.lastName}`;
          const rebookLink = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/#/public/lead-form?id=${lead.id}&rebook=true`;
          
          // Send 24h follow-up WhatsApp reminder
          const { sendCustomWhatsApp } = require('../services/chatbotService');
          const reminderMsg = `Hello *${clientName}*,\n\nThis is a friendly reminder to reschedule your Spain Visa free consultation. Choose your preferred date and time slot using the link below:\n\n🔗 ${rebookLink}`;
          await sendCustomWhatsApp(lead.phone, reminderMsg).catch(err => console.error('[BG-WA] Rebook reminder WA failed:', err.message));
          
          // Send 24h follow-up Email reminder
          await sendEmail({
            to: lead.email,
            subject: 'Spain Visa Consultation Reminder: Choose Your Slot',
            html: `
              <h3>Reschedule Your Free Consultation</h3>
              <p>Dear ${lead.firstName},</p>
              <p>We noticed you haven't rescheduled your Spain Visa consultation yet.</p>
              <p>You can choose your preferred date and time slot using the link below:</p>
              <p><a href="${rebookLink}" style="background-color: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">Choose Date & Time Slot</a></p>
              <p>Thank you!</p>
            `
          }).catch(err => console.error('[BG-Email] Rebook reminder email failed:', err.message));
          console.log(`[Auto-Cancel-Reminder] Sent 24h rebook reminder to ${lead.email}`);
        } else {
          console.log(`[Auto-Cancel-Reminder] Lead status is no longer Cancelled (current: ${lead?.status}). Skipping reminder.`);
        }
      } catch (err) {
        console.error(`[Auto-Cancel-Reminder] Failed to process cancel reminder for lead ${leadId}:`, err.message);
        throw err;
      }
      return;
    }

    if (job.name === 'consultation-completed-drip') {
      const { leadId, clientId, email, phone, firstName, lastName, dripIndex } = job.data;
      const prisma = require('../config/db');

      try {
        const lead = await prisma.lead.findUnique({
          where: { id: leadId },
          include: { client: { include: { payments: true } } }
        });

        if (!lead) {
          console.warn(`[Completed-Drip] Lead not found: ${leadId}`);
          return;
        }

        // Check if there is any paid payment under this lead's client
        const hasPaid = lead.client && lead.client.payments.some(p => p.status === 'Paid');
        if (hasPaid) {
          console.log(`[Completed-Drip] Client ${lead.email} has already made a payment. Skipping drip.`);
          return;
        }

        const clientName = `${lead.firstName} ${lead.lastName}`;
        const checkoutLink = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/#/portal/documents/${lead.clientId || ''}`;
        const { sendCustomWhatsApp } = require('../services/chatbotService');

        if (dripIndex === 2) {
          // 3-day follow-up
          const msg = `Hello *${clientName}*,\n\nWe noticed you haven't selected your Spain Visa package yet. Choose one of our packages or start with Option A: Professional Case Assessment for €250 to review your file in detail. Your assessment fee is 100% deductible within 14 days!\n\n🔗 ${checkoutLink}`;
          await sendCustomWhatsApp(lead.phone, msg).catch(err => console.error('[BG-WA] Completed Drip 2 failed:', err.message));
          
          await sendEmail({
            to: lead.email,
            subject: 'Spain Visa: Still Thinking? Secure Your Professional Case Assessment!',
            html: `<h3>Resettle in Spain</h3>
                   <p>Dear ${lead.firstName},</p>
                   <p>We noticed you haven't selected your Spain Visa package yet.</p>
                   <p>Choose one of our packages or start with <strong>Option A: Professional Case Assessment for €250</strong> to review your file in detail.</p>
                   <p>Your assessment fee is 100% deductible if you choose a package within 14 days.</p>
                   <p><a href="${checkoutLink}" style="background-color: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">Get Started Now</a></p>`
          }).catch(err => console.error('[BG-Email] Completed Drip 2 email failed:', err.message));
          console.log(`[Completed-Drip] Sent 3-day follow-up to ${lead.email}`);
        } else if (dripIndex === 3) {
          // 7-day follow-up
          const msg = `Hello *${clientName}*,\n\nIt has been 1 week since your consultation call! 🇪🇸\n\nResidency application slots are limited for this month. Secure your relocation pathway and start document checks now:\n\n🔗 ${checkoutLink}`;
          await sendCustomWhatsApp(lead.phone, msg).catch(err => console.error('[BG-WA] Completed Drip 3 failed:', err.message));
          
          await sendEmail({
            to: lead.email,
            subject: 'Final Reminder: Resettle in Spain with AAA Business Consultancy!',
            html: `<h3>Spain Visa Call Review</h3>
                   <p>Dear ${lead.firstName},</p>
                   <p>It has been 1 week since your consultation call. Relocation slots are limited for this month's intake.</p>
                   <p>Select your package and start your document review process now:</p>
                   <p><a href="${checkoutLink}" style="background-color: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">Secure Your Relocation Slot</a></p>`
          }).catch(err => console.error('[BG-Email] Completed Drip 3 email failed:', err.message));
          console.log(`[Completed-Drip] Sent 7-day final follow-up to ${lead.email}`);
        }
      } catch (err) {
        console.error(`[Completed-Drip] Error in completed drip processing for lead ${leadId}:`, err.message);
        throw err;
      }
      return;
    }

    if (job.name === 'paid-assessment-upgrade-drip') {
      const { clientId, dripIndex } = job.data;
      const prisma = require('../config/db');

      try {
        const client = await prisma.client.findUnique({
          where: { id: clientId }
        });

        if (!client) {
          console.warn(`[Upgrade-Drip] Client not found: ${clientId}`);
          return;
        }

        // If client already selected a package, skip upgrade drip
        if (client.packageId && ['full_process', 'premium', 'relocation'].includes(client.packageId.toLowerCase())) {
          console.log(`[Upgrade-Drip] Client ${client.email} has already purchased package ${client.packageId}. Skipping drip.`);
          return;
        }

        const clientName = `${client.firstName} ${client.lastName}`;
        const checkoutLink = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/#/portal/documents/${client.id}`;
        const { sendCustomWhatsApp } = require('../services/chatbotService');

        let msg = '';
        let subject = '';
        let html = '';

        if (dripIndex === 1) {
          msg = `Hello *${clientName}*,\n\nWe hope you liked your Case Review session! 🇪🇸\n\nGet started with your visa application by selecting a full package (Option B, C, or D). Your *€250* credit will be automatically applied at checkout!\n\n🔗 ${checkoutLink}`;
          subject = 'How was your Case Review session? Upgrade and save €250!';
          html = `<h3>Case Review Follow-up</h3><p>Hi ${client.firstName},</p><p>Get started with your visa application by selecting Option B, C, or D. Your €250 credit will be automatically applied at checkout.</p><p><a href="${checkoutLink}">Upgrade Package Now</a></p>`;
        } else if (dripIndex === 2) {
          msg = `Hello *${clientName}*,\n\nIt's been a week since your case review. Spain visa applications are time-sensitive. Upgrade now and get your *€250* assessment fee deducted automatically:\n\n🔗 ${checkoutLink}`;
          subject = 'Spain Visa: Time-sensitive application update';
          html = `<h3>Spain Visa Processing</h3><p>Hi ${client.firstName},</p><p>Residency applications are time-sensitive. Upgrade now and get your €250 credit deducted automatically.</p><p><a href="${checkoutLink}">Resettle in Spain</a></p>`;
        } else if (dripIndex === 3) {
          msg = `Hello *${clientName}*,\n\nUpgrade your case evaluation to a full Spanish residency package. Only *4 days* left to redeem your €250 credit!\n\n🔗 ${checkoutLink}`;
          subject = 'Only 4 days left to redeem your €250 credit!';
          html = `<h3>Deduction Expiry Alert</h3><p>Hi ${client.firstName},</p><p>You only have 4 days left to redeem your €250 assessment credit towards a full visa package.</p><p><a href="${checkoutLink}">Upgrade Today</a></p>`;
        } else if (dripIndex === 4) {
          msg = `Hello *${clientName}*,\n\n⚠️ Today is your *LAST* day to redeem your €250 assessment credit! Upgrade today to avoid losing your credit:\n\n🔗 ${checkoutLink}`;
          subject = 'Last Call: €250 Credit Expiry Today!';
          html = `<h3>⚠️ Credit Expiring Today</h3><p>Hi ${client.firstName},</p><p>Today is your final day to adjust your €250 assessment fee on full packages. Upgrade today before it expires.</p><p><a href="${checkoutLink}">Redeem €250 Credit Now</a></p>`;
        }

        if (msg) {
          await sendCustomWhatsApp(client.phone, msg).catch(err => console.error(`[BG-WA] Upgrade Drip ${dripIndex} failed:`, err.message));
          await sendEmail({ to: client.email, subject, html }).catch(err => console.error(`[BG-Email] Upgrade Drip ${dripIndex} failed:`, err.message));
          console.log(`[Upgrade-Drip] Sent upgrade drip ${dripIndex} to ${client.email}`);
        }
      } catch (err) {
        console.error(`[Upgrade-Drip] Error in upgrade drip processing for client ${clientId}:`, err.message);
        throw err;
      }
      return;
    }

    if (job.name === 'google-review-request-drip') {
      const { clientId, leadId, phone, clientName, dripIndex = 2 } = job.data;
      const prisma = require('../config/db');

      try {
        let targetPhone = phone;
        let targetName = clientName;
        let targetEmail = null;

        if (clientId) {
          const client = await prisma.client.findUnique({ where: { id: clientId } });
          if (client) {
            if (client.googleReviewSubmitted) {
              console.log(`[Google-Review-Drip] Client ${client.email} already submitted Google review. Skipping.`);
              return;
            }
            targetPhone = targetPhone || client.phone;
            targetName = targetName || `${client.firstName} ${client.lastName}`.trim();
            targetEmail = client.email;
          }
        } else if (leadId) {
          const lead = await prisma.lead.findUnique({ where: { id: leadId } });
          if (lead) {
            targetPhone = targetPhone || lead.phone;
            targetName = targetName || `${lead.firstName} ${lead.lastName}`.trim();
            targetEmail = lead.email;
          }
        }

        if (!targetPhone) {
          console.warn(`[Google-Review-Drip] Missing phone number for job ${job.id}. Skipping.`);
          return;
        }

        const { sendGoogleReviewRequestWhatsApp } = require('../services/whatsappService');

        await sendGoogleReviewRequestWhatsApp({
          phone: targetPhone,
          clientName: targetName,
          clientId,
          leadId,
          triggerStage: 'POST_PAYMENT_3D'
        });

        if (targetEmail) {
          await sendEmail({
            to: targetEmail,
            subject: 'Share Your Experience with AAA Business Consultancy!',
            html: `<h3>Share Your Feedback</h3>
                   <p>Dear ${targetName || 'Client'},</p>
                   <p>Thank you for choosing AAA Business Consultancy for your Spain Relocation path.</p>
                   <p>Please take 1 minute to share your experience by leaving us a Google review here:</p>
                   <p><a href="https://g.page/r/CXugL6bqOJCXEAI/review" style="background-color: #ffc107; color: black; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block; font-weight: bold;">Leave a Google Review</a></p>`
          }).catch(err => console.error('[BG-Email] Google review email failed:', err.message));
        }
      } catch (err) {
        console.error(`[Google-Review-Drip] Error in Google review drip processing:`, err.message);
        throw err;
      }
      return;
    }

    const { toEmail, toPhone, subject, emailHtml, whatsappTemplate, whatsappComponents } = job.data;

    try {
      if (toEmail && emailHtml) {
        await sendEmail({
          to: toEmail,
          subject: subject || 'Spain Visa Consultation Reminder',
          html: emailHtml
        });
      }

      if (toPhone && whatsappTemplate) {
        await sendWhatsAppMessage({
          to: toPhone,
          templateName: whatsappTemplate,
          components: whatsappComponents || []
        });
      }
    } catch (err) {
      console.error(`Failed to process reminder job ${job.id}:`, err);
      throw err;
    }
  }, { connection });

  remindersWorker.on('failed', handleJobFailure);

  // No-Show Enforcer Worker
  const noShowEnforcerWorker = new Worker('no-show-enforcer', async (job) => {
    console.log(`Processing no-show-enforcer job ${job.id} - Messaging disabled by admin setting.`);
  }, { connection });

  noShowEnforcerWorker.on('failed', handleJobFailure);

  // Payment Drip Worker
  const paymentDripWorker = new Worker('payment-drip', async (job) => {
    console.log(`Processing payment-drip job ${job.id} - ${job.name}`);
    const { email, phone, name, invoiceId, amount, discountOffer } = job.data;

    try {
      let subject = 'Invoice Payment Pending';
      let html = `<p>Hi ${name || 'Client'},</p><p>This is a reminder that payment of €${amount} is pending for Invoice #${invoiceId}.</p>`;
      
      if (discountOffer) {
        subject = 'Special 24-Hour Discount Offer from CEO';
        html = `<h3>Special 24h Offer</h3>
                <p>Hello ${name},</p>
                <p>Use discount code <strong>CEO24H</strong> to complete your payment for Invoice #${invoiceId} with a special discount!</p>
                <p>Valid for 24 hours only.</p>`;
      }

      if (email) {
        await sendEmail({ to: email, subject, html });
      }

      if (phone) {
        await sendWhatsAppMessage({
          to: phone,
          templateName: discountOffer ? 'payment_drip_discount' : 'payment_pending_reminder',
          components: [
            {
              type: 'body',
              parameters: [
                { type: 'text', text: name || 'Client' },
                { type: 'text', text: invoiceId }
              ]
            }
          ]
        });
      }
    } catch (err) {
      console.error(`Failed to process payment drip reminder for job ${job.id}:`, err);
      throw err;
    }
  }, { connection });

  paymentDripWorker.on('failed', handleJobFailure);

  console.log('BullMQ Workers initialized');
};

module.exports = { setupWorkers };
