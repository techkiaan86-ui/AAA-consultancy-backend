const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
  const cons = await prisma.consultation.findMany({
    where: { leadId: 'a03f1c2b-7c1c-4f7b-b10f-b7c181741a33' }
  });
  console.log(JSON.stringify(cons, null, 2));
}

run()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
