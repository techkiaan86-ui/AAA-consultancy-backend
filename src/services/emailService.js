const nodemailer = require('nodemailer');
const { Resend } = require('resend');
const prisma = require('../config/db');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM;

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = process.env.SMTP_PORT || 587;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_SECURE = process.env.SMTP_SECURE === 'true' || SMTP_PORT == 465;
const SMTP_FROM = process.env.SMTP_FROM || `"AAA Business Consultancy" <info@aaabusinessconsultancy.com>`;

let resendClient = null;
let transporter = null;

const getCleanPackageName = (rawPackageName, serviceType) => {
  const input = String(rawPackageName || serviceType || '').trim();
  if (!input) return 'Spain Visa & Residency Services';

  // If input is a raw technical ID like pkg_1785313855786 or Stripe session ID
  if (input.startsWith('pkg_') || input.startsWith('cs_') || input.startsWith('pi_') || input.startsWith('ch_')) {
    if (serviceType && !String(serviceType).startsWith('pkg_')) {
      return getCleanPackageName(serviceType, null);
    }
    return 'Spain Relocation & Visa Package';
  }

  const lower = input.toLowerCase();
  if (lower.includes('case_assessment') || lower.includes('option_a') || lower === 'option a') return 'Professional Case Assessment';
  if (lower.includes('option_b') || lower.includes('full processing')) return 'Full Processing Package (Option B)';
  if (lower.includes('option_c') || lower.includes('premium')) return 'Premium Package (Option C)';
  if (lower.includes('option_d') || lower.includes('relocation')) return 'Administrative Relocation Package (Option D)';
  if (lower.includes('nomad') || lower.includes('dnv')) return 'Spain Digital Nomad Visa (DNV)';
  if (lower.includes('lucrative') || lower.includes('nlv')) return 'Spain Non-Lucrative Visa (NLV)';
  if (lower.includes('study') || lower.includes('student')) return 'Spain Student Visa';
  if (lower.includes('tourist') || lower.includes('schengen')) return 'Spain Tourist Visa (Schengen)';
  if (lower.includes('property') || lower.includes('investment')) return 'Property Investment Guidance Service';
  if (lower.includes('translation') || lower.includes('sworn')) return 'Spanish Sworn Translation Service';

  return input;
};

/**
 * Helper function to format any Date object or string (YYYY-MM-DD, ISO, timestamp) into DD/MM/YYYY
 */
