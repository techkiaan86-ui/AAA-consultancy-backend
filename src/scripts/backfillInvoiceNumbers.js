require('dotenv').config();
const prisma = require('../config/db');

async function backfillInvoiceNumbers() {
  console.log('--- Starting Backfill of Invoice Numbers ---');
  try {
    const payments = await prisma.payment.findMany();

    console.log(`Found ${payments.length} total payment records.`);

    let updatedCount = 0;
    for (const p of payments) {
      if (!p.invoiceNumber || p.invoiceNumber.length > 25) {
        const shortHex = (p.id || '').replace(/-/g, '').slice(0, 8).toUpperCase();
        const generatedInvoiceNum = `INV-2026-${shortHex}`;

        await prisma.payment.update({
          where: { id: p.id },
          data: {
            invoiceNumber: generatedInvoiceNum
          }
        });
        updatedCount++;
      }
    }

    console.log(`✅ Successfully backfilled ${updatedCount} payment records with invoiceNumber.`);
  } catch (error) {
    console.error('Error during invoiceNumber backfill:', error);
  } finally {
    await prisma.$disconnect();
  }
}

backfillInvoiceNumbers();
