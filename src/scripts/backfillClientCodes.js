const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function backfillClientCodes() {
  try {
    const clients = await prisma.client.findMany({
      orderBy: { createdAt: 'asc' }
    });

    console.log(`Found ${clients.length} clients in database.`);
    let startNumber = 12001;

    for (let i = 0; i < clients.length; i++) {
      const client = clients[i];
      const targetCode = `CID ${startNumber + i}`;

      if (!client.clientCode || !client.clientCode.startsWith('CID ')) {
        await prisma.client.update({
          where: { id: client.id },
          data: { clientCode: targetCode }
        });
        console.log(`Updated client ${client.id} (${client.firstName} ${client.lastName}) -> ${targetCode}`);
      } else {
        console.log(`Client ${client.id} already has code ${client.clientCode}`);
      }
    }

    console.log('Backfill complete!');
  } catch (err) {
    console.error('Backfill error:', err);
  } finally {
    await prisma.$disconnect();
  }
}

backfillClientCodes();
