const prisma = require('../config/db');

// In-Memory Lock to guarantee single execution per Lead ID
const activeBookingSyncLocks = new Set();

const getLeads = async (req, res) => {
  try {
    // 1. Fetch lightweight sorted lead IDs (sorts only UUIDs to prevent MySQL sort_buffer_size overflow code 1038)
    const leadIds = await prisma.lead.findMany({
      select: { id: true },
      orderBy: { createdAt: 'desc' }
    });

    if (!leadIds || leadIds.length === 0) {
      return res.json([]);
    }

    const idList = leadIds.map(l => l.id);

    // 2. Fetch full lead objects using primary key list (zero SQL sort memory overhead)
    const leads = await prisma.lead.findMany({
      where: { id: { in: idList } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        nationality: true,
        countryOfResidence: true,
        preferredLanguage: true,
        serviceType: true,
        applicantsCount: true,
        source: true,
        campaignId: true,
        status: true,
        notes: true,
        timeline: true,
        qualificationData: true,
        dependentsDetails: true,
        meetingPreferredDate: true,
        meetingPreferredTime: true,
        meetingPreferredLanguage: true,
        meetingNotes: true,
        formSubmittedAt: true,
        preferableArea: true,
        budget: true,
        sourceLanguage: true,
        targetLanguage: true,
        wordCount: true,
        createdAt: true,
        updatedAt: true,
        assignedToId: true,
        assignedAt: true,
        nextFollowUpDate: true,
        clientId: true,
        assignedTo: {
          select: { fullName: true }
        },
        client: {
          select: {
            id: true,
            clientCode: true,
            documents: {
              select: { id: true, name: true, status: true, url: true }
            },
            payments: {
              select: {
                id: true,
                amount: true,
                totalPaid: true,
                status: true,
                paidAt: true,
                transactionId: true,
                gatewayId: true,
                paymentMethod: true,
                invoiceNumber: true
              },
              orderBy: { createdAt: 'desc' }
            },
            communications: {
              select: {
                id: true,
                channel: true,
                direction: true,
                deliveryStatus: true,
                externalProviderId: true,
                failureReason: true,
                createdAt: true
              },
              orderBy: { createdAt: 'desc' }
            }
          }
        }
      }
    });

    // 3. Preserve the exact createdAt desc order
    const leadMap = new Map(leads.map(l => [l.id, l]));
    const sortedLeads = idList.map(id => leadMap.get(id)).filter(Boolean);

    // 4. Map to frontend expectation
    const mapped = sortedLeads.map((l, idx) => {
      const autoCode = l.client?.clientCode || `CID-${12001 + (sortedLeads.length - 1 - idx)}`;
      return {
        ...l,
        createdDate: l.createdAt,
        assignedAt: l.assignedAt || l.createdAt,
        name: `${l.firstName} ${l.lastName}`,
        serviceId: l.serviceType,
        assignedConsultantId: l.assignedToId,
        assignedConsultantName: l.assignedTo?.fullName,
        clientCode: autoCode,
        displayId: autoCode,
        documents: l.client?.documents || [],
        payments: l.client?.payments || [],
        payment: l.client?.payments?.[0] || null,
        communications: l.client?.communications || []
      };
    });
    res.json(mapped);
  } catch (error) {
    console.error('Error fetching leads:', error);
    res.status(500).json({ message: 'Server error fetching leads', error: error.message });
  }
};

