const prisma = require('../config/db');

// GET /api/v1/notifications/my — fetch all notifications for logged-in user
const getMyNotifications = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const notifications = await prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50
    });

    res.json(notifications);
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ message: 'Server error fetching notifications' });
  }
};

// GET /api/v1/notifications/unread-count
const getUnreadCount = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ count: 0 });

    const count = await prisma.notification.count({
      where: { userId, isRead: false }
    });

    res.json({ count });
  } catch (error) {
    res.status(500).json({ count: 0 });
  }
};

// PATCH /api/v1/notifications/:id/read
const markRead = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;

    await prisma.notification.updateMany({
      where: { id, userId },
      data: { isRead: true }
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ message: 'Server error marking notification read' });
  }
};

// PATCH /api/v1/notifications/read-all
const markAllRead = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    await prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true }
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ message: 'Server error marking all read' });
  }
};

// Internal helper — called when any document is uploaded (general or checklist)
const createDocumentNotification = async ({ userId, clientName: inputClientName, clientId, documentId, documentName, category, reqApp }) => {
  try {
    // 1. Fetch client details if clientId is provided
    let client = null;
    if (clientId) {
      client = await prisma.client.findUnique({
        where: { id: clientId },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          assignedToId: true,
          assignedTo: {
            select: { id: true, email: true, hotlineNumber: true, fullName: true }
          }
        }
      });
    }

    const clientName = (client ? `${client.firstName} ${client.lastName}`.trim() : inputClientName) || 'Client';
    const targetUserId = userId || client?.assignedToId;

    // 2. Find ALL relevant staff members (super_admin, admin, operations, plus assigned consultant)
    const staffMembers = await prisma.user.findMany({
      where: {
        OR: [
          { role: { in: ['super_admin', 'admin', 'operations'] } },
          ...(targetUserId ? [{ id: targetUserId }] : [])
        ]
      },
      select: { id: true, email: true, hotlineNumber: true, fullName: true, role: true }
    });

    // 3. Create internal CRM Notifications in DB for all relevant staff
    const title = `📄 New Document from ${clientName}`;
    const body = `${clientName} uploaded "${documentName}" (${category || 'General'}). Please review and verify.`;

    if (staffMembers.length > 0) {
      try {
        if (prisma.notification && typeof prisma.notification.createMany === 'function') {
          const notificationEntries = staffMembers.map(staff => ({
            userId: staff.id,
            type: 'new_document',
            title,
            body,
            clientId: clientId || null,
            documentId: documentId || null,
            isRead: false
          }));

          await prisma.notification.createMany({
            data: notificationEntries,
            skipDuplicates: true
          });
        }
      } catch (dbNotifErr) {
        console.warn('[Notification DB Write Warn]:', dbNotifErr.message);
      }
    }

    // 4. Real-time Socket.io Broadcast to live CRM dashboards
    if (reqApp) {
      const io = reqApp.get('io');
      if (io) {
        io.emit('new-notification', { title, body, type: 'new_document', clientId, documentId });
        console.log(`[Document Notification] 📡 Socket.io broadcast sent for document: ${documentName}`);
      }
    }

    // 5. WhatsApp Notifications (Client + Staff + Central Admin)
    const { sendCustomWhatsApp } = require('../services/chatbotService');
    const frontendUrl = process.env.FRONTEND_URL || 'https://aaa-crm-service.netlify.app';

    // 5a. Client WhatsApp Confirmation
    const clientPhone = client?.phone;
    if (clientPhone) {
      const clientWaMsg = `📄 *Document Received!*\n\nHello *${client?.firstName || clientName}*,\n\nWe have received your uploaded document:\n• *File:* ${documentName}\n• *Category:* ${category || 'General'}\n\nOur team is reviewing it. You can track your application anytime on your client portal:\n🔗 ${frontendUrl}/#/portal/login`;

      sendCustomWhatsApp(clientPhone, clientWaMsg).catch(err => {
        console.error('[DocUpload WA Client Error]:', err.message);
      });
    }

    // 5b. Staff & Admin WhatsApp Alerts
    const staffHotlines = new Set();
    if (client?.assignedTo?.hotlineNumber) {
      staffHotlines.add(client.assignedTo.hotlineNumber);
    }
    staffMembers.forEach(staff => {
      if (staff.hotlineNumber) staffHotlines.add(staff.hotlineNumber);
    });
    if (process.env.ADMIN_WHATSAPP) {
      staffHotlines.add(process.env.ADMIN_WHATSAPP);
    }

    const staffWaMsg = `🔔 *[ALERT] New Document Uploaded*\n\nClient: *${clientName}*\nFile: *${documentName}*\nCategory: *${category || 'General'}*\n\nPlease log in to the CRM to review and verify.`;

    staffHotlines.forEach(phone => {
      sendCustomWhatsApp(phone, staffWaMsg).catch(err => {
        console.error(`[DocUpload WA Staff Error for ${phone}]:`, err.message);
      });
    });

    // 6. Email Notifications (Client + Staff + Central Admin)
    const { sendEmail } = require('../services/emailService');

    // 6a. Client Email Receipt
    const clientEmail = client?.email;
    if (clientEmail) {
      sendEmail({
        to: clientEmail,
        subject: `📄 Document Received: ${documentName} - AAA Business Consultancy`,
        html: `
          <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
            <h3 style="color: #051A3B;">Hello ${client?.firstName || clientName},</h3>
            <p>We have successfully received your uploaded document:</p>
            <ul>
              <li><b>Document Name:</b> ${documentName}</li>
              <li><b>Category:</b> ${category || 'General'}</li>
              <li><b>Uploaded Date:</b> ${new Date().toLocaleDateString('en-US', { dateStyle: 'medium' })}</li>
            </ul>
            <p>Our document verification team is reviewing your file. You can track your application status anytime on your client portal.</p>
            <p style="margin-top: 20px;">
              <a href="${frontendUrl}/#/portal/login" 
                 style="background-color: #051A3B; color: #E5C058; padding: 10px 20px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block;">
                 Go to Client Portal
              </a>
            </p>
            <br/>
            <p>Best regards,<br/><b>AAA Business Consultancy Team</b></p>
          </div>
        `
      }).catch(err => console.error('[DocUpload Email Client Error]:', err.message));
    }

    // 6b. Staff & Admin Alert Email
    const staffEmails = new Set();
    if (client?.assignedTo?.email) {
      staffEmails.add(client.assignedTo.email);
    }
    staffMembers.forEach(staff => {
      if (staff.email) staffEmails.add(staff.email);
    });
    if (process.env.ADMIN_EMAIL) {
      staffEmails.add(process.env.ADMIN_EMAIL);
    }

    const adminEmailRecipients = Array.from(staffEmails);
    if (adminEmailRecipients.length > 0) {
      adminEmailRecipients.forEach(staffEmail => {
        sendEmail({
          to: staffEmail,
          subject: `[CRM ALERT] New Document Uploaded by ${clientName} 📄`,
          html: `
            <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
              <h3 style="color: #051A3B;">Hello Team,</h3>
              <p>Client <b>${clientName}</b> has uploaded a new document for review:</p>
              <ul>
                <li><b>Document Name:</b> ${documentName}</li>
                <li><b>Category:</b> ${category || 'General'}</li>
                <li><b>Client Email:</b> ${clientEmail || 'N/A'}</li>
              </ul>
              <p>Please log in to the CRM admin panel to review and verify this document.</p>
              <br/>
              <p>AAA Visa CRM System</p>
            </div>
          `
        }).catch(err => console.error(`[DocUpload Email Staff Error for ${staffEmail}]:`, err.message));
      });
    }

  } catch (error) {
    console.error('Error creating document notification:', error);
    // Non-fatal — don't throw, just log
  }
};

