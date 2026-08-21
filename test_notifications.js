const { notifyClient } = require('./src/services/notificationService');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function runTests() {
  console.log("=== STARTING NOTIFICATION PIPELINE TESTS ===");

  try {
    // We'll create a dummy client to test idempotency and delivery
    const client = await prisma.client.create({
      data: {
        firstName: 'Test',
        lastName: 'Notification',
        email: 'test' + Date.now() + '@example.com',
        phone: '+1234567890', // non-whitelisted dummy
      }
    });

    const lead = await prisma.lead.create({
      data: {
        firstName: 'Test',
        lastName: 'Notification',
        email: client.email,
        phone: client.phone,
        clientId: client.id
      }
    });

    const consultation = await prisma.consultation.create({
      data: {
        leadId: lead.id,
        date: '2030-01-01',
        timeSlot: '14:00',
        status: 'Scheduled'
      }
    });

    console.log("[TEST 1] Testing MEETING_BOOKED Notification...");
    await notifyClient({
      event: 'MEETING_BOOKED',
      clientId: client.id,
      consultationId: consultation.id,
      data: { date: '2030-01-01', time: '14:00', link: 'http://zoom.us/test' }
    });

    console.log("\n[TEST 2] Testing MEETING_CANCELLED Notification...");
    await notifyClient({
      event: 'MEETING_CANCELLED',
      clientId: client.id,
      consultationId: consultation.id
    });

    // Verify logs
    const logs = await prisma.communicationLog.findMany({
      where: { clientId: client.id }
    });
    console.log("\n--- Communication Logs ---");
    logs.forEach(l => console.log(`[${l.channel}] ${l.direction} | Status: ${l.deliveryStatus} | Reason: ${l.failureReason || 'N/A'}`));

    // Clean up
    await prisma.communicationLog.deleteMany({ where: { clientId: client.id } });
    await prisma.consultation.deleteMany({ where: { leadId: lead.id } });
    await prisma.lead.deleteMany({ where: { id: lead.id } });
    await prisma.client.deleteMany({ where: { id: client.id } });
    
    console.log("\n=== TESTS COMPLETED ===");
  } catch (err) {
    console.error("Test failed:", err);
  } finally {
    await prisma.$disconnect();
  }
}

runTests();
