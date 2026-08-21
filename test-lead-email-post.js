require('dotenv').config();
const { createLead } = require('./src/controllers/leadController');

async function testLeadDualDispatch() {
  console.log('Testing createLead Dual WhatsApp + Email dispatch...');

  const mockReq = {
    body: {
      firstName: 'Ritik',
      lastName: 'Gawde',
      email: 'ritikgawde9@gmail.com',
      phone: '+917693091260',
      nationality: 'Indian',
      countryOfResidence: 'India',
      preferredLanguage: 'English',
      serviceType: 'Digital Nomad Visa',
      meetingPreferredDate: '2026-08-07',
      meetingPreferredTime: '11:00',
      meetingNotes: 'Dual WhatsApp and Email Test'
    },
    app: {
      get: () => null
    }
  };

  const mockRes = {
    status: (statusCode) => ({
      json: (data) => {
        console.log(`[HTTP Response ${statusCode}]:`, JSON.stringify(data, null, 2));
      }
    })
  };

  try {
    await createLead(mockReq, mockRes);
  } catch (err) {
    console.error('Error during testLeadDualDispatch execution:', err);
  }
}

testLeadDualDispatch();
