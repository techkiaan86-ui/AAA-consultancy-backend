const fs = require('fs');
const prisma = require('../config/db');
const { createDocumentNotification } = require('./notificationController');

const getFileUrl = (file) => {
  if (!file) return '';
  if (file.location) return file.location;
  return `/uploads/${file.filename}`;
};

const getDocuments = async (req, res) => {
  try {
    const whereClause = req.user.role === 'client' ? { clientId: req.user.id } : {};

    const documents = await prisma.document.findMany({
      where: whereClause,
      include: {
        client: { select: { firstName: true, lastName: true } }
      },
      orderBy: { uploadedDate: 'desc' }
    });
    
    const mapped = documents.map(d => ({
      ...d,
      clientName: d.client ? `${d.client.firstName} ${d.client.lastName}` : 'Unknown'
    }));
    
    res.json(mapped);
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching documents' });
  }
};

const autoCategorizeDocument = (fileName) => {
  const name = (fileName || '').toLowerCase();
  
  if (name.includes('passport') || name.includes('travel document') || name.includes('pasaporte') || name.includes('travel_doc')) {
    return 'Passport';
  }
  if (name.includes('criminal') || name.includes('police clearance') || name.includes('background') || name.includes('antecedentes') || name.includes('police_clearance')) {
    return 'Criminal Record';
  }
  if (name.includes('insurance') || name.includes('health') || name.includes('sanitas') || name.includes('seguro') || name.includes('poliza')) {
    return 'Health Insurance';
  }
  if (name.includes('bank') || name.includes('statement') || name.includes('financial') || name.includes('balance') || name.includes('cuenta') || name.includes('ahorro') || name.includes('extracto')) {
    return 'Bank Statement / Financial Proof';
  }
  if (name.includes('medical') || name.includes('health certificate') || name.includes('doctor') || name.includes('médico') || name.includes('certificado')) {
    return 'Medical Certificate';
  }
  if (name.includes('application') || name.includes('form') || name.includes('solicitud') || name.includes('ex01') || name.includes('ex11') || name.includes('ex-01') || name.includes('ex-11')) {
    return 'Application Form';
  }
  if (name.includes('translation') || name.includes('sworn') || name.includes('traducción') || name.includes('jurada')) {
    return 'Sworn Translation Document';
  }
  return 'General';
};

