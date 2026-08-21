const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { sendEmail } = require('./emailService');
const { sendCustomWhatsApp } = require('./chatbotService');

/**
 * Helper to parse a date string (YYYY-MM-DD or DD/MM/YYYY) and time string (e.g. "12:00 PM – 01:00 PM" or "14:00")
 * into a JS Date object representing the exact absolute UTC moment of the meeting in UAE Timezone (UTC+4).
 */
function parseMeetingDateTime(dateStr, timeSlotStr) {
  if (!dateStr) return null;
  
  let yyyy = '', mm = '', dd = '';
  const s = String(dateStr).trim();
  
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const parts = s.split('T')[0].split('-');
    yyyy = parts[0];
    mm = parts[1];
    dd = parts[2];
  } else if (/^\d{2}\/\d{2}\/\d{4}/.test(s)) {
    const parts = s.split('/');
    dd = parts[0];
    mm = parts[1];
    yyyy = parts[2];
  } else {
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    yyyy = d.getUTCFullYear();
    mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    dd = String(d.getUTCDate()).padStart(2, '0');
  }

  let startTime = '09:00 AM';
  if (timeSlotStr && typeof timeSlotStr === 'string' && !timeSlotStr.toLowerCase().includes('tbd')) {
    // Split by any dash: ASCII hyphen (-), en-dash (–), em-dash (—), or 'to'
    const parts = timeSlotStr.split(/[-–—]|(?:\s+to\s+)/i);
    startTime = parts[0].trim();
  }

  let hours = 9, minutes = 0;
  const timeMatch = startTime.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (timeMatch) {
    hours = parseInt(timeMatch[1], 10);
    minutes = parseInt(timeMatch[2], 10);
    const ampm = timeMatch[3] ? timeMatch[3].toUpperCase() : null;
    if (ampm === 'PM' && hours < 12) hours += 12;
    if (ampm === 'AM' && hours === 12) hours = 0;
  } else {
    const singleHourMatch = startTime.match(/(\d{1,2})\s*(AM|PM)?/i);
    if (singleHourMatch) {
      hours = parseInt(singleHourMatch[1], 10);
      const ampm = singleHourMatch[2] ? singleHourMatch[2].toUpperCase() : null;
      if (ampm === 'PM' && hours < 12) hours += 12;
      if (ampm === 'AM' && hours === 12) hours = 0;
    }
  }

  // UAE Time is strictly UTC+4 (Gulf Standard Time).
  // Calculate exact UTC timestamp by subtracting 4 hours (4 * 3600 * 1000 ms) from UAE wall-clock time.
  const uaeUtcMs = Date.UTC(parseInt(yyyy, 10), parseInt(mm, 10) - 1, parseInt(dd, 10), hours, minutes, 0) - (4 * 60 * 60 * 1000);
  return new Date(uaeUtcMs);
}

/**
 * Format any date value into DD/MM/YYYY
 */
function formatDDMMYYYY(dateVal) {
  if (!dateVal) return '';
  const s = String(dateVal).trim();
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const p = s.split('T')[0].split('-');
    return `${p[2]}/${p[1]}/${p[0]}`;
  }
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  }
  return s;
}

