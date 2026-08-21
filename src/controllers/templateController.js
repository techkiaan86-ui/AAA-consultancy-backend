const prisma = require('../config/db');

// Default initial system templates if DB has no templates yet
const DEFAULT_SYSTEM_TEMPLATES = [
  {
    name: 'Greet',
    type: 'QUICK_REPLY',
    category: 'QUICK_REPLY',
    body: 'Hello👋 \n\nWelcome to AAA Business Consultancy Services! \n\nWe’re here to help you with your Spain Visa, Residency & Relocation requirements. \n\nReply Hi to get started.',
    active: true
  },
  {
    name: 'Booking & Assessment Form',
    type: 'QUICK_REPLY',
    category: 'QUICK_REPLY',
    body: 'Hello! 🇪🇸✈️ Thank you for connecting with AAA Business Consultancy LLC.\n\nTo check your full eligibility for Spain Visa & Residency (Digital Nomad, NLV, Golden Visa) and schedule your consultation, please complete our quick assessment form here:\n👉 https://aaa-crm-service.netlify.app/#/public/lead-form?source=Social_Comment\n\nOur team looks forward to assisting you!',
    active: true
  }
];

/**
 * GET /api/templates
 * Retrieve active templates available to users
 */
exports.getTemplates = async (req, res) => {
  try {
    let templates = await prisma.template.findMany({
      where: { active: true },
      orderBy: { createdAt: 'desc' }
    });

    // Seed defaults if no templates exist in DB
    if (templates.length === 0) {
      try {
        await prisma.template.createMany({
          data: DEFAULT_SYSTEM_TEMPLATES
        });
        templates = await prisma.template.findMany({
          where: { active: true },
          orderBy: { createdAt: 'desc' }
        });
      } catch (seedErr) {
        console.warn('Could not seed default templates:', seedErr.message);
      }
    }

    return res.status(200).json(templates);
  } catch (err) {
    console.error('Error fetching templates:', err.message);
    return res.status(500).json({ message: 'Failed to fetch templates' });
  }
};

/**
 * GET /api/templates/all
 * Retrieve all templates for Admin Customization Settings screen
 */
exports.getAllTemplatesAdmin = async (req, res) => {
  try {
    const templates = await prisma.template.findMany({
      orderBy: { createdAt: 'desc' }
    });
    return res.status(200).json(templates);
  } catch (err) {
    console.error('Error fetching admin templates:', err.message);
    return res.status(500).json({ message: 'Failed to fetch templates' });
  }
};

/**
 * POST /api/templates
 * Create a new static template
 */
exports.createTemplate = async (req, res) => {
  try {
    const { name, type, category, body, contentSid, language, active } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'Template name is required' });
    }
    if (!body || !body.trim()) {
      return res.status(400).json({ message: 'Message body is required' });
    }

    const templateType = type || category || 'QUICK_REPLY';
    const templateCategory = category || type || 'QUICK_REPLY';

    let finalContentSid = contentSid ? contentSid.trim() : null;

    // If type is META_APPROVED and no contentSid is provided, submit directly to Twilio Content API to generate SID
    if ((templateType === 'META_APPROVED' || templateCategory === 'META_APPROVED') && !finalContentSid) {
      const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
      const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

      if (TWILIO_ACCOUNT_SID && TWILIO_ACCOUNT_SID.startsWith('AC') && TWILIO_AUTH_TOKEN) {
        try {
          const twilio = require('twilio');
          const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

          const twilioContent = await twilioClient.content.v1.contents.create({
            friendlyName: name.trim().replace(/\s+/g, '_').toLowerCase().slice(0, 60),
            language: (language || 'en').trim().toLowerCase(),
            types: {
              'twilio/text': {
                body: body.trim()
              }
            }
          });

          if (twilioContent && twilioContent.sid) {
            finalContentSid = twilioContent.sid;
            console.log(`[Twilio Content API] ✅ Created template "${name}" on Twilio with SID: ${finalContentSid}`);
          }
        } catch (twilioErr) {
          console.warn('[Twilio Content API Warning] Automatic SID generation failed:', twilioErr.message);
        }
      }
    }

    const initialApproval = (templateType === 'META_APPROVED' || templateCategory === 'META_APPROVED') ? 'PENDING' : 'APPROVED';

    const newTemplate = await prisma.template.create({
      data: {
        name: name.trim(),
        type: templateType,
        category: templateCategory,
        body: body.trim(), // Exact static text body — NO variable resolution
        contentSid: finalContentSid,
        twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || null,
        approvalStatus: initialApproval,
        language: language ? language.trim() : 'en',
        active: active !== undefined ? Boolean(active) : true,
        createdBy: req.user?.id || null
      }
    });

    return res.status(201).json(newTemplate);
  } catch (err) {
    console.error('Error creating template:', err.message);
    return res.status(500).json({ message: 'Failed to create template' });
  }
};