const createLead = async (req, res) => {
  try {
    const {
      firstName, 
      lastName, 
      email, 
      phone, 
      source, 
      campaignId, 
      serviceType, 
      serviceId, 
      nationality, 
      countryOfResidence,
      preferredLanguage, 
      applicantsCount,
      dependentsDetails,
      meetingPreferredDate,
      meetingPreferredTime,
      meetingPreferredLanguage,
      meetingNotes,
      qualificationData,
      preferableArea,
      budget,
      sourceLanguage,
      targetLanguage,
      wordCount
    } = req.body;

    if (!req.user && (!nationality || !countryOfResidence)) {
      return res.status(400).json({
        success: false,
        message: 'Nationality and Country of Residence are required.'
      });
    }

    // Same-Day Booking Restriction
    if (meetingPreferredDate) {
      const todayStr = new Date().toISOString().split('T')[0];
      const { getCustomization } = require('./settingsController');
      const settings = getCustomization();
      const allowSameDay = Boolean(settings.flowAutomationSettings?.allowSameDayBooking);

      if (allowSameDay) {
        if (meetingPreferredDate < todayStr) {
          return res.status(400).json({
            success: false,
            message: 'Past dates cannot be booked.'
          });
        }
      } else {
        if (meetingPreferredDate <= todayStr) {
          return res.status(400).json({
            success: false,
            message: 'Booking date must be at least the next calendar day.'
          });
        }
      }
    }
    
    const safeEmail = email ? email.trim().toLowerCase() : '';
    // Normalize phone number to check for existing lead (last 10 digits to match with or without country code)
    const cleanPhone = phone ? phone.replace(/\D/g, '') : '';
    const matchDigits = cleanPhone.length >= 10 ? cleanPhone.slice(-10) : cleanPhone;

    // 1. Check blocked client
    const blockedClient = await prisma.client.findFirst({
      where: {
        isBlocked: true,
        OR: [
          ...(safeEmail ? [{ email: safeEmail }] : []),
          ...(matchDigits ? [{ phone: { contains: matchDigits } }] : [])
        ]
      }
    });

    if (blockedClient) {
      return res.status(403).json({
        code: 'BLOCKED',
        message: 'Your booking cannot be processed automatically. Contact support.'
      });
    }

    // 2. Check blacklist first
    const blacklisted = await prisma.blacklistedClient.findFirst({
      where: {
        OR: [
          ...(safeEmail ? [{ email: safeEmail }] : []),
          ...(matchDigits ? [{ phone: { contains: matchDigits } }] : [])
        ]
      }
    });

    const { isNameSimilar } = require('../utils/fuzzyMatch');
    const blacklist = await prisma.blacklistedClient.findMany();
    const fullNameInput = `${firstName || ''} ${lastName || ''}`.trim();
    const matchesBlacklistByName = blacklist.some(b => isNameSimilar(fullNameInput, b.name));

    if (blacklisted || matchesBlacklistByName) {
      return res.status(403).json({
        code: 'BLACKLISTED',
        message: 'This profile is not eligible for further eligibility assessments due to a previous missed appointment.'
      });
    }

    // 2b. Check if an active Client already exists with this email or phone
    const existingClient = await prisma.client.findFirst({
      where: {
        OR: [
          ...(safeEmail ? [{ email: safeEmail }] : []),
          ...(matchDigits ? [{ phone: { contains: matchDigits } }] : [])
        ]
      }
    });

    if (existingClient) {
      return res.status(409).json({
        code: 'EXISTING_CLIENT',
        message: 'An active client profile already exists under this email or phone number. A new lead cannot be created.'
      });
    }
    
    // 3. Check for Duplicate Active Bookings for Public Form Submissions
    if (!req.user) {
      const latestLead = await prisma.lead.findFirst({
        where: {
          OR: [
            ...(safeEmail ? [{ email: safeEmail }] : []),
            ...(matchDigits ? [{ phone: { contains: matchDigits } }] : [])
          ]
        },
        select: {
          id: true,
          email: true,
          phone: true,
          status: true,
          createdAt: true
        },
        orderBy: { createdAt: 'desc' }
      });

      const inactiveStatuses = ['Lost Lead', 'Spam', 'Cold Lead', 'No Show', 'Completed', 'Cancelled', 'Canceled', 'Refused', 'Meeting Completed', 'Meeting Cancelled'];
      
      if (latestLead) {
        const timeDiffMs = Date.now() - new Date(latestLead.createdAt).getTime();
        if (timeDiffMs < 60000) {
          console.log(`[BOOKING GUARD] Rapid duplicate submission detected for Lead ID ${latestLead.id} (${timeDiffMs}ms ago). Reusing existing lead.`);
          const fullLead = await prisma.lead.findUnique({
            where: { id: latestLead.id },
            include: { consultations: true }
          });
          const consultation = fullLead?.consultations?.[0];
          return res.status(200).json({
            success: true,
            ...fullLead,
            meetingLink: consultation?.meetingLink
          });
        }

        if (!inactiveStatuses.includes(latestLead.status)) {
          return res.status(409).json({
            code: 'DUPLICATE_LEAD',
            message: 'An active booking or application already exists under this email or phone number.'
          });
        }
      }
    }

    let lead = null;

    // Smart auto-assign: prefer property specialist for Property Investment leads
    const finalServiceType = serviceType || serviceId || '';
    const isPropertyLead = finalServiceType.toLowerCase().includes('property') || finalServiceType.toLowerCase().includes('investment');
    let assignedToId = null;
    if (isPropertyLead) {
      // Try to find a property specialist first
      const propertySpecialists = await prisma.user.findMany({ where: { role: 'consultant', isPropertySpecialist: true } });
      if (propertySpecialists.length > 0) {
        assignedToId = propertySpecialists[0].id;
      } else {
        // Fallback to any available consultant
        const consultants = await prisma.user.findMany({ where: { role: 'consultant' } });
        assignedToId = consultants.length > 0 ? consultants[0].id : null;
      }
    } else {
      // Normal assignment for non-property leads
      let ruleMatched = false;
      const settings = await prisma.companySetting.findFirst({
        select: { routingRules: true }
      }).catch(() => null);
      if (settings && settings.routingRules && Array.isArray(settings.routingRules)) {
        const leadNat = (nationality || '').toLowerCase();
        const leadCountry = (countryOfResidence || '').toLowerCase();
        
        const rule = settings.routingRules.find(r => {
          const ruleNat = (r.nationality || '').toLowerCase();
          const ruleCountry = (r.country || '').toLowerCase();
          const natMatch = ruleNat && leadNat.includes(ruleNat);
          const countryMatch = ruleCountry && leadCountry.includes(ruleCountry);
          return natMatch || countryMatch;
        });
        
        if (rule && rule.consultantId) {
          assignedToId = rule.consultantId;
          ruleMatched = true;
        }
      }

      if (!ruleMatched) {
        // Normal round-robin assignment fallback
        const consultants = await prisma.user.findMany({ where: { role: 'consultant' } });
        assignedToId = consultants.length > 0 ? consultants[0].id : null;
      }
    }

    // Create new lead (compatible with Railway schema)
    lead = await prisma.lead.create({
        data: {
          firstName: firstName || '',
          lastName: lastName || '',
          email: safeEmail || email || '',
          phone: phone || '',
          source: source || 'Website',
          campaignId,
          serviceType: serviceType || serviceId,
          nationality,
          countryOfResidence: countryOfResidence || null,
          preferredLanguage: preferredLanguage || 'English',
          applicantsCount: applicantsCount ? String(applicantsCount) : undefined,
          dependentsDetails: dependentsDetails || undefined,
          meetingPreferredDate,
          meetingPreferredTime,
          meetingPreferredLanguage,
          meetingNotes,
          qualificationData: qualificationData || undefined,
          assignedToId,
          assignedAt: assignedToId ? new Date() : null,
          preferableArea: preferableArea || null,
          budget: budget || null,
          sourceLanguage: sourceLanguage || null,
          targetLanguage: targetLanguage || null,
          wordCount: wordCount ? parseInt(wordCount, 10) : null,
          formSubmittedAt: meetingPreferredDate ? new Date() : undefined,
          status: meetingPreferredDate ? 'Form Submitted' : 'New Lead'
        }
      });
      console.log(`New Lead created (ID: ${lead.id}, Phone: ${lead.phone})`);

      // Trigger In-App Notifications for all staff
      const { createLeadNotification } = require('./notificationController');
      createLeadNotification({
        leadName: `${lead.firstName} ${lead.lastName}`,
        email: lead.email,
        phone: lead.phone,
        country: lead.countryOfResidence,
        serviceCategory: lead.serviceType,
        appointmentDate: lead.meetingPreferredDate ? `${lead.meetingPreferredDate} ${lead.meetingPreferredTime || ''}` : null,
        reqApp: req.app
      }).catch(err => console.error('[Lead Notification Error]:', err.message));

      if (req.app && lead.meetingPreferredDate && lead.meetingPreferredTime) {
        const io = req.app.get('io');
        if (io) {
          io.emit('public-slot-booked', {
            date: lead.meetingPreferredDate,
            timeSlot: lead.meetingPreferredTime
          });
        }
      }

    // Dispatch consultation sync, Zoom meeting creation, WhatsApp, & Emails asynchronously in background
    // Respond immediately to prevent HTTP network timeouts (150ms response time)
    syncLeadConsultation(lead.id, req.app).catch(syncErr => {
      console.error('[SYNC] Background error in syncLeadConsultation:', syncErr.message);
    });

    return res.status(201).json({
      success: true,
      ...lead
    });
  } catch (error) {
    console.error('Error in createLead:', error);
    res.status(500).json({ message: 'Server error creating lead', error: error.message });
  }
};

