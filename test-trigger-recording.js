const axios = require('axios');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function triggerMockWebhook() {
  console.log('--- Zoom Webhook Local Simulation Tool ---');
  
  // Find target consultation (either specific or latest)
  let consultationId = process.argv[2];
  let consultation = null;

  if (consultationId) {
    console.log(`Looking for Consultation with ID: ${consultationId}`);
    consultation = await prisma.consultation.findUnique({
      where: { id: consultationId }
    });
  } else {
    console.log('No Consultation ID provided. Fetching the latest scheduled consultation...');
    consultation = await prisma.consultation.findFirst({
      where: {
        meetingLink: {
          not: null
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });
  }

  if (!consultation) {
    console.error('Error: No eligible Consultation found in the database. Please schedule a meeting first.');
    await prisma.$disconnect();
    return;
  }

  console.log(`\nFound Consultation:`);
  console.log(`- ID: ${consultation.id}`);
  console.log(`- Date: ${consultation.date}`);
  console.log(`- Meeting Link: ${consultation.meetingLink}`);

  // Extract Zoom Meeting ID from the link (extracts sequence of digits)
  const match = consultation.meetingLink.match(/j\/(\d+)/) || consultation.meetingLink.match(/(\d+)/);
  if (!match) {
    console.error('Error: Could not extract Zoom meeting ID from the meeting link.');
    await prisma.$disconnect();
    return;
  }

  const zoomMeetingId = match[1];
  console.log(`- Extracted Zoom Meeting ID: ${zoomMeetingId}`);

  // Mock Zoom webhook payload
  const webhookPayload = {
    event: 'recording.completed',
    event_ts: Date.now(),
    payload: {
      account_id: 'mock_account_id',
      object: {
        uuid: 'mock_uuid_12345',
        id: parseInt(zoomMeetingId, 10),
        host_id: 'mock_host_id',
        topic: 'Spain Visa Eligibility Assessment',
        type: 2,
        share_url: 'https://us02web.zoom.us/rec/share/mock-assessment-recording-url-12345',
        recording_files: [
          {
            id: 'mock_file_id',
            meeting_id: zoomMeetingId,
            play_url: 'https://us02web.zoom.us/rec/play/mock-play-url',
            download_url: 'https://us02web.zoom.us/rec/webhook_download/mock-download-url',
            status: 'completed',
            file_type: 'MP4'
          }
        ]
      }
    }
  };

  const port = process.env.PORT || 5000;
  const webhookUrl = `http://localhost:${port}/api/v1/webhooks/zoom`;

  console.log(`\nSending mock Zoom Webhook (recording.completed) to ${webhookUrl}...`);

  try {
    const response = await axios.post(webhookUrl, webhookPayload);
    console.log(`Response Status: ${response.status} (${response.statusText})`);
    console.log(`Response Data: ${response.data}`);
    console.log('\nSuccess! Check your CRM page now. The loading spinner should have updated to the "Play Recording on Zoom Cloud" button.');
  } catch (error) {
    console.error('\nError sending webhook to local server:');
    if (error.response) {
      console.error(`- Status: ${error.response.status}`);
      console.error(`- Data: ${error.response.data}`);
    } else {
      console.error(`- Message: ${error.message}`);
    }
    console.log('\nMake sure your backend server is running on port ' + port + ' before running this script.');
  } finally {
    await prisma.$disconnect();
  }
}

triggerMockWebhook();
