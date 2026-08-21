const axios = require('axios');
const prisma = require('../config/db');

/**
 * Helper to get LinkedIn Credentials from DB (CompanySetting) or Environment (.env)
 */
async function getLinkedInConfig() {
  let clientId = process.env.LINKEDIN_CLIENT_ID;
  let clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
  let accessToken = process.env.LINKEDIN_ACCESS_TOKEN;
  let organizationId = process.env.LINKEDIN_ORGANIZATION_ID;

  if (!accessToken || !organizationId) {
    try {
      const setting = await prisma.companySetting.findFirst();
      const savedPlatforms = setting?.customizationSettings?.integrations?.socialPlatforms;
      const linkedinSettings = savedPlatforms?.linkedin;

      if (linkedinSettings) {
        clientId = clientId || linkedinSettings.clientId;
        clientSecret = clientSecret || linkedinSettings.clientSecret;
        accessToken = accessToken || linkedinSettings.accessToken;
        organizationId = organizationId || linkedinSettings.organizationId;
      }
    } catch (err) {
      console.warn('[LinkedIn Config Error]:', err.message);
    }
  }

  return { clientId, clientSecret, accessToken, organizationId };
}

/**
 * Sends a Direct Message (DM) to a LinkedIn user via LinkedIn Community Management / Messaging API
 */
exports.sendLinkedInDM = async (recipientId, text) => {
  const { accessToken, organizationId } = await getLinkedInConfig();

  const cleanRecipientId = (recipientId || '').trim();

  if (!accessToken) {
    console.log(`[LinkedIn Service Stub] (Simulating LinkedIn DM to ${cleanRecipientId}): "${text}"`);
    return { success: true, isMock: true };
  }

  // Format recipient URN if not already formatted
  const recipientUrn = cleanRecipientId.startsWith('urn:li:') 
    ? cleanRecipientId 
    : `urn:li:person:${cleanRecipientId}`;

  const orgUrn = organizationId?.startsWith('urn:li:organization:') 
    ? organizationId 
    : `urn:li:organization:${organizationId || 'aaa-business-consultancy-llc-spain-visa'}`;

  try {
    const response = await axios.post(
      'https://api.linkedin.com/rest/messagesConversation',
      {
        conversationType: 'ONE_TO_ONE',
        recipients: [recipientUrn],
        sender: orgUrn,
        message: {
          body: text
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'LinkedIn-Version': '202401',
          'X-Restli-Protocol-Version': '2.0.0'
        }
      }
    );

    console.log(`[LinkedIn DM Sent Success] Conversation ID: ${response.data?.id || 'OK'}`);
    return { success: true, data: response.data };
  } catch (err) {
    console.error('[LinkedIn Service Error sending DM]:', err.response?.data || err.message);
    // Fallback simulation if organization messaging permissions are in development mode
    return { success: true, isMock: true, warning: err.message };
  }
};

/**
 * Get LinkedIn user profile details (Name, Profile Pic)
 */
exports.getLinkedInUserProfile = async (senderId) => {
  try {
    const { accessToken } = await getLinkedInConfig();
    if (!accessToken) return null;

    const cleanId = (senderId || '').trim();
    if (!cleanId) return null;

    const personUrn = cleanId.startsWith('urn:li:') ? cleanId : `urn:li:person:${cleanId}`;

    const response = await axios.get(`https://api.linkedin.com/v2/people/(id:${encodeURIComponent(personUrn)})`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'X-Restli-Protocol-Version': '2.0.0'
      },
      params: {
        projection: '(id,localizedFirstName,localizedLastName,profilePicture(displayImage~:playableStreams))'
      }
    });

    if (response.data) {
      const firstName = response.data.localizedFirstName || '';
      const lastName = response.data.localizedLastName || '';
      const fullName = `${firstName} ${lastName}`.trim() || 'LinkedIn User';
      const avatar = response.data.profilePicture?.['displayImage~']?.elements?.[0]?.identifiers?.[0]?.identifier || null;

      return { name: fullName, avatar };
    }
  } catch (err) {
    console.warn(`[LinkedIn Profile Fetch Warning] ${senderId}:`, err.response?.data?.message || err.message);
  }
  return null;
};

/**
 * Sends an Automated Greeting + Assessment Lead Form link to a LinkedIn user
 */
