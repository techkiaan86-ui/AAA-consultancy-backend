const prisma = require('../config/db');

/**
 * Asynchronously logs an activity entry into AuditLog table.
 * Does not block or fail main request execution if logging fails.
 */
async function logActivity({
  leadId,
  clientId,
  documentId,
  applicationId,
  actorId,
  actorName,
  actorRole,
  action,
  description,
  previousState,
  newState
}) {
  try {
    const log = await prisma.auditLog.create({
      data: {
        leadId: leadId || undefined,
        clientId: clientId || undefined,
        documentId: documentId || undefined,
        applicationId: applicationId || undefined,
        actorId: actorId || 'system',
        actorName: actorName || 'System',
        actorRole: actorRole || 'system',
        action: action || 'ACTION_LOGGED',
        description: description || '',
        previousState: previousState ? JSON.parse(JSON.stringify(previousState)) : undefined,
        newState: newState ? JSON.parse(JSON.stringify(newState)) : undefined
      }
    });
    console.log(`[AuditLog] Activity recorded (${action}): ${description}`);
    return log;
  } catch (err) {
    console.error('[AuditLog Error] Failed to write audit log:', err.message);
    return null;
  }
}

module.exports = { logActivity };