const assignLead = async (req, res) => {
  try {
    const { leadId, agentId } = req.body;
    const lead = await prisma.lead.update({
      where: { id: leadId },
      data: { assignedToId: agentId, assignedAt: new Date() },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        assignedToId: true,
        assignedAt: true,
        clientId: true
      }
    });

    // Update consultant on any existing active (non-cancelled) consultation directly in DB
    await prisma.consultation.updateMany({
      where: { leadId, status: { notIn: ['Cancelled'] } },
      data: { consultantId: agentId, status: 'Scheduled', assignedAt: new Date() }
    }).catch(err => console.warn('[assignLead] Consultation update warning:', err.message));

    // Also trigger consultation sync to ensure meeting record exists
    syncLeadConsultation(leadId, req.app).catch(err => console.warn('[assignLead] syncLeadConsultation warning:', err.message));

    // Also update associated client assignedToId if exists
    if (lead.clientId) {
      await prisma.client.update({
        where: { id: lead.clientId },
        data: { assignedToId: agentId, assignedAt: new Date() }
      }).catch(err => console.warn('[assignLead] Client update warning:', err.message));
    }

    res.json(lead);
  } catch (error) {
    console.error('Error assigning lead:', error);
    res.status(500).json({ message: 'Server error assigning lead', error: error.message });
  }
};

const updateLeadStatus = async (req, res) => {
  try {
    const { leadId, status } = req.body;
    const lead = await prisma.lead.update({
      where: { id: leadId },
      data: { status },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        status: true,
        meetingPreferredDate: true,
        meetingPreferredTime: true
      }
    });

    if (status === 'Eligible') {
      try {
        const { autoConvertLeadToClient } = require('./consultationController');
        await autoConvertLeadToClient(lead.id);
      } catch (convErr) {
        console.error('[updateLeadStatus] Failed autoConvertLeadToClient:', convErr.message);
      }
    }

    if (status === 'No Show' || status === 'No-Show') {
      try {
        await prisma.blacklistedClient.upsert({
          where: { email: lead.email.toLowerCase() },
          update: { phone: lead.phone || '' },
          create: {
            email: lead.email.toLowerCase(),
            name: `${lead.firstName} ${lead.lastName}`,
            phone: lead.phone || ''
          }
        });
        console.log(`[Blacklist] Blacklisted client on No Show status: ${lead.email}`);
      } catch (dbErr) {
        console.error('[Blacklist] Failed to insert blacklist record:', dbErr.message);
      }
    }

    if (status === 'Meeting Cancelled' || status === 'Cancelled') {
      try {
        // Update active consultations to Cancelled
        await prisma.consultation.updateMany({
          where: { leadId: lead.id, status: { notIn: ['Cancelled', 'Completed'] } },
          data: { status: 'Cancelled' }
        }).catch(err => console.warn('[updateLeadStatus] Consultation cancel warning:', err.message));

        const consultation = await prisma.consultation.findFirst({
          where: { leadId: lead.id },
          orderBy: { createdAt: 'desc' }
        });

        const { notifyClient } = require('../services/notificationService');
        notifyClient({
          event: 'MEETING_CANCELLED',
          leadId: lead.id,
          consultationId: consultation?.id || null,
          data: {
            date: consultation?.date || lead.meetingPreferredDate,
            time: consultation?.timeSlot || lead.meetingPreferredTime
          }
        }).catch(err => console.error('[updateLeadStatus] Cancellation notifyClient failed:', err.message));

        const remindersQueue = req.app ? req.app.get('remindersQueue') : null;
        if (remindersQueue && remindersQueue.add) {
          await remindersQueue.add('cancelled-rebook-reminder', {
            leadId: lead.id,
            email: lead.email,
            phone: lead.phone,
            firstName: lead.firstName,
            lastName: lead.lastName
          }, {
            delay: 24 * 60 * 60 * 1000 // 24 hours
          }).catch(err => console.warn('[updateLeadStatus] Reminders queue warning:', err.message));
        }
        console.log(`[updateLeadStatus] Dispatched cancellation notifications & rebook link for lead ${lead.id}`);
      } catch (cancelErr) {
        console.error('[updateLeadStatus] Failed to process cancellation triggers:', cancelErr.message);
      }
    }

    const { logActivity } = require('../services/auditService');
    const actorName = req.user ? (req.user.fullName || req.user.email) : 'System';
    const actorRole = req.user ? (req.user.role || 'staff') : 'system';
    logActivity({
      leadId: lead.id,
      actorId: req.user?.id || 'system',
      actorName,
      actorRole,
      action: 'STATUS_CHANGED',
      description: `Lead status updated to "${status}" by ${actorName}.`
    });

    res.json(lead);
  } catch (error) {
    res.status(500).json({ message: 'Server error updating status' });
  }
};