const formatDateDDMMYYYY = (dateInput) => {
  if (!dateInput) return '';
  const str = String(dateInput).trim();
  
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(str)) {
    return str;
  }
  
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) {
    const clean = str.split('T')[0];
    const parts = clean.split('-');
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }
  
  const d = new Date(dateInput);
  if (!isNaN(d.getTime())) {
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}/${month}/${year}`;
  }
  
  return str;
};

if (RESEND_API_KEY && RESEND_API_KEY !== 'your_resend_api_key_here') {
  console.log('Email Service: Initializing Resend client');
  resendClient = new Resend(RESEND_API_KEY);
}

if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  console.log(`Email Service: Initializing SMTP transporter to ${SMTP_HOST}:${SMTP_PORT}`);
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT, 10),
    secure: SMTP_SECURE,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS
    },
    tls: {
      rejectUnauthorized: false
    },
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 10000
  });
}

if (!resendClient && !transporter) {
  console.warn('Email Service: Neither Resend nor SMTP credentials configured. Running in local DRY-RUN/Sandbox mode.');
}

/**
 * Sends an email using Resend, SMTP, or prints to logs if neither is configured (dry-run).
 * @param {Object} options - Email sending options
 * @param {string} options.to - Recipient email
 * @param {string} options.subject - Email subject
 * @param {string} options.html - HTML body
 * @param {string} [options.text] - Plain text body fallback
 * @returns {Promise<{success: boolean, messageId?: string, dryRun?: boolean}>}
 */
exports.sendEmail = async ({ to, subject, html, text }) => {
  const currentKey = process.env.RESEND_API_KEY;
  if (!resendClient && currentKey && currentKey !== 'your_resend_api_key_here') {
    console.log('Email Service: Dynamically initializing Resend client');
    resendClient = new Resend(currentKey);
  }

  if (resendClient) {
    try {
      const rawFrom = process.env.RESEND_FROM || process.env.RESEND_FROM_EMAIL || process.env.SMTP_FROM || 'client@aaabusinessconsultancy.com';
      let cleanFrom = rawFrom.replace(/\\"/g, '"');
      if (!cleanFrom.includes('<')) {
        cleanFrom = `AAA Business Consultancy <${cleanFrom}>`;
      }
      const response = await resendClient.emails.send({
        from: cleanFrom,
        to,
        subject,
        html,
        text: text || html.replace(/<[^>]*>/g, '') // Basic HTML strip for fallback text
      });

      if (response.error) {
        throw new Error(response.error.message);
      }

      console.log(`Email sent successfully via Resend to ${to}. Message ID: ${response.data?.id}`);
      return { success: true, messageId: response.data?.id, dryRun: false };
    } catch (error) {
      console.error(`Failed to send email via Resend to ${to}:`, error.message || error);
      if (transporter) {
        console.log(`Resend dispatch failed for ${to}. Attempting automatic SMTP fallback...`);
        try {
          const info = await transporter.sendMail({
            from: SMTP_FROM,
            to,
            subject,
            text: text || html.replace(/<[^>]*>/g, ''),
            html
          });
          console.log(`Email sent successfully via SMTP fallback to ${to}. Message ID: ${info.messageId}`);
          return { success: true, messageId: info.messageId, dryRun: false };
        } catch (smtpErr) {
          console.error(`SMTP fallback also failed for ${to}:`, smtpErr.message || smtpErr);
          throw smtpErr;
        }
      }
      throw error;
    }
  } else if (transporter) {
    try {
      const sendPromise = transporter.sendMail({
        from: SMTP_FROM,
        to,
        subject,
        text: text || html.replace(/<[^>]*>/g, ''), // Basic HTML strip for fallback text
        html
      });

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('SMTP sendMail timed out after 10s')), 10000)
      );

      const info = await Promise.race([sendPromise, timeoutPromise]);

      console.log(`Email sent successfully via SMTP to ${to}. Message ID: ${info.messageId}`);
      return { success: true, messageId: info.messageId, dryRun: false };
    } catch (error) {
      console.error(`Failed to send email via SMTP to ${to}:`, error);
      throw error;
    }
  } else {
    // Sandbox / Dry-Run Log
    const fromAddress = RESEND_FROM || SMTP_FROM;
    console.log('------------------------------------------------------------');
    console.log(`[EMAIL DRY-RUN (NOT CONFIGURED)]`);
    console.log(`From:    ${fromAddress}`);
    console.log(`To:      ${to}`);
    console.log(`Subject: ${subject}`);
    console.log(`Body (Preview): ${html.substring(0, 150)}...`);
    console.log('------------------------------------------------------------');
    return { success: true, messageId: `dryrun-${Date.now()}`, dryRun: true };
  }
};

/**
 * Sends a customized Spain Visa checklist to the client upon successful payment.
 * @param {string} to - Client email
 * @param {string} clientName - Client's name
 * @param {string} serviceType - Service type/visa selected
 */
exports.sendVisaChecklist = async (to, clientName, serviceType, paymentData = {}) => {
  const normalizedService = (serviceType || '').toLowerCase();
  let checklistTitle = "Spain Visa Document Checklist";
  let checklistHtml = `
    <li>Valid Passport (original and copy of all pages)</li>
    <li>Proof of clean criminal record (duly apostilled)</li>
    <li>Visa application form duly filled and signed</li>
    <li>Recent passport-size photographs</li>
    <li>Proof of healthcare coverage in Spain</li>
  `;

  if (normalizedService.includes('nomad') || normalizedService.includes('dnv')) {
    checklistTitle = "Spain Digital Nomad Visa (DNV) Checklist";
    checklistHtml = `
      <li><b>Passport:</b> Valid passport with at least 1 year validity and copies of all pages.</li>
      <li><b>Employment Certificate:</b> Document proving relationship with foreign employers for at least 3 months.</li>
      <li><b>Company Legitimacy:</b> Certificate of Incorporation/Business Registry of your employer.</li>
      <li><b>Proof of Income:</b> Bank statements or invoices showing at least €2,646 per month (200% of SMI).</li>
      <li><b>Criminal Record Certificate:</b> Apostilled clean background check from country of residence for last 5 years.</li>
      <li><b>Degree/Experience:</b> University degree/diploma or proof of 3+ years professional experience.</li>
      <li><b>Private Health Insurance:</b> Spanish health insurance policy (no copay, no waiting period).</li>
    `;
  } else if (normalizedService.includes('lucrative') || normalizedService.includes('nlv')) {
    checklistTitle = "Spain Non-Lucrative Visa (NLV) Checklist";
    checklistHtml = `
      <li><b>Passport:</b> Valid passport with at least 1 year validity and copies of all pages.</li>
      <li><b>Sufficient Financial Means:</b> Proof of passive income or savings showing at least €28,800 annually (400% of IPREM).</li>
      <li><b>Criminal Record Certificate:</b> Apostilled clean background check from last 5 years.</li>
      <li><b>Private Health Insurance:</b> Comprehensive Spanish health insurance (no copay).</li>
      <li><b>Medical Certificate:</b> Form stating you do not suffer from diseases that pose public health risks.</li>
    `;
  } else if (normalizedService.includes('tourist') || normalizedService.includes('schengen')) {
    checklistTitle = "Spain Schengen Tourist Visa Checklist";
    checklistHtml = `
      <li><b>Schengen Visa Form:</b> Fully completed and signed application form.</li>
      <li><b>Travel Insurance:</b> Coverage of at least €30,000 for medical expenses inside Schengen zone.</li>
      <li><b>Flight & Hotel Booking:</b> Confirmed return ticket reservation and accommodation details.</li>
      <li><b>Proof of Funds:</b> Bank statements showing at least €108 per day of stay in Spain.</li>
      <li><b>Employment Status:</b> Reference letter from current employer or business license copy.</li>
    `;
  } else if (normalizedService.includes('study') || normalizedService.includes('student')) {
    checklistTitle = "Spain Student Visa Checklist";
    checklistHtml = `
      <li><b>Letter of Acceptance:</b> Official admission letter from accredited Spanish educational institution.</li>
      <li><b>Proof of Funds:</b> Financial resources showing at least €600 per month (100% of IPREM).</li>
      <li><b>Medical Certificate:</b> Proof of good health (for stays longer than 180 days).</li>
      <li><b>Criminal Record Certificate:</b> Clean record certificate from last 5 years (for stays longer than 180 days).</li>
      <li><b>Private Spanish Health Insurance:</b> Coverage for student stay.</li>
    `;
  } else if (normalizedService.includes('self') || normalizedService.includes('business') || normalizedService.includes('employed')) {
    checklistTitle = "Spain Self-Employed / Business Residency Checklist";
    checklistHtml = `
      <li><b>Business Plan:</b> Detailed business plan approved by official Spanish trade organizations.</li>
      <li><b>Professional Qualification:</b> Proof of qualifications/license required to run your business.</li>
      <li><b>Proof of Investment:</b> Sufficient capital setup and funding commitments in Spain.</li>
      <li><b>Criminal Record Certificate:</b> Apostilled clean background certificate from last 5 years.</li>
      <li><b>Private Health Insurance:</b> Spanish private health coverage.</li>
    `;
  }

  const frontendUrl = process.env.FRONTEND_URL || 'https://aaa-crm-service.netlify.app';
  const clientCode = paymentData.clientCode || 'N/A';
  const amountPaid = paymentData.amount ? `€${Number(paymentData.amount).toFixed(2)}` : 'N/A';
  const packageName = getCleanPackageName(paymentData.packageName, serviceType);
  const dateStr = formatDateDDMMYYYY(paymentData.dateStr || new Date());
  const invoiceUrl = paymentData.invoiceUrl || `${frontendUrl}/#/portal/login?zoho_fallback=true`;
  const portalUrl = `${frontendUrl}/#/portal/login`;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 620px; margin: auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; background-color: #ffffff; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
      <div style="background: linear-gradient(135deg, #0f0c29, #302b63); padding: 24px; text-align: center; color: #ffffff;">
        <h2 style="margin: 0; font-size: 22px; font-weight: 800;">AAA Business Consultancy</h2>
        <p style="margin: 6px 0 0; font-size: 14px; opacity: 0.8;">Spain Visa & Residency Services</p>
      </div>

      <div style="padding: 28px;">
        <h3 style="color: #2d3748; margin-top: 0; font-size: 18px;">🎉 Payment Confirmed - AAA Business Consultancy</h3>
        <p style="color: #4a5568; line-height: 1.6;">Dear <b>${clientName}</b>,</p>
        <p style="color: #4a5568; line-height: 1.6;">Thank you! We have successfully received your payment. Here are your transaction details:</p>

        <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 18px; margin: 20px 0;">
          <h4 style="margin-top: 0; color: #1e293b; font-size: 15px;">📋 Receipt Summary:</h4>
          <ul style="margin: 0; padding-left: 20px; color: #334155; line-height: 1.8;">
            <li><b>👤 Client ID:</b> ${clientCode}</li>
            <li><b>💳 Amount Paid:</b> ${amountPaid}</li>
            <li><b>📦 Package / Service:</b> ${packageName}</li>
            <li><b>📅 Date:</b> ${dateStr}</li>
          </ul>
        </div>

        <div style="margin: 20px 0; background-color: #eff6ff; border-left: 4px solid #2563eb; padding: 14px; border-radius: 4px;">
          <p style="margin: 0; color: #1e40af; font-size: 14px;">
            <b>🧾 Official Tax Invoice:</b> <a href="${invoiceUrl}" style="color: #2563eb; text-decoration: underline; font-weight: 600;">View & Download Official Tax Invoice</a>
          </p>
        </div>

        <div style="margin: 24px 0;">
          <h4 style="color: #1e293b; margin-top: 0; font-size: 15px;">🚀 Next Steps:</h4>
          <p style="color: #4a5568; line-height: 1.6; margin-bottom: 12px;">Your Client Portal is active. Log in to upload your required documents and track your application progress:</p>
          <div style="text-align: center; margin: 16px 0;">
            <a href="${portalUrl}" style="display: inline-block; padding: 12px 24px; background-color: #2563eb; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 700; font-size: 14px;">🔗 Client Portal Login</a>
          </div>
        </div>

        <p style="color: #4a5568; margin-top: 24px; line-height: 1.6;">Thank you for choosing AAA Business Consultancy! 🇪🇸</p>
        <p style="color: #2d3748; margin-bottom: 0;"><b>Best regards,</b><br/>AAA Business Consultancy Team</p>
      </div>

      <div style="background-color: #f8fafc; border-top: 1px solid #e2e8f0; padding: 16px; text-align: center; color: #94a3b8; font-size: 12px;">
        © 2026 AAA Business Consultancy · All rights reserved
      </div>
    </div>
  `;

  return exports.sendEmail({
    to,
    subject: `🎉 Payment Confirmed - AAA Business Consultancy (${clientCode})`,
    html
  });
};

/**
 * Sends branded Appointment Confirmation email with Reschedule, Cancel, and Packages action buttons.
 */
exports.sendAppointmentConfirmationEmail = async ({ to, firstName, date, timeSlot, time, meetingLink, link, consultationId, rescheduleLink, cancelLink }) => {
  const formattedDate = formatDateDDMMYYYY(date);
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const finalTime = timeSlot || time || 'TBD';
  const joinUrl = meetingLink || link || 'https://zoom.us';
  const finalRescheduleUrl = rescheduleLink || `${frontendUrl}/#/public/lead-form?reschedule=true&consultationId=${consultationId || ''}`;
  const finalCancelUrl = cancelLink || `${frontendUrl}/#/public/lead-form?cancel=true&consultationId=${consultationId || ''}`;
  const packagesUrl = "https://aaabusinessconsultancy.com/services-and-packages/";

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 620px; margin: auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; background-color: #ffffff; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
      <div style="background: linear-gradient(135deg, #0f0c29, #302b63); padding: 24px; text-align: center; color: #ffffff;">
        <h2 style="margin: 0; font-size: 22px; font-weight: 800;">AAA Business Consultancy</h2>
        <p style="margin: 6px 0 0; font-size: 14px; opacity: 0.8;">Spain Visa & Residency Services</p>
      </div>

      <div style="padding: 28px;">
        <h3 style="color: #2d3748; margin-top: 0; font-size: 18px;">✈️ Appointment Confirmation</h3>
        <p style="color: #4a5568; line-height: 1.6;">Dear <b>${firstName}</b>,</p>
        <p style="color: #4a5568; line-height: 1.6;">Thank you for booking your <b>Free 20-Minute Eligibility Assessment</b> with our expert team. Your booking is confirmed.</p>

        <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 18px; margin: 20px 0;">
          <h4 style="margin-top: 0; color: #1e293b; font-size: 15px;">📅 Appointment Details:</h4>
          <ul style="margin: 0; padding-left: 20px; color: #334155; line-height: 1.8;">
            <li><b>Date:</b> ${formattedDate}</li>
            <li><b>Time:</b> ${finalTime} (UAE)</li>
            <li><b>Duration:</b> 20 Minutes</li>
            <li><b>Meeting Link:</b> <a href="${joinUrl}" style="color: #2563eb; font-weight: 600;">Click to Join Zoom Meeting</a></li>
          </ul>
        </div>

        <div style="text-align: center; margin: 24px 0;">
          <a href="${joinUrl}" style="display: inline-block; padding: 12px 24px; background-color: #2563eb; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 700; font-size: 14px;">🎥 Join Zoom Meeting</a>
        </div>

        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />

        <h4 style="color: #334155; margin-bottom: 12px; font-size: 14px;">⚙️ Manage Your Booking:</h4>
        <div style="margin-bottom: 20px;">
          <a href="${finalRescheduleUrl}" style="display: inline-block; padding: 10px 18px; background-color: #4f46e5; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 13px; margin-right: 8px; margin-bottom: 8px;">🔄 Reschedule Appointment</a>
          <a href="${finalCancelUrl}" style="display: inline-block; padding: 10px 18px; background-color: #ef4444; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 13px; margin-right: 8px; margin-bottom: 8px;">❌ Cancel Appointment</a>
          <a href="${packagesUrl}" style="display: inline-block; padding: 10px 18px; background-color: #059669; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 13px; margin-bottom: 8px;">📦 Explore Service Packages</a>
        </div>

        <p style="font-size: 12px; color: #64748b; line-height: 1.5; background-color: #f1f5f9; padding: 12px; border-radius: 6px;">
          ⚠️ <b>Policy Note:</b> If you do not join your scheduled Free Eligibility Assessment within 10 minutes of the appointment time, your booking will be automatically cancelled.
        </p>
      </div>

      <div style="background-color: #f8fafc; border-top: 1px solid #e2e8f0; padding: 16px; text-align: center; color: #94a3b8; font-size: 12px;">
        © 2026 AAA Business Consultancy · All rights reserved
      </div>
    </div>
  `;

  return exports.sendEmail({
    to,
    subject: `Booking Confirmed: Spain Visa Eligibility Assessment (${date} at ${timeSlot}) ✈️`,
    html
  });
};

/**
 * Sends a branded Invoice & Payment Link Email to the client.
 */
exports.sendInvoiceNotificationEmail = async ({ to, clientName, amount, discount, netAmount, serviceType, checkoutUrl, portalUrl, tempPassword }) => {
  const loginUrl = portalUrl || `${process.env.FRONTEND_URL || 'http://localhost:5173'}/#/portal/login`;
  const paymentLink = checkoutUrl || loginUrl;

  const html = `
    <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 620px; margin: auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; background-color: #ffffff; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
      <div style="background: linear-gradient(135deg, #0f0c29, #302b63); padding: 24px; text-align: center; color: #ffffff;">
        <h2 style="margin: 0; font-size: 22px; font-weight: 800;">AAA Business Consultancy</h2>
        <p style="margin: 6px 0 0; font-size: 14px; opacity: 0.85;">Spain Relocation & Visa Legal Services</p>
      </div>

      <div style="padding: 28px;">
        <h3 style="color: #1e293b; margin-top: 0; font-size: 18px;">📄 Spain Visa Relocation Invoice & Portal Account</h3>
        <p style="color: #475569; line-height: 1.6;">Dear <b>${clientName}</b>,</p>
        <p style="color: #475569; line-height: 1.6;">Welcome to AAA Business Consultancy! Your relocation folder has been initialized. Please find your invoice details below:</p>

        <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 20px; margin: 20px 0;">
          <h4 style="margin-top: 0; color: #1e293b; font-size: 15px;">💳 Invoice Summary:</h4>
          <ul style="margin: 0; padding-left: 20px; color: #334155; line-height: 1.8;">
            <li><b>Service Selected:</b> ${serviceType || 'Spain Relocation Legal Package'}</li>
            <li><b>Base Amount:</b> €${Number(amount || 0).toLocaleString()}</li>
            ${discount > 0 ? `<li><b>Discount Applied:</b> -€${Number(discount).toLocaleString()}</li>` : ''}
            <li><b>Total Amount Due:</b> <strong style="color: #2563eb; font-size: 16px;">€${Number(netAmount || amount || 0).toLocaleString()}</strong></li>
          </ul>

          <div style="text-align: center; margin-top: 20px;">
            <a href="${paymentLink}" style="display: inline-block; padding: 12px 26px; background-color: #2563eb; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 700; font-size: 14px;">💳 Proceed to Secure Stripe Payment</a>
          </div>
        </div>

        ${tempPassword ? `
        <div style="background-color: #f1f5f9; border-left: 4px solid #4f46e5; border-radius: 6px; padding: 16px; margin: 20px 0;">
          <h4 style="margin: 0 0 8px; color: #4f46e5; font-size: 14px;">🔐 Client Portal Access Credentials:</h4>
          <p style="margin: 4px 0; font-size: 13px; color: #334155;"><b>Portal Link:</b> <a href="${loginUrl}" style="color: #2563eb; font-weight: 600;">Access Portal Here</a></p>
          <p style="margin: 4px 0; font-size: 13px; color: #334155;"><b>Username:</b> ${to}</p>
          <p style="margin: 4px 0; font-size: 13px; color: #334155;"><b>Temporary Password:</b> <code style="background-color: #ffffff; padding: 2px 8px; border-radius: 4px; border: 1px solid #cbd5e1; font-weight: bold; color: #e11d48;">${tempPassword}</code></p>
          <p style="font-size: 11px; color: #ef4444; margin: 8px 0 0;">* Note: You can also log in to pay directly inside your portal and change your password.</p>
        </div>
        ` : ''}

        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
        <p style="font-size: 12px; color: #64748b; line-height: 1.5;">
          If you have any questions or require assistance, please reply directly to this email or contact your assigned consultant.
        </p>
      </div>

      <div style="background-color: #f8fafc; border-top: 1px solid #e2e8f0; padding: 16px; text-align: center; color: #94a3b8; font-size: 12px;">
        © 2026 AAA Business Consultancy · All rights reserved
      </div>
    </div>
  `;

  return exports.sendEmail({
    to,
    subject: `Relocation Invoice & Client Portal Account - AAA Business Consultancy 🇪🇸`,
    html
  });
};

