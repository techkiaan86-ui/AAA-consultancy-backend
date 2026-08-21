const { getActiveCases, getClosedCases, getCyclesByClient, createCycle, updateCycle } = require('./src/controllers/caseController');

// Mock response helper
function createMockRes() {
  return {
    statusCode: 200,
    responseData: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.responseData = data;
      return this;
    }
  };
}

async function runUnitTests() {
  console.log('--- STARTING PHASE 1 CONTROLLER UNIT SAFEGUARD TESTS ---');
  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`[PASS] ${message}`);
      passed++;
    } else {
      console.error(`[FAIL] ${message}`);
      failed++;
    }
  }

  const prisma = require('./src/config/db');

  // Backup original prisma methods
  const originalFindUnique = prisma.client.findUnique;
  const originalFindFirstCycle = prisma.applicationCycle.findFirst;
  const originalFindUniqueCycle = prisma.applicationCycle.findUnique;
  const originalCreateCycle = prisma.applicationCycle.create;
  const originalUpdateCycle = prisma.applicationCycle.update;
  const originalUpdateClient = prisma.client.update;
  const originalFindManyCycles = prisma.applicationCycle.findMany;
  const originalTransaction = prisma.$transaction;
  prisma.resubmissionChecklistItem = { 
    createMany: async () => ({ count: 5 }),
    findMany: async () => [{ isMandatory: true, status: 'VERIFIED' }]
  };
  prisma.$transaction = async (cb) => {
    return await cb(prisma);
  };

  try {
    // 1. Consultant Access Security (Unassigned consultant attempt)
    prisma.client.findUnique = async () => ({ id: 'client-1', assignedToId: 'assigned-consultant-id', visaStatus: 'Refused' });
    const consultantUnassignedReq = {
      user: { id: 'other-consultant-id', role: 'consultant' },
      body: { clientId: 'client-1', type: 'resubmission' }
    };
    const res1 = createMockRes();
    await createCycle(consultantUnassignedReq, res1);
    assert(res1.statusCode === 403, 'Unassigned consultant createCycle returns 403 Forbidden');

    // 2. Refusal Prerequisite Safeguard
    prisma.client.findUnique = async () => ({ id: 'client-1', assignedToId: 'assigned-consultant-id', visaStatus: 'Submitted - Pending Decision', status: 'Under Process' });
    const nonRefusedReq = {
      user: { id: 'admin-1', role: 'admin' },
      body: { clientId: 'client-1', type: 'resubmission' }
    };
    const res2 = createMockRes();
    await createCycle(nonRefusedReq, res2);
    assert(res2.statusCode === 400, 'Cycle creation on non-refused client returns 400 Bad Request');

    // 3. Duplicate Active Cycle Safeguard
    prisma.client.findUnique = async () => ({ id: 'client-1', assignedToId: 'assigned-consultant-id', visaStatus: 'Refused', status: 'Refused' });
    prisma.applicationCycle.findFirst = async () => ({ id: 'cycle-1', type: 'resubmission', status: 'Resubmission in Progress' });
    const duplicateReq = {
      user: { id: 'admin-1', role: 'admin' },
      body: { clientId: 'client-1', type: 'appeal' }
    };
    const res3 = createMockRes();
    await createCycle(duplicateReq, res3);
    assert(res3.statusCode === 409, 'Duplicate active cycle creation returns 409 Conflict');

    // 4. Valid Cycle Creation by Admin / Assigned Consultant
    prisma.applicationCycle.findFirst = async () => null; // No active cycle
    let clientVisaStatusUpdated = false;
    prisma.client.update = async ({ data }) => {
      clientVisaStatusUpdated = data.visaStatus === 'Resubmission in Progress' && data.status === undefined;
    };
    prisma.applicationCycle.create = async ({ data }) => ({ id: 'new-cycle-1', ...data });

    const validCreateReq = {
      user: { id: 'admin-1', role: 'admin', email: 'admin@aaa.com' },
      body: { clientId: 'client-1', type: 'resubmission', refusalReason: 'Missing document' }
    };
    const res4 = createMockRes();
    await createCycle(validCreateReq, res4);
    assert(res4.statusCode === 201 && res4.responseData.id === 'new-cycle-1', 'Valid cycle creation returns 201 Created');
    assert(clientVisaStatusUpdated, 'createCycle updates client.visaStatus correctly and preserves client.status untouched');

    // 5. Invalid Transition Sequence (Direct Jump: Resubmission in Progress -> Resubmitted)
    prisma.applicationCycle.findUnique = async () => ({ id: 'cycle-1', clientId: 'client-1', status: 'Resubmission in Progress' });
    const invalidJumpReq = {
      user: { id: 'admin-1', role: 'admin' },
      params: { id: 'cycle-1' },
      body: { status: 'Resubmitted' }
    };
    const res5 = createMockRes();
    await updateCycle(invalidJumpReq, res5);
    assert(res5.statusCode === 400, 'Invalid transition sequence (Resubmission in Progress -> Resubmitted) returns 400 Bad Request');

    // 6. Valid Transition Sequence (Resubmission in Progress -> Ready for Resubmission -> Resubmitted)
    prisma.client.update = async ({ data }) => {};
    const validStep1Req = {
      user: { id: 'admin-1', role: 'admin' },
      params: { id: 'cycle-1' },
      body: { status: 'Ready for Resubmission' }
    };
    prisma.applicationCycle.update = async ({ data }) => ({ id: 'cycle-1', status: data.status, clientId: 'client-1' });
    const res6 = createMockRes();
    await updateCycle(validStep1Req, res6);
    assert(res6.statusCode === 200 && res6.responseData.status === 'Ready for Resubmission', 'Valid transition to Ready for Resubmission returns 200 OK');

    prisma.applicationCycle.findUnique = async () => ({ id: 'cycle-1', clientId: 'client-1', status: 'Ready for Resubmission' });
    const validStep2Req = {
      user: { id: 'admin-1', role: 'admin' },
      params: { id: 'cycle-1' },
      body: { status: 'Resubmitted' }
    };
    const res7 = createMockRes();
    await updateCycle(validStep2Req, res7);
    assert(res7.statusCode === 200 && res7.responseData.status === 'Resubmitted', 'Valid transition to Resubmitted returns 200 OK');

    // 7. Client Security & Data Sanitization
    const clientCrossReq = {
      user: { id: 'client-A', role: 'client' },
      params: { clientId: 'client-B' }
    };
    const res8 = createMockRes();
    await getCyclesByClient(clientCrossReq, res8);
    assert(res8.statusCode === 403, 'Client A requesting Client B cycles returns 403 Forbidden');

    prisma.applicationCycle.findMany = async () => [
      { id: 'c1', status: 'Resubmission in Progress', appealDocuments: { notes: 'Private strategy notes', publicDoc: 'URL' } }
    ];
    const clientSelfReq = {
      user: { id: 'client-A', role: 'client' },
      params: { clientId: 'client-A' }
    };
    const res9 = createMockRes();
    await getCyclesByClient(clientSelfReq, res9);
    assert(res9.statusCode === 200, 'Client self access returns 200 OK');
    assert(res9.responseData[0].appealDocuments?.notes === undefined, 'Private lawyer notes are sanitized for client view');

  } catch (err) {
    console.error('Unit test error:', err);
    failed++;
  } finally {
    // Restore originals
    prisma.client.findUnique = originalFindUnique;
    prisma.applicationCycle.findFirst = originalFindFirstCycle;
    prisma.applicationCycle.findUnique = originalFindUniqueCycle;
    prisma.applicationCycle.create = originalCreateCycle;
    prisma.applicationCycle.update = originalUpdateCycle;
    prisma.client.update = originalUpdateClient;
    prisma.applicationCycle.findMany = originalFindManyCycles;

    console.log(`\n--- UNIT TEST SUMMARY: ${passed} PASSED, ${failed} FAILED ---`);
    process.exit(failed > 0 ? 1 : 0);
  }
}

runUnitTests();
