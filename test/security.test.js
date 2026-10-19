// Run with: npm test
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const security = require('../security');

const root = path.resolve(__dirname, '..');

test('static files: app pages and assets are public', () => {
  assert.strictEqual(security.resolvePublicPath(root, '/'), path.join(root, 'index.html'));
  assert.strictEqual(security.resolvePublicPath(root, '/script.js'), path.join(root, 'script.js'));
  assert.strictEqual(security.resolvePublicPath(root, '/icons/icon-192.png'), path.join(root, 'icons/icon-192.png'));
  assert.strictEqual(security.resolvePublicPath(root, '/dashboard/'), path.join(root, 'dashboard') + path.sep);
  assert.strictEqual(security.resolvePublicPath(root, '/dashboard'), path.join(root, 'dashboard'));
});

test('static files: server code, secrets and dotfiles are not', () => {
  for (const p of ['/server.js', '/org.js', '/package.json', '/cctv/.env', '/cctv/relay.py', '/.env',
    '/.git/config', '/node_modules/ws/package.json', '/scripts/migrate-multi-org.js', '/README.md',
    '/dashboard/README.md', '/../etc/passwd', '/icons/../server.js', '/a\0b']) {
    assert.strictEqual(security.resolvePublicPath(root, p), null, p);
  }
});

test('booking validation', () => {
  const ok = { room: 'ห้อง 101', date: '2026-10-19', startTime: '09:00', endTime: '10:30', bookerName: 'Somchai' };
  assert.strictEqual(security.bookingProblem(ok), '');
  assert.strictEqual(security.bookingProblem({ ...ok, endTime: '24:00' }), '');
  assert.ok(security.bookingProblem({ ...ok, room: { $ne: null } }));
  assert.ok(security.bookingProblem({ ...ok, date: '19/10/2026' }));
  assert.ok(security.bookingProblem({ ...ok, startTime: '9:00' }));
  assert.ok(security.bookingProblem({ ...ok, startTime: '11:00' }));  // after end
  assert.ok(security.bookingProblem({ ...ok, bookerName: 'x'.repeat(101) }));
  assert.ok(security.bookingProblem({ ...ok, purpose: 'x'.repeat(501) }));
});

test('service URLs set by owners must be public https', () => {
  assert.ok(security.isAllowedServiceUrl('https://controlbuu-production.up.railway.app'));
  for (const u of ['http://example.com', 'https://127.0.0.1', 'https://10.0.0.5/x', 'https://169.254.169.254',
    'https://localhost:8080', 'https://svc.railway.internal', 'https://[::1]/', 'https://user:pw@example.com', 'not a url']) {
    assert.ok(!security.isAllowedServiceUrl(u), u);
  }
});

test('private address detection', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1']) {
    assert.ok(security.isPrivateAddress(ip), ip);
  }
  for (const ip of ['8.8.8.8', '104.16.0.1', '2606:4700::1111']) assert.ok(!security.isPrivateAddress(ip), ip);
});

test('organization clock uses its timezone', () => {
  const now = new Date('2026-10-19T20:30:15Z');
  assert.deepStrictEqual(security.orgClock({ settings: { timezone: 'Asia/Bangkok' } }, now),
    { today: '2026-10-20', minutes: 3 * 60 + 30, seconds: 3 * 3600 + 30 * 60 + 15 });
  assert.strictEqual(security.orgClock({ settings: { timezone: 'Europe/London' } }, now).today, '2026-10-19');
  assert.strictEqual(security.orgClock({ settings: { timezone: 'Not/AZone' } }, now).today, '2026-10-20');
});

test('rate limit', () => {
  const ip = 'test-' + Math.random();
  for (let i = 0; i < 30; i++) assert.strictEqual(security.rateLimited('verify', ip), 0);
  assert.ok(security.rateLimited('verify', ip) > 0);
});
