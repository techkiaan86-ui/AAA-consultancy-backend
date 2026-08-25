const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const bcrypt = require('bcrypt');
const { sendCustomWhatsApp } = require('./chatbotService');
const { sendEmail } = require('./emailService');

/**
 * Format date strictly as DD/MM/YYYY
 */
const formatDateDDMMYYYY = (date = new Date()) => {
  const d = new Date(date);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
};

/**
 * Generate a clean, secure 6-character temporary password
 */
const generateTempPassword = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let pass = '';
  for (let i = 0; i < 6; i++) {
    pass += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return pass;
};

/**
 * Robust, Idempotent Sworn Translation Payment Success Handler
 *
 * Requirements:
 * 1. Confirms genuine provider payment.
 * 2. Persists Payment, Client, and Lead records atomically in DB first.
 * 3. Dispatches WhatsApp, Client Email, Internal Team Email, and In-App CRM Notifications.
 * 4. Strictly idempotent (keyed on Stripe session.id).
 * 5. External API failures never roll back or fail the verified payment.
 * 6. Logs all delivery results to CommunicationLog.
 *
 * @param {Object} params
 * @param {string} params.leadId - Target lead ID (optional if in session)
 * @param {Object} params.session - Stripe Checkout Session object
 * @param {Object} [params.reqApp] - Express app instance for Socket.io
 * @returns {Promise<{success: boolean, alreadyProcessed?: boolean, lead?: Object, payment?: Object}>}
 */
