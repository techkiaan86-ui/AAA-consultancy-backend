const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Try to find the lead
  let lead = await prisma.lead.findFirst({
    where: { OR: [
      { id: 'dabd6864-5f07-43b1-a62f-dde5759bf7e2' },
      { id: '238886b6-3632-4fa3-b6e6-27413cca393c' },
      { email: 'avnish@gmail.com' }
    ]}
  });

  if (!lead) {
    console.log("Lead not found");
    return;
  }

  console.log("Found lead:", lead.firstName, lead.id);

  // See if there's already a consultation
  const existing = await prisma.consultation.findFirst({
    where: { leadId: lead.id }
  });

  if (existing) {
    console.log("Updating existing consultation...");
    await prisma.consultation.update({
      where: { id: existing.id },
      data: {
        date: '2026-07-20',
        timeSlot: 'Morning',
        status: 'Pending Acceptance',
        consultantId: lead.assignedToId || null
      }
    });
  } else {
    console.log("Creating new consultation...");
    await prisma.consultation.create({
      data: {
        date: '2026-07-20',
        timeSlot: 'Morning',
        durationMinutes: 30,
        status: 'Pending Acceptance',
        leadId: lead.id,
        consultantId: lead.assignedToId || null,
        internalNotes: 'I want to know about Digital Nomad Visa process and requirements.'
      }
    });
  }

  console.log("Done!");
}

main()
  .catch(e => console.error(e))
  .finally(async () => {
    await prisma.$disconnect();
  });
