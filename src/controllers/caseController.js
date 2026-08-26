const fs = require('fs');
const crypto = require('crypto');
const prisma = require('../config/db');
const { logActivity } = require('../services/auditService');

const getFileUrl = (file) => {
  if (!file) return '';
  if (file.location) return file.location;
  if (file.path) {
    try {
      if (fs.existsSync(file.path)) {
        const fileBuffer = fs.readFileSync(file.path);
        const mimeType = file.mimetype || 'application/pdf';
        return `data:${mimeType};base64,${fileBuffer.toString('base64')}`;
      }
    } catch (err) {
      console.warn('[getFileUrl] Could not convert file to Data URI:', err.message);
    }
  }
  return `/uploads/${file.filename}`;
};

// Default checklist item templates generated when a resubmission cycle is created
const DEFAULT_CHECKLIST_TEMPLATES = [
  {
    templateKey: 'passport_main',
    belongsTo: 'Main Applicant',
    category: 'Identity Documents',
    title: 'Passport Copy (Main Applicant)',
    isMandatory: true,
    clientInstructions: 'High-resolution color scan of all pages including blank pages.'
  },
  {
    templateKey: 'rejection_letter',
    belongsTo: 'Main Applicant',
    category: 'Official Notices',
    title: 'Embassy Rejection Notice',
    isMandatory: true,
    clientInstructions: 'Complete official refusal letter issued by the embassy/consulate.'
  },
  {
    templateKey: 'proof_income',
    belongsTo: 'Main Applicant',
    category: 'Financial Documents',
    title: 'Proof of Income / Employment',
    isMandatory: true,
    clientInstructions: 'Recent payslips, employment certificate, or tax returns for the last 12 months.'
  },
  {
    templateKey: 'bank_statement',
    belongsTo: 'Main Applicant',
    category: 'Financial Documents',
    title: '6-Month Bank Statement',
    isMandatory: true,
    clientInstructions: 'Official bank statement showing sufficient funds and regular income.'
  },
  {
    templateKey: 'cover_letter',
    belongsTo: 'Main Applicant',
    category: 'Application Forms',
    title: 'Updated Cover Letter & Resubmission Summary',
    isMandatory: true,
    clientInstructions: 'Detailed letter explaining how previous refusal points have been addressed.'
  }
];

const getActiveCases = async (req, res) => {
  try {
    const activeCases = await prisma.client.findMany({
      where: {
        OR: [
          { status: { notIn: ['Closed', 'Refused'] } },
          {
            applicationCycles: {
              some: {
                status: { in: ['Resubmission in Progress', 'Ready for Resubmission', 'Appeal in Progress'] }
              }
            }
          }
        ]
      },
      include: {
        assignedTo: { select: { fullName: true } },
        applicationCycles: true
      },
      orderBy: { createdAt: 'desc' }
    });
    
    const mapped = activeCases.map(c => ({
      ...c,
      onboardingDate: c.createdAt,
      name: `${c.firstName} ${c.lastName}`,
      assignedConsultantName: c.assignedTo?.fullName
    }));
    
    res.json(mapped);
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching active cases' });
  }
};

const getClosedCases = async (req, res) => {
  try {
    const closedCases = await prisma.client.findMany({
      where: {
        status: { in: ['Closed', 'Refused'] },
        NOT: {
          applicationCycles: {
            some: {
              status: { in: ['Resubmission in Progress', 'Ready for Resubmission', 'Appeal in Progress'] }
            }
          }
        }
      },
      include: {
        assignedTo: { select: { fullName: true } },
        applicationCycles: true
      },
      orderBy: { createdAt: 'desc' }
    });
    
    const mapped = closedCases.map(c => ({
      ...c,
      onboardingDate: c.createdAt,
      name: `${c.firstName} ${c.lastName}`,
      assignedConsultantName: c.assignedTo?.fullName
    }));
    
    res.json(mapped);
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching closed cases' });
  }
};