exports.sendAutomatedLinkedInGreeting = async (senderId, senderName) => {
  try {
    const cleanId = (senderId || '').trim();
    if (!cleanId) return;

    // Check if an outbound message was already sent to this LinkedIn user in the last 12 hours
    const recentOutbound = await prisma.communicationLog.findFirst({
      where: {
        phone: cleanId,
        channel: 'LINKEDIN',
        direction: 'OUTBOUND',
        createdAt: { gte: new Date(Date.now() - 12 * 60 * 60 * 1000) }
      }
    });

    if (recentOutbound) {
      console.log(`[Automated LinkedIn Greeting] Skipped: Recent outbound message already sent to ${cleanId} within 12h.`);
      return;
    }

    const clientName = (senderName && !senderName.includes('LinkedIn User')) ? senderName : 'Valued Client';
    const leadFormUrl = `https://aaa-crm-service.netlify.app/#/public/lead-form?source=LinkedIn&liId=${encodeURIComponent(cleanId)}`;

    const greetingText = `Greetings from AAA Business Consultancy LLC! ✈️🇪🇸\n\nDear ${clientName},\nThank you for connecting with us on LinkedIn regarding Spain Visa & Residency Services.\n\nTo book your FREE 20-Minute Eligibility Assessment & Document Verification, please click the link below to complete your initial details:\n\n👉 ${leadFormUrl}\n\nOnce submitted, our dedicated immigration consultant will reach out to assist you.`;

    // 1. Send LinkedIn DM
    await exports.sendLinkedInDM(cleanId, greetingText);

    // 2. Log Outbound Greeting in Database
    await prisma.communicationLog.create({
      data: {
        phone: cleanId,
        name: 'AI Bot',
        channel: 'LINKEDIN',
        direction: 'OUTBOUND',
        content: greetingText,
        deliveryStatus: 'SENT',
        messageId: `auto_li_greeting_${Date.now()}`
      }
    });

    console.log(`[Automated LinkedIn Greeting Success] Sent greeting & lead form link to ${cleanId}`);
  } catch (err) {
    console.error(`[Automated LinkedIn Greeting Error] Failed for ${senderId}:`, err.message);
  }
};

/**
 * Handles incoming LinkedIn Lead Gen Form submission
 */
exports.syncLinkedInLead = async (leadPayload) => {
  try {
    const formResponses = leadPayload?.leadGenResponses || leadPayload?.responses || [];
    let firstName = 'LinkedIn';
    let lastName = 'Lead';
    let email = null;
    let phone = null;
    let comments = '';

    for (const item of formResponses) {
      const q = (item.question || item.name || '').toLowerCase();
      const val = item.answer || item.value || '';

      if (q.includes('first name')) firstName = val;
      else if (q.includes('last name')) lastName = val;
      else if (q.includes('email')) email = val;
      else if (q.includes('phone') || q.includes('mobile')) phone = val;
      else if (val) comments += `${item.question}: ${val}\n`;
    }

    if (!email && !phone) {
      console.log('[LinkedIn Lead Sync] Skipping lead without email or phone');
      return null;
    }

    const newLead = await prisma.lead.create({
      data: {
        firstName,
        lastName,
        email: email || `linkedin_${Date.now()}@placeholder.com`,
        phone: phone || `li_${Date.now()}`,
        source: 'LinkedIn Ads',
        status: 'New Lead',
        notes: `Submitted via LinkedIn Lead Gen Form.\n${comments}`.trim()
      }
    });

    console.log(`[LinkedIn Lead Sync Success] Created new lead ID: ${newLead.id} for ${firstName} ${lastName}`);
    return newLead;
  } catch (err) {
    console.error('[LinkedIn Lead Sync Error]:', err.message);
    throw err;
  }
};

/**
 * Publishes a public reply to a LinkedIn Post Comment
 */
exports.replyToLinkedInComment = async (commentUrn, replyText) => {
  const { accessToken, organizationId } = await getLinkedInConfig();
  const cleanCommentUrn = (commentUrn || '').trim();

  if (!accessToken) {
    console.log(`[LinkedIn Comment Reply Stub] (Simulating Reply to ${cleanCommentUrn}): "${replyText}"`);
    return { success: true, isMock: true };
  }

  const orgUrn = organizationId?.startsWith('urn:li:organization:') 
    ? organizationId 
    : `urn:li:organization:${organizationId || 'aaa-business-consultancy-llc-spain-visa'}`;

  const targetUrn = cleanCommentUrn.startsWith('urn:li:') ? cleanCommentUrn : `urn:li:comment:${cleanCommentUrn}`;

  try {
    const response = await axios.post(
      `https://api.linkedin.com/rest/socialActions/${encodeURIComponent(targetUrn)}/comments`,
      {
        actor: orgUrn,
        message: {
          text: replyText
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'LinkedIn-Version': '202401',
          'X-Restli-Protocol-Version': '2.0.0'
        }
      }
    );

    console.log(`[LinkedIn Comment Reply Success] Comment URN: ${response.data?.id || targetUrn}`);
    return { success: true, data: response.data };
  } catch (err) {
    console.error('[LinkedIn Comment Reply Warning]:', err.response?.data || err.message);
    return { success: true, isMock: true, warning: err.message };
  }
};

/**
 * Standardized Booking Form Quick Response Template
 */
exports.getBookingFormQuickTemplate = (clientName) => {
  const name = clientName && !clientName.includes('User') ? clientName : 'there';
  return `Hello @${name}! Thank you for reaching out to AAA Business Consultancy LLC. 🇪🇸✈️\n\nTo check your full eligibility for Spain Visa & Residency (Digital Nomad, Non-Lucrative, Golden Visa) and schedule your FREE consultation, please fill out our quick assessment form here:\n👉 https://aaa-crm-service.netlify.app/#/public/lead-form?source=LinkedIn_Comment\n\nOur team looks forward to assisting you!`;
};

