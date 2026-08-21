const https = require('https');

function testEndpoint(path, method = 'GET') {
  return new Promise((resolve) => {
    const options = {
      hostname: 'aaa-consultancy-backend-production.up.railway.app',
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({ path, method, status: res.statusCode, body: data });
      });
    });

    req.on('error', (e) => {
      resolve({ path, method, status: 'ERROR', error: e.message });
    });

    if (method === 'POST') {
      req.write(JSON.stringify({}));
    }
    req.end();
  });
}

async function runDebug() {
  const routesToTest = [
    { path: '/health', method: 'GET' },
    { path: '/api/v1/health', method: 'GET' },
    { path: '/api/v1/cases/active', method: 'GET' },
    { path: '/api/v1/cases/cycles', method: 'POST' },
    { path: '/api/v1/cases/cycles/a499d31e-b8c8-4c58-b35b-d0118a6ef75a', method: 'GET' },
    { path: '/api/v1/cases/cycles/a499d31e-b8c8-4c58-b35b-d0118a6ef75a/checklist', method: 'GET' },
    { path: '/api/v1/cases/cycles/a499d31e-b8c8-4c58-b35b-d0118a6ef75a/generate-checklist', method: 'POST' },
    { path: '/api/v1/cases/cycles/generate-checklist', method: 'POST' },
    { path: '/api/v1/cases/checklists/generate-checklist', method: 'POST' },
    { path: '/api/v1/cases/generate-checklist', method: 'POST' }
  ];

  console.log('--- TESTING RAILWAY LIVE BACKEND ROUTES ---');
  for (const r of routesToTest) {
    const res = await testEndpoint(r.path, r.method);
    console.log(`[${res.method}] ${res.path} -> Status: ${res.status} | Body: ${res.body.substring(0, 100)}`);
  }
}

runDebug();