// Internal helper — called when a new lead form is submitted or assessment booked
const createLeadNotification = async ({ leadName, email, phone, country, serviceCategory, appointmentDate, reqApp }) => {
  try {
    // Find ALL staff members across every role so nobody misses the notification
    const staffMembers = await prisma.user.findMany({
      where: {
        role: { in: ['super_admin', 'admin', 'operations', 'consultant', 'finance', 'marketing', 'agent'] }
      },
      select: { id: true, role: true }
    });

    console.log(`[Lead Notification] Found ${staffMembers.length} staff members to notify for lead: ${leadName || email}`);

    if (!staffMembers || staffMembers.length === 0) {
      console.warn('[Lead Notification] No staff members found in DB — skipping notification creation.');
      return;
    }

    const isBooking = !!appointmentDate;
    const title = isBooking 
      ? `📅 Assessment Booked: ${leadName || email || 'Client'}`
      : `🎯 New Lead: ${leadName || email || 'Client'}`;

    let formattedDate = '';
    if (appointmentDate) {
      const str = String(appointmentDate).trim();
      const match = str.match(/^(\d{4})-(\d{2})-(\d{2})(.*)$/);
      if (match) {
        const [, yyyy, mm, dd, rest] = match;
        formattedDate = `${dd}/${mm}/${yyyy}${rest}`;
      } else {
        try {
          const parsed = new Date(appointmentDate);
          if (!isNaN(parsed.getTime())) {
            const day = String(parsed.getDate()).padStart(2, '0');
            const month = String(parsed.getMonth() + 1).padStart(2, '0');
            const year = parsed.getFullYear();
            const timeStr = parsed.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
            formattedDate = `${day}/${month}/${year} ${timeStr}`;
          } else {
            formattedDate = appointmentDate;
          }
        } catch (_) {
          formattedDate = appointmentDate;
        }
      }
    }

    const body = isBooking
      ? `${leadName || email} (${country || 'Global'}) booked a Free Assessment for ${serviceCategory || 'Spain Visa'} on ${formattedDate}.`
      : `${leadName || email} (${country || 'Global'}) submitted a lead for ${serviceCategory || 'Spain Visa'}.`;

    const notificationEntries = staffMembers.map(staff => ({
      userId: staff.id,
      type: isBooking ? 'new_booking' : 'new_lead',
      title,
      body,
      isRead: false
    }));

    await prisma.notification.createMany({
      data: notificationEntries,
      skipDuplicates: true
    });

    console.log(`[Lead Notification] ✅ Created ${notificationEntries.length} notifications for "${leadName || email}"`);

    // Broadcast via Socket.io so UI updates in real-time without waiting for the 15s poll
    if (reqApp) {
      const io = reqApp.get('io');
      if (io) {
        io.emit('new-notification', { title, body, isBooking });
        console.log('[Lead Notification] 📡 Socket.io broadcast sent.');
      } else {
        console.warn('[Lead Notification] Socket.io not available on req.app.');
      }
    } else {
      console.warn('[Lead Notification] reqApp not provided — skipping socket broadcast.');
    }
  } catch (error) {
    console.error('[Lead Notification] ❌ Error creating notification:', error.message, error.stack);
  }
};

module.exports = { getMyNotifications, getUnreadCount, markRead, markAllRead, createDocumentNotification, createLeadNotification };
