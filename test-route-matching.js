const express = require('express');
const caseRoutes = require('./src/routes/caseRoutes');

const app = express();
app.use(express.json());

// Mock authMiddleware & rbacMiddleware for local route testing
app.use((req, res, next) => {
  req.user = { id: 'test-user-id', role: 'super_admin', email: 'test@example.com' };
  next();
});

app.use('/api/v1/cases', caseRoutes);

const server = app.listen(5099, async () => {
  console.log('Testing route matching on port 5099...');

  try {
    const resGetCycles = await fetch('http://localhost:5099/api/v1/cases/cycles/client-123');
    console.log('GET /cycles/client-123 -> Status:', resGetCycles.status);

    const resGetChecklist = await fetch('http://localhost:5099/api/v1/cases/cycles/cycle-456/checklist');
    console.log('GET /cycles/cycle-456/checklist -> Status:', resGetChecklist.status);

    const resPostGenerate = await fetch('http://localhost:5099/api/v1/cases/cycles/cycle-456/generate-checklist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    console.log('POST /cycles/cycle-456/generate-checklist -> Status:', resPostGenerate.status);

  } catch (err) {
    console.error('Fetch error:', err);
  } finally {
    server.close();
  }
});