exports.sendPackagePaymentConfirmationEmail = async ({ clientId, paymentId }) => {
  try {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: { client: true }
    });

    if (!payment || !payment.client) {
      console.warn('[Email Confirmation] payment or client not found for confirmation email');
      return;
    }

    const client = payment.client;
    const clientName = `${client.firstName || ''} ${client.lastName || ''}`.trim() || 'Valued Client';

    // Parse snapshot
    let snapshot = payment.invoiceSnapshot;
    if (typeof snapshot === 'string') {
      try { snapshot = JSON.parse(snapshot); } catch (e) { }
    }

    if (!snapshot) {
      console.warn('[Email Confirmation] invoiceSnapshot is missing for payment:', paymentId);
      return;
    }

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const loginUrl = `${frontendUrl}/#/portal/login`;

    const htmlBody = `
      <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 620px; margin: auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; background-color: #ffffff; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
        <div style="background: linear-gradient(135deg, #0f0c29, #302b63); padding: 24px; text-align: center; color: #ffffff;">
          <h2 style="margin: 0; font-size: 22px; font-weight: 800;">AAA Business Consultancy</h2>
          <p style="margin: 6px 0 0; font-size: 14px; opacity: 0.85;">Spain Relocation & Visa Legal Services</p>
        </div>

        <div style="padding: 28px;">
          <h3 style="color: #22c55e; margin-top: 0; font-size: 18px;">🎉 Payment Successful & Confirmed</h3>
          <p style="color: #475569; line-height: 1.6;">Dear <b>${clientName}</b>,</p>
          <p style="color: #475569; line-height: 1.6;">Thank you for your payment! We have successfully received your payment for the selected Spanish residency package.</p>

          <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 20px; margin: 20px 0;">
            <h4 style="margin-top: 0; color: #1e293b; font-size: 15px; border-bottom: 1px solid #e2e8f0; padding-bottom: 8px;">📄 Invoice Receipt Details:</h4>
            <table style="width: 100%; border-collapse: collapse; font-size: 14px; color: #334155; line-height: 1.8;">
              <tr>
                <td style="padding: 4px 0; font-weight: 600;">Invoice Reference:</td>
                <td style="padding: 4px 0; text-align: right;">PAY-${payment.id.slice(0, 8).toUpperCase()}</td>
              </tr>
              <tr>
                <td style="padding: 4px 0; font-weight: 600;">Selected Package:</td>
                <td style="padding: 4px 0; text-align: right;">${snapshot.packageName}</td>
              </tr>
              <tr>
                <td style="padding: 4px 0; font-weight: 600;">Main Applicant Price:</td>
                <td style="padding: 4px 0; text-align: right;">€${Number(snapshot.basePrice).toFixed(2)}</td>
              </tr>
              ${snapshot.additionalApplicants > 0 ? `
              <tr>
                <td style="padding: 4px 0; font-weight: 600;">Additional Applicants:</td>
                <td style="padding: 4px 0; text-align: right;">${snapshot.additionalApplicants} × €${Number(snapshot.additionalApplicantPrice).toFixed(2)} (+€${Number(snapshot.additionalApplicantTotal).toFixed(2)})</td>
              </tr>
              ` : ''}
              ${snapshot.creditApplied > 0 ? `
              <tr>
                <td style="padding: 4px 0; font-weight: 600; color: #22c55e;">Professional Assessment Credit:</td>
                <td style="padding: 4px 0; text-align: right; color: #22c55e;">-€${Number(snapshot.creditApplied).toFixed(2)}</td>
              </tr>
              ` : ''}
              <tr style="border-top: 1px solid #e2e8f0; border-bottom: 1px solid #e2e8f0;">
                <td style="padding: 6px 0; font-weight: bold;">Subtotal:</td>
                <td style="padding: 6px 0; text-align: right; font-weight: bold;">€${Number(snapshot.subtotal).toFixed(2)}</td>
              </tr>
              <tr>
                <td style="padding: 4px 0; font-weight: 600;">VAT (${snapshot.vatRate}%):</td>
                <td style="padding: 4px 0; text-align: right;">€${Number(snapshot.vatAmount).toFixed(2)}</td>
              </tr>
              <tr style="font-size: 16px; border-top: 2px solid #1e293b;">
                <td style="padding: 8px 0; font-weight: bold; color: #1e293b;">Total Amount Paid:</td>
                <td style="padding: 8px 0; text-align: right; font-weight: bold; color: #2563eb;">€${Number(snapshot.total).toFixed(2)}</td>
              </tr>
            </table>

            <div style="text-align: center; margin-top: 24px;">
              <a href="${loginUrl}" style="display: inline-block; padding: 12px 26px; background-color: #2563eb; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 700; font-size: 14px;">💻 Log In to Client Portal</a>
            </div>
          </div>

          <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
          <p style="font-size: 12px; color: #64748b; line-height: 1.5;">
            Your official invoice receipt is now available directly in your client portal under the document upload section. If you have any questions or require relocation support, please contact your assigned visa coordinator.
          </p>
        </div>

        <div style="background-color: #f8fafc; border-top: 1px solid #e2e8f0; padding: 16px; text-align: center; color: #94a3b8; font-size: 12px;">
          © 2026 AAA Business Consultancy · All rights reserved
        </div>
      </div>
    `;

    return exports.sendEmail({
      to: client.email,
      subject: `Payment Confirmed — ${snapshot.packageName} — AAA Business Consultancy 🎉`,
      html: htmlBody
    });
  } catch (error) {
    console.error('[Email Confirmation Error] Failed to prepare/send package confirmation email:', error.message);
  }
};

