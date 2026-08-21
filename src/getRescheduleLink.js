require('dotenv').config({ path: __dirname + '/../.env' });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const jwt = require('jsonwebtoken');

const { JWT_SECRET } = require('./config/jwt');

async function main() {
  const lead = await prisma.lead.findFirst({
    where: {
      OR: [
        { email: { contains: 'abc' } },
        { phone: { contains: '7047687998' } },
        { firstName: { contains: 'abc' } }
      ]
    },
    include: { consultations: true, client: true }
  });

  if (!lead) {
    console.log('Lead not found');
    return;
  }

  console.log('--- LEAD DETAILS ---');
  console.log('Lead ID:', lead.id);
  console.log('Name:', lead.firstName, lead.lastName);
  console.log('Email:', lead.email);
  console.log('Phone:', lead.phone);

  const consultation = lead.consultations && lead.consultations.length > 0 ? lead.consultations[0] : null;
  if (!consultation) {
    console.log('No consultation record found for lead');
    return;
  }

  const token = jwt.sign({ consultationId: consultation.id, purpose: 'reschedule_cancel' }, JWT_SECRET, { expiresIn: '30d' });

  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const rescheduleUrlWithToken = `${frontendUrl}/#/public/lead-form?reschedule=true&token=${token}&consultationId=${consultation.id}`;
  const directRescheduleUrl = `${frontendUrl}/#/reschedule-meeting/${token}`;
  const simpleUrl = `${frontendUrl}/#/public/lead-form?reschedule=true&consultationId=${consultation.id}`;

  console.log('\n--- RESCHEDULE LINKS ---');
  console.log('Consultation ID:', consultation.id);
  console.log('Secure Token Link:', rescheduleUrlWithToken);
  console.log('Direct Token Route:', directRescheduleUrl);
  console.log('Simple Link:', simpleUrl);
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
  });
