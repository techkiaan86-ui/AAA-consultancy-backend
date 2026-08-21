const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function fixAllClientCodes() {
  try {
    const clients = await prisma.client.findMany({
      orderBy: { createdAt: 'asc' }
    });

    console.log(`Total clients in DB: ${clients.length}`);

    // Track used CID numbers
    const usedNumbers = new Set();
    const clientsToFix = [];

    for (const client of clients) {
      if (client.clientCode && client.clientCode.startsWith('CID ')) {
        const num = parseInt(client.clientCode.replace('CID ', ''), 10);
        if (!isNaN(num)) {
          usedNumbers.add(num);
        } else {
          clientsToFix.push(client);
        }
      } else {
        clientsToFix.push(client);
      }
    }

    console.log(`Clients with missing or invalid clientCode: ${clientsToFix.length}`);

    let nextNumber = 12001;
    for (const client of clientsToFix) {
      while (usedNumbers.has(nextNumber)) {
        nextNumber++;
      }

      const newCode = `CID ${nextNumber}`;
      await prisma.client.update({
        where: { id: client.id },
        data: { clientCode: newCode }
      });
      usedNumbers.add(nextNumber);
      console.log(`Fixed client ${client.id} (${client.firstName} ${client.lastName}) -> ${newCode}`);
    }

    console.log('All client codes fixed successfully!');
  } catch (err) {
    console.error('Fix error:', err);
  } finally {
    await prisma.$disconnect();
  }
}

fixAllClientCodes();