const getCyclesByClient = async (req, res) => {
  try {
    const { clientId } = req.params;
    const userRole = req.user?.role;
    const userId = req.user?.id;

    // Check client ownership for client role
    if (userRole === 'client' && userId !== clientId) {
      return res.status(403).json({ message: 'Access denied. You can only view your own application cycles.' });
    }

    // Check consultant assignment for consultant role
    if (userRole === 'consultant') {
      const clientObj = await prisma.client.findUnique({ where: { id: clientId } });
      if (clientObj && clientObj.assignedToId !== userId) {
        return res.status(403).json({ message: 'Access denied. You can only view application cycles for clients assigned to you.' });
      }
    }

    const cycles = await prisma.applicationCycle.findMany({
      where: { clientId },
      include: {
        checklistItems: {
          include: {
            activeDocument: true,
            documents: { orderBy: { version: 'desc' } }
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    // Sanitization per role
    const sanitized = cycles.map(cycle => {
      if (userRole === 'client' || userRole === 'operations' || userRole === 'finance') {
        const { appealDocuments, ...rest } = cycle;
        let sanitizedDocs = null;
        if (appealDocuments && typeof appealDocuments === 'object') {
          const { notes, strategy, internalNotes, ...publicDocs } = appealDocuments;
          sanitizedDocs = publicDocs;
        }
        return {
          ...rest,
          appealDocuments: sanitizedDocs
        };
      }
      return cycle;
    });

    res.json(sanitized);
  } catch (error) {
    console.error('Error in getCyclesByClient:', error);
    res.status(500).json({ message: 'Server error fetching application cycles' });
  }
};

const createCycle = async (req, res) => {
  try {
    const { 
      clientId, 
      type, 
      refusalReason, 
      refusalDate, 
      originalSubmissionDate,
      changesMade,
      lawyerAssigned, 
      appealSubmissionDate,
      appealDeadline, 
      appealDocuments,
      serviceType 
    } = req.body;

    if (!clientId) {
      return res.status(400).json({ message: 'clientId is required' });
    }

    const userRole = req.user?.role;
    const userId = req.user?.id;

    // 1. Fetch target Client
    const client = await prisma.client.findUnique({ where: { id: clientId } });
    if (!client) {
      return res.status(404).json({ message: 'Client not found' });
    }

    // 2. Consultant Assignment Safeguard (Guard 1)
    if (userRole === 'consultant' && client.assignedToId !== userId) {
      return res.status(403).json({ message: 'Access denied. You can only initiate application cycles for clients assigned to you.' });
    }

    // 3. Refusal Prerequisite Safeguard (Guard 6)
    const refusedVisaStatuses = ['Refused', 'Visa Refused', 'Rejected', 'Final Refusal'];
    const isClientRefused = refusedVisaStatuses.includes(client.visaStatus) || client.status === 'Refused';
    if (!isClientRefused) {
      return res.status(400).json({ message: 'Invalid transition: A new cycle can only be initiated for refused applications.' });
    }

    // 4. Duplicate Active Cycle Safeguard (Guard 5)
    const activeCycle = await prisma.applicationCycle.findFirst({
      where: {
        clientId,
        status: { in: ['Resubmission in Progress', 'Ready for Resubmission', 'Appeal in Progress'] }
      }
    });

    if (activeCycle) {
      return res.status(409).json({
        message: `Cannot initiate a new cycle. Client already has an active ${activeCycle.type} cycle (${activeCycle.status}).`
      });
    }

    const cycleType = (type || 'resubmission').toLowerCase();
    const isAppeal = cycleType === 'appeal';
    const initialStatus = isAppeal ? 'Appeal in Progress' : 'Resubmission in Progress';
    const actorName = req.user ? (req.user.fullName || req.user.email) : 'Consultant';

    // Atomic Transaction: Create Cycle + Default Checklist Items
    const result = await prisma.$transaction(async (tx) => {
      const cycle = await tx.applicationCycle.create({
        data: {
          clientId,
          type: type || 'resubmission',
          status: initialStatus,
          serviceType: serviceType || client.serviceType || 'Resubmission Package',
          originalSubmissionDate: originalSubmissionDate ? new Date(originalSubmissionDate) : (client.createdAt || new Date()),
          refusalReason: refusalReason || client.refusalReason || 'Visa Refused',
          refusalDate: refusalDate ? new Date(refusalDate) : new Date(),
          changesMade: changesMade || null,
          resubmissionDate: null,
          lawyerAssigned: lawyerAssigned || null,
          appealSubmissionDate: appealSubmissionDate ? new Date(appealSubmissionDate) : (isAppeal ? new Date() : null),
          appealDeadline: appealDeadline ? new Date(appealDeadline) : null,
          appealDocuments: appealDocuments || null
        }
      });

      // Generate default checklist items for resubmission cycle
      let createdItems = [];
      if (!isAppeal) {
        const templates = [...DEFAULT_CHECKLIST_TEMPLATES];
        if (client.applicantsCount && client.applicantsCount.toLowerCase().includes('spouse')) {
          templates.push({
            templateKey: 'passport_spouse',
            belongsTo: 'Spouse',
            category: 'Identity Documents',
            title: 'Passport Copy (Spouse)',
            isMandatory: true,
            clientInstructions: 'High-resolution color scan of spouse passport.'
          });
        }

        await tx.resubmissionChecklistItem.createMany({
          data: templates.map(tpl => ({
            applicationId: cycle.id,
            templateKey: tpl.templateKey,
            belongsTo: tpl.belongsTo,
            category: tpl.category,
            title: tpl.title,
            isMandatory: tpl.isMandatory,
            clientInstructions: tpl.clientInstructions,
            status: 'MISSING'
          }))
        });

        createdItems = await tx.resubmissionChecklistItem.findMany({
          where: { applicationId: cycle.id },
          orderBy: { createdAt: 'asc' }
        });
      }

      // Update client.visaStatus ONLY (Preserve client.status untouched)
      await tx.client.update({
        where: { id: clientId },
        data: { visaStatus: initialStatus }
      });

      return { ...cycle, checklistItems: createdItems };
    });

    // Log Activity Timeline
    logActivity({
      clientId,
      actorId: userId || 'staff',
      actorName,
      actorRole: userRole || 'staff',
      action: isAppeal ? 'APPEAL_INITIATED' : 'RESUBMISSION_INITIATED',
      description: isAppeal 
        ? `Legal Appeal initiated by ${actorName}. Lawyer assigned: ${lawyerAssigned || 'TBD'}. Deadline: ${appealDeadline || 'Not set'}.`
        : `Resubmission initiated by ${actorName}. Refusal Reason: "${refusalReason || 'None'}". Automatic checklist items generated.`
    });

    res.status(201).json(result);
  } catch (error) {
    console.error('Error creating application cycle:', error);
    res.status(500).json({ message: 'Server error creating application cycle', error: error.message });
  }
};

const updateCycle = async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      status, 
      lawyerAssigned, 
      refusalReason, 
      changesMade,
      resubmissionDate,
      appealSubmissionDate,
      appealDeadline, 
      appealDocuments,
      governmentDecision,
      governmentDecisionDate
    } = req.body;

    const userRole = req.user?.role;
    const userId = req.user?.id;
    const actorName = req.user ? (req.user.fullName || req.user.email) : 'Staff';

    // 1. Fetch existing cycle
    const existingCycle = await prisma.applicationCycle.findUnique({ where: { id } });
    if (!existingCycle) {
      return res.status(404).json({ message: 'Application cycle not found' });
    }

    // 2. Consultant Assignment Safeguard (Guard 1)
    if (userRole === 'consultant') {
      const clientObj = await prisma.client.findUnique({ where: { id: existingCycle.clientId } });
      if (clientObj && clientObj.assignedToId !== userId) {
        return res.status(403).json({ message: 'Access denied. You can only update application cycles for clients assigned to you.' });
      }
    }

    // 3. Transition Sequence Matrix Safeguard & Manual Ready Validation
    if (status && status !== existingCycle.status) {
      const current = existingCycle.status;
      let isValidTransition = false;

      if (current === 'Resubmission in Progress') {
        isValidTransition = status === 'Ready for Resubmission';
      } else if (current === 'Ready for Resubmission') {
        isValidTransition = status === 'Resubmitted';
      } else if (current === 'Appeal in Progress') {
        isValidTransition = status === 'Appeal Approved' || status === 'Appeal Refused';
      } else if (current === 'Resubmitted') {
        isValidTransition = true; // Governed by governmentDecision recording
      }

      if (!isValidTransition) {
        return res.status(400).json({
          message: `Invalid status transition from '${current}' to '${status}'.`
        });
      }

      // Requirement 5: Validate Manual Ready for Resubmission
      if (status === 'Ready for Resubmission') {
        const cycleItems = await prisma.resubmissionChecklistItem.findMany({
          where: { applicationId: id }
        });

        const activeMandatoryItems = cycleItems.filter(i => i.isMandatory && i.status !== 'NOT_REQUIRED');

        if (activeMandatoryItems.length === 0) {
          return res.status(400).json({
            message: "Cannot transition status to 'Ready for Resubmission'. Checklist contains no active mandatory items.",
            incompleteCount: 0,
            incompleteItems: []
          });
        }

        const incompleteItems = activeMandatoryItems
          .filter(i => i.status !== 'VERIFIED')
          .map(i => ({ title: i.title, status: i.status }));

        if (incompleteItems.length > 0) {
          return res.status(400).json({
            message: `Cannot transition cycle status to 'Ready for Resubmission'. ${incompleteItems.length} mandatory checklist item(s) remain unverified.`,
            incompleteCount: incompleteItems.length,
            incompleteItems: incompleteItems
          });
        }
      }
    }

    const cycle = await prisma.applicationCycle.update({
      where: { id },
      data: {
        status: status || undefined,
        lawyerAssigned: lawyerAssigned || undefined,
        refusalReason: refusalReason || undefined,
        changesMade: changesMade || undefined,
        resubmissionDate: resubmissionDate ? new Date(resubmissionDate) : undefined,
        appealSubmissionDate: appealSubmissionDate ? new Date(appealSubmissionDate) : undefined,
        appealDeadline: appealDeadline ? new Date(appealDeadline) : undefined,
        appealDocuments: appealDocuments || undefined,
        governmentDecision: governmentDecision || undefined,
        governmentDecisionDate: governmentDecisionDate ? new Date(governmentDecisionDate) : undefined
      }
    });

    // Update Client Visa Status according to cycle status (Leave client.status untouched)
    let clientVisaStatus = undefined;
    if (status === 'Resubmission in Progress') clientVisaStatus = 'Resubmission in Progress';
    if (status === 'Ready for Resubmission') clientVisaStatus = 'Ready for Resubmission';
    if (status === 'Resubmitted') clientVisaStatus = 'Resubmitted';
    if (status === 'Appeal in Progress') clientVisaStatus = 'Appeal in Progress';
    if (status === 'Appeal Approved' || governmentDecision === 'Approved') clientVisaStatus = 'Visa Approved';
    if (status === 'Appeal Refused' || governmentDecision === 'Refused') clientVisaStatus = 'Visa Refused';

    if (clientVisaStatus) {
      await prisma.client.update({
        where: { id: cycle.clientId },
        data: { visaStatus: clientVisaStatus }
      });
    }

    // Log Activity Timeline
    logActivity({
      clientId: cycle.clientId,
      actorId: userId || 'staff',
      actorName,
      actorRole: userRole || 'staff',
      action: 'CYCLE_STATUS_UPDATED',
      description: `Case cycle updated to "${status || cycle.status}". Government Decision: ${governmentDecision || cycle.governmentDecision || 'Pending'}. Updated by ${actorName}.`
    });

    res.json(cycle);
  } catch (error) {
    console.error('Error updating application cycle:', error);
    res.status(500).json({ message: 'Server error updating application cycle', error: error.message });
  }
};

const getCycleChecklist = async (req, res) => {
  try {
    const cycleId = req.params.cycleId || req.params.id;
    const userRole = req.user?.role;
    const userId = req.user?.id;

    const cycle = await prisma.applicationCycle.findUnique({
      where: { id: cycleId },
      include: { client: true }
    });

    if (!cycle) {
      return res.status(404).json({ message: 'Application cycle not found' });
    }

    if (userRole === 'client' && cycle.clientId !== userId) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    if (userRole === 'consultant' && cycle.client?.assignedToId !== userId) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const items = await prisma.resubmissionChecklistItem.findMany({
      where: { applicationId: cycleId },
      include: {
        activeDocument: {
          include: {
            reviewedBy: { select: { fullName: true, email: true } }
          }
        },
        sourceDocument: true,
        documents: {
          orderBy: { version: 'desc' },
          include: {
            reviewedBy: { select: { fullName: true, email: true } }
          }
        }
      },
      orderBy: { createdAt: 'asc' }
    });

    res.json(items);
  } catch (error) {
    console.error('Error in getCycleChecklist:', error);
    res.status(500).json({ message: 'Server error fetching checklist' });
  }
};

const addChecklistItem = async (req, res) => {
  try {
    const { applicationId, title, category, belongsTo, isMandatory, dueDate, clientInstructions } = req.body;
    
    if (!applicationId || !title || !category) {
      return res.status(400).json({ message: 'applicationId, title, and category are required' });
    }

    const cycle = await prisma.applicationCycle.findUnique({ where: { id: applicationId } });
    if (!cycle) {
      return res.status(404).json({ message: 'Application cycle not found' });
    }

    const item = await prisma.resubmissionChecklistItem.create({
      data: {
        applicationId,
        templateKey: `custom_${crypto.randomUUID()}`,
        title,
        category,
        belongsTo: belongsTo || 'Main Applicant',
        isMandatory: isMandatory !== undefined ? isMandatory : true,
        dueDate: dueDate ? new Date(dueDate) : null,
        clientInstructions: clientInstructions || null,
        status: 'MISSING'
      }
    });

    logActivity({
      clientId: cycle.clientId,
      actorId: req.user?.id || 'staff',
      actorName: req.user ? (req.user.fullName || req.user.email) : 'Consultant',
      actorRole: req.user?.role || 'consultant',
      action: 'CHECKLIST_ITEM_ADDED',
      description: `Added custom checklist item "${title}" for ${belongsTo || 'Main Applicant'}.`
    });

    res.status(201).json(item);
  } catch (error) {
    console.error('Error adding checklist item:', error);
    res.status(500).json({ message: 'Server error adding checklist item' });
  }
};

const updateChecklistItem = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, category, belongsTo, isMandatory, dueDate, clientInstructions, status } = req.body;

    const existing = await prisma.resubmissionChecklistItem.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ message: 'Checklist item not found' });
    }

    const item = await prisma.resubmissionChecklistItem.update({
      where: { id },
      data: {
        title: title !== undefined ? title : existing.title,
        category: category !== undefined ? category : existing.category,
        belongsTo: belongsTo !== undefined ? belongsTo : existing.belongsTo,
        isMandatory: isMandatory !== undefined ? isMandatory : existing.isMandatory,
        dueDate: dueDate ? new Date(dueDate) : existing.dueDate,
        clientInstructions: clientInstructions !== undefined ? clientInstructions : existing.clientInstructions,
        status: status !== undefined ? status : existing.status
      }
    });

    res.json(item);
  } catch (error) {
    console.error('Error updating checklist item:', error);
    res.status(500).json({ message: 'Server error updating checklist item' });
  }
};

