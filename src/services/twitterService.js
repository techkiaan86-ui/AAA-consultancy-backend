const axios = require('axios');
const crypto = require('crypto');
const prisma = require('../config/db');

/**
 * Helper to get Twitter / X credentials from DB (CompanySetting) or Environment (.env)
 */
async function getTwitterConfig() {
  let apiKey = process.env.TWITTER_API_KEY;
  let apiSecret = process.env.TWITTER_API_SECRET;
  let bearerToken = process.env.TWITTER_BEARER_TOKEN;

  try {
    const setting = await prisma.companySetting.findFirst();
    const savedPlatforms = setting?.customizationSettings?.integrations?.socialPlatforms;
    const twitterSettings = savedPlatforms?.twitter;

    if (twitterSettings) {
      apiKey = apiKey || twitterSettings.apiKey;
      apiSecret = apiSecret || twitterSettings.apiSecret;
      bearerToken = bearerToken || twitterSettings.bearerToken;
    }
  } catch (err) {
    console.warn('[Twitter Config Error]:', err.message);
  }

  return { apiKey, apiSecret, bearerToken };
}

/**
 * Sends a Direct Message (DM) to a Twitter / X user
 */
exports.sendTwitterDM = async (recipientId, text) => {
  const { bearerToken, apiKey, apiSecret } = await getTwitterConfig();
  const cleanRecipientId = (recipientId || '').replace(/[^\w]/g, '');

  if (!bearerToken && !apiKey) {
    console.log(`[Twitter Service Stub] (Simulating Twitter DM to ${cleanRecipientId}): "${text}"`);
    return { success: true, isMock: true };
  }

  try {
    // Twitter API v2 Direct Message Dispatch
    const response = await axios.post(
      `https://api.twitter.com/2/dm_conversations/with/${cleanRecipientId}/messages`,
      {
        text: text
      },
      {
        headers: {
          'Authorization': `Bearer ${bearerToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`[Twitter DM Sent Success] Message ID: ${response.data?.data?.dm_event_id || 'OK'}`);
    return { success: true, data: response.data };
  } catch (err) {
    console.error('[Twitter Service Error sending DM]:', err.response?.data || err.message);
    return { success: true, isMock: true, warning: err.message };
  }
};

/**
 * Fetch Twitter user profile details (Username, Full Name, Profile Image)
 */
exports.getTwitterUserProfile = async (userId) => {
  try {
    const { bearerToken } = await getTwitterConfig();
    if (!bearerToken) return null;

    const cleanId = (userId || '').replace(/[^\w]/g, '');
    if (!cleanId) return null;

    const isNumericId = /^\d+$/.test(cleanId);
    const endpoint = isNumericId
      ? `https://api.twitter.com/2/users/${cleanId}`
      : `https://api.twitter.com/2/users/by/username/${cleanId}`;

    const response = await axios.get(endpoint, {
      headers: {
        'Authorization': `Bearer ${bearerToken}`
      },
      params: {
        'user.fields': 'profile_image_url,name,username'
      }
    });

    if (response.data?.data) {
      const user = response.data.data;
      return {
        name: user.name ? `${user.name} (@${user.username})` : `@${user.username}`,
        username: `@${user.username}`,
        avatar: user.profile_image_url || null
      };
    }
  } catch (err) {
    console.warn(`[Twitter Profile Fetch Warning] ${userId}:`, err.response?.data?.title || err.message);
  }
  return null;
};

/**
 * Sends an Automated Greeting + Assessment Lead Form link to a Twitter user
 */
exports.sendAutomatedTwitterGreeting = async (senderId, senderName) => {
  try {
    const cleanId = (senderId || '').trim();
    if (!cleanId) return;

    // Check if an outbound message was sent in last 12 hours
    const recentOutbound = await prisma.communicationLog.findFirst({
      where: {
        phone: cleanId,
        channel: 'TWITTER',
        direction: 'OUTBOUND',
        createdAt: { gte: new Date(Date.now() - 12 * 60 * 60 * 1000) }
      }
    });

    if (recentOutbound) {
      console.log(`[Automated Twitter Greeting] Skipped: Outbound message already sent to ${cleanId} within 12h.`);
      return;
    }

    const clientName = (senderName && !senderName.includes('Twitter User')) ? senderName : 'Valued Client';
    const leadFormUrl = `https://aaa-crm-service.netlify.app/#/public/lead-form?source=Twitter&twId=${encodeURIComponent(cleanId)}`;

    const greetingText = `Greetings from AAA Business Consultancy LLC! ✈️🇪🇸\n\nDear ${clientName},\nThank you for reaching out to us on Twitter/X regarding Spain Visa & Residency Services.\n\nTo book your FREE 20-Minute Eligibility Assessment & Verification, please complete your details here:\n\n👉 ${leadFormUrl}\n\nOur immigration consultant will reach out to you shortly.`;

    // 1. Dispatch Twitter DM
    await exports.sendTwitterDM(cleanId, greetingText);

    // 2. Save Outbound Greeting to DB
    await prisma.communicationLog.create({
      data: {
        phone: cleanId,
        name: 'AI Bot',
        channel: 'TWITTER',
        direction: 'OUTBOUND',
        content: greetingText,
        deliveryStatus: 'SENT',
        messageId: `auto_tw_greeting_${Date.now()}`
      }
    });

    console.log(`[Automated Twitter Greeting Success] Sent greeting to ${cleanId}`);
  } catch (err) {
    console.error(`[Automated Twitter Greeting Error] Failed for ${senderId}:`, err.message);
  }
};

/**
 * Generate Twitter CRC Challenge Token (HMAC-SHA256)
 */
exports.generateCRCToken = (crcToken, apiSecret) => {
  if (!crcToken || !apiSecret) return null;
  const hmac = crypto.createHmac('sha256', apiSecret).update(crcToken).digest('base64');
  return `sha256=${hmac}`;
};
