const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// The strict 32 statuses as defined by enterprise architecture
const VALID_STATUSES = [
  "New Lead", "Assessment Booked", "Assessment Completed - Eligible",
  "Assessment Completed - Not Eligible", "No-Show", "Waiting for Payment",
  "Payment Received - Pending Docs", "Documents Under Verification",
  "Documents Rejected", "Documents Verified - Processing Application",
  "Submitted to Government", "Government Additional Info Requested",
  "Approved - Visa Granted", "Refused", "Appeal in Progress",
  "Appeal Successful", "Appeal Denied", "Resubmission in Progress",
  "Relocation Planning", "Completed", "Refund Requested",
  "Refund Processed", "Client Unresponsive", "Blocked - Fraud Detected",
  // Additional internal statuses...
];

const updateApplicationStatus = async (applicationId, newStatus, actorId, previousState = {}) => {
  if (!VALID_STATUSES.includes(newStatus)) {
    throw new Error(`Invalid status transition to: ${newStatus}`);
  }

  return await prisma.$transaction(async (tx) => {
    // 1. Update Application Cycle State
    const updatedApp = await tx.applicationCycle.update({
      where: { id: applicationId },
      data: { status: newStatus }
    });

    // 2. Cascade Client Visa Status
    await tx.client.update({
      where: { id: updatedApp.clientId },
      data: { visaStatus: newStatus }
    });

    // 3. WORM Audit Logging
    await tx.auditLog.create({
      data: {
        applicationId,
        actorId,
        action: 'STATUS_CHANGED',
        previousState: previousState,
        newState: { status: newStatus }
      }
    });

    return updatedApp;
  });
};

module.exports = {
  updateApplicationStatus,
  VALID_STATUSES
};