/**
 * Sends branded Payment Success Email for Sworn Translation & general payments with Customer ID and Login Credentials.
 */
exports.sendPaymentSuccessEmail = async ({ to, clientName, customerId, serviceType, amount, tempPassword, zohoInvoiceUrl }) => {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const loginUrl = `${frontendUrl}/#/portal/login`;
  const formattedAmount = Number(amount || 0).toFixed(2);

  const html = `
    <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 620px; margin: auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; background-color: #ffffff; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
      <div style="background: linear-gradient(135deg, #0f0c29, #302b63); padding: 24px; text-align: center; color: #ffffff;">
        <h2 style="margin: 0; font-size: 22px; font-weight: 800;">AAA Business Consultancy</h2>
        <p style="margin: 6px 0 0; font-size: 14px; opacity: 0.85;">Certified Sworn Translation & Visa Services</p>
      </div>

      <div style="padding: 28px;">
        <h3 style="color: #22c55e; margin-top: 0; font-size: 18px;">🎉 Payment Successful & Receipt Confirmed</h3>
        <p style="color: #475569; line-height: 1.6;">Dear <b>${clientName || 'Valued Client'}</b>,</p>
        <p style="color: #475569; line-height: 1.6;">Thank you for choosing AAA Business Consultancy. We have successfully received your payment.</p>

        <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 20px; margin: 20px 0;">
          <h4 style="margin-top: 0; color: #1e293b; font-size: 15px; border-bottom: 1px solid #e2e8f0; padding-bottom: 8px;">📄 Payment Receipt Details:</h4>
          <ul style="margin: 0; padding-left: 20px; color: #334155; line-height: 1.8;">
            <li><b>Customer ID:</b> <strong style="color: #2563eb;">${customerId || 'N/A'}</strong></li>
            <li><b>Service Selected:</b> ${serviceType || 'Spanish Sworn Translation'}</li>
            <li><b>Amount Paid:</b> <strong style="color: #22c55e; font-size: 16px;">€${formattedAmount}</strong></li>
            <li><b>Max Delivery Time:</b> 7 working days from date of payment confirmation</li>
          </ul>

          ${zohoInvoiceUrl ? `
          <div style="background-color: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 14px; margin-top: 16px; text-align: center;">
            <h4 style="margin: 0 0 6px; color: #166534; font-size: 14px;">🧾 Official Tax Invoice:</h4>
            <a href="${zohoInvoiceUrl}" target="_blank" style="display: inline-block; padding: 8px 18px; background-color: #16a34a; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 700; font-size: 13px;">View Official Zoho Tax Invoice</a>
          </div>
          ` : ''}

          ${tempPassword ? `
          <div style="background-color: #ffffff; border: 1px solid #cbd5e1; border-radius: 8px; padding: 14px; margin-top: 16px;">
            <h4 style="margin: 0 0 6px; color: #4f46e5; font-size: 14px;">🔑 Client Portal Login Credentials:</h4>
            <p style="margin: 4px 0; font-size: 13px; color: #334155;"><b>Portal Link:</b> <a href="${loginUrl}" style="color: #2563eb; font-weight: 600;">Click to Login</a></p>
            <p style="margin: 4px 0; font-size: 13px; color: #334155;"><b>Username (Email):</b> ${to}</p>
            <p style="margin: 4px 0; font-size: 13px; color: #334155;"><b>Temporary Password:</b> <code style="background-color: #f1f5f9; padding: 2px 8px; border-radius: 4px; border: 1px solid #cbd5e1; font-weight: bold; color: #e11d48;">${tempPassword}</code></p>
          </div>
          ` : ''}

          <div style="text-align: center; margin-top: 20px;">
            <a href="${loginUrl}" style="display: inline-block; padding: 12px 26px; background-color: #2563eb; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 700; font-size: 14px;">💻 Access Client Portal</a>
          </div>
        </div>

        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
        <p style="font-size: 12px; color: #64748b; line-height: 1.5;">
          You can log into your client portal anytime to upload your documents and track your order status in real time.
        </p>
      </div>

      <div style="background-color: #f8fafc; border-top: 1px solid #e2e8f0; padding: 16px; text-align: center; color: #94a3b8; font-size: 12px;">
        © 2026 AAA Business Consultancy · All rights reserved
      </div>
    </div>
  `;

  return exports.sendEmail({
    to,
    subject: `Payment Confirmed [${customerId || 'Receipt'}] — AAA Business Consultancy 🇪🇸`,
    html
  });
};