const deleteChecklistItem = async (req, res) => {
  try {
    const { id } = req.params;

    const item = await prisma.resubmissionChecklistItem.findUnique({
      where: { id },
      include: {
        applicationCycle: true,
        documents: true
      }
    });

    if (!item) {
      return res.status(404).json({ message: 'Checklist item not found' });
    }

    const cycleStatus = item.applicationCycle.status;
    const hasUploadedDocs = item.documents && item.documents.length > 0;

    // Rule 2 Enforcement:
    if (cycleStatus === 'Resubmission in Progress' && !hasUploadedDocs && !item.sourceDocumentId && !item.activeDocumentId) {
      // Hard delete allowed only if zero upload/review history & cycle is Resubmission in Progress
      await prisma.resubmissionChecklistItem.delete({ where: { id } });
      
      logActivity({
        clientId: item.applicationCycle.clientId,
        actorId: req.user?.id || 'staff',
        actorName: req.user ? (req.user.fullName || req.user.email) : 'Staff',
        actorRole: req.user?.role || 'staff',
        action: 'CHECKLIST_ITEM_DELETED',
        description: `Hard-deleted checklist item "${item.title}" (no uploads/history).`
      });

      return res.json({ success: true, deleted: true, status: 'DELETED' });
    } else {
      // Mark as NOT_REQUIRED to preserve complete document and review history
      const updated = await prisma.resubmissionChecklistItem.update({
        where: { id },
        data: { status: 'NOT_REQUIRED' }
      });

      logActivity({
        clientId: item.applicationCycle.clientId,
        actorId: req.user?.id || 'staff',
        actorName: req.user ? (req.user.fullName || req.user.email) : 'Staff',
        actorRole: req.user?.role || 'staff',
        action: 'CHECKLIST_ITEM_MARKED_NOT_REQUIRED',
        description: `Marked checklist item "${item.title}" as NOT_REQUIRED to preserve document history.`
      });

      return res.json({ success: true, deleted: false, status: 'NOT_REQUIRED', item: updated });
    }
  } catch (error) {
    console.error('Error deleting checklist item:', error);
    res.status(500).json({ message: 'Server error deleting checklist item' });
  }
};

