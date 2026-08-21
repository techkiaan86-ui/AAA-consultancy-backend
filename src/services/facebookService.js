const axios = require('axios');

const getFacebookAccessToken = async () => {
  if (process.env.META_PAGE_ACCESS_TOKEN) {
    return process.env.META_PAGE_ACCESS_TOKEN;
  }
  try {
    const prisma = require('../config/db');
    const settings = await prisma.companySetting.findMany();
    for (const setting of settings) {
      const parsed = typeof setting.customizationSettings === 'string' ? JSON.parse(setting.customizationSettings) : setting.customizationSettings;
      const token = parsed?.integrations?.socialPlatforms?.facebook?.accessToken;
      if (token) return token;
    }
  } catch (e) {
    console.warn('[Facebook Service] Could not fetch token from DB:', e.message);
  }
  return null;
};

/**
 * Sends a Facebook Messenger direct message to a user.
 */
exports.sendMessengerMessage = async (recipientId, text) => {
  const token = await getFacebookAccessToken();
  const cleanRecipientId = (recipientId || '').replace(/[^\d]/g, '');

  if (!token) {
    console.log(`[Facebook Service Stub] (Simulating Messenger to ${cleanRecipientId}): "${text}"`);
    return { success: true, isMock: true };
  }

  try {
    const response = await axios.post(`https://graph.facebook.com/v19.0/me/messages`, {
      recipient: { id: cleanRecipientId },
      message: { text }
    }, {
      params: { access_token: token }
    });
    console.log(`[Facebook Messenger Sent Success] Message ID: ${response.data?.message_id}`);
    return { success: true, data: response.data };
  } catch (err) {
    console.error('[Facebook Service Error sending Messenger DM]:', err.response?.data || err.message);
    throw err;
  }
};

/**
 * Get Facebook User Profile (Full Name, Profile Pic)
 */
exports.getFacebookUserProfile = async (senderId) => {
  try {
    const rawId = String(senderId || '').trim();
    if (!rawId) return null;

    // Phone number strings (e.g. +278298289..., +971..., etc.) are not Facebook PSIDs.
    if (rawId.startsWith('+') || (rawId.length >= 10 && /^\+?\d+$/.test(rawId) && (rawId.startsWith('27') || rawId.startsWith('260') || rawId.startsWith('280') || rawId.startsWith('971') || rawId.startsWith('91')))) {
      return null;
    }

    const token = await getFacebookAccessToken();
    if (!token) return null;
    const cleanId = rawId.replace(/[^\d]/g, '');
    if (!cleanId) return null;

    const response = await axios.get(`https://graph.facebook.com/v19.0/${cleanId}`, {
      params: {
        fields: 'name,first_name,last_name,profile_pic',
        access_token: token
      }
    });

    if (response.data) {
      const name = response.data.name || `${response.data.first_name || ''} ${response.data.last_name || ''}`.trim();
      return { name: name || 'Facebook User', avatar: response.data.profile_pic || null };
    }
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    if (!msg.includes('Unsupported get request') && !msg.includes('does not exist')) {
      console.warn(`[Facebook Service Profile Error] ${senderId}:`, msg);
    }
  }
  return null;
};

/**
 * Replies to a comment on a Facebook Page feed post.
 */
exports.replyToFacebookComment = async (commentId, text) => {
  const token = await getFacebookAccessToken();
  if (!token) {
    console.log(`[Facebook Service Stub] (Simulating Feed comment reply to ID ${commentId}): "${text}"`);
    return { success: true, isMock: true };
  }

  try {
    const response = await axios.post(`https://graph.facebook.com/v19.0/${commentId}/comments`, {
      message: text
    }, {
      params: { access_token: token }
    });
    return { success: true, data: response.data };
  } catch (err) {
    console.error('[Facebook Service Error replying to comment]:', err.response?.data || err.message);
    throw err;
  }
};

/**
 * Sends an Automated Greeting + Assessment Lead Form link to a Facebook Messenger user
 */
exports.sendAutomatedFacebookGreeting = async (senderId, senderName) => {
  const prisma = require('../config/db');

  try {
    const cleanId = (senderId || '').replace(/[^\d]/g, '');
    if (!cleanId) return;

    // Check if an outbound automated message was sent to this senderId in the last 12 hours
    const recentOutbound = await prisma.communicationLog.findFirst({
      where: {
        phone: cleanId,
        channel: 'FACEBOOK',
        direction: 'OUTBOUND',
        createdAt: { gte: new Date(Date.now() - 12 * 60 * 60 * 1000) }
      }
    });

    if (recentOutbound) {
      console.log(`[Automated Facebook Greeting] Skipped: Recent outbound message already sent to ${cleanId} within 12h.`);
      return;
    }

    const clientName = (senderName && !senderName.includes('Meta User')) ? senderName : 'Valued Client';
    const leadFormUrl = `https://aaa-crm-service.netlify.app/#/public/lead-form?source=Facebook&fbId=${encodeURIComponent(cleanId)}`;

    const greetingText = `Greetings from AAA Business Consultancy LLC! ✈️🇪🇸\n\nDear ${clientName},\nThank you for reaching out to us on Facebook Messenger regarding Spain Visa & Residency Services.\n\nTo book your FREE 20-Minute Eligibility Assessment & Verification, please click the link below to complete your initial details:\n\n👉 ${leadFormUrl}\n\nOnce submitted, our dedicated consultant will immediately reach out to assist you.`;

    // 1. Send FB Messenger DM via Graph API
    await exports.sendMessengerMessage(cleanId, greetingText);

    // 2. Log Outbound Greeting in Database
    await prisma.communicationLog.create({
      data: {
        phone: cleanId,
        name: 'AI Bot',
        channel: 'FACEBOOK',
        direction: 'OUTBOUND',
        content: greetingText,
        deliveryStatus: 'SENT',
        messageId: `auto_fb_greeting_${Date.now()}`
      }
    });

    console.log(`[Automated Facebook Greeting Success] Sent greeting & lead form link to ${cleanId}`);
  } catch (err) {
    console.error(`[Automated Facebook Greeting Error] Failed for ${senderId}:`, err.message);
  }
};
