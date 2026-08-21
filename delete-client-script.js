const prisma = require('./src/config/db');

async function findAndDelete() {
  try {
    const term = '7693091260';
    console.log('Searching for records with phone term:', term);

    const clients = await prisma.client.findMany({
      where: { phone: { contains: term } }
    });
    console.log(`Found ${clients.length} Client records:`);
    clients.forEach(c => console.log(` - ID: ${c.id}, Name: ${c.firstName} ${c.lastName}, Phone: ${c.phone}, Email: ${c.email}`));

    const leads = await prisma.lead.findMany({
      where: { phone: { contains: term } }
    });
    console.log(`Found ${leads.length} Lead records:`);
    leads.forEach(l => console.log(` - ID: ${l.id}, Name: ${l.firstName} ${l.lastName}, Phone: ${l.phone}, Email: ${l.email}`));

    for (const c of clients) {
      console.log(`Deleting dependent records for Client ID ${c.id}...`);
      await prisma.payment.deleteMany({ where: { clientId: c.id } }).catch(() => {});
      await prisma.document.deleteMany({ where: { clientId: c.id } }).catch(() => {});
      await prisma.notification.deleteMany({ where: { clientId: c.id } }).catch(() => {});
      await prisma.applicationCycle.deleteMany({ where: { clientId: c.id } }).catch(() => {});
      await prisma.lead.deleteMany({ where: { clientId: c.id } }).catch(() => {});
      await prisma.client.delete({ where: { id: c.id } });
      console.log(`Deleted Client ${c.id}`);
    }

    for (const l of leads) {
      console.log(`Deleting dependent records for Lead ID ${l.id}...`);
      await prisma.consultation.deleteMany({ where: { leadId: l.id } });
      await prisma.lead.delete({ where: { id: l.id } });
      console.log(`Deleted Lead ${l.id}`);
    }

    console.log('\n============================================================');
    console.log('✅ CLEANUP COMPLETE: All records for phone 7693091260 removed!');
    console.log('============================================================');
  } catch (err) {
    console.error('Error during cleanup:', err.message);
  } finally {
    await prisma.$disconnect();
  }
}

findAndDelete();