// Requirement 4: Helper for Storage Orphan Cleanup
const deleteUploadedOrphanFile = async (file) => {
  if (!file) return;
  try {
    const fs = require('fs');
    if (file.path && fs.existsSync(file.path)) {
      fs.unlink(file.path, (err) => {
        if (err) console.error('[Storage Cleanup Error] Failed to delete local orphan file:', err.message);
      });
    } else if (file.key || file.filename) {
      const isAwsConfigured = process.env.AWS_ACCESS_KEY_ID && 
        process.env.AWS_SECRET_ACCESS_KEY && 
        process.env.AWS_BUCKET_NAME && 
        !process.env.AWS_ACCESS_KEY_ID.includes('your_aws');

      if (isAwsConfigured) {
        const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
        const s3 = new S3Client({
          region: process.env.AWS_REGION || 'eu-west-1',
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
          }
        });
        const key = file.key || `documents/${file.filename}`;
        await s3.send(new DeleteObjectCommand({
          Bucket: process.env.AWS_BUCKET_NAME,
          Key: key
        }));
      }
    }
  } catch (err) {
    console.error('[Storage Cleanup Exception] Non-fatal orphan cleanup error:', err.message);
  }
};

const uploadChecklistDoc = async (req, res) => {
  try {
    const { id } = req.params; // checklistItemId

    const item = await prisma.resubmissionChecklistItem.findUnique({
      where: { id },
      include: { applicationCycle: { include: { client: true } } }
    });

    if (!item) {
      if (req.file) await deleteUploadedOrphanFile(req.file);
      return res.status(404).json({ message: 'Checklist item not found' });
    }

    const client = item.applicationCycle?.client;
    if (!client) {
      if (req.file) await deleteUploadedOrphanFile(req.file);
      return res.status(404).json({ message: 'Associated client record not found' });
    }

    // Backend Role & Ownership Validation (Requirement 2B)
    const userRole = req.user?.role;
    const userId = req.user?.id;
    const userEmail = req.user?.email;

    if (userRole === 'client') {
      if (userId !== client.id && userEmail !== client.email) {
        if (req.file) await deleteUploadedOrphanFile(req.file);
        return res.status(403).json({ message: 'Access denied. You can only upload documents for your own checklist.' });
      }
    } else if (userRole === 'consultant') {
      if (client.assignedToId && client.assignedToId !== userId) {
        if (req.file) await deleteUploadedOrphanFile(req.file);
        return res.status(403).json({ message: 'Access denied. You are not the assigned consultant for this client.' });
      }
    } else if (['operations', 'finance', 'marketing'].includes(userRole)) {
      if (req.file) await deleteUploadedOrphanFile(req.file);
      return res.status(403).json({ message: 'Access denied. Operations, Finance, and Marketing roles cannot upload checklist documents.' });
    } else if (!['super_admin', 'admin'].includes(userRole)) {
      if (req.file) await deleteUploadedOrphanFile(req.file);
      return res.status(403).json({ message: 'Access denied. Unauthorized role.' });
    }

    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    // Versioning logic: Find highest current version for this checklist item
    const lastDoc = await prisma.document.findFirst({
      where: { checklistItemId: id },
      orderBy: { version: 'desc' }
    });
    const nextVersion = lastDoc ? lastDoc.version + 1 : 1;

    // Create Document version record
    let document;
    try {
      document = await prisma.document.create({
        data: {
          clientId: item.applicationCycle.clientId,
          applicationId: item.applicationId,
          checklistItemId: id,
          version: nextVersion,
          name: req.file.originalname,
          category: item.category,
          url: getFileUrl(req.file),
          size: `${(req.file.size / 1024 / 1024).toFixed(2)} MB`,
          status: 'PENDING_VERIFICATION',
          belongsTo: item.belongsTo || 'Main Applicant'
        }
      });

      // Update active document and set item status to PENDING_VERIFICATION
      await prisma.resubmissionChecklistItem.update({
        where: { id },
        data: {
          activeDocumentId: document.id,
          status: 'PENDING_VERIFICATION'
        }
      });
    } catch (dbError) {
      // Requirement 4: Clean up storage orphan if DB insertion fails
      await deleteUploadedOrphanFile(req.file);
      throw dbError;
    }

    logActivity({
      clientId: item.applicationCycle.clientId,
      documentId: document.id,
      actorId: req.user?.id || 'client',
      actorName: req.user ? (req.user.fullName || req.user.email) : 'Client',
      actorRole: req.user?.role || 'client',
      action: 'CHECKLIST_DOC_UPLOADED',
      description: `Uploaded version V${nextVersion} for checklist item "${item.title}".`
    });

    // Trigger central multi-channel document notifications (WhatsApp, Email, CRM)
    const { createDocumentNotification } = require('./notificationController');
    createDocumentNotification({
      userId: client.assignedToId,
      clientName: client ? `${client.firstName} ${client.lastName}` : 'Client',
      clientId: client.id,
      documentId: document.id,
      documentName: req.file.originalname,
      category: item.category || 'Checklist Document',
      reqApp: req.app
    }).catch(err => console.error('[Checklist Upload Notification Error]:', err.message));

    res.status(201).json(document);
  } catch (error) {
    if (req.file) await deleteUploadedOrphanFile(req.file);
    console.error('Error uploading checklist document:', error);
    res.status(500).json({ message: 'Server error uploading checklist document' });
  }
};