const uploadDocument = async (req, res) => {
  try {
    const file = req.file || (req.files && req.files.length > 0 ? req.files[0] : null);
    if (!file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }
    
    const { clientId, belongsTo } = req.body;
    let category = req.body.category;
    
    // Auto-categorize if category is missing or generic
    if (!category || category === 'General') {
      category = autoCategorizeDocument(file.originalname);
    }
    
    // Extract word count for PDF files
    let wordCount = 0;
    const isPdf = (file.originalname || '').toLowerCase().endsWith('.pdf') || file.mimetype === 'application/pdf';
    if (isPdf && file.path) {
      try {
        const fs = require('fs');
        const { extractText } = require('unpdf');
        const dataBuffer = fs.readFileSync(file.path);
        const extractPromise = extractText(new Uint8Array(dataBuffer));
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('PDF text extraction timed out (5s limit)')), 5000)
        );
        const pdfData = await Promise.race([extractPromise, timeoutPromise]);
        
        const text = Array.isArray(pdfData.text) ? pdfData.text.join(' ') : (pdfData.text || '');
        if (text) {
          const words = text.trim().split(/\s+/).filter(w => w.length > 0);
          wordCount = words.length;
        }
      } catch (pdfErr) {
        console.warn('[PDF Parse Word Count] Could not extract text:', pdfErr.message);
      }
    }

    // 1. Save document to DB
    const document = await prisma.document.create({
      data: {
        clientId,
        name: file.originalname,
        category: category || 'General',
        url: getFileUrl(file),
        size: `${(file.size / 1024 / 1024).toFixed(2)} MB`,
        status: req.body.status || 'Pending Verification',
        belongsTo: belongsTo || 'Main Applicant',
        wordCount
      }
    });

    // Auto-update client or dependent passportNumber if provided in payload
    if (req.body.passportNumber && clientId) {
      try {
        const passNum = String(req.body.passportNumber).trim();
        if (belongsTo === 'Main Applicant' || !belongsTo) {
          await prisma.client.update({
            where: { id: clientId },
            data: { passportNumber: passNum }
          });
        } else {
          const clientRec = await prisma.client.findUnique({
            where: { id: clientId },
            select: { dependentsDetails: true }
          });
          if (clientRec && Array.isArray(clientRec.dependentsDetails)) {
            const updatedDeps = clientRec.dependentsDetails.map(dep => {
              const depName = `${dep.firstName || ''} ${dep.lastName || ''}`.trim().toLowerCase();
              const depFirstName = (dep.firstName || '').trim().toLowerCase();
              const target = (belongsTo || '').toLowerCase();
              if ((depFirstName && target.includes(depFirstName)) || (depName && target.includes(depName))) {
                return { ...dep, passportNumber: passNum };
              }
              return dep;
            });
            await prisma.client.update({
              where: { id: clientId },
              data: { dependentsDetails: updatedDeps }
            });
          }
        }
      } catch (pErr) {
        console.warn('[DocUpload] Could not update client passport number:', pErr.message);
      }
    }

    // 2. Find the client to get their name, email and assigned operator
    let client = await prisma.client.findUnique({
      where: { id: clientId },
      select: { 
        firstName: true, 
        lastName: true, 
        email: true,
        assignedToId: true,
        assignedTo: {
          select: { email: true, hotlineNumber: true }
        }
      }
    });

    if (client) {
      const clientName = `${client.firstName} ${client.lastName}`;
      const fileNameLower = (req.file.originalname || '').toLowerCase();
      const isTranslationDoc = (category || '').toLowerCase().includes('translation') || fileNameLower.includes('translation') || fileNameLower.includes('sworn');

      // Check if uploaded by staff/agent for the client -> Send client email notification
      if (req.body.uploadedByRole === 'agent' || category === 'Official Sworn Output' || belongsTo === 'Staff Upload') {
        if (client.email) {
          const { sendEmail } = require('../services/emailService');
          sendEmail({
            to: client.email,
            subject: `[COMPLETED] Your Official Sworn Translation is Ready! 📜`,
            html: `
              <h3>Hello ${clientName},</h3>
              <p>Great news! Your official Spanish Sworn Translation document <b>${req.file.originalname}</b> has been completed and uploaded by our operations team.</p>
              <p>It is now available for direct download on your <b>Client Portal</b> under your documents section.</p>
              <br/>
              <p>Best regards,<br/><b>AAA Immigration Services LLC</b></p>
            `
          }).then(() => {
            console.log(`[Sworn Delivery] Client notification email sent to ${client.email}`);
          }).catch((e) => {
            console.error('Failed to notify client via email:', e.message);
          });
        }
      }
      
      // Simulate classification check: handwritten/unreadable names trigger the routing override
      const isHandwritten = fileNameLower.includes('handwritten') || fileNameLower.includes('blurry') || fileNameLower.includes('draft');
      
      if (isTranslationDoc && isHandwritten) {
        const flagReason = 'AI Quality Flag: Handwritten or unreadable scan detected';
        
        // Fetch all Senior Operators (operations role with isSenior: true)
        const seniorOperators = await prisma.user.findMany({
          where: {
            OR: [
              { role: 'operations' },
              { role: 'admin' },
              { role: 'super_admin' }
            ],
            isSenior: true
          },
          include: {
            _count: {
              select: { assignedClients: true }
            }
          }
        });

        if (seniorOperators.length > 0) {
          // Sort by active client workload count (lowest first)
          seniorOperators.sort((a, b) => a._count.assignedClients - b._count.assignedClients);
          const selectedSenior = seniorOperators[0];
          
          // Re-assign the client and flag them in the database
          await prisma.client.update({
            where: { id: clientId },
            data: {
              assignedToId: selectedSenior.id,
              isAiFlagged: true,
              flagReason
            }
          });
          
          // Update local variables for notification
          client.assignedToId = selectedSenior.id;
          client.assignedTo = {
            email: selectedSenior.email,
            hotlineNumber: selectedSenior.hotlineNumber || selectedSenior.phone
          };
          
          console.log(`[AI Auto-Route] Document flagged. Client ${clientId} auto-routed to Senior Operator: ${selectedSenior.fullName}`);
        }
      }

      // 3. Trigger central multi-channel document notifications (WhatsApp, Email, CRM)
      await createDocumentNotification({
        userId: client.assignedToId,
        clientName,
        clientId,
        documentId: document.id,
        documentName: req.file.originalname,
        category: category || 'General',
        reqApp: req.app
      });
    }

    // Log activity
    const { logActivity } = require('../services/auditService');
    const uploaderName = req.user ? (req.user.fullName || req.user.email) : (client ? `${client.firstName} ${client.lastName}` : 'Client');
    const uploaderRole = req.user ? (req.user.role || 'agent') : 'client';
    logActivity({
      clientId: clientId || undefined,
      documentId: document.id,
      actorId: req.user?.id || clientId || 'client',
      actorName: uploaderName,
      actorRole: uploaderRole,
      action: 'DOC_UPLOADED',
      description: `${uploaderName} uploaded document "${document.name}" under category "${document.category}".`
    });

    res.status(201).json(document);
  } catch (error) {
    console.error('Error uploading document:', error);
    res.status(500).json({ message: 'Server error uploading document' });
  }
};

