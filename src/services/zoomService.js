const axios = require('axios');

const ZOOM_ACCOUNT_ID = process.env.ZOOM_ACCOUNT_ID;
const ZOOM_CLIENT_ID = process.env.ZOOM_CLIENT_ID;
const ZOOM_CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET;

const isConfigured = !!(ZOOM_ACCOUNT_ID && ZOOM_CLIENT_ID && ZOOM_CLIENT_SECRET);

if (isConfigured) {
  console.log('Zoom Service: Configured and active.');
} else {
  console.warn('Zoom Service: Credentials not configured. Zoom scheduling will run in Mock Mode.');
}

/**
 * Gets a Server-to-Server OAuth access token from Zoom.
 * @returns {Promise<string|null>}
 */
const getZoomAccessToken = async () => {
  if (!isConfigured) return null;
  try {
    const tokenUrl = `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${ZOOM_ACCOUNT_ID}`;
    const authHeader = Buffer.from(`${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`).toString('base64');
    
    const response = await axios.post(tokenUrl, null, {
      headers: {
        'Authorization': `Basic ${authHeader}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
    
    return response.data.access_token;
  } catch (error) {
    const errorData = error.response?.data || error.message;
    console.error('Failed to retrieve Zoom access token:', JSON.stringify(errorData));
    throw new Error(`Zoom Auth Error: ${error.message}`);
  }
};

/**
 * Creates a Zoom meeting with automatic cloud recording enabled.
 * @param {Object} options
 * @param {string} options.topic - Meeting topic
 * @param {string} options.startTime - ISO 8601 formatted start time (e.g. 2026-07-13T12:00:00Z)
 * @param {number} options.durationMinutes - Meeting duration in minutes
 * @returns {Promise<{meetingId: string, joinUrl: string, startUrl: string}|null>}
 */
exports.createZoomMeeting = async ({ topic, startTime, durationMinutes }) => {
  if (!isConfigured) {
    return null;
  }
  
  try {
    const token = await getZoomAccessToken();
    const meetingUrl = 'https://api.zoom.us/v2/users/me/meetings';
    
    const response = await axios.post(meetingUrl, {
      topic: topic || 'Eligibility Assessment',
      type: 2, // Scheduled Meeting
      start_time: startTime,
      duration: durationMinutes || 30,
      timezone: 'UTC',
      settings: {
        host_video: true,
        participant_video: true,
        join_before_host: true,
        mute_upon_entry: true,
        auto_recording: 'cloud' // Force automatic cloud recording
      }
    }, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    
    return {
      meetingId: response.data.id.toString(),
      joinUrl: response.data.join_url,
      startUrl: response.data.start_url
    };
  } catch (error) {
    const errorData = error.response?.data || error.message;
    console.error('Failed to create Zoom meeting:', JSON.stringify(errorData));
    throw new Error(`Zoom API Error: ${error.message}`);
  }
};

exports.isConfigured = isConfigured;
exports.getZoomAccessToken = getZoomAccessToken;