const reviewChecklistDoc = async (req, res) => {
  try {
    const { documentId } = req.params;
    const { status, comment } = req.body; // status: 'VERIFIED' | 'REJECTED'

    if (!['VERIFIED', 'REJECTED'].includes(status)) {
      return res.status(400).json({ message: 'Status must be VERIFIED or REJECTED' });
    }

    if (status === 'REJECTED' && (!comment || comment.trim() === '')) {
      return res.status(400).json({ message: 'Rejection reason is mandatory when rejecting a document.' });
    }

    const doc = await prisma.document.findUnique({
      where: { id: documentId },
      include: { checklistItem: true, client: true }
    });

    if (!doc) {
      return res.status(404).json({ message: 'Document not found' });
    }

    // Requirement 3: Confirm document is the latest active document version
    if (doc.checklistItemId) {
      const checklistItem = await prisma.resubmissionChecklistItem.findUnique({
        where: { id: doc.checklistItemId }
      });

      if (checklistItem && checklistItem.activeDocumentId && doc.id !== checklistItem.activeDocumentId) {
        return res.status(409).json({
          message: 'Only the latest active document version can be reviewed.'
        });
      }
    }

    // Update document status & review notes
    const updatedDoc = await prisma.document.update({
      where: { id: documentId },
      data: {
        status: status,
        comment: comment || null,
        reviewedById: req.user?.id || null,
        reviewedAt: new Date()
      }
    });

    // If this doc is linked to a checklist item, update item status
    let cycleAutoUpdated = false;
    if (doc.checklistItemId) {
      await prisma.resubmissionChecklistItem.update({
        where: { id: doc.checklistItemId },
        data: { status }
      });

      // Check Readiness Guard for cycle:
      // If ALL mandatory items (isMandatory: true AND status != 'NOT_REQUIRED') are VERIFIED, transition cycle to Ready for Resubmission
      const cycleItems = await prisma.resubmissionChecklistItem.findMany({
        where: { applicationId: doc.applicationId }
      });

      const mandatoryItems = cycleItems.filter(i => i.isMandatory && i.status !== 'NOT_REQUIRED');
      const allMandatoryVerified = mandatoryItems.length > 0 && mandatoryItems.every(i => i.status === 'VERIFIED');

      if (allMandatoryVerified) {
        await prisma.applicationCycle.update({
          where: { id: doc.applicationId },
          data: { status: 'Ready for Resubmission' }
        });

        await prisma.client.update({
          where: { id: doc.clientId },
          data: { visaStatus: 'Ready for Resubmission' }
        });

        cycleAutoUpdated = true;

        logActivity({
          clientId: doc.clientId,
          actorId: 'system',
          actorName: 'System Policy Engine',
          actorRole: 'system',
          action: 'CYCLE_READY_FOR_RESUBMISSION',
          description: `All mandatory checklist items verified. Application Cycle automatically transitioned to "Ready for Resubmission".`
        });
      }
    }

    logActivity({
      clientId: doc.clientId,
      documentId: doc.id,
      actorId: req.user?.id || 'operations',
      actorName: req.user ? (req.user.fullName || req.user.email) : 'Operations Staff',
      actorRole: req.user?.role || 'operations',
      action: status === 'VERIFIED' ? 'DOC_VERIFIED' : 'DOC_REJECTED',
      description: `Operations staff marked document "${doc.name}" as ${status}.${comment ? ` Rejection Reason: "${comment}"` : ''}`
    });

    // Send instant automated WhatsApp & Email notification to Client
    if (doc.client) {
      try {
        const { sendEmail } = require('../services/emailService');
        const { sendCustomWhatsApp } = require('../services/chatbotService');
        const frontendUrl = (process.env.FRONTEND_URL || 'https://aaa-crm-service.netlify.app').replace(/\/$/, '');
        const portalUrl = `${frontendUrl}/#/portal/login`;
        const clientName = `${doc.client.firstName || ''} ${doc.client.lastName || ''}`.trim() || 'Client';
        const docDisplayName = doc.name || doc.category || 'Document';

        if (status === 'VERIFIED') {
          if (doc.client.email) {
            sendEmail({
              to: doc.client.email,
              subject: `✅ Document Approved: ${docDisplayName} - Spain Visa 🇪🇸`,
              html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #e2e8f0; padding: 25px; border-radius: 10px; color: #1e293b;">
                  <div style="text-align: center; margin-bottom: 20px;">
                    <h2 style="color: #051A3B; margin: 0;">AAA Business Consultancy</h2>
                    <p style="color: #64748b; font-size: 14px; margin-top: 4px;">Spain Immigration & Relocation Services</p>
                  </div>
                  <div style="background-color: #ecfdf5; border: 1px solid #a7f3d0; padding: 16px; border-radius: 8px; margin: 20px 0; text-align: center;">
                    <h3 style="color: #059669; margin: 0 0 6px;">Document Verified & Approved ✅</h3>
                    <p style="color: #047857; margin: 0; font-size: 14px;">Your checklist document <b>"${docDisplayName}"</b> has been reviewed and verified.</p>
                  </div>
                  <p>Hello <b>${clientName}</b>,</p>
                  <p>Our operations team has approved your document <b>"${docDisplayName}"</b> for your application cycle.</p>
                  <div style="text-align: center; margin: 26px 0;">
                    <a href="${portalUrl}" style="background-color: #051A3B; color: #ffffff; padding: 12px 26px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
                      View Status in Portal
                    </a>
                  </div>
                  <br>
                  <p style="margin: 0;">Best regards,</p>
                  <p style="margin: 4px 0 0; font-weight: bold; color: #051A3B;">AAA Business Consultancy Team</p>
                </div>
              `
            }).catch(err => console.error('[BG-Email] Checklist Doc Approved email failed:', err.message));
          }

          if (doc.client.phone) {
            const waMsg = `✅ *Checklist Document Approved!*\n\nHello *${clientName}*,\n\nYour uploaded checklist document *"${docDisplayName}"* has been reviewed and *VERIFIED*.\n\nTrack your application status:\n🔗 ${portalUrl}\n\n*AAA Business Consultancy Team*`;
            sendCustomWhatsApp(doc.client.phone, waMsg).catch(err => console.error('[BG-WA] Checklist Doc Approved WA failed:', err.message));
          }
        } else if (status === 'REJECTED') {
          if (doc.client.email) {
            sendEmail({
              to: doc.client.email,
              subject: `⚠️ Action Required: Checklist Document Re-upload Needed - ${docDisplayName} 🇪🇸`,
              html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #e2e8f0; padding: 25px; border-radius: 10px; color: #1e293b;">
                  <div style="text-align: center; margin-bottom: 20px;">
                    <h2 style="color: #051A3B; margin: 0;">AAA Business Consultancy</h2>
                    <p style="color: #64748b; font-size: 14px; margin-top: 4px;">Spain Immigration & Relocation Services</p>
                  </div>
                  <div style="background-color: #fef2f2; border: 1px solid #fecaca; padding: 16px; border-radius: 8px; margin: 20px 0;">
                    <h3 style="color: #dc2626; margin: 0 0 6px;">Document Correction Required ⚠️</h3>
                    <p style="color: #991b1b; margin: 0; font-size: 14px;">Your checklist document <b>"${docDisplayName}"</b> needs correction.</p>
                  </div>
                  <p>Hello <b>${clientName}</b>,</p>
                  <div style="background-color: #f8fafc; border-left: 4px solid #ef4444; padding: 12px 16px; margin: 16px 0; border-radius: 4px;">
                    <strong style="color: #0f172a;">Rejection Reason:</strong>
                    <p style="color: #475569; margin: 6px 0 0; font-size: 14px;">${comment || 'Document does not meet guidelines. Please re-upload a clear replacement copy.'}</p>
                  </div>
                  <div style="text-align: center; margin: 26px 0;">
                    <a href="${portalUrl}" style="background-color: #051A3B; color: #ffffff; padding: 12px 26px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
                      Upload Replacement Document
                    </a>
                  </div>
                  <br>
                  <p style="margin: 0;">Best regards,</p>
                  <p style="margin: 4px 0 0; font-weight: bold; color: #051A3B;">AAA Business Consultancy Team</p>
                </div>
              `
            }).catch(err => console.error('[BG-Email] Checklist Doc Rejected email failed:', err.message));
          }

          if (doc.client.phone) {
            const waMsg = `⚠️ *Action Required: Checklist Document Rejected*\n\nHello *${clientName}*,\n\nYour checklist document *"${docDisplayName}"* was *REJECTED*.\n\n*Reason:* "${comment || 'Please re-upload a clear copy'}"\n\nPlease log in to re-upload:\n🔗 ${portalUrl}\n\n*AAA Business Consultancy Team*`;
            sendCustomWhatsApp(doc.client.phone, waMsg).catch(err => console.error('[BG-WA] Checklist Doc Rejected WA failed:', err.message));
          }
        }
      } catch (notifErr) {
        console.error('[reviewChecklistDoc Notif Error]:', notifErr.message);
      }
    }

    res.json({ document: updatedDoc, cycleAutoUpdated });
  } catch (error) {
    console.error('Error reviewing checklist document:', error);
    res.status(500).json({ message: 'Server error reviewing document' });
  }
};

