require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function clearTestPhones() {
  const phone = '7047687998';
  
  console.log('=== Clearing phone 7047687998 from all test clients ===\n');
  
  // Find all clients with this phone
  const clients = await prisma.client.findMany({
    where: { phone: { contains: phone } },
    select: { id: true, firstName: true, lastName: true, email: true, phone: true, status: true }
  });
  
  console.log(`Found ${clients.length} clients with this phone.`);
  
  // Clear phone from all of them
  let updated = 0;
  for (const c of clients) {
    await prisma.client.update({
      where: { id: c.id },
      data: { phone: '' }
    });
    console.log(`  Cleared: ${c.firstName} ${c.lastName} (${c.email})`);
    updated++;
  }
  
  // Also clear any leads with this phone
  const leads = await prisma.lead.findMany({
    where: { phone: { contains: phone } }
  });
  
  for (const l of leads) {
    await prisma.lead.update({
      where: { id: l.id },
      data: { phone: '' }
    });
    console.log(`  Lead cleared: ${l.firstName} ${l.lastName} (${l.email}) - status: ${l.status}`);
  }
  
  console.log(`\n✅ Done! Cleared phone from ${updated} clients and ${leads.length} leads.`);
  console.log('Ab usi phone number se fresh booking kar sakte ho!');
  
  await prisma.$disconnect();
}

clearTestPhones().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
