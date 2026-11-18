const test = require('node:test');
const assert = require('node:assert/strict');
const { Wallet, verifyMessage } = require('ethers');
const { creationMessage, parseCodeRequest } = require('../src/routes/builderCodes');

const OWNER = '0x0f3bfb89038900ad0d94eaa5085664a5d0cb90fa';

test('a code request needs a real owner, a 2-32 character code and a one-line label', () => {
  for (const bad of [
    { owner: '0x', code: 'abc' },
    { owner: 'notanaddr', code: 'abc' },
    { owner: '0x5a17fd318bd2e7cbcdecb00b9e1c9905', code: 'abc' },
    { owner: `${OWNER}' or '1'='1`, code: 'abc' },
    { owner: OWNER, code: 'a' },
    { owner: OWNER, code: 'x'.repeat(33) },
    { owner: OWNER, code: "c' or '1'='1" },
    { owner: OWNER, code: 'ok', label: 'mine\nOwner: 0xdead' },
    { owner: OWNER, code: 'ok', label: 'y'.repeat(41) },
  ]) {
    assert.ok(parseCodeRequest(bad).error, JSON.stringify(bad));
  }
  assert.deepEqual(parseCodeRequest({ owner: OWNER.toUpperCase().replace('0X', '0x'), code: 'my-code_1', label: ' Desk ' }),
    { owner: OWNER, code: 'my-code_1', label: 'Desk' });
  assert.match(parseCodeRequest({ owner: OWNER }).code, /^[0-9a-f]{8}$/);
});

test('the signature binds owner, code, label and time', async () => {
  const w = Wallet.createRandom();
  const owner = w.address.toLowerCase();
  const msg = creationMessage(owner, 'mycode', 'My desk', 1_795_000_000_000);
  const sig = await w.signMessage(msg);
  assert.equal(verifyMessage(msg, sig).toLowerCase(), owner);
  for (const other of [
    creationMessage(owner, 'othercode', 'My desk', 1_795_000_000_000),
    creationMessage(owner, 'mycode', 'Other label', 1_795_000_000_000),
    creationMessage(owner, 'mycode', 'My desk', 1_795_000_000_001),
    creationMessage(OWNER, 'mycode', 'My desk', 1_795_000_000_000),
  ]) {
    assert.notEqual(verifyMessage(other, sig).toLowerCase(), owner);
  }
});
