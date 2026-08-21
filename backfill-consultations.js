require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const leads = await prisma.lead.findMany({
    where: { 
      assignedToId: { not: null }
    },
    include: { consultations: true }
  });

  for (const lead of leads) {
    if (lead.consultations.length === 0) {
      const fallbackDate = lead.formSubmittedAt ? new Date(lead.formSubmittedAt).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
      const meetingDate = lead.meetingPreferredDate || fallbackDate;
      const meetingTime = lead.meetingPreferredTime || 'TBD / Flexible';

      console.log(`Creating consultation for lead: ${lead.firstName} ${lead.lastName} (ID: ${lead.id})`);
      await prisma.consultation.create({
        data: {
          date: meetingDate,
          timeSlot: meetingTime,
          durationMinutes: 30,
          status: 'Pending Acceptance',
          leadId: lead.id,
          consultantId: lead.assignedToId,
          internalNotes: lead.meetingNotes || 'Auto-created consultation session'
        }
      });
    }
  }
  console.log("Backfill complete!");
}

main()
  .catch(e => console.error(e))
  .finally(() => prisma.$disconnect());
