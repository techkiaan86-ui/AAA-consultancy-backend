const prisma = require('../config/db');

/**
 * Get unified case activity timeline logs for a lead or client.
 * Aggregates AuditLog entries, existing Lead/Client creation dates, 
 * Booked Consultations, Uploaded Documents, Payments, Case Comments, and Communications.
 */
const getCaseTimeline = async (req, res) => {
  try {
    const { clientId, leadId, applicationId } = req.query;

    if (!clientId && !leadId && !applicationId) {
      return res.status(400).json({ success: false, message: 'Must provide clientId, leadId, or applicationId' });
    }

    const timelineEvents = [];

    // 1. Fetch Audit Log Entries (Safe try-catch wrapper)
    try {
      const whereConditions = [];
      if (clientId) whereConditions.push({ clientId });
      if (leadId) whereConditions.push({ leadId });
      if (applicationId) whereConditions.push({ applicationId });

      if (whereConditions.length > 0) {
        const auditLogs = await prisma.auditLog.findMany({
          where: { OR: whereConditions },
          orderBy: { createdAt: 'desc' },
          take: 100
        });

        auditLogs.forEach(log => {
          timelineEvents.push({
            id: log.id,
            timestamp: log.createdAt,
            type: log.action,
            actorName: log.actorName || 'System',
            actorRole: log.actorRole || 'system',
            description: log.description || '',
            category: 'AUDIT'
          });
        });
      }
    } catch (auditErr) {
      console.warn('[AuditLog Query Warning] Falling back to standard entity timeline:', auditErr.message);
    }

    // 2. Fetch Lead details & history if leadId is provided
    let targetPhone = null;
    let targetEmail = null;
    let effectiveClientId = clientId;

    if (leadId) {
      const lead = await prisma.lead.findUnique({
        where: { id: leadId },
        include: {
          consultations: { include: { consultant: { select: { fullName: true } } } },
          assignedTo: { select: { fullName: true } }
        }
      });

      if (lead) {
        targetPhone = lead.phone;
        targetEmail = lead.email;
        if (lead.clientId) effectiveClientId = lead.clientId;

        // Lead Creation Event
        const creationDate = lead.formSubmittedAt || lead.createdAt;
        timelineEvents.push({
          id: `lead-created-${lead.id}`,
          timestamp: creationDate,
          type: 'LEAD_REGISTERED',
          actorName: `${lead.firstName} ${lead.lastName}`.trim() || 'Lead',
          actorRole: 'client',
          description: `Lead created & registered in CRM via Form Submission. Initial Status: "${lead.status}".`,
          category: 'LEAD'
        });

        // Preferred Meeting Slot Event
        if (lead.meetingPreferredDate) {
          timelineEvents.push({
            id: `lead-pref-meeting-${lead.id}`,
            timestamp: creationDate,
            type: 'MEETING_PREFERRED',
            actorName: `${lead.firstName} ${lead.lastName}`.trim(),
            actorRole: 'client',
            description: `Requested consultation slot for ${lead.meetingPreferredDate} at ${lead.meetingPreferredTime || 'TBD'} (${lead.meetingPreferredLanguage || lead.preferredLanguage || 'English'}).`,
            category: 'MEETING'
          });
        }

        // Scheduled Consultations
        if (lead.consultations && lead.consultations.length > 0) {
          lead.consultations.forEach(c => {
            timelineEvents.push({
              id: `consultation-${c.id}`,
              timestamp: c.createdAt || c.updatedAt,
              type: `CONSULTATION_${c.status ? c.status.toUpperCase().replace(/\s+/g, '_') : 'SCHEDULED'}`,
              actorName: c.consultant?.fullName || 'Assigned Consultant',
              actorRole: 'consultant',
              description: `Consultation Meeting (${c.status}): Scheduled for ${c.date} at ${c.timeSlot}.${c.meetingLink ? ' Zoom link generated.' : ''}`,
              category: 'MEETING'
            });
          });
        }

        // Historical caseComments or notes on Lead
        if (Array.isArray(lead.caseComments)) {
          lead.caseComments.forEach((c, idx) => {
            timelineEvents.push({
              id: `lead-comment-${lead.id}-${idx}`,
              timestamp: c.timestamp || c.createdAt || lead.updatedAt,
              type: 'NOTE_ADDED',
              actorName: c.author || c.addedBy || 'Staff',
              actorRole: c.role || 'staff',
              description: `Note: ${c.text || c.note || JSON.stringify(c)}`,
              category: 'NOTE'
            });
          });
        } else if (lead.notes && typeof lead.notes === 'string') {
          timelineEvents.push({
            id: `lead-notes-${lead.id}`,
            timestamp: lead.updatedAt || lead.createdAt,
            type: 'NOTE_ADDED',
            actorName: lead.assignedTo?.fullName || 'Staff',
            actorRole: 'staff',
            description: `Case File Notes: ${lead.notes}`,
            category: 'NOTE'
          });
        }
      }
    }

    // 3. Fetch Client details & documents/payments if effectiveClientId exists
    if (effectiveClientId) {
      const client = await prisma.client.findUnique({
        where: { id: effectiveClientId },
        include: {
          documents: true,
          payments: true
        }
      });

      if (client) {
        if (!targetPhone) targetPhone = client.phone;
        if (!targetEmail) targetEmail = client.email;

        // Existing Documents Upload & Review Events
        if (client.documents && client.documents.length > 0) {
          client.documents.forEach(d => {
            timelineEvents.push({
              id: `doc-${d.id}`,
              timestamp: d.uploadedDate || d.updatedAt,
              type: d.status === 'VERIFIED' ? 'DOC_VERIFIED' : d.status === 'REJECTED' ? 'DOC_REJECTED' : 'DOC_UPLOADED',
              actorName: `${client.firstName} ${client.lastName}`.trim(),
              actorRole: 'client',
              description: `Document "${d.name}" (${d.category || 'General'}) — Status: ${d.status}.${d.comment ? ` Comment: "${d.comment}"` : ''}`,
              category: 'DOCUMENT'
            });
          });
        }

        // Payments Events
        if (client.payments && client.payments.length > 0) {
          client.payments.forEach(p => {
            timelineEvents.push({
              id: `pay-${p.id}`,
              timestamp: p.updatedAt || p.createdAt,
              type: `PAYMENT_${p.status ? p.status.toUpperCase() : 'PENDING'}`,
              actorName: `${client.firstName} ${client.lastName}`.trim(),
              actorRole: 'client',
              description: `Payment of €${p.amount?.toLocaleString()} (${p.status}) via ${p.paymentMethod || 'Stripe Checkout'}.`,
              category: 'PAYMENT'
            });
          });
        }
      }
    }

    // 4. Fetch Communication Logs (by clientId, phone, or email)
    const commWhere = [];
    if (effectiveClientId) commWhere.push({ clientId: effectiveClientId });
    if (targetPhone) commWhere.push({ phone: targetPhone });

    if (commWhere.length > 0) {
      const commLogs = await prisma.communicationLog.findMany({
        where: { OR: commWhere },
        include: { respondedByUser: { select: { fullName: true, role: true } } },
        orderBy: { createdAt: 'desc' },
        take: 50
      });

      commLogs.forEach(comm => {
        timelineEvents.push({
          id: `comm-${comm.id}`,
          timestamp: comm.createdAt,
          type: `COMM_${comm.channel}_${comm.direction}`,
          actorName: comm.direction === 'INBOUND' ? (comm.name || 'Client') : (comm.respondedByUser?.fullName || 'System Automated'),
          actorRole: comm.direction === 'INBOUND' ? 'client' : (comm.respondedByUser?.role || 'system'),
          description: `[${comm.channel}] ${comm.direction === 'INBOUND' ? 'Received message' : 'Sent message'}: "${comm.content.substring(0, 120)}${comm.content.length > 120 ? '...' : ''}"`,
          category: 'COMMUNICATION'
        });
      });
    }

    // 5. Deduplicate events by ID and sort chronologically (Newest first)
    const uniqueEventsMap = new Map();
    timelineEvents.forEach(evt => {
      if (!uniqueEventsMap.has(evt.id)) {
        uniqueEventsMap.set(evt.id, evt);
      }
    });

    const finalTimeline = Array.from(uniqueEventsMap.values()).sort(
      (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
    );

    res.json({
      success: true,
      timeline: finalTimeline
    });
  } catch (error) {
    console.error('[getCaseTimeline Error]:', error);
    res.status(500).json({ success: false, message: 'Server error fetching case timeline', error: error.message });
  }
};

module.exports = {
  getCaseTimeline
};
