const prisma = require('../config/db');

const getCommunications = async (req, res) => {
  try {
    const { clientId, leadId } = req.query;

    let targetClientId = clientId;
    let targetLeadId = leadId;

    // If leadId passed but no clientId, check if lead is linked to a client
    if (leadId && !targetClientId) {
      const lead = await prisma.lead.findUnique({ where: { id: leadId } });
      if (lead && lead.clientId) {
        targetClientId = lead.clientId;
      }
    }

    // Fetch Communication Logs
    let commLogs = [];
    if (targetClientId) {
      commLogs = await prisma.communicationLog.findMany({
        where: { clientId: targetClientId },
        include: {
          respondedByUser: { select: { fullName: true, email: true } }
        },
        orderBy: { createdAt: 'desc' }
      });
    }

    // Fetch Meetings / Consultations
    let whereConsultation = {};
    if (targetLeadId && targetClientId) {
      whereConsultation = {
        OR: [
          { leadId: targetLeadId },
          { lead: { clientId: targetClientId } }
        ]
      };
    } else if (targetLeadId) {
      whereConsultation = { leadId: targetLeadId };
    } else if (targetClientId) {
      whereConsultation = { lead: { clientId: targetClientId } };
    }

    const consultations = await prisma.consultation.findMany({
      where: whereConsultation,
      include: {
        consultant: { select: { fullName: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    // Map consultations into common communication format
    const meetingLogs = consultations.map(c => {
      const formattedDate = c.date && c.date.includes('-') ? c.date.split('-').reverse().join('/') : c.date;
      return {
        id: c.id,
        clientId: targetClientId,
        channel: 'MEETING',
        direction: 'OUTBOUND',
        content: `Meeting: ${c.type || 'Eligibility Assessment'} | Date: ${formattedDate} at ${c.timeSlot} | Consultant: ${c.consultant?.fullName || 'Unassigned'}${c.recordingUrl ? ' | Recording: ' + c.recordingUrl : ''}${c.internalNotes ? ' | Notes: ' + c.internalNotes : ''}`,
        deliveryStatus: c.status,
        recordingUrl: c.recordingUrl,
        meetingLink: c.meetingLink,
        respondedByUser: c.consultant ? { fullName: c.consultant.fullName } : null,
        createdAt: c.createdAt
      };
    });

    // Combine and sort by createdAt desc
    const combined = [...commLogs, ...meetingLogs].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json(combined);
  } catch (error) {
    console.error('Error fetching communications:', error);
    res.status(500).json({ message: 'Server error fetching communications', error: error.message });
  }
};

const createCommunicationLog = async (req, res) => {
  try {
    const { clientId, channel, direction, content, deliveryStatus, failureReason, respondedByUserId } = req.body;

    if (!clientId || !channel || !content) {
      return res.status(400).json({ message: 'clientId, channel, and content are required.' });
    }

    const validUser = (respondedByUserId && typeof respondedByUserId === 'string' && respondedByUserId.trim() !== '') ? respondedByUserId.trim() : (req.user ? req.user.id : null);
    
    // Check if user exists before assigning relation to prevent foreign key error
    let finalRespondedByUserId = null;
    if (validUser) {
      const userExists = await prisma.user.findUnique({ where: { id: validUser } });
      if (userExists) finalRespondedByUserId = validUser;
    }

    const log = await prisma.communicationLog.create({
      data: {
        clientId,
        channel: channel.toUpperCase(), // WHATSAPP, EMAIL, CALL, MEETING
        direction: direction || 'OUTBOUND',
        content,
        deliveryStatus: deliveryStatus || 'SENT',
        failureReason,
        respondedByUserId: finalRespondedByUserId
      },
      include: {
        respondedByUser: { select: { fullName: true, email: true } }
      }
    });

    res.status(201).json(log);
  } catch (error) {
    console.error('Error creating communication log:', error);
    res.status(500).json({ message: 'Server error creating communication log', error: error.message });
  }
};

module.exports = {
  getCommunications,
  createCommunicationLog
};