const deleteLead = async (req, res) => {
  try {
    if (req.user && req.user.role !== 'super_admin') {
      return res.status(403).json({ message: 'Only Super Admin has permission to delete leads.' });
    }
    const { id } = req.params;

    // Fetch lead first to get clientId if present
    const existingLead = await prisma.lead.findUnique({
      where: { id },
      select: { id: true, clientId: true, meetingPreferredDate: true, meetingPreferredTime: true }
    });

    if (existingLead) {
      // Delete associated consultations matching leadId OR clientId to prevent lingering orphan records
      await prisma.consultation.deleteMany({
        where: {
          OR: [
            { leadId: id },
            ...(existingLead.clientId ? [{ clientId: existingLead.clientId }] : [])
          ]
        }
      });
    }

    // Delete the lead with explicit select
    const lead = await prisma.lead.delete({
      where: { id },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        status: true
      }
    });

    if (req.app) {
      const io = req.app.get('io');
      if (io) {
        io.emit('public-slot-booked');
      }
    }

    res.json({ success: true, message: 'Lead deleted successfully', lead });
  } catch (error) {
    console.error('Error deleting lead:', error.message);
    res.status(500).json({ message: 'Server error deleting lead', error: error.message });
  }
};

const getLeadById = async (req, res) => {
  try {
    const { id } = req.params;
    const lead = await prisma.lead.findUnique({
      where: { id },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        nationality: true,
        countryOfResidence: true,
        preferredLanguage: true,
        serviceType: true,
        applicantsCount: true,
        source: true,
        campaignId: true,
        status: true,
        notes: true,
        timeline: true,
        qualificationData: true,
        dependentsDetails: true,
        meetingPreferredDate: true,
        meetingPreferredTime: true,
        meetingPreferredLanguage: true,
        meetingNotes: true,
        formSubmittedAt: true,
        preferableArea: true,
        budget: true,
        sourceLanguage: true,
        targetLanguage: true,
        wordCount: true,
        createdAt: true,
        updatedAt: true,
        assignedToId: true,
        assignedAt: true,
        nextFollowUpDate: true,
        clientId: true,
        assignedTo: {
          select: { id: true, fullName: true }
        },
        client: {
          select: {
            id: true,
            clientCode: true,
            documents: {
              select: { id: true, name: true, status: true, url: true }
            }
          }
        }
      }
    });
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    const autoCode = lead.client?.clientCode || `CID-12001`;
    const mapped = {
      ...lead,
      name: `${lead.firstName || ''} ${lead.lastName || ''}`.trim(),
      serviceId: lead.serviceType,
      assignedConsultantId: lead.assignedToId,
      assignedConsultantName: lead.assignedTo?.fullName,
      clientCode: autoCode,
      displayId: autoCode,
      documents: lead.client?.documents || []
    };
    res.json(mapped);
  } catch (error) {
    console.error('[getLeadById Error]:', error.message);
    res.status(500).json({ message: 'Server error fetching lead details', error: error.message });
  }
};

const updateLead = async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      firstName, 
      lastName, 
      email, 
      phone, 
      nationality, 
      preferredLanguage, 
      serviceId, 
      applicantsCount, 
      source, 
      campaignId, 
      status, 
      notes, 
      timeline, 
      qualificationData,
      assignedConsultantId,
      preferableArea,
      budget,
      sourceLanguage,
      targetLanguage,
      wordCount,
      nextFollowUpDate
    } = req.body;

    const lead = await prisma.lead.update({
      where: { id },
      data: {
        firstName,
        lastName,
        email,
        phone,
        nationality,
        preferredLanguage,
        serviceType: serviceId,
        applicantsCount: applicantsCount ? String(applicantsCount) : undefined,
        source,
        campaignId,
        status,
        notes,
        timeline,
        qualificationData,
        assignedToId: assignedConsultantId,
        ...(assignedConsultantId ? { assignedAt: new Date() } : {}),
        nextFollowUpDate: nextFollowUpDate !== undefined ? (nextFollowUpDate ? new Date(nextFollowUpDate) : null) : undefined,
        preferableArea: preferableArea !== undefined ? preferableArea : undefined,
        budget: budget !== undefined ? budget : undefined,
        sourceLanguage: sourceLanguage !== undefined ? sourceLanguage : undefined,
        targetLanguage: targetLanguage !== undefined ? targetLanguage : undefined,
        wordCount: wordCount !== undefined ? (wordCount ? parseInt(wordCount, 10) : null) : undefined
      }
    });

    if (assignedConsultantId) {
      await prisma.consultation.updateMany({
        where: { leadId: lead.id },
        data: { consultantId: assignedConsultantId }
      }).catch(err => console.warn('[updateLead] Consultation update warning:', err.message));
    }

    const mapped = {
      ...lead,
      name: `${lead.firstName} ${lead.lastName}`,
      serviceId: lead.serviceType,
      assignedConsultantId: lead.assignedToId
    };
    res.json(mapped);
  } catch (error) {
    res.status(500).json({ message: 'Server error updating lead', error: error.message });
  }
};