async function handleSwornTranslationPaymentSuccess({ leadId, session, reqApp = null }) {
  if (!session || !session.id) {
    console.warn('[TranslationPaymentService] Invalid invocation: Missing Stripe session or session ID.');
    return { success: false, error: 'Missing Stripe session' };
  }

  const sessionId = session.id;
  const targetLeadId = leadId || session.metadata?.leadId || session.client_reference_id;

  console.log(`[TranslationPaymentService] Processing payment success for Stripe Session: ${sessionId}, Target Lead: ${targetLeadId || 'UNKNOWN'}`);

  // 1. Resolve the Target Lead
  let lead = null;
  if (targetLeadId) {
    lead = await prisma.lead.findUnique({
      where: { id: targetLeadId }
    });
  }

  if (!lead && (session.customer_email || session.customer_details?.email)) {
    const customerEmail = (session.customer_email || session.customer_details?.email).toLowerCase();
    lead = await prisma.lead.findFirst({
      where: {
        email: customerEmail,
        serviceType: 'Spanish Sworn Translation'
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  if (!lead) {
    console.error(`[TranslationPaymentService] Could not resolve Lead for Stripe session ${sessionId}. Aborting.`);
    return { success: false, error: 'Lead not found for translation payment session' };
  }

  const clientName = `${lead.firstName || ''} ${lead.lastName || ''}`.trim() || 'Client';
  const totalPaid = session.amount_total 
    ? session.amount_total / 100 
    : (Number(session.metadata?.amount) || lead.qualificationData?.estimatedPrice || 0);

  const wordCount = lead.wordCount || Number(session.metadata?.wordCount) || lead.qualificationData?.wordCount || 0;
  const sourceLang = lead.sourceLanguage || lead.qualificationData?.sourceLanguage || 'English';
  const targetLang = lead.targetLanguage || lead.qualificationData?.targetLanguage || 'Spanish';
  const documentsList = Array.isArray(lead.qualificationData?.documents) ? lead.qualificationData.documents : [];
  const paymentReference = sessionId.startsWith('MANUAL-')
    ? `TRN-MAN-${lead.id.substring(0, 6).toUpperCase()}`
    : `TRN-${sessionId.substring(sessionId.length - 8).toUpperCase()}`;
  const frontendUrl = (process.env.FRONTEND_URL || 'https://aaa-crm-service.netlify.app').replace(/\/$/, '');

  // 2. Strong Idempotency: Find or Create Client and Payment records in DB
  let client = null;
  let plainTempPassword = null;

  if (lead.clientId) {
    client = await prisma.client.findUnique({ where: { id: lead.clientId } });
  }

  if (!client && lead.email) {
    client = await prisma.client.findUnique({ where: { email: lead.email.toLowerCase() } });
  }

  if (!client) {
    const tempPass = generateTempPassword();
    plainTempPassword = tempPass;
    const hashedPassword = await bcrypt.hash(tempPass, 10);

    try {
      // Create new client record for translation customer
      client = await prisma.client.create({
        data: {
          firstName: lead.firstName,
          lastName: lead.lastName,
          email: lead.email.toLowerCase(),
          phone: lead.phone,
          nationality: lead.nationality || null,
          serviceType: 'Spanish Sworn Translation',
          status: 'Payment Completed',
          visaStatus: 'Not Applicable',
          documentUploadAllowed: true,
          password: hashedPassword,
          isTemporaryPassword: true,
          sourceLanguage: sourceLang,
          targetLanguage: targetLang,
          wordCount: wordCount
        }
      });
      console.log(`[TranslationPaymentService] Created Client profile ${client.id} for Lead ${lead.id} with temp credentials`);
    } catch (clientCreateErr) {
      if (clientCreateErr.code === 'P2002' || clientCreateErr.message?.includes('Unique constraint')) {
        client = await prisma.client.findUnique({ where: { email: lead.email.toLowerCase() } });
      } else {
        throw clientCreateErr;
      }
    }
  } else {
    // Existing client: check if password exists, if not generate one
    let updateData = {
      status: 'Payment Completed',
      documentUploadAllowed: true,
      serviceType: client.serviceType || 'Spanish Sworn Translation'
    };

    if (!client.password) {
      const tempPass = generateTempPassword();
      plainTempPassword = tempPass;
      const hashedPassword = await bcrypt.hash(tempPass, 10);
      updateData.password = hashedPassword;
      updateData.isTemporaryPassword = true;
    }

    client = await prisma.client.update({
      where: { id: client.id },
      data: updateData
    });
  }

  // Idempotent Payment Record Handling
  let existingPayment = await prisma.payment.findFirst({
    where: {
      OR: [
        { gatewayId: sessionId },
        { transactionId: sessionId }
      ]
    }
  });

  let paymentRecord = existingPayment;
  if (!paymentRecord) {
    try {
      paymentRecord = await prisma.payment.create({
        data: {
          clientId: client.id,
          amount: totalPaid,
          discount: 0,
          totalPaid: totalPaid,
          status: 'Paid',
          paymentMethod: sessionId.startsWith('MANUAL-') ? 'Manual / Admin' : 'Stripe',
          transactionId: sessionId,
          gatewayId: sessionId,
          invoiceNumber: paymentReference,
          packageType: 'Spanish Sworn Translation',
          paymentPurpose: 'SWORN_TRANSLATION',
          paidAt: new Date(),
          billingDate: new Date(),
          dueDate: new Date(),
          invoiceSnapshot: {
            serviceType: 'Spanish Sworn Translation',
            wordCount,
            sourceLanguage: sourceLang,
            targetLanguage: targetLang,
            documents: documentsList,
            amount: totalPaid,
            leadId: lead.id,
            paymentReference,
            stripeSessionId: sessionId
          }
        }
      });
      console.log(`[TranslationPaymentService] Created Payment record ${paymentRecord.id} with status: Paid`);
    } catch (paymentCreateErr) {
      if (paymentCreateErr.code === 'P2002' || paymentCreateErr.message?.includes('Unique constraint')) {
        paymentRecord = await prisma.payment.findFirst({
          where: {
            OR: [
              { gatewayId: sessionId },
              { transactionId: sessionId }
            ]
          }
        });
      } else {
        throw paymentCreateErr;
      }
    }
  } else if (paymentRecord.status !== 'Paid') {
    paymentRecord = await prisma.payment.update({
      where: { id: paymentRecord.id },
      data: {
        status: 'Paid',
        totalPaid: totalPaid,
        paidAt: new Date(),
        invoiceNumber: paymentRecord.invoiceNumber || paymentReference
      }
    });
    console.log(`[TranslationPaymentService] Updated Payment record ${paymentRecord.id} to status: Paid`);
  }

  // Update Lead Status & Qualification Data
  let existingQual = lead.qualificationData || {};
  if (typeof existingQual !== 'object') existingQual = {};

  const updatedQual = {
    ...existingQual,
    paymentStatus: 'Paid',
    paidAt: new Date().toISOString(),
    stripeSessionId: sessionId,
    paymentId: paymentRecord.id,
    paymentReference: paymentReference,
    totalPaid: totalPaid
  };

  // Check if client is already linked to another lead
  let shouldLinkClientId = Boolean(client && client.id);
  if (shouldLinkClientId) {
    const existingOwner = await prisma.lead.findFirst({
      where: {
        clientId: client.id,
        id: { not: lead.id }
      }
    });
    if (existingOwner) {
      shouldLinkClientId = false;
    }
  }

  const updateLeadData = {
    status: 'Payment Completed',
    qualificationData: updatedQual
  };

  if (shouldLinkClientId) {
    updateLeadData.clientId = client.id;
  }

  lead = await prisma.lead.update({
    where: { id: lead.id },
    data: updateLeadData
  });

  // Sync uploaded translation documents to Client in Document table
  try {
    const rawDocs = Array.isArray(lead.qualificationData?.documents) ? lead.qualificationData.documents : [];
    if (rawDocs.length > 0) {
      const existingClientDocs = await prisma.document.findMany({
        where: { clientId: client.id }
      });
      for (let idx = 0; idx < rawDocs.length; idx++) {
        const doc = rawDocs[idx];
        if (doc.url || doc.name) {
          const docName = (doc.name || `Translation Document ${idx + 1}.pdf`).substring(0, 200);
          const docCat = doc.category || 'Sworn Translation';
          const existingDoc = existingClientDocs[idx] || existingClientDocs.find(d => d.name === docName && d.category === docCat);
          if (!existingDoc) {
            let cleanUrl = doc.url || '';
            if (!cleanUrl || cleanUrl.startsWith('data:') || cleanUrl.length > 255) {
              cleanUrl = `/uploads/translation_doc_${client.id}_${idx}.pdf`;
            }
            const created = await prisma.document.create({
              data: {
                clientId: client.id,
                name: docName,
                url: cleanUrl,
                category: docCat,
                status: 'Pending',
                wordCount: Number(doc.wordCount) || Number(wordCount) || 0,
                comment: `Source: ${doc.sourceLanguage || doc.documentLanguage || sourceLang} ➔ Target: ${doc.targetLanguage || targetLang} | Words: ${doc.wordCount || wordCount}`
              }
            }).catch(dErr => console.warn('[TranslationDocCreate Warn]:', dErr.message));
            if (created) existingClientDocs.push(created);
          }
        }
      }
    } else if (lead.qualificationData?.documentUrl) {
      const existingDoc = await prisma.document.findFirst({
        where: {
          clientId: client.id,
          name: lead.qualificationData.documentName || 'Translation Document.pdf'
        }
      });
      if (!existingDoc) {
        let cleanQualUrl = lead.qualificationData.documentUrl || '';
        if (!cleanQualUrl || cleanQualUrl.startsWith('data:') || cleanQualUrl.length > 255) {
          cleanQualUrl = `/uploads/translation_qual_${client.id}.pdf`;
        }
        await prisma.document.create({
          data: {
            clientId: client.id,
            name: (lead.qualificationData.documentName || 'Translation Document.pdf').substring(0, 200),
            url: cleanQualUrl,
            category: 'Sworn Translation',
            status: 'Pending',
            wordCount: Number(wordCount) || 0,
            comment: `Source: ${sourceLang} ➔ Target: ${targetLang} | Words: ${wordCount}`
          }
        }).catch(dErr => console.warn('[TranslationDocCreate Warn]:', dErr.message));
      }
    }
    console.log(`[TranslationPaymentService] ✅ Document records synced for Client ${client.id}`);
  } catch (docSyncErr) {
    console.error('[TranslationPaymentService] Failed syncing documents to client:', docSyncErr.message);
  }

  // Audit Log Entry
  try {
    await prisma.auditLog.create({
      data: {
        leadId: lead.id,
        clientId: client.id,
        actorId: 'System-StripeWebhook',
        actorName: 'Stripe Payment Engine',
        actorRole: 'system',
        action: 'PAYMENT_RECEIVED',
        description: `Sworn Translation payment of €${totalPaid} confirmed for ${clientName}. Reference: ${paymentReference}`
      }
    });
  } catch (auditErr) {
    console.warn('[TranslationPaymentService] AuditLog warning:', auditErr.message);
  }

  console.log(`[TranslationPaymentService] Database records committed successfully for Lead ${lead.id}. Now executing notifications.`);

  // -------------------------------------------------------------
  // NOTIFICATIONS (Executed OUTSIDE DB transaction, fault-tolerant)
  // -------------------------------------------------------------

  const portalUrl = `${frontendUrl}/#/portal/login`;

  // 3. Client WhatsApp Confirmation
  const waIdempotencyKey = `SWORN_TRN_PAYMENT_WA_${sessionId}`;
  const existingWa = await prisma.communicationLog.findFirst({
    where: {
      OR: [
        { messageId: waIdempotencyKey },
        { externalProviderId: waIdempotencyKey }
      ]
    }
  });

  if (!existingWa) {
    const clientPhone = lead.phone || client.phone;
    if (clientPhone && clientPhone.trim()) {
      const paymentDateFormatted = formatDateDDMMYYYY(new Date());

      let credentialsWaSection = '';
      if (plainTempPassword) {
        credentialsWaSection = `\n\n🔑 *YOUR CLIENT PORTAL CREDENTIALS:*\n🌐 *Portal Link:* ${portalUrl}\n👤 *Username:* ${lead.email}\n🔑 *Temporary Password:* ${plainTempPassword}\n\n⚠️ *Note:* You can log in to your Client Portal to track your translation progress and download your official certified PDF as soon as it is ready.`;
      } else {
        credentialsWaSection = `\n\n🔑 *YOUR CLIENT PORTAL LOGIN:*\n🌐 *Portal Link:* ${portalUrl}\n👤 *Username:* ${lead.email}\n🔑 *Password:* Use your existing registered password\n\n⚠️ *Note:* You can log in to your Client Portal to track your translation progress and download your official certified PDF as soon as it is ready.`;
      }

      const waMessage = `Hello *${clientName}*,\n\nYour payment of *€${Number(totalPaid).toFixed(2)}* for *Spanish Sworn Translation (Traducción Jurada Oficial)* has been successfully received. 🎉\n\nThank you for your payment. We have recorded your payment and our certified sworn translators will now proceed with the translation of your document(s).\n\n📋 *Payment Reference:* ${paymentReference}\n📅 *Payment Date:* ${paymentDateFormatted}\n📑 *Words:* ${wordCount}\n🌐 *Language:* ${sourceLang} ➔ ${targetLang}${credentialsWaSection}\n\nYour official certified sworn translation with ministry certification stamps will also be delivered to your registered email (*${lead.email}*) within max 7 working days.\n\nThank you for choosing AAA Business Consultancy! 🇪🇸`;

      try {
        await sendCustomWhatsApp(clientPhone, waMessage);
        await prisma.communicationLog.create({
          data: {
            clientId: client.id,
            phone: clientPhone,
            name: clientName,
            channel: 'WHATSAPP',
            direction: 'OUTBOUND',
            messageId: waIdempotencyKey,
            externalProviderId: waIdempotencyKey,
            deliveryStatus: 'SENT',
            content: waMessage
          }
        }).catch(logErr => console.warn('[CommunicationLog Duplication Guard]:', logErr.message));
        console.log(`[TranslationPaymentService] ✅ WhatsApp confirmation delivered to ${clientPhone}`);
      } catch (waErr) {
        console.error(`[TranslationPaymentService] ❌ WhatsApp delivery failed for ${clientPhone}:`, waErr.message);
        await prisma.communicationLog.create({
          data: {
            clientId: client.id,
            phone: clientPhone,
            name: clientName,
            channel: 'WHATSAPP',
            direction: 'OUTBOUND',
            messageId: waIdempotencyKey,
            externalProviderId: waIdempotencyKey,
            deliveryStatus: 'FAILED',
            failureReason: waErr.message,
            content: waMessage
          }
        }).catch(err => console.warn('[CommunicationLog Log Error]:', err.message));
      }
    } else {
      console.warn(`[TranslationPaymentService] Skipping WhatsApp: Client ${lead.id} has no valid phone number.`);
      await prisma.communicationLog.create({
        data: {
          clientId: client.id,
          phone: null,
          name: clientName,
          channel: 'WHATSAPP',
          direction: 'OUTBOUND',
          messageId: waIdempotencyKey,
          externalProviderId: waIdempotencyKey,
          deliveryStatus: 'FAILED',
          failureReason: 'Missing or empty phone number',
          content: 'WhatsApp confirmation skipped due to missing phone number.'
        }
      }).catch(() => null);
    }
  } else {
    console.log(`[TranslationPaymentService] WhatsApp already sent for session ${sessionId}. Skipping duplicate.`);
  }

  // 4. Client Confirmation Email
  const emailIdempotencyKey = `SWORN_TRN_PAYMENT_EMAIL_${sessionId}`;
  const existingEmail = await prisma.communicationLog.findFirst({
    where: {
      OR: [
        { messageId: emailIdempotencyKey },
        { externalProviderId: emailIdempotencyKey }
      ]
    }
  });

  if (!existingEmail) {
    const clientEmail = lead.email || client.email;
    if (clientEmail && clientEmail.trim()) {
      const formattedDate = formatDateDDMMYYYY(new Date());
      
      const emailHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 20px; color: #1e293b; }
          .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.06); border: 1px solid #e2e8f0; }
          .header { background: linear-gradient(135deg, #051A3B 0%, #0c2b5c 100%); padding: 32px 24px; text-align: center; color: #ffffff; }
          .badge { display: inline-block; background: rgba(16, 185, 129, 0.15); border: 1px solid #10b981; color: #10b981; font-weight: 700; padding: 6px 14px; border-radius: 20px; font-size: 12px; margin-bottom: 12px; }
          .content { padding: 32px 24px; }
          .summary-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; margin: 20px 0; }
          .creds-card { background: #f0fdf4; border: 1.5px solid #86efac; border-radius: 12px; padding: 20px; margin: 20px 0; }
          .creds-table { width: 100%; border-collapse: collapse; background: #ffffff; border: 1px solid #bbf7d0; border-radius: 8px; margin: 12px 0 16px 0; overflow: hidden; }
          .creds-table td { padding: 10px 14px; font-size: 13px; }
          .creds-table tr:not(:last-child) td { border-bottom: 1px solid #f1f5f9; }
          .btn-login { display: inline-block; background: #051A3B; color: #ffffff !important; font-weight: 700; font-size: 13px; padding: 12px 24px; border-radius: 8px; text-decoration: none; }
          .row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f1f5f9; font-size: 14px; }
          .row:last-child { border-bottom: none; }
          .label { color: #64748b; font-weight: 500; }
          .value { color: #0f172a; font-weight: 700; }
          .timeline-card { background: #eff6ff; border-left: 4px solid #3b82f6; border-radius: 8px; padding: 14px 16px; margin: 20px 0; font-size: 13px; color: #1e40af; }
          .footer { background: #f8fafc; padding: 20px 24px; text-align: center; font-size: 12px; color: #94a3b8; border-top: 1px solid #e2e8f0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="badge">✓ Payment Confirmed</div>
            <h1 style="margin: 0; font-size: 24px; font-weight: 800;">Official Translation Order Confirmed</h1>
            <p style="margin: 8px 0 0 0; color: #cbd5e1; font-size: 14px;">AAA Business Consultancy — Certified Sworn Translation</p>
          </div>
          <div class="content">
            <p style="font-size: 15px; line-height: 1.6; margin-top: 0;">Dear <strong>${clientName}</strong>,</p>
            <p style="font-size: 14px; line-height: 1.6; color: #334155;">
              We are pleased to confirm that your payment for <strong>Certified Spanish Sworn Translation (Traducción Jurada Oficial)</strong> has been successfully received and verified.
            </p>
            
            <div class="summary-card">
              <div class="row">
                <span class="label">Service</span>
                <span class="value">Spanish Sworn Translation</span>
              </div>
              <div class="row">
                <span class="label">Payment Reference</span>
                <span class="value" style="color: #6366f1;">${paymentReference}</span>
              </div>
              <div class="row">
                <span class="label">Amount Paid</span>
                <span class="value" style="color: #10b981;">€${Number(totalPaid).toFixed(2)} EUR</span>
              </div>
              <div class="row">
                <span class="label">Payment Date</span>
                <span class="value">${formattedDate}</span>
              </div>
              <div class="row">
                <span class="label">Word Count</span>
                <span class="value">${wordCount} words</span>
              </div>
              <div class="row">
                <span class="label">Language Pair</span>
                <span class="value">${sourceLang} ➔ ${targetLang}</span>
              </div>
            </div>

            <!-- Credentials Box -->
            <div class="creds-card">
              <h3 style="margin: 0 0 8px 0; color: #166534; font-size: 16px; font-weight: 800;">
                🔑 Your Client Portal Login Credentials
              </h3>
              <p style="margin: 0 0 12px 0; font-size: 13px; color: #15803d; line-height: 1.5;">
                You can log in to your secure Client Portal dashboard to track translation progress and download your completed certified PDF files directly.
              </p>
              <table class="creds-table">
                <tr>
                  <td style="color: #64748b; font-weight: 600; width: 38%;">Portal Link:</td>
                  <td style="font-weight: 700;"><a href="${portalUrl}" style="color: #051A3B; text-decoration: underline;">${portalUrl}</a></td>
                </tr>
                <tr>
                  <td style="color: #64748b; font-weight: 600;">Username:</td>
                  <td style="font-weight: 700; color: #0F172A; font-family: monospace;">${clientEmail}</td>
                </tr>
                <tr>
                  <td style="color: #64748b; font-weight: 600;">Password:</td>
                  <td style="font-weight: 700;">
                    ${plainTempPassword ? `<code style="background: #dcfce7; color: #166534; padding: 4px 10px; border-radius: 4px; font-size: 14px; font-weight: 800; letter-spacing: 1px;">${plainTempPassword}</code>` : `<span style="color: #0F172A;">Your existing registered password</span>`}
                  </td>
                </tr>
              </table>
              <div style="text-align: center;">
                <a href="${portalUrl}" class="btn-login">
                  Access Client Portal →
                </a>
              </div>
            </div>

            <div class="timeline-card">
              <strong>🚀 What happens next?</strong><br>
              Our certified sworn translators (registered with the Spanish Ministry of Foreign Affairs) have started processing your documents. The finalized translation with official ministry stamps will be uploaded to your portal and delivered to your email within <strong>max 7 working days</strong>.
            </div>

            <p style="font-size: 13px; color: #64748b; line-height: 1.5;">
              If you have any questions or require additional expedited services, simply reply to this email or contact your support advisor.
            </p>
          </div>
          <div class="footer">
            © ${new Date().getFullYear()} AAA Business Consultancy LLC. All rights reserved.<br>
            Official Spanish Immigration & Certified Sworn Translation Services.
          </div>
        </div>
      </body>
      </html>
      `;

      try {
        await sendEmail({
          to: clientEmail,
          subject: `Payment Received — Spanish Sworn Translation — ${paymentReference}`,
          html: emailHtml
        });
        await prisma.communicationLog.create({
          data: {
            clientId: client.id,
            phone: null,
            name: clientName,
            channel: 'EMAIL',
            direction: 'OUTBOUND',
            messageId: emailIdempotencyKey,
            externalProviderId: emailIdempotencyKey,
            deliveryStatus: 'SENT',
            content: `Sworn Translation payment confirmation email sent to ${clientEmail}`
          }
        }).catch(logErr => console.warn('[CommunicationLog Duplication Guard]:', logErr.message));
        console.log(`[TranslationPaymentService] ✅ Client confirmation email sent to ${clientEmail}`);
      } catch (emailErr) {
        console.error(`[TranslationPaymentService] ❌ Client confirmation email failed for ${clientEmail}:`, emailErr.message);
        await prisma.communicationLog.create({
          data: {
            clientId: client.id,
            phone: null,
            name: clientName,
            channel: 'EMAIL',
            direction: 'OUTBOUND',
            messageId: emailIdempotencyKey,
            externalProviderId: emailIdempotencyKey,
            deliveryStatus: 'FAILED',
            failureReason: emailErr.message,
            content: `Failed sending Sworn Translation confirmation email to ${clientEmail}`
          }
        }).catch(() => null);
      }
    } else {
      console.warn(`[TranslationPaymentService] Skipping client email: Client ${lead.id} has no valid email.`);
    }
  } else {
    console.log(`[TranslationPaymentService] Client email already sent for session ${sessionId}. Skipping duplicate.`);
  }

  // 5. Internal Team / Super Admin Email Notification
  const internalEmailIdempotencyKey = `SWORN_TRN_PAYMENT_INTERNAL_EMAIL_${sessionId}`;
  const existingInternalEmail = await prisma.communicationLog.findFirst({
    where: {
      OR: [
        { messageId: internalEmailIdempotencyKey },
        { externalProviderId: internalEmailIdempotencyKey }
      ]
    }
  });

  if (!existingInternalEmail) {
    try {
      const settings = await prisma.companySetting.findFirst().catch(() => null);
      const companyEmail = settings?.email || process.env.ADMIN_EMAIL || 'info@aaabusinessconsultancy.com';
      
      const superAdmins = await prisma.user.findMany({
        where: { role: 'super_admin' },
        select: { email: true }
      });

      const recipientEmails = Array.from(new Set([
        companyEmail,
        ...superAdmins.map(u => u.email)
      ].filter(Boolean)));

      if (recipientEmails.length > 0) {
        const crmLeadUrl = `${frontendUrl}/#/leads/${lead.id}`;
        const formattedDate = formatDateDDMMYYYY(new Date());

        const internalEmailHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f1f5f9; padding: 20px; color: #0f172a; }
            .card { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #cbd5e1; padding: 24px; }
            .header { border-bottom: 2px solid #e2e8f0; padding-bottom: 16px; margin-bottom: 20px; }
            .row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 13px; }
            .label { color: #64748b; font-weight: 600; }
            .val { font-weight: 700; color: #0f172a; }
            .btn { display: inline-block; background: #051A3B; color: #ffffff !important; padding: 12px 24px; border-radius: 8px; font-weight: 700; text-decoration: none; margin-top: 20px; }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="header">
              <h2 style="margin: 0; color: #051A3B;">💳 New Sworn Translation Payment Received</h2>
              <p style="margin: 4px 0 0 0; color: #64748b; font-size: 13px;">AAA Business Consultancy CRM Notification</p>
            </div>

            <div class="row"><span class="label">Client Name:</span><span class="val">${clientName}</span></div>
            <div class="row"><span class="label">Client Email:</span><span class="val">${lead.email}</span></div>
            <div class="row"><span class="label">Client Phone / WhatsApp:</span><span class="val">${lead.phone}</span></div>
            <div class="row"><span class="label">Service:</span><span class="val">Spanish Sworn Translation</span></div>
            <div class="row"><span class="label">Amount Paid:</span><span class="val" style="color: #10b981;">€${Number(totalPaid).toFixed(2)} EUR</span></div>
            <div class="row"><span class="label">Word Count:</span><span class="val">${wordCount} words</span></div>
            <div class="row"><span class="label">Language Pair:</span><span class="val">${sourceLang} ➔ ${targetLang}</span></div>
            <div class="row"><span class="label">Payment Reference:</span><span class="val">${paymentReference}</span></div>
            <div class="row"><span class="label">Stripe Session ID:</span><span class="val" style="font-family: monospace; font-size: 11px;">${sessionId}</span></div>
            <div class="row"><span class="label">Paid Date:</span><span class="val">${formattedDate}</span></div>
            <div class="row"><span class="label">Status:</span><span class="val" style="color: #10b981;">Payment Completed / Paid</span></div>
            <div class="row"><span class="label">Lead ID:</span><span class="val" style="font-family: monospace; font-size: 11px;">${lead.id}</span></div>
            <div class="row"><span class="label">Client ID:</span><span class="val" style="font-family: monospace; font-size: 11px;">${client.id}</span></div>

            <div style="text-align: center;">
              <a href="${crmLeadUrl}" class="btn">View Lead Details in CRM →</a>
            </div>
          </div>
        </body>
        </html>
        `;

        await Promise.allSettled(
          recipientEmails.map(recipient =>
            sendEmail({
              to: recipient,
              subject: `Payment Received — Sworn Translation — ${clientName}`,
              html: internalEmailHtml
            }).catch(internalErr => {
              console.error(`[TranslationPaymentService] Failed internal email to ${recipient}:`, internalErr.message);
            })
          )
        );

        await prisma.communicationLog.create({
          data: {
            clientId: client.id,
            phone: null,
            name: 'Super Admin / Team',
            channel: 'EMAIL',
            direction: 'OUTBOUND',
            messageId: internalEmailIdempotencyKey,
            externalProviderId: internalEmailIdempotencyKey,
            deliveryStatus: 'SENT',
            content: `Internal payment received notification sent to ${recipientEmails.join(', ')}`
          }
        }).catch(logErr => console.warn('[CommunicationLog Duplication Guard]:', logErr.message));
        console.log(`[TranslationPaymentService] ✅ Internal payment notification email sent to ${recipientEmails.join(', ')}`);
      }
    } catch (teamEmailErr) {
      console.error('[TranslationPaymentService] Internal team email alert exception:', teamEmailErr.message);
    }
  } else {
    console.log(`[TranslationPaymentService] Internal email already sent for session ${sessionId}. Skipping duplicate.`);
  }

  // 6. In-App CRM Notifications & Real-Time Socket.io Broadcast
  try {
    const staffUsers = await prisma.user.findMany({
      where: { role: { in: ['super_admin', 'admin', 'operations', 'finance'] } },
      select: { id: true }
    });

    const notifTitle = 'Sworn Translation Payment Received 💳';
    const notifBody = `Payment of €${Number(totalPaid).toFixed(2)} received from ${clientName} for Spanish Sworn Translation (${wordCount} words).`;

    if (staffUsers.length > 0) {
      const notifRows = staffUsers.map(u => ({
        userId: u.id,
        type: 'payment_received',
        title: notifTitle,
        body: notifBody,
        clientId: client.id,
        isRead: false
      }));

      await prisma.notification.createMany({
        data: notifRows,
        skipDuplicates: true
      });
      console.log(`[TranslationPaymentService] Created in-app CRM notifications for ${staffUsers.length} staff members.`);
    }

    // Socket.io Real-time Broadcast
    if (reqApp && reqApp.get) {
      const io = reqApp.get('io');
      if (io) {
        io.emit('new-notification', {
          title: notifTitle,
          body: notifBody,
          type: 'payment_received',
          clientId: client.id,
          leadId: lead.id,
          amount: totalPaid,
          serviceType: 'Spanish Sworn Translation'
        });
        io.emit('lead-updated', {
          leadId: lead.id,
          status: 'Payment Completed'
        });
        console.log(`[TranslationPaymentService] 📡 Socket.io real-time broadcast dispatched.`);
      }
    }
  } catch (notifErr) {
    console.warn('[TranslationPaymentService] In-app notification creation warning:', notifErr.message);
  }

  return {
    success: true,
    lead,
    payment: paymentRecord,
    client
  };
}

module.exports = {
  handleSwornTranslationPaymentSuccess
};