const startReminderScheduler = () => {
  console.log('[Reminder Scheduler] Starting periodic reminders engine (Standardized to UAE Time UTC+4)...');

  const checkReminders = async () => {
    try {
      const now = new Date();
      
      // SECTION A: Check Payment Reminders
      const pendingClients = await prisma.client.findMany({
        where: { status: 'Waiting for Payment' }
      });
      
      for (const client of pendingClients) {
        const timeDiffMs = now.getTime() - new Date(client.createdAt).getTime();
        const hoursElapsed = timeDiffMs / (1000 * 60 * 60);
        
        if (hoursElapsed >= 2 && hoursElapsed < 24) {
          const sentLog = await prisma.reminderLog.findFirst({
            where: { clientId: client.id, type: '2h' }
          });
          if (!sentLog) {
            await sendPaymentReminder(client, '2h', 'Reminder: Complete Your Spain Visa Package Payment ✈️', 
              `Please complete your payment within today to initiate your Spain residency processing. Checkout link: ${process.env.FRONTEND_URL || 'http://localhost:5173'}/#/portal/documents/${client.id}`
            );
          }
        }
        
        if (hoursElapsed >= 24 && hoursElapsed < 48) {
          const sentLog = await prisma.reminderLog.findFirst({
            where: { clientId: client.id, type: '24h' }
          });
          if (!sentLog) {
            await sendPaymentReminder(client, '24h', 'Action Required: Finish Your Spain Relocation Setup 🇪🇸',
              `It has been 24 hours. Don't lose access to your assigned specialist. Complete payment: ${process.env.FRONTEND_URL || 'http://localhost:5173'}/#/portal/documents/${client.id}`
            );
          }
        }
        
        if (hoursElapsed >= 48 && hoursElapsed < 120) {
          const sentLog = await prisma.reminderLog.findFirst({
            where: { clientId: client.id, type: '2d' }
          });
          if (!sentLog) {
            await sendPaymentReminder(client, '2d', 'Reminder: Confirm Your Application Details & Invoice 🧾',
              `Your invoice is pending payment for 2 days. Final link: ${process.env.FRONTEND_URL || 'http://localhost:5173'}/#/portal/documents/${client.id}`
            );
          }
        }

        if (hoursElapsed >= 120) {
          const sentLog = await prisma.reminderLog.findFirst({
            where: { clientId: client.id, type: '5d' }
          });
          if (!sentLog) {
            await prisma.reminderLog.create({
              data: { clientId: client.id, type: '5d' }
            });
          }
        }
      }

      // SECTION B: Check 24 Hours Cancellation Reminders
      const cancelledConsultations = await prisma.consultation.findMany({
        where: { status: 'Cancelled' },
        include: { lead: true }
      });

      for (const cons of cancelledConsultations) {
        if (!cons.lead) continue;
        
        const hasRebooked = await prisma.consultation.findFirst({
          where: {
            leadId: cons.leadId,
            status: { in: ['Scheduled', 'Completed', 'Pending Acceptance'] }
          }
        });
        if (hasRebooked) continue;

        const timeDiffMs = now.getTime() - new Date(cons.updatedAt).getTime();
        const hoursElapsed = timeDiffMs / (1000 * 60 * 60);

        if (hoursElapsed >= 24) {
          const sentLog = await prisma.reminderLog.findFirst({
            where: {
              clientId: cons.lead.clientId || cons.leadId,
              type: 'cancelled_rebook_24h'
            }
          });
          if (!sentLog) {
            try {
              await prisma.reminderLog.create({
                data: {
                  clientId: cons.lead.clientId || cons.leadId,
                  type: 'cancelled_rebook_24h'
                }
              });

              const rebookLink = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/#/public/lead-form?id=${cons.lead.id}&rebook=true`;

              if (cons.lead.phone) {
                await sendCustomWhatsApp(cons.lead.phone, `🔔 *Reminder: Rebook your Spain Visa Consultation*\n\nDear ${cons.lead.firstName},\n\nThis is a reminder to rebook your Free Spain Visa Eligibility Assessment. Spots are filling up quickly.\n\nClick the link to book now:\n🔗 ${rebookLink}`);
              }

              if (cons.lead.email) {
                await sendEmail({
                  to: cons.lead.email,
                  subject: 'Reminder: Rebook Your Spain Visa Consultation - AAA Business Consultancy',
                  html: `
                    <h3>Appointment Reminder</h3>
                    <p>Dear ${cons.lead.firstName},</p>
                    <p>This is a reminder to rebook your Free Spain Visa Eligibility Assessment. Spots are filling up quickly.</p>
                    <p>Please click the link below to select a new date and time:</p>
                    <p><a href="${rebookLink}" style="background-color: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">Rebook Now</a></p>
                    <p>Thank you!</p>
                  `
                });
              }
              console.log(`[Reminder Scheduler] Sent 24h cancellation rebook reminder to ${cons.lead.email}`);
            } catch (err) {
              console.error('[Reminder Scheduler] Failed to send 24h cancellation reminder:', err.message);
            }
          }
        }
      }

      // SECTION C: Check 48 Hours Additional Documents Reminders
      const pendingDocsClients = await prisma.client.findMany({
        where: { status: 'Additional Documents Required' }
      });

      for (const client of pendingDocsClients) {
        const timeDiffMs = now.getTime() - new Date(client.updatedAt).getTime();
        const hoursElapsed = timeDiffMs / (1000 * 60 * 60);

        if (hoursElapsed >= 48) {
          const sentLog = await prisma.reminderLog.findFirst({
            where: { clientId: client.id, type: 'additional_docs_48h' }
          });
          if (!sentLog) {
            try {
              await prisma.reminderLog.create({
                data: { clientId: client.id, type: 'additional_docs_48h' }
              });

              const portalUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/#/portal/login`;
              const clientName = `${client.firstName} ${client.lastName}`;

              if (client.email) {
                await sendEmail({
                  to: client.email,
                  subject: 'Reminder: Pending Additional Documents for Spain Visa 🇪🇸',
                  html: `
                    <h3>Document Upload Reminder</h3>
                    <p>Dear ${client.firstName},</p>
                    <p>This is a reminder that we are still waiting for the additional documents requested for your Spain Visa / Relocation application.</p>
                    <p>Please log in to your portal and upload the files to avoid delays in your submission process:</p>
                    <p><a href="${portalUrl}" style="background-color: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">Upload Portal Login</a></p>
                    <p>Best regards,<br/>AAA Business Consultancy Team</p>
                  `
                });
              }

              if (client.phone) {
                await sendCustomWhatsApp(client.phone, `🔔 *Reminder: Pending Additional Documents Required*\n\nHello *${clientName}*,\n\nWe haven't received your requested additional documents yet. Please upload them here:\n\n🔗 ${portalUrl}`);
              }
              console.log(`[Reminder Scheduler] Sent additional docs reminder to ${client.email}`);
            } catch (err) {
              console.error('[Reminder Scheduler] Failed to send additional docs reminder:', err.message);
            }
          }
        }
      }

      // SECTION D: Check 24h & 1h Meeting Reminders for Scheduled Consultations
      const scheduledConsultations = await prisma.consultation.findMany({
        where: { status: 'Scheduled' },
        include: {
          lead: true
        }
      });

      for (const cons of scheduledConsultations) {
        const phone = cons.lead?.phone;
        const email = cons.lead?.email;
        const firstName = cons.lead?.firstName || 'Valued Client';
        if (!phone && !email) continue;

        const meetingDateObj = parseMeetingDateTime(cons.date, cons.timeSlot);
        if (!meetingDateObj || isNaN(meetingDateObj.getTime())) continue;

        const diffMs = meetingDateObj.getTime() - now.getTime();
        const diffHours = diffMs / (1000 * 60 * 60);

        const formattedDateStr = formatDDMMYYYY(cons.date);
        const displayDateTime = `${formattedDateStr} at ${cons.timeSlot || 'Scheduled Time'} (UAE)`;
        const zoomLink = cons.meetingLink || 'https://zoom.us';

        // 1. Check 24 Hours Meeting Reminder (diffHours between 22h and 26h)
        if (diffHours >= 22 && diffHours <= 26) {
          const sentLog = await prisma.reminderLog.findFirst({
            where: {
              clientId: cons.lead?.clientId || cons.leadId,
              type: `meeting_reminder_24h_${cons.id}`
            }
          });

          if (!sentLog) {
            console.log(`[Reminder Scheduler] Triggering 24h meeting reminder for consultation ${cons.id} (${formattedDateStr})`);
            await prisma.reminderLog.create({
              data: {
                clientId: cons.lead?.clientId || cons.leadId,
                type: `meeting_reminder_24h_${cons.id}`
              }
            });

            if (phone) {
              const { sendWhatsAppMessage } = require('./whatsappService');
              await sendWhatsAppMessage({
                to: phone,
                templateName: 'aaa_meeting_reminder_24h',
                components: [
                  {
                    type: 'body',
                    parameters: [
                      { type: 'text', text: firstName },
                      { type: 'text', text: displayDateTime },
                      { type: 'text', text: zoomLink }
                    ]
                  }
                ]
              }).catch(err => console.error('[24h WhatsApp Reminder Err]:', err.message));
            }

            if (email) {
              await sendEmail({
                to: email,
                subject: `⏰ Reminder: Spain Visa Assessment Tomorrow (${formattedDateStr})`,
                html: `
                  <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #e2e8f0; border-radius: 10px; padding: 20px;">
                    <h3 style="color: #2563eb;">⏰ Spain Visa Assessment Reminder (24 Hours)</h3>
                    <p>Dear <b>${firstName}</b>,</p>
                    <p>This is a gentle reminder that your Free 20-Minute Spain Visa Eligibility Assessment is scheduled for tomorrow.</p>
                    <div style="background: #f8fafc; padding: 15px; border-radius: 8px; margin: 15px 0;">
                      <p style="margin: 4px 0;"><b>📅 Date:</b> ${formattedDateStr}</p>
                      <p style="margin: 4px 0;"><b>⏰ Time:</b> ${cons.timeSlot || 'Scheduled Time'} (UAE)</p>
                      <p style="margin: 4px 0;"><b>🎥 Meeting Link:</b> <a href="${zoomLink}">${zoomLink}</a></p>
                    </div>
                    <p>Best regards,<br/>AAA Business Consultancy Team</p>
                  </div>
                `
              }).catch(err => console.error('[24h Email Reminder Err]:', err.message));
            }
          }
        }

        // 2. Check 1 Hour Meeting Reminder (diffHours between 0.1h and 1.5h, i.e. 6 mins to 90 mins)
        if (diffHours >= 0.1 && diffHours <= 1.5) {
          const sentLog = await prisma.reminderLog.findFirst({
            where: {
              clientId: cons.lead?.clientId || cons.leadId,
              type: `meeting_reminder_1h_${cons.id}`
            }
          });

          if (!sentLog) {
            console.log(`[Reminder Scheduler] Triggering 1h meeting reminder for consultation ${cons.id} (${formattedDateStr} ${cons.timeSlot} UAE) - diffHours: ${diffHours.toFixed(2)}h`);
            await prisma.reminderLog.create({
              data: {
                clientId: cons.lead?.clientId || cons.leadId,
                type: `meeting_reminder_1h_${cons.id}`
              }
            });

            if (phone) {
              const { sendWhatsAppMessage } = require('./whatsappService');
              await sendWhatsAppMessage({
                to: phone,
                templateName: 'aaa_meeting_reminder_1h',
                components: [
                  {
                    type: 'body',
                    parameters: [
                      { type: 'text', text: firstName },
                      { type: 'text', text: displayDateTime },
                      { type: 'text', text: zoomLink }
                    ]
                  }
                ]
              }).catch(err => console.error('[1h WhatsApp Reminder Err]:', err.message));
            }

            if (email) {
              await sendEmail({
                to: email,
                subject: `⏳ Assessment Starts in 1 Hour (${formattedDateStr})`,
                html: `
                  <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #e2e8f0; border-radius: 10px; padding: 20px;">
                    <h3 style="color: #dc2626;">⏳ Spain Visa Assessment Starts in 1 Hour</h3>
                    <p>Dear <b>${firstName}</b>,</p>
                    <p>Your Free 20-Minute Spain Visa Eligibility Assessment is starting in 1 HOUR.</p>
                    <div style="background: #f8fafc; padding: 15px; border-radius: 8px; margin: 15px 0;">
                      <p style="margin: 4px 0;"><b>📅 Date:</b> ${formattedDateStr}</p>
                      <p style="margin: 4px 0;"><b>⏰ Time:</b> ${cons.timeSlot || 'Scheduled Time'} (UAE)</p>
                      <p style="margin: 4px 0;"><b>🎥 Meeting Link:</b> <a href="${zoomLink}">${zoomLink}</a></p>
                    </div>
                    <p>Please be ready to join 5 minutes before start time.</p>
                    <p>Best regards,<br/>AAA Business Consultancy Team</p>
                  </div>
                `
              }).catch(err => console.error('[1h Email Reminder Err]:', err.message));
            }
          }
        }
      }
    } catch (error) {
      console.error('[Reminder Scheduler] Error running reminders cron:', error);
    }
  };

  // Run immediately on boot to prevent any startup delay
  checkReminders().catch(err => console.error('[Reminder Scheduler Boot Error]:', err.message));

  // Run periodic check every 5 minutes
  setInterval(checkReminders, 1000 * 60 * 5);
};

async function sendPaymentReminder(client, type, subject, messageBody) {
  try {
    console.log(`[Reminder Scheduler] Sending ${type} payment reminder to client ${client.email}`);
    
    await prisma.reminderLog.create({
      data: { clientId: client.id, type }
    });
    
    if (client.email) {
      await sendEmail({
        to: client.email,
        subject,
        html: `
          <h3>Hello ${client.firstName},</h3>
          <p>${messageBody}</p>
          <p>Best regards,<br/>AAA Business Consultancy Team</p>
        `
      });
    }
    
    if (client.phone) {
      const { sendWhatsAppMessage } = require('./whatsappService');
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
      const checkoutLink = `${frontendUrl}/#/portal/documents/${client.id}`;
      
      let templateName = 'payment_reminder_2h';
      if (type === '24h') {
        templateName = 'payment_reminder_24h';
      } else if (type === '2d') {
        templateName = 'payment_reminder_48h';
      }

      await sendWhatsAppMessage({
        to: client.phone,
        templateName,
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: client.firstName || 'Client' },
              { type: 'text', text: checkoutLink }
            ]
          }
        ]
      });
    }
  } catch (err) {
    console.error(`Failed to send ${type} reminder:`, err.message);
  }
}

module.exports = { startReminderScheduler };