const resubmitCycle = async (req, res) => {
  try {
    const { id } = req.params;
    const { resubmissionDate, submissionReference, changesMade, submissionNotes, submissionReceiptUrl } = req.body;

    const existingCycle = await prisma.applicationCycle.findUnique({ where: { id } });
    if (!existingCycle) {
      return res.status(404).json({ message: 'Application cycle not found' });
    }

    if (existingCycle.status !== 'Ready for Resubmission') {
      return res.status(400).json({
        message: `Cannot resubmit. Cycle status must be "Ready for Resubmission" (current: "${existingCycle.status}").`
      });
    }

    const updatedCycle = await prisma.applicationCycle.update({
      where: { id },
      data: {
        status: 'Resubmitted',
        resubmissionDate: resubmissionDate ? new Date(resubmissionDate) : new Date(),
        submissionReference: submissionReference || null,
        changesMade: changesMade || null,
        submissionNotes: submissionNotes || null,
        submissionReceiptUrl: submissionReceiptUrl || null,
        submittedById: req.user?.id || null,
        submittedAt: new Date()
      }
    });

    await prisma.client.update({
      where: { id: existingCycle.clientId },
      data: { visaStatus: 'Resubmitted' }
    });

    logActivity({
      clientId: existingCycle.clientId,
      actorId: req.user?.id || 'staff',
      actorName: req.user ? (req.user.fullName || req.user.email) : 'Consultant',
      actorRole: req.user?.role || 'consultant',
      action: 'RESUBMISSION_FILED',
      description: `Application resubmitted to government authority. Submission Ref: "${submissionReference || 'N/A'}".`
    });

    res.json(updatedCycle);
  } catch (error) {
    console.error('Error in resubmitCycle:', error);
    res.status(500).json({ message: 'Server error submitting resubmission' });
  }
};