exports.sendMeetingCancelledEmail = async ({ to, firstName, date, time, rebookLink }) => {
  const formattedDate = formatDateDDMMYYYY(date);
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 620px; margin: auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; background-color: #ffffff; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
      <div style="background: linear-gradient(135deg, #0f0c29, #302b63); padding: 24px; text-align: center; color: #ffffff;">
        <h2 style="margin: 0; font-size: 22px; font-weight: 800;">AAA Business Consultancy</h2>
        <p style="margin: 6px 0 0; font-size: 14px; opacity: 0.8;">Spain Visa & Residency Services</p>
      </div>

      <div style="padding: 28px;">
        <h3 style="color: #e53e3e; margin-top: 0; font-size: 18px;">❌ Appointment Cancelled</h3>
        <p style="color: #4a5568; line-height: 1.6;">Dear <b>${firstName}</b>,</p>
        <p style="color: #4a5568; line-height: 1.6;">Your Spain Visa Eligibility Assessment scheduled for <b>${formattedDate}</b> at <b>${time}</b> (UAE) has been successfully cancelled.</p>
        
        <p style="color: #4a5568; line-height: 1.6;">If you would like to schedule another appointment, please use the button below to rebook at your convenience:</p>

        <div style="text-align: center; margin: 24px 0;">
          <a href="${rebookLink}" style="display: inline-block; padding: 12px 24px; background-color: #2563eb; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 700; font-size: 14px;">🔄 Rebook Appointment</a>
        </div>
      </div>

      <div style="background-color: #f8fafc; border-top: 1px solid #e2e8f0; padding: 16px; text-align: center; color: #94a3b8; font-size: 12px;">
        © 2026 AAA Business Consultancy · All rights reserved
      </div>
    </div>
  `;
  return exports.sendEmail({
    to,
    subject: `Appointment Cancelled: Spain Visa Eligibility Assessment ❌`,
    html
  });
};

exports.sendMeetingRescheduledEmail = async ({ to, firstName, date, time, link, rescheduleLink, cancelLink }) => {
  const formattedDate = formatDateDDMMYYYY(date);
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 620px; margin: auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; background-color: #ffffff; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
      <div style="background: linear-gradient(135deg, #0f0c29, #302b63); padding: 24px; text-align: center; color: #ffffff;">
        <h2 style="margin: 0; font-size: 22px; font-weight: 800;">AAA Business Consultancy</h2>
        <p style="margin: 6px 0 0; font-size: 14px; opacity: 0.8;">Spain Visa & Residency Services</p>
      </div>

      <div style="padding: 28px;">
        <h3 style="color: #4f46e5; margin-top: 0; font-size: 18px;">🔄 Appointment Rescheduled</h3>
        <p style="color: #4a5568; line-height: 1.6;">Dear <b>${firstName}</b>,</p>
        <p style="color: #4a5568; line-height: 1.6;">Your Spain Visa Eligibility Assessment has been rescheduled successfully.</p>

        <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 18px; margin: 20px 0;">
          <h4 style="margin-top: 0; color: #1e293b; font-size: 15px;">📅 New Appointment Details:</h4>
          <ul style="margin: 0; padding-left: 20px; color: #334155; line-height: 1.8;">
            <li><b>Date:</b> ${formattedDate}</li>
            <li><b>Time:</b> ${time} (UAE)</li>
            <li><b>Duration:</b> 20 Minutes</li>
            <li><b>Meeting Link:</b> <a href="${link}" style="color: #2563eb; font-weight: 600;">Click to Join Zoom Meeting</a></li>
          </ul>
        </div>

        <div style="text-align: center; margin: 24px 0;">
          <a href="${link}" style="display: inline-block; padding: 12px 24px; background-color: #2563eb; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 700; font-size: 14px;">🎥 Join Zoom Meeting</a>
        </div>

        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
        <h4 style="color: #334155; margin-bottom: 12px; font-size: 14px;">⚙️ Manage Your Booking:</h4>
        <div style="margin-bottom: 20px;">
          <a href="${rescheduleLink}" style="display: inline-block; padding: 10px 18px; background-color: #4f46e5; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 13px; margin-right: 8px; margin-bottom: 8px;">🔄 Reschedule Appointment</a>
          <a href="${cancelLink}" style="display: inline-block; padding: 10px 18px; background-color: #ef4444; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 13px; margin-right: 8px; margin-bottom: 8px;">❌ Cancel Appointment</a>
        </div>
      </div>

      <div style="background-color: #f8fafc; border-top: 1px solid #e2e8f0; padding: 16px; text-align: center; color: #94a3b8; font-size: 12px;">
        © 2026 AAA Business Consultancy · All rights reserved
      </div>
    </div>
  `;
  return exports.sendEmail({
    to,
    subject: `Appointment Rescheduled: Spain Visa Eligibility Assessment (${formattedDate} at ${time}) 🔄`,
    html
  });
};