const reviewDocument = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, feedbackComment } = req.body;
    
    const document = await prisma.document.update({
      where: { id },
      data: { status, comment: feedbackComment }
    });

    const { logActivity } = require('../services/auditService');
    const reviewerName = req.user ? (req.user.fullName || req.user.email) : 'Operator';
    const reviewerRole = req.user ? (req.user.role || 'staff') : 'staff';
    const actionType = status === 'VERIFIED' ? 'DOC_VERIFIED' : status === 'REJECTED' ? 'DOC_REJECTED' : 'DOC_REVIEWED';

    logActivity({
      clientId: document.clientId || undefined,
      documentId: document.id,
      actorId: req.user?.id || 'operator',
      actorName: reviewerName,
      actorRole: reviewerRole,
      action: actionType,
      description: `${reviewerName} marked document "${document.name}" as ${status}.${feedbackComment ? ` Comment: "${feedbackComment}"` : ''}`
    });
    
    res.json(document);
  } catch (error) {
    res.status(500).json({ message: 'Server error reviewing document' });
  }
};

const uploadTranslatedDocument = async (req, res) => {
  try {
    const file = req.file || (req.files && req.files.length > 0 ? req.files[0] : null);
    if (!file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    const { id } = req.params;

    // 1. Update the document with translated url and status
    const document = await prisma.document.update({
      where: { id },
      data: {
        translatedUrl: getFileUrl(file),
        status: 'Translated'
      },
      include: {
        client: true
      }
    });

    // 2. Trigger email to client notifying them that translation is ready
    const frontendBase = process.env.FRONTEND_URL || 'http://localhost:5173';
    const clientName = document.client ? `${document.client.firstName || ''} ${document.client.lastName || ''}`.trim() : 'Client';
    const portalUrl = `${frontendBase}/#/portal/documents/${document.clientId}`;

    if (document.client && document.client.email) {
      const { sendEmail } = require('../services/emailService');
      sendEmail({
        to: document.client.email,
        subject: 'Your Certified Sworn Translation is Ready! 🇪🇸',
        html: `
          <h3>Dear ${document.client.firstName || 'Client'},</h3>
          <p>We are pleased to inform you that the sworn translation of your document (<b>${document.name}</b>) is complete and ready.</p>
          <p>You can now download the certified PDF directly from your Client Portal dashboard.</p>
          <p><a href="${portalUrl}" style="display:inline-block;padding:10px 18px;background:#16a34a;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:bold;">Log in to Client Portal</a></p>
          <br/>
          <p>Best regards,<br/>AAA Business Consultancy Team</p>
        `
      }).catch((emailErr) => {
        console.error('Failed to send email notification:', emailErr);
      });
    }

    // 3. Trigger WhatsApp notification to client if phone is available
    if (document.client && document.client.phone) {
      try {
        const { sendWhatsAppMessage } = require('../services/whatsappService');
        sendWhatsAppMessage({
          to: document.client.phone,
          templateName: 'translation_ready',
          components: [
            {
              type: 'body',
              parameters: [
                { type: 'text', text: document.client.firstName || 'Client' },
                { type: 'text', text: document.name || 'Document' },
                { type: 'text', text: portalUrl }
              ]
            }
          ]
        }).catch((waErr) => {
          console.warn('[WhatsApp] Could not send translation ready notification:', waErr.message);
        });
      } catch (waEx) {
        console.warn('[WhatsApp Exception]:', waEx.message);
      }
    }

    // 4. Record Communication Log
    if (document.client) {
      try {
        await prisma.communicationLog.create({
          data: {
            clientId: document.clientId,
            phone: document.client.phone || null,
            name: clientName,
            channel: 'EMAIL',
            direction: 'OUTBOUND',
            externalProviderId: 'translation_ready',
            deliveryStatus: 'SENT',
            content: `Certified Sworn Translation ready for "${document.name}". Notification sent asking client to check portal at ${portalUrl}.`
          }
        });
      } catch (logErr) {
        console.warn('[CommLog] Error saving communication log:', logErr.message);
      }
    }

    res.json({ success: true, document });
  } catch (error) {
    console.error('Error uploading translated document:', error);
    res.status(500).json({ message: 'Server error uploading translated document' });
  }
};

const deleteDocument = async (req, res) => {
  try {
    const { id } = req.params;

    const doc = await prisma.document.findUnique({ where: { id } });
    if (!doc) {
      return res.status(404).json({ message: 'Document not found' });
    }

    // 🔒 COMPLIANCE HARD-BLOCK: Verified / Approved / Submitted compliance documents cannot be deleted
    const protectedStatuses = ['VERIFIED', 'APPROVED', 'SUBMITTED', 'TRANSLATED'];
    const currentStatusUpper = (doc.status || '').toUpperCase();

    if (protectedStatuses.includes(currentStatusUpper) || (req.user.role === 'client' && currentStatusUpper !== 'PENDING VERIFICATION')) {
      return res.status(403).json({
        message: 'Compliance Security Restriction: Verified or processed application documents cannot be deleted. Contact system admin for audit overrides.'
      });
    }

    // Remove document record from DB
    await prisma.document.delete({ where: { id } });

    res.json({ success: true, message: 'Document deleted successfully' });
  } catch (error) {
    console.error('Error deleting document:', error);
    res.status(500).json({ message: 'Server error deleting document' });
  }
};

const uploadBatchDocuments = async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ message: 'No files uploaded in batch' });
    }

    const { clientId } = req.body;
    if (!clientId || clientId === 'undefined' || clientId === 'null') {
      return res.status(400).json({ message: 'Missing or invalid Client ID in upload request' });
    }

    const existingClient = await prisma.client.findUnique({ where: { id: clientId } }).catch(() => null);
    if (!existingClient) {
      return res.status(404).json({ message: 'Client account not found in system database' });
    }

    let metadataList = [];
    try {
      metadataList = req.body.metadata ? JSON.parse(req.body.metadata) : [];
    } catch (_) {}

    const createdDocs = [];
    const batchId = `BATCH-${Date.now()}`;
    let mainPassportNum = null;
    const depPassportMap = {};

    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      const meta = metadataList[i] || {};
      let category = meta.category || req.body.category || 'General';
      if (!category || category === 'General') {
        category = autoCategorizeDocument(file.originalname);
      }
      const belongsTo = meta.belongsTo || req.body.belongsTo || 'Main Applicant';
      const passportNum = meta.passportNumber || (category.toLowerCase().includes('passport') ? req.body.passportNumber : null);

      if (passportNum && typeof passportNum === 'string' && passportNum.trim()) {
        if (belongsTo === 'Main Applicant' || !belongsTo) {
          mainPassportNum = passportNum.trim();
        } else {
          depPassportMap[belongsTo] = passportNum.trim();
        }
      }

      const document = await prisma.document.create({
        data: {
          clientId,
          name: file.originalname,
          category: category,
          url: getFileUrl(file),
          size: `${(file.size / 1024 / 1024).toFixed(2)} MB`,
          status: 'Pending Verification',
          belongsTo: belongsTo,
          wordCount: 0
        }
      });
      createdDocs.push(document);
    }

    // Update client status to "Documents Under Review", enable documentUploadAllowed, and update passportNumbers
    if (clientId) {
      const clientUpdateData = {
        status: 'Documents Under Review',
        documentUploadAllowed: true
      };

      if (mainPassportNum) {
        clientUpdateData.passportNumber = mainPassportNum;
      }

      if (Object.keys(depPassportMap).length > 0 && Array.isArray(existingClient.dependentsDetails)) {
        clientUpdateData.dependentsDetails = existingClient.dependentsDetails.map(dep => {
          for (const [key, pNum] of Object.entries(depPassportMap)) {
            const depFullName = `${dep.firstName || ''} ${dep.lastName || ''}`.trim().toLowerCase();
            const depFirstName = (dep.firstName || '').trim().toLowerCase();
            const k = key.toLowerCase();
            if ((depFirstName && k.includes(depFirstName)) || (depFullName && k.includes(depFullName))) {
              return { ...dep, passportNumber: pNum };
            }
          }
          return dep;
        });
      }

      const updatedClient = await prisma.client.update({
        where: { id: clientId },
        data: clientUpdateData
      }).catch(err => console.warn('[BatchUpload] Could not update client status/passports:', err.message));

      // Trigger ONE single consolidated Notification (WhatsApp / Email / CRM / AuditLog)
      if (updatedClient) {
        const clientName = `${updatedClient.firstName} ${updatedClient.lastName}`;
        const passportDocsCount = createdDocs.filter(d => (d.category || '').toLowerCase().includes('passport')).length;

        // Log to Audit Log
        await prisma.auditLog.create({
          data: {
            action: 'Document Batch Uploaded',
            actorName: clientName,
            actorRole: 'client',
            description: `Client ${clientName} submitted a complete document package of ${createdDocs.length} files (${passportDocsCount} Passports included).`
          }
        }).catch(() => null);

        // System notification (1 single alert for the entire batch submission)
        await createDocumentNotification({
          userId: updatedClient.assignedToId,
          clientName,
          clientId,
          documentName: `Complete Document Package (${createdDocs.length} files)`,
          category: 'Complete Package',
          reqApp: req.app
        }).catch((err) => console.error('[BatchNotification Error]:', err.message));
      }
    }

    res.status(201).json({
      success: true,
      message: `Successfully uploaded package of ${createdDocs.length} documents.`,
      batchId,
      documents: createdDocs
    });
  } catch (error) {
    console.error('[uploadBatchDocuments Error]:', error);
    res.status(500).json({ message: 'Server error uploading batch documents', error: error.message });
  }
};

module.exports = {
  getDocuments,
  uploadDocument,
  uploadBatchDocuments,
  reviewDocument,
  uploadTranslatedDocument,
  deleteDocument
};