const recordGovernmentDecision = async (req, res) => {
  try {
    const { id } = req.params;
    const { governmentDecision, governmentDecisionDate } = req.body;

    if (!['Approved', 'Refused'].includes(governmentDecision)) {
      return res.status(400).json({ message: 'governmentDecision must be "Approved" or "Refused".' });
    }

    const existingCycle = await prisma.applicationCycle.findUnique({ where: { id } });
    if (!existingCycle) {
      return res.status(404).json({ message: 'Application cycle not found' });
    }

    // Rule 1 Enforcement:
    // Permanently record government decision & date while keeping cycle status as Resubmitted
    const updatedCycle = await prisma.applicationCycle.update({
      where: { id },
      data: {
        governmentDecision: governmentDecision,
        governmentDecisionDate: governmentDecisionDate ? new Date(governmentDecisionDate) : new Date()
      }
    });

    // Update Client.visaStatus to "Visa Approved" or "Visa Refused"
    const newVisaStatus = governmentDecision === 'Approved' ? 'Visa Approved' : 'Visa Refused';
    const updatedClient = await prisma.client.update({
      where: { id: existingCycle.clientId },
      data: { visaStatus: newVisaStatus }
    });

    // Send WhatsApp & Email Alert for Official Decision
    try {
      const { sendEmail } = require('../services/emailService');
      const { sendCustomWhatsApp } = require('../services/chatbotService');
      const frontendUrl = (process.env.FRONTEND_URL || 'https://aaa-crm-service.netlify.app').replace(/\/$/, '');
      const portalUrl = `${frontendUrl}/#/portal/login`;
      const clientName = `${updatedClient.firstName} ${updatedClient.lastName}`.trim();

      if (newVisaStatus === 'Visa Approved') {
        if (updatedClient.email) {
          sendEmail({
            to: updatedClient.email,
            subject: '🎉 Congratulations! Your Spain Visa Has Been Approved! 🇪🇸',
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #e2e8f0; padding: 25px; border-radius: 10px; color: #1e293b;">
                <div style="text-align: center; margin-bottom: 20px;">
                  <h2 style="color: #051A3B; margin: 0;">AAA Business Consultancy</h2>
                  <p style="color: #64748b; font-size: 14px; margin-top: 4px;">Spain Immigration & Relocation Services</p>
                </div>
                <div style="background-color: #ecfdf5; border: 1px solid #a7f3d0; padding: 18px; border-radius: 8px; margin: 20px 0; text-align: center;">
                  <h2 style="color: #059669; margin: 0 0 8px;">Visa Approved! 🎉</h2>
                  <p style="color: #047857; margin: 0; font-size: 15px;">Congratulations! Your Spain Visa application has been officially approved by the immigration authorities.</p>
                </div>
                <p>Hello <b>${clientName}</b>,</p>
                <p>We are delighted to inform you that your <b>${updatedClient.serviceType || 'Spain Visa'}</b> application has been approved.</p>
                <p>Please log in to your Client Portal to review your official approval details and the next steps for your NIE / Residency Card (TIE) registration in Spain.</p>
                <div style="text-align: center; margin: 28px 0;">
                  <a href="${portalUrl}" style="background-color: #051A3B; color: #ffffff; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
                    Access Client Portal
                  </a>
                </div>
                <p>If you have any questions, our dedicated team is here to assist you.</p>
                <br>
                <p style="margin: 0;">Warm regards,</p>
                <p style="margin: 4px 0 0; font-weight: bold; color: #051A3B;">AAA Business Consultancy Team 🇪🇸</p>
              </div>
            `
          }).catch(err => console.error('[BG-Email] Decision Approved email failed:', err.message));
        }

        if (updatedClient.phone) {
          const waMsg = `🎉 *Congratulations ${clientName}!* 🇪🇸\n\nYour Spain Visa application (*${updatedClient.serviceType || 'Spain Visa'}*) has been officially *APPROVED*! ✨\n\nPlease log in to your client portal to review your approval details and next steps:\n\n🔗 ${portalUrl}\n\nBest regards,\n*AAA Business Consultancy Team*`;
          sendCustomWhatsApp(updatedClient.phone, waMsg).catch(err => console.error('[BG-WA] Decision Approved WA failed:', err.message));
        }
      } else if (newVisaStatus === 'Visa Refused') {
        if (updatedClient.email) {
          sendEmail({
            to: updatedClient.email,
            subject: 'Important Update Regarding Your Spain Visa Application 🇪🇸',
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #e2e8f0; padding: 25px; border-radius: 10px; color: #1e293b;">
                <div style="text-align: center; margin-bottom: 20px;">
                  <h2 style="color: #051A3B; margin: 0;">AAA Business Consultancy</h2>
                  <p style="color: #64748b; font-size: 14px; margin-top: 4px;">Spain Immigration & Relocation Services</p>
                </div>
                <div style="background-color: #fef2f2; border: 1px solid #fecaca; padding: 18px; border-radius: 8px; margin: 20px 0;">
                  <h3 style="color: #dc2626; margin: 0 0 8px;">Application Status Update</h3>
                  <p style="color: #991b1b; margin: 0; font-size: 14px;">We have received a decision regarding your Spain Visa application (${updatedClient.serviceType || 'Spain Visa'}).</p>
                </div>
                <p>Hello <b>${clientName}</b>,</p>
                <p>We are writing to inform you that your visa application has received a refusal notice from the immigration authorities.</p>
                <p>Our legal and immigration specialists are actively analyzing the grounds for refusal to guide you on the next course of action (administrative appeal or resubmission).</p>
                <div style="text-align: center; margin: 28px 0;">
                  <a href="${portalUrl}" style="background-color: #051A3B; color: #ffffff; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
                    View Case in Portal
                  </a>
                </div>
                <p>Your Case Officer will contact you shortly.</p>
                <br>
                <p style="margin: 0;">Sincerely,</p>
                <p style="margin: 4px 0 0; font-weight: bold; color: #051A3B;">AAA Business Consultancy Team</p>
              </div>
            `
          }).catch(err => console.error('[BG-Email] Decision Refused email failed:', err.message));
        }

        if (updatedClient.phone) {
          const waMsg = `📢 *Important Update on Your Spain Visa Application*\n\nHello *${clientName}*,\n\nWe have received an update regarding your Spain Visa application (*${updatedClient.serviceType || 'Spain Visa'}*). The application has received a refusal notice.\n\nOur legal and immigration specialists are reviewing the case to prepare the next steps (appeal or resubmission).\n\nPlease check your client portal for the complete case details:\n\n🔗 ${portalUrl}\n\nYour Case Officer will contact you soon.\n\n*AAA Business Consultancy Team*`;
          sendCustomWhatsApp(updatedClient.phone, waMsg).catch(err => console.error('[BG-WA] Decision Refused WA failed:', err.message));
        }
      }
    } catch (notifErr) {
      console.error('[recordGovernmentDecision Notif Error]:', notifErr.message);
    }

    logActivity({
      clientId: existingCycle.clientId,
      actorId: req.user?.id || 'staff',
      actorName: req.user ? (req.user.fullName || req.user.email) : 'Staff',
      actorRole: req.user?.role || 'staff',
      action: 'GOVERNMENT_DECISION_RECORDED',
      description: `Official Government Decision recorded: ${governmentDecision} on ${governmentDecisionDate || new Date().toISOString().split('T')[0]}. Client visa status updated to "${newVisaStatus}".`
    });

    res.json({ cycle: updatedCycle, clientVisaStatus: newVisaStatus });
  } catch (error) {
    console.error('Error recording government decision:', error);
    res.status(500).json({ message: 'Server error recording government decision' });
  }
};

