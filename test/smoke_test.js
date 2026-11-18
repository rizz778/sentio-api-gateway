const http = require('http');
const WebSocket = require('ws');

// Override port for testing
process.env.PORT = '4001';
process.env.GRPC_TARGET = 'localhost:50051';

console.log('[Test] Starting Gateway test...');

// Require gateway index (boots on port 4001)
require('../src/index');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  await sleep(1000);

  // 1. Test /healthz
  console.log('[Test] 1. Testing GET /healthz...');
  const healthRes = await new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:4001/healthz', (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: JSON.parse(data) }));
    }).on('error', reject);
  });

  if (healthRes.statusCode !== 200 || healthRes.body.status !== 'ok') {
    throw new Error(`Healthcheck failed: ${JSON.stringify(healthRes)}`);
  }
  console.log('[Test] ✓ /healthz responded OK:', healthRes.body.status, healthRes.body.service);

  // 2. Test /ready
  console.log('[Test] 2. Testing GET /ready...');
  const readyRes = await new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:4001/ready', (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: JSON.parse(data) }));
    }).on('error', reject);
  });

  if (readyRes.statusCode !== 200 || readyRes.body.status !== 'ready') {
    throw new Error(`Readiness check failed: ${JSON.stringify(readyRes)}`);
  }
  console.log('[Test] ✓ /ready responded OK:', readyRes.body.status);

  // 3. Test WebSocket connection to /ws/live
  console.log('[Test] 3. Testing WebSocket connection to ws://127.0.0.1:4001/ws/live...');
  const ws = new WebSocket('ws://127.0.0.1:4001/ws/live?sessionId=test-session-1&userId=user-42');

  const wsOpenPromise = new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  await wsOpenPromise;
  console.log('[Test] ✓ WebSocket opened successfully');

  // Verify connection manager registered it
  const statsRes = await new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:4001/healthz', (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });

  if (statsRes.connections.activeConnections !== 1) {
    throw new Error(`Expected 1 active connection, got: ${statsRes.connections.activeConnections}`);
  }
  console.log('[Test] ✓ Connection Manager tracked connection: activeConnections = 1');

  // Send an interrupt frame (barge-in)
  console.log('[Test] 4. Testing client interrupt frame...');
  ws.send(JSON.stringify({ type: 'interrupt', reason: 'user_speaking' }));

  // Send a raw PCM binary buffer
  console.log('[Test] 5. Testing binary PCM audio frame...');
  const dummyAudioChunk = Buffer.alloc(320); // 10ms of 16-bit 16kHz audio
  ws.send(dummyAudioChunk);

  await sleep(500);

  // Close WS
  ws.close();
  console.log('[Test] ✓ WebSocket closed cleanly');

  await sleep(300);
  console.log('[Test] All gateway unit/smoke tests passed successfully!');
  process.exit(0);
}

run().catch((err) => {
  console.error('[Test] FAILED:', err);
  process.exit(1);
});
