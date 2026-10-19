// Starts server.js without a reachable database and checks how it answers browsers.
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const PORT = 18000 + Math.floor(Math.random() * 1000);

function get(p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, headers }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

let child;
test.before(async () => {
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), MONGODB_URI: 'mongodb://127.0.0.1:1/x?serverSelectionTimeoutMS=500' }),
    stdio: 'ignore'
  });
  for (let i = 0; i < 50; i++) {
    try { await get('/healthz'); return; } catch (e) { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
});
test.after(() => child && child.kill());

test('serves the app with security headers', async () => {
  const r = await get('/');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
  assert.match(r.headers['content-security-policy'], /frame-ancestors 'self'/);
});

test('does not serve server code or secrets', async () => {
  for (const p of ['/server.js', '/package.json', '/cctv/.env', '/cctv/relay.py', '/node_modules/ws/package.json']) {
    assert.strictEqual((await get(p)).status, 404, p);
  }
});

test('a malformed URL gets 400 and the server keeps running', async () => {
  assert.strictEqual((await get('/%E0')).status, 400);
  assert.strictEqual((await get('/')).status, 200);
});

test('health check and API report the database is not ready', async () => {
  assert.strictEqual((await get('/healthz')).status, 503);
  assert.strictEqual((await get('/api/bookings')).status, 503);
});

test('versioned assets are cached, gzip is used', async () => {
  const r = await get('/script.js?v=1', { 'accept-encoding': 'gzip' });
  assert.match(r.headers['cache-control'], /immutable/);
  assert.strictEqual(r.headers['content-encoding'], 'gzip');
});