const generateDefaultChecklist = async (req, res) => {
  try {
    const id = req.params.id || req.params.cycleId; // cycleId

    const cycle = await prisma.applicationCycle.findUnique({
      where: { id },
      include: { client: true }
    });

    if (!cycle) {
      return res.status(404).json({ message: 'Application cycle not found' });
    }

    if (cycle.type === 'appeal') {
      return res.status(400).json({ message: 'Default checklist generation is not applicable for legal appeal cycles.' });
    }

    // Check if checklist items already exist
    const existingCount = await prisma.resubmissionChecklistItem.count({
      where: { applicationId: id }
    });

    if (existingCount > 0) {
      return res.status(400).json({
        message: `Cycle already has ${existingCount} checklist item(s). Default checklist generation is only allowed when checklist is empty.`,
        count: existingCount
      });
    }

    const templates = [...DEFAULT_CHECKLIST_TEMPLATES];
    if (cycle.client?.applicantsCount && cycle.client.applicantsCount.toLowerCase().includes('spouse')) {
      templates.push({
        templateKey: 'passport_spouse',
        belongsTo: 'Spouse',
        category: 'Identity Documents',
        title: 'Passport Copy (Spouse)',
        isMandatory: true,
        clientInstructions: 'High-resolution color scan of spouse passport.'
      });
    }

    await prisma.resubmissionChecklistItem.createMany({
      data: templates.map(tpl => ({
        applicationId: id,
        templateKey: tpl.templateKey,
        belongsTo: tpl.belongsTo,
        category: tpl.category,
        title: tpl.title,
        isMandatory: tpl.isMandatory,
        clientInstructions: tpl.clientInstructions,
        status: 'MISSING'
      }))
    });

    const items = await prisma.resubmissionChecklistItem.findMany({
      where: { applicationId: id },
      orderBy: { createdAt: 'asc' }
    });

    logActivity({
      clientId: cycle.clientId,
      actorId: req.user?.id || 'staff',
      actorName: req.user ? (req.user.fullName || req.user.email) : 'Staff',
      actorRole: req.user?.role || 'staff',
      action: 'DEFAULT_CHECKLIST_GENERATED',
      description: `Generated ${items.length} default checklist items for Application Cycle #${id.substring(0, 8)}.`
    });

    res.status(201).json({
      message: `Successfully generated ${items.length} default checklist items.`,
      count: items.length,
      items
    });
  } catch (error) {
    console.error('Error generating default checklist:', error);
    res.status(500).json({ message: 'Server error generating default checklist', error: error.message });
  }
};

module.exports = {
  getActiveCases,
  getClosedCases,
  getCyclesByClient,
  createCycle,
  updateCycle,
  getCycleChecklist,
  addChecklistItem,
  updateChecklistItem,
  deleteChecklistItem,
  uploadChecklistDoc,
  reviewChecklistDoc,
  resubmitCycle,
  recordGovernmentDecision,
  generateDefaultChecklist
};