/**
 * GET /api/templates/check-status/:id
 * Check live Meta/Twilio approval status for a template
 */
exports.checkApprovalStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const template = await prisma.template.findUnique({ where: { id } });
    if (!template) {
      return res.status(404).json({ message: 'Template not found' });
    }

    if (!template.contentSid) {
      return res.status(200).json({ success: true, approvalStatus: template.approvalStatus || 'APPROVED' });
    }

    const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
    const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

    if (TWILIO_ACCOUNT_SID && TWILIO_ACCOUNT_SID.startsWith('AC') && TWILIO_AUTH_TOKEN) {
      try {
        const twilio = require('twilio');
        const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
        const approval = await twilioClient.content.v1.contents(template.contentSid).approvalFetch().fetch();

        const statusStr = (approval.status || 'APPROVED').toUpperCase();
        const updated = await prisma.template.update({
          where: { id: template.id },
          data: { approvalStatus: statusStr }
        });

        return res.status(200).json({ success: true, approvalStatus: statusStr, template: updated });
      } catch (twilioErr) {
        console.warn(`[Twilio Content API] Could not fetch approval status for SID ${template.contentSid}:`, twilioErr.message);
      }
    }

    return res.status(200).json({ success: true, approvalStatus: template.approvalStatus || 'APPROVED' });
  } catch (err) {
    console.error('Error checking template status:', err.message);
    return res.status(500).json({ message: 'Failed to check approval status' });
  }
};

/**
 * PUT /api/templates/:id
 * Update an existing static template
 */
exports.updateTemplate = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, type, category, body, contentSid, language, active } = req.body;

    const existing = await prisma.template.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ message: 'Template not found' });
    }

    const templateType = type || category || existing.type || 'QUICK_REPLY';
    const templateCategory = category || type || existing.category || 'QUICK_REPLY';

    const updated = await prisma.template.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name: name.trim() } : {}),
        type: templateType,
        category: templateCategory,
        ...(body !== undefined ? { body: body.trim() } : {}),
        ...(contentSid !== undefined ? { contentSid: contentSid ? contentSid.trim() : null } : {}),
        ...(language !== undefined ? { language: language.trim() } : {}),
        ...(active !== undefined ? { active: Boolean(active) } : {})
      }
    });

    return res.status(200).json(updated);
  } catch (err) {
    console.error('Error updating template:', err.message);
    return res.status(500).json({ message: 'Failed to update template' });
  }
};

/**
 * DELETE /api/templates/:id
 * Soft delete / deactivate a template (preserves historical messages)
 */
exports.deleteTemplate = async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.template.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ message: 'Template not found' });
    }

    // Soft delete by setting active = false
    const deactivated = await prisma.template.update({
      where: { id },
      data: { active: false }
    });

    return res.status(200).json({ message: 'Template deactivated successfully', template: deactivated });
  } catch (err) {
    console.error('Error deactivating template:', err.message);
    return res.status(500).json({ message: 'Failed to deactivate template' });
  }
};
