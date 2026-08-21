require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkPhone() {
  const phone = '7047687998';
  
  console.log('=== Checking phone: +91 7047687998 ===\n');
  
  // Check Leads
  const leads = await prisma.lead.findMany({
    where: { phone: { contains: phone } },
    orderBy: { createdAt: 'desc' }
  });
  
  console.log(`LEADS found: ${leads.length}`);
  leads.forEach(l => {
    console.log(`  - ID: ${l.id}`);
    console.log(`    Name: ${l.firstName} ${l.lastName}`);
    console.log(`    Email: ${l.email}`);
    console.log(`    Status: ${l.status}`);
    console.log(`    Outcome: ${l.outcome}`);
    console.log(`    Created: ${l.createdAt}`);
    console.log('');
  });
  
  // Check Clients
  const clients = await prisma.client.findMany({
    where: { phone: { contains: phone } }
  });
  
  console.log(`CLIENTS found: ${clients.length}`);
  clients.forEach(c => {
    console.log(`  - ID: ${c.id}`);
    console.log(`    Name: ${c.firstName} ${c.lastName}`);
    console.log(`    Email: ${c.email}`);
    console.log(`    Status: ${c.status}`);
    console.log(`    isBlocked: ${c.isBlocked}`);
    console.log('');
  });
  
  // Check Blacklist
  const blacklisted = await prisma.blacklistedClient.findMany({
    where: { phone: { contains: phone } }
  });
  
  console.log(`BLACKLISTED found: ${blacklisted.length}`);
  blacklisted.forEach(b => {
    console.log(`  - Name: ${b.name}, Email: ${b.email}, Phone: ${b.phone}`);
  });

  await prisma.$disconnect();
}

checkPhone().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
