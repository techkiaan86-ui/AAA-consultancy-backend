const axios = require('axios');

/**
 * Sends an Instagram Direct Message (DM) to a recipient.
 */
exports.sendInstagramDM = async (recipientId, text) => {
  const prisma = require('../config/db');
  let accessToken = process.env.META_PAGE_ACCESS_TOKEN || process.env.INSTAGRAM_ACCESS_TOKEN;
  let accountId = null;

  if (!accessToken) {
    const setting = await prisma.companySetting.findFirst();
    const savedPlatforms = setting?.customizationSettings?.integrations?.socialPlatforms;
    accessToken = savedPlatforms?.instagram?.accessToken || savedPlatforms?.facebook?.accessToken;
    accountId = savedPlatforms?.instagram?.accountId;
  }

  const cleanRecipientId = (recipientId || '').replace(/[^\d]/g, '');

  if (!accessToken) {
    console.log(`[Instagram Service Stub] (Simulating IG DM to ${cleanRecipientId}): "${text}"`);
    return { success: true, isMock: true };
  }

  const apiBase = (accessToken && accessToken.startsWith('IG')) ? 'https://graph.instagram.com/v19.0' : 'https://graph.facebook.com/v19.0';
  const endpoint = accountId ? `${apiBase}/${accountId}/messages` : `${apiBase}/me/messages`;

  try {
    const response = await axios.post(endpoint, {
      recipient: { id: cleanRecipientId },
      message: { text }
    }, {
      params: { access_token: accessToken }
    });
    console.log(`[Instagram DM Sent Success] Message ID: ${response.data?.message_id}`);
    return { success: true, data: response.data };
  } catch (err) {
    console.error('[Instagram Service Error sending DM]:', err.response?.data || err.message);
    throw err;
  }
};

/**
 * Get Instagram user profile details (Username, Full Name, Profile Pic)
 */
exports.getInstagramUserProfile = async (senderId) => {
  try {
    const prisma = require('../config/db');
    let accessToken = process.env.META_PAGE_ACCESS_TOKEN || process.env.INSTAGRAM_ACCESS_TOKEN;
    if (!accessToken) {
      const setting = await prisma.companySetting.findFirst();
      const savedPlatforms = setting?.customizationSettings?.integrations?.socialPlatforms;
      accessToken = savedPlatforms?.instagram?.accessToken || savedPlatforms?.facebook?.accessToken;
    }

    if (!accessToken) return null;

    const cleanId = (senderId || '').replace(/[^\d]/g, '');
    if (!cleanId) return null;

    const apiBase = (accessToken && accessToken.startsWith('IG')) ? 'https://graph.instagram.com/v19.0' : 'https://graph.facebook.com/v19.0';

    const response = await axios.get(`${apiBase}/${cleanId}`, {
      params: {
        fields: 'name,username,profile_pic',
        access_token: accessToken
      }
    });

    if (response.data) {
      const rawName = response.data.name;
      const rawUsername = response.data.username ? (response.data.username.startsWith('@') ? response.data.username : `@${response.data.username}`) : null;
      let displayName = rawName;
      if (rawUsername) {
        displayName = (rawName && rawName !== rawUsername) ? `${rawName} (${rawUsername})` : rawUsername;
      }

      return { name: displayName || rawUsername || rawName, username: rawUsername, avatar: response.data.profile_pic || null };
    }
  } catch (err) {
    console.warn(`[Instagram Service Profile Error] ${senderId}:`, err.response?.data?.error?.message || err.message);
  }
  return null;
};

/**
 * Sends an Automated Greeting + Assessment Lead Form link to an Instagram user
 */
exports.sendAutomatedInstagramGreeting = async (senderId, senderName) => {
  const prisma = require('../config/db');

  try {
    const cleanId = (senderId || '').replace(/[^\d]/g, '');
    if (!cleanId) return;

    // Check if an outbound automated message was sent to this senderId in the last 12 hours
    const recentOutbound = await prisma.communicationLog.findFirst({
      where: {
        phone: cleanId,
        channel: 'INSTAGRAM',
        direction: 'OUTBOUND',
        createdAt: { gte: new Date(Date.now() - 12 * 60 * 60 * 1000) }
      }
    });

    if (recentOutbound) {
      console.log(`[Automated Instagram Greeting] Skipped: Recent outbound message already sent to ${cleanId} within 12h.`);
      return;
    }

    const clientName = (senderName && !senderName.includes('Meta User')) ? senderName : 'Valued Client';
    const leadFormUrl = `https://aaa-crm-service.netlify.app/#/public/lead-form?source=Instagram&igId=${encodeURIComponent(cleanId)}`;

    const greetingText = `Greetings from AAA Business Consultancy LLC! ✈️🇪🇸\n\nDear ${clientName},\nThank you for reaching out to us regarding Spain Visa & Residency Services.\n\nTo book your FREE 20-Minute Eligibility Assessment & Verification, please click the link below to complete your initial details:\n\n👉 ${leadFormUrl}\n\nOnce submitted, our dedicated consultant will immediately reach out to assist you.`;

    // 1. Send IG DM via Meta Graph API
    await exports.sendInstagramDM(cleanId, greetingText);

    // 2. Log Outbound Greeting in Database
    await prisma.communicationLog.create({
      data: {
        phone: cleanId,
        name: 'AI Bot',
        channel: 'INSTAGRAM',
        direction: 'OUTBOUND',
        content: greetingText,
        deliveryStatus: 'SENT',
        messageId: `auto_ig_greeting_${Date.now()}`
      }
    });

    console.log(`[Automated Instagram Greeting Success] Sent greeting & lead form link to ${cleanId}`);
  } catch (err) {
    console.error(`[Automated Instagram Greeting Error] Failed for ${senderId}:`, err.message);
  }
};