// Find lead by ID — used by public self-fill form to securely retrieve details
async function getPublicLeadDetails(req, res) {
  try {
    const { id } = req.params;
    let lead = await prisma.lead.findFirst({
      where: {
        OR: [
          { id: id },
          { clientId: id }
        ]
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        nationality: true,
        countryOfResidence: true,
        preferredLanguage: true,
        serviceType: true,
        meetingPreferredDate: true,
        meetingPreferredTime: true,
        meetingPreferredLanguage: true,
        meetingNotes: true,
        formSubmittedAt: true,
        clientId: true
      }
    });

    if (!lead) {
      const clientObj = await prisma.client.findUnique({
        where: { id },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          nationality: true,
          countryOfResidence: true,
          preferredLanguage: true,
          serviceType: true
        }
      });

      if (clientObj) {
        return res.json({
          id: clientObj.id,
          clientId: clientObj.id,
          firstName: clientObj.firstName,
          lastName: clientObj.lastName,
          email: clientObj.email,
          phone: clientObj.phone,
          nationality: clientObj.nationality,
          countryOfResidence: clientObj.countryOfResidence,
          preferredLanguage: clientObj.preferredLanguage,
          serviceType: clientObj.serviceType,
          isClient: true
        });
      }

      return res.status(404).json({ message: 'No lead or client found with this ID' });
    }

    res.json({
      id: lead.id,
      clientId: lead.clientId || lead.id,
      firstName: lead.firstName,
      lastName: lead.lastName,
      email: lead.email,
      phone: lead.phone,
      nationality: lead.nationality,
      countryOfResidence: lead.countryOfResidence,
      preferredLanguage: lead.preferredLanguage,
      serviceType: lead.serviceType,
      meetingPreferredDate: lead.meetingPreferredDate,
      meetingPreferredTime: lead.meetingPreferredTime,
      meetingPreferredLanguage: lead.meetingPreferredLanguage,
      meetingNotes: lead.meetingNotes,
      formSubmittedAt: lead.formSubmittedAt,
      isClient: !!lead.clientId
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching details', error: error.message });
  }
}

// Update meeting preferences — called when lead submits self-fill form
async function updateMeetingPreference(req, res) {
  try {
    const { id } = req.params;
    const {
      firstName,
      lastName,
      email,
      phone,
      nationality,
      preferredLanguage,
      meetingPreferredDate,
      meetingPreferredTime,
      meetingPreferredLanguage,
      meetingNotes,
      qualificationData,
      serviceType,
      serviceId
    } = req.body;

    // Same-Day Booking Restriction
    if (meetingPreferredDate) {
      const todayStr = new Date().toISOString().split('T')[0];
      const { getCustomization } = require('./settingsController');
      const settings = getCustomization();
      const allowSameDay = Boolean(settings.flowAutomationSettings?.allowSameDayBooking);

      if (allowSameDay) {
        if (meetingPreferredDate < todayStr) {
          return res.status(400).json({
            success: false,
            message: 'Past dates cannot be booked.'
          });
        }
      } else {
        if (meetingPreferredDate <= todayStr) {
          return res.status(400).json({
            success: false,
            message: 'Booking date must be at least the next calendar day.'
          });
        }
      }
    }

    // Check if ID belongs to an existing converted Client (match by Client ID or linked Lead ID)
    const clientObj = await prisma.client.findFirst({
      where: {
        OR: [
          { id: id },
          { lead: { id: id } }
        ]
      },
      include: { lead: true }
    });

    if (clientObj) {
      let meetingLink = 'https://zoom.us/j/' + Math.floor(100000000 + Math.random() * 900000000);
      let zoomMeetingId = null;

      const zoomService = require('../services/zoomService');
      if (zoomService.isConfigured) {
        try {
          let startTimeISO = new Date().toISOString();
          if (meetingPreferredDate) {
            const timeStr = meetingPreferredTime && meetingPreferredTime.includes(':') ? meetingPreferredTime : '10:00';
            const dateObj = new Date(`${meetingPreferredDate}T${timeStr}`);
            if (!isNaN(dateObj.getTime())) {
              startTimeISO = dateObj.toISOString();
            }
          }
          const zoomMeeting = await zoomService.createZoomMeeting({
            topic: `Follow-up Consultation for ${clientObj.firstName} ${clientObj.lastName}`,
            startTime: startTimeISO,
            durationMinutes: 30
          });
          if (zoomMeeting && zoomMeeting.joinUrl) {
            meetingLink = zoomMeeting.joinUrl;
            zoomMeetingId = zoomMeeting.meetingId;
          }
        } catch (zErr) {
          console.error('[ZOOM] Failed creating rebook Zoom link:', zErr.message);
        }
      }

      const consultation = await prisma.consultation.create({
        data: {
          clientId: clientObj.id,
          leadId: clientObj.lead?.id || null,
          date: meetingPreferredDate,
          timeSlot: meetingPreferredTime,
          durationMinutes: 30,
          type: 'follow_up',
          status: 'Scheduled',
          consultantId: clientObj.assignedToId || undefined,
          internalNotes: meetingNotes || 'Client Follow-up Rebook Meeting',
          meetingLink,
          zoomMeetingId
        }
      });

      const { sendCustomWhatsApp } = require('../services/chatbotService');
      const { sendAppointmentConfirmationEmail } = require('../services/emailService');
      const dayjs = require('dayjs');

      const formattedDate = meetingPreferredDate.includes('-') ? dayjs(meetingPreferredDate).format('DD/MM/YYYY') : meetingPreferredDate;
      const frontendUrl = process.env.FRONTEND_URL || 'https://aaa-crm-service.netlify.app';
      const rescheduleUrl = `${frontendUrl}/#/public/lead-form?reschedule=true&consultationId=${consultation.id}`;
      const cancelUrl = `${frontendUrl}/#/public/lead-form?cancel=true&consultationId=${consultation.id}`;
      const packagesUrl = "https://aaabusinessconsultancy.com/services-and-packages/";

      const clientFullName = `${clientObj.firstName || ''} ${clientObj.lastName || ''}`.trim() || 'Client';
      const targetPhone = phone || clientObj.phone || clientObj.lead?.phone;
      const targetEmail = email || clientObj.email || clientObj.lead?.email;

      const waMsg = `✈️ *Spain Visa Follow-up Consultation Confirmed!*

Dear *${clientFullName}*,

Thank you for rebooking your consultation meeting with *AAA Business Consultancy*! 🎉

📅 *Date:* ${formattedDate}
⏰ *Time:* ${meetingPreferredTime} (UAE)
🔗 *Meeting Join Link:* ${meetingLink}

─────────────
👇 *Quick Action Links:*
• 🔄 *Reschedule Booking:* ${rescheduleUrl}
• ❌ *Cancel Booking:* ${cancelUrl}
• 📦 *View Visa Packages:* ${packagesUrl}

_Note: Please join on time (within 10 minutes of appointment time to avoid automatic cancellation)._`;

      if (targetPhone) {
        sendCustomWhatsApp(targetPhone, waMsg).catch(e => console.error('[REBOOK WA Error]:', e.message));
        console.log(`[REBOOK WA Sent] Dispatched WhatsApp follow-up confirmation to ${targetPhone}`);
      }

      if (targetEmail) {
        sendAppointmentConfirmationEmail({
          to: targetEmail,
          firstName: clientObj.firstName || 'Client',
          date: meetingPreferredDate,
          timeSlot: meetingPreferredTime,
          meetingLink,
          consultationId: consultation.id
        }).catch(e => console.error('[REBOOK EMAIL Error]:', e.message));
        console.log(`[REBOOK Email Sent] Dispatched Email follow-up confirmation to ${targetEmail}`);
      }

      return res.json({
        success: true,
        message: 'Follow-up meeting booked successfully!',
        consultation,
        meetingLink
      });
    }

    const lead = await prisma.lead.update({
      where: { id },
      data: {
        firstName,
        lastName,
        phone,
        nationality,
        preferredLanguage,
        meetingPreferredDate,
        meetingPreferredTime,
        meetingPreferredLanguage,
        meetingNotes,
        qualificationData: qualificationData || undefined,
        serviceType: serviceType || serviceId || undefined,
        formSubmittedAt: new Date(),
        status: 'Form Submitted'
      }
    });

    // Auto-create/update consultation — runs in background, does NOT block response
    res.json({
      success: true,
      message: 'Shukriya! Aapki details save ho gayi hain. Hum jald hi aapse contact karenge.',
      lead: {
        id: lead.id,
        firstName: lead.firstName,
        formSubmittedAt: lead.formSubmittedAt
      }
    });

    // 🔔 Trigger In-App Notifications for all staff (same as createLead)
    const { createLeadNotification } = require('./notificationController');
    createLeadNotification({
      leadName: `${lead.firstName} ${lead.lastName}`,
      email: lead.email,
      phone: lead.phone,
      country: lead.countryOfResidence,
      serviceCategory: lead.serviceType,
      appointmentDate: lead.meetingPreferredDate ? `${lead.meetingPreferredDate} ${lead.meetingPreferredTime || ''}` : null,
      reqApp: req.app
    }).catch(err => console.error('[Meeting Pref Notification Error]:', err.message));

    if (req.app && lead.meetingPreferredDate && lead.meetingPreferredTime) {
      const io = req.app.get('io');
      if (io) {
        io.emit('public-slot-booked', {
          date: lead.meetingPreferredDate,
          timeSlot: lead.meetingPreferredTime
        });
      }
    }

    syncLeadConsultation(lead.id, req.app).catch(err => console.error('[BG] syncLeadConsultation failed:', err.message));

  } catch (error) {
    res.status(500).json({ message: 'Server error saving meeting preferences', error: error.message });
  }
}

// Sync Consultation Session and generate/update meeting details and link
async function syncLeadConsultation(leadId, reqApp = null) {
  // 1. In-Memory Mutex Lock: Prevent concurrent syncs for the exact same leadId
  if (activeBookingSyncLocks.has(leadId)) {
    console.log(`[SYNC LOCK] Sync already in progress for Lead ID: ${leadId}. Skipping redundant parallel trigger.`);
    return null;
  }
  activeBookingSyncLocks.add(leadId);

  try {
    console.log(`[BOOKING] Booking submission received for Lead ID: ${leadId}`);
    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        serviceType: true,
        meetingPreferredDate: true,
        meetingPreferredTime: true,
        meetingNotes: true,
        formSubmittedAt: true,
        assignedToId: true,
        clientId: true
      }
    });
    if (!lead) {
      console.log(`[BOOKING] Lead not found for Lead ID: ${leadId}`);
      return null;
    }

    console.log(`[BOOKING] Consultant assigned: ${lead.assignedToId || 'Unassigned'} for Lead: ${lead.firstName} ${lead.lastName}`);

    const isTranslation = (lead.serviceType || '').toLowerCase().includes('translation') || (lead.serviceType || '').toLowerCase().includes('sworn');
    if (isTranslation) {
      return null;
    }

    const { getCustomization } = require('./settingsController');
    const settings = getCustomization();
    const duration = settings.flowAutomationSettings?.defaultMeetingDuration || 30;

    let consultation = await prisma.consultation.findFirst({
      where: {
        OR: [
          { leadId: lead.id },
          ...(lead.clientId ? [{ clientId: lead.clientId }] : [])
        ]
      },
      orderBy: { createdAt: 'desc' }
    });

    const fallbackDate = lead.formSubmittedAt ? new Date(lead.formSubmittedAt).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
    const meetingDate = lead.meetingPreferredDate || fallbackDate;
    const meetingTime = lead.meetingPreferredTime || 'TBD / Flexible';

    // 2. Idempotency Check: Reuse existing Zoom link if already generated
    let meetingLink = consultation?.meetingLink || null;
    let zoomFailed = false;

    if (!meetingLink) {
      console.log(`[ZOOM] Creating meeting for ${lead.firstName} ${lead.lastName} on ${meetingDate} at ${meetingTime}`);
      const zoomService = require('../services/zoomService');
      if (zoomService.isConfigured) {
        try {
          let startTimeISO = new Date().toISOString();
          if (meetingDate) {
            const timeStr = meetingTime && meetingTime.includes(':') ? meetingTime : '10:00';
            const dateObj = new Date(`${meetingDate}T${timeStr}`);
            if (!isNaN(dateObj.getTime())) {
              startTimeISO = dateObj.toISOString();
            }
          }
          const zoomMeeting = await zoomService.createZoomMeeting({
            topic: `Eligibility Assessment for ${lead.firstName} ${lead.lastName}`,
            startTime: startTimeISO,
            durationMinutes: Number(duration) || 30
          });
          if (zoomMeeting && zoomMeeting.joinUrl) {
            meetingLink = zoomMeeting.joinUrl;
            console.log(`[ZOOM] Meeting created successfully: ${meetingLink}`);
          }
        } catch (zoomErr) {
          console.error('[ZOOM] Meeting creation failed:', zoomErr.message);
          zoomFailed = true;
        }
      }

      // Fallback: Generate mock/placeholder link if Zoom not configured
      if (!meetingLink && !zoomFailed) {
        console.log('[ZOOM] Zoom service not configured. Generating mock meeting link.');
        meetingLink = 'https://zoom.us/j/' + Math.floor(100000000 + Math.random() * 900000000);
      }
    } else {
      console.log(`[ZOOM] Reusing existing meetingLink for Consultation ID: ${consultation.id}: ${meetingLink}`);
    }

    // Determine Consultation status based on Zoom creation result
    const consultationStatus = (zoomFailed && !meetingLink) ? 'Pending Zoom' : (lead.assignedToId ? 'Scheduled' : 'Pending Assignment');

    if (!consultation) {
      consultation = await prisma.consultation.create({
        data: {
          date: meetingDate,
          timeSlot: meetingTime,
          durationMinutes: Number(duration),
          status: consultationStatus,
          leadId: lead.id,
          clientId: lead.clientId || null,
          consultantId: lead.assignedToId || null,
          internalNotes: lead.meetingNotes || '',
          meetingLink: meetingLink
        }
      });
      console.log(`[BOOKING] Created consultation (ID: ${consultation.id}) with status: ${consultationStatus}`);
    } else {
      const updatedStatus = (consultation.status === 'Cancelled' || consultation.status === 'Pending Assignment')
        ? (lead.assignedToId ? 'Scheduled' : 'Pending Assignment')
        : consultation.status;

      consultation = await prisma.consultation.update({
        where: { id: consultation.id },
        data: {
          date: meetingDate,
          timeSlot: meetingTime,
          status: updatedStatus,
          leadId: lead.id,
          clientId: lead.clientId || consultation.clientId || null,
          consultantId: lead.assignedToId || consultation.consultantId || null,
          internalNotes: lead.meetingNotes || consultation.internalNotes || '',
          meetingLink: meetingLink || consultation.meetingLink
        }
      });
      console.log(`[BOOKING] Updated consultation (ID: ${consultation.id}) with status: ${updatedStatus}`);
    }

    // Clean up any stale duplicate consultation cards for this lead/client for the exact same slot
    await prisma.consultation.deleteMany({
      where: {
        OR: [
          { leadId: lead.id },
          ...(lead.clientId ? [{ clientId: lead.clientId }] : [])
        ],
        id: { not: consultation.id },
        date: meetingDate,
        timeSlot: meetingTime,
        status: { in: ['Pending Acceptance', 'Scheduled', 'Pending Assignment'] }
      }
    }).catch(err => console.warn('[BOOKING] Cleanup duplicate consultation warning:', err.message));

    // Update Lead status to Meeting Scheduled if scheduled
    if (consultationStatus === 'Scheduled' || consultation.status === 'Scheduled') {
      await prisma.lead.update({
        where: { id: lead.id },
        data: { status: 'Meeting Scheduled' }
      }).catch(err => console.error('[BOOKING] Failed to update lead status:', err.message));
      console.log(`[BOOKING] Consultation marked Scheduled for Lead ID: ${lead.id}`);
    }

    // 3. Immediate Idempotent WhatsApp Confirmation for Lead
    if ((consultationStatus === 'Scheduled' || consultation.status === 'Scheduled') && meetingLink && lead.phone) {
      try {
        const dayjs = require('dayjs');
        const formattedDate = meetingDate ? (meetingDate.includes('-') ? dayjs(meetingDate).format('DD/MM/YYYY') : meetingDate) : meetingDate;

        // Strict Deduplication Check: Check if an identical WhatsApp booking confirmation was already sent to this phone for this date within the last 15 minutes
        const rawDigits = lead.phone.replace(/\D/g, '');
        const searchDigits = rawDigits.length >= 10 ? rawDigits.slice(-10) : rawDigits;
        const recentCutoff = new Date(Date.now() - 15 * 60 * 1000);

        const existingLog = await prisma.communicationLog.findFirst({
          where: {
            channel: 'WHATSAPP',
            direction: 'OUTBOUND',
            createdAt: { gte: recentCutoff },
            phone: { contains: searchDigits }
          },
          orderBy: { createdAt: 'desc' }
        });

        const isAlreadySent = Boolean(
          existingLog &&
          existingLog.content &&
          existingLog.content.includes('Spain Visa Consultation Confirmed') &&
          existingLog.content.includes(formattedDate) &&
          (meetingTime === 'TBD / Flexible' || existingLog.content.includes(meetingTime))
        );

        if (!isAlreadySent) {
          console.log(`[WHATSAPP] Dispatching single booking confirmation for Lead: ${lead.firstName} ${lead.lastName} (${lead.phone})`);
          
          const frontendUrl = process.env.FRONTEND_URL || 'https://aaa-crm-service.netlify.app';
          const rescheduleUrl = `${frontendUrl}/#/public/lead-form?reschedule=true&consultationId=${consultation.id}`;
          const cancelUrl = `${frontendUrl}/#/public/lead-form?cancel=true&consultationId=${consultation.id}`;
          const packagesUrl = 'https://aaabusinessconsultancy.com/services-and-packages/';
          const clientName = `${lead.firstName || ''} ${lead.lastName || ''}`.trim() || 'Valued Client';

          const messageBody = `✈️ *Spain Visa Consultation Confirmed!*\n\nDear *${clientName}*,\n\nYour Free Spain Visa Eligibility Assessment with *AAA Business Consultancy* has been scheduled successfully! 🎉\n\n📅 *Date:* ${formattedDate}\n⏰ *Time:* ${meetingTime} (UAE)\n🔗 *Meeting Join Link:* ${meetingLink}\n\n─────────────\n👇 *Quick Action Links:*\n• 🔄 *Reschedule Booking:* ${rescheduleUrl}\n• ❌ *Cancel Booking:* ${cancelUrl}\n• 📦 *View Visa Packages:* ${packagesUrl}\n\n_Note: Please join within 10 minutes of appointment time to avoid automatic cancellation._`;

          const { sendCustomWhatsApp } = require('../services/chatbotService');
          await sendCustomWhatsApp(lead.phone, messageBody, { name: clientName, externalProviderId: consultation.id }).catch(err => console.error('[WHATSAPP Direct Send Error]:', err.message));
        } else {
          console.log(`[WHATSAPP] Booking confirmation already dispatched for ${lead.phone} on ${formattedDate} (${meetingTime}). Skipping duplicate.`);
        }
      } catch (waErr) {
        console.error('[WHATSAPP] Confirmation failed:', waErr.message);
      }
    }

    // 4. Immediate Email Confirmation for User (Applicant) and Admin Notification (Runs for every booking)
    try {
      const { sendAppointmentConfirmationEmail, sendEmail } = require('../services/emailService');
      const clientName = `${lead.firstName || ''} ${lead.lastName || ''}`.trim();
      const adminSenderEmail = process.env.RESEND_FROM_EMAIL || process.env.SMTP_USER || 'client@aaabusinessconsultancy.com';
      const mLink = meetingLink || consultation.meetingLink || 'https://zoom.us';
      const mDate = meetingDate || consultation.date || 'TBD';
      const mTime = meetingTime || consultation.timeSlot || 'TBD';

      // Send Confirmation Email to User/Applicant
      if (lead.email) {
        sendAppointmentConfirmationEmail({
          to: lead.email,
          firstName: lead.firstName || 'Client',
          date: mDate,
          timeSlot: mTime,
          meetingLink: mLink,
          consultationId: consultation.id
        })
        .then(() => console.log(`[BOOKING EMAIL] Sent confirmation email to user ${lead.email}`))
        .catch(err => console.error('[BOOKING EMAIL] User email failed:', err.message));
      }

      // Send Booking Notification Email to Admin/Sender
      sendEmail({
        to: adminSenderEmail,
        subject: `🔔 New Assessment Booking Received: ${clientName} (${mDate} at ${mTime})`,
        html: `
          <div style="font-family: Arial, sans-serif; padding: 20px; color: #1e293b;">
            <h2 style="color: #0f172a;">📅 New Assessment Consultation Booked</h2>
            <p>A new consultation has been booked on the website portal.</p>
            <hr style="border: 1px solid #e2e8f0; margin: 15px 0;" />
            <ul style="line-height: 1.8;">
              <li><b>Client Name:</b> ${clientName}</li>
              <li><b>Email:</b> ${lead.email || 'N/A'}</li>
              <li><b>Phone:</b> ${lead.phone || 'N/A'}</li>
              <li><b>Service Category:</b> ${lead.serviceType || 'Spain Visa / Residency'}</li>
              <li><b>Date:</b> ${mDate}</li>
              <li><b>Time:</b> ${mTime} (UAE)</li>
              <li><b>Zoom Link:</b> <a href="${mLink}">${mLink}</a></li>
            </ul>
            <br/>
            <p><b>AAA Business Consultancy CRM System</b></p>
          </div>
        `
      })
      .then(() => console.log(`[BOOKING EMAIL] Sent notification email to Admin (${adminSenderEmail})`))
      .catch(err => console.error('[BOOKING EMAIL] Admin notification failed:', err.message));

    } catch (emailErr) {
      console.error('[BOOKING EMAIL] Error invoking email dispatch:', emailErr.message);
    }

    // 5. Socket.io Notification to CRM Staff
    try {
      if (reqApp) {
        const io = reqApp.get('io');
        if (io) {
          io.to('role:admin').to('role:consultant').to(`user:${lead.assignedToId}`).emit('new_booking', {
            consultation,
            lead
          });
          console.log(`[SOCKET] new_booking emitted for Consultation ID: ${consultation.id}`);
        }
      }
    } catch (socketErr) {
      console.warn('[SOCKET] Broadcast warning:', socketErr.message);
    }

    return consultation;
  } catch (error) {
    console.error('Error in syncLeadConsultation:', error);
    return null;
  } finally {
    activeBookingSyncLocks.delete(leadId);
  }
}

module.exports = { 
  getLeads, 
  createLead, 
  assignLead, 
  updateLeadStatus, 
  deleteLead,
  getLeadById, 
  updateLead, 
  getPublicLeadDetails, 
  updateMeetingPreference,
  syncLeadConsultation
};


