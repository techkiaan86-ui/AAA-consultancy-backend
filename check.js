const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const clients = await prisma.client.findMany({
    where: { email: 'test@gmail.com' },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { id: true, email: true, status: true, documentUploadAllowed: true, payments: { select: { status: true, amount: true } } }
  });
  console.log(JSON.stringify(clients, null, 2));
}

main().finally(() => prisma.$disconnect());
