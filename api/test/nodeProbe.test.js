const test = require('node:test');
const assert = require('node:assert/strict');
const { isPublicAddress, resolvePublic } = require('../src/services/nodeProbe');

test('only public unicast addresses are dialled', () => {
  for (const a of [
    '127.0.0.1', '10.0.0.5', '172.16.3.4', '192.168.1.1', '169.254.169.254', '100.64.1.1', '0.0.0.0',
    '224.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.2.10', '::', '::1', '::127.0.0.1', 'fe80::1',
    'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254', '64:ff9b::7f00:1', '2002:7f00:1::1', 'ff02::1',
  ]) {
    assert.equal(isPublicAddress(a), false, a);
  }
  for (const a of ['8.8.8.8', '46.225.30.187', '1.1.1.1', '2001:4860:4860::8888', '::ffff:8.8.8.8']) {
    assert.equal(isPublicAddress(a), true, a);
  }
  assert.equal(isPublicAddress('localhost'), false);
});

test('loopback and link-local in any spelling are refused before a connection', async () => {
  for (const h of [
    'localhost', 'lOcAlHoSt', 'localhost.', '127.0.0.1', '127.1', '2130706433', '0x7f000001', '0177.0.0.1',
    '0', '169.254.169.254', '10.0.0.5',
  ]) {
    await assert.rejects(resolvePublic(h), /public IP address|cannot resolve/, h);
  }
});

test('a public address resolves to itself and is what gets dialled', async () => {
  const r = await resolvePublic('8.8.8.8');
  assert.equal(r.address, '8.8.8.8');
  assert.equal(r.family, 4);
});
