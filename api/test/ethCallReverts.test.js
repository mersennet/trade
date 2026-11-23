// eth_call reverts: nodes before the eth_call-errors release answer a reverted
// call with the revert bytes as the result, later nodes answer JSON-RPC error 3
// with the bytes in `error.data`. The precompile readers must behave the same
// against both, and a halt (or any other RPC failure) must still propagate.
const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

process.env.RPC_URL = 'http://node.test.invalid';

const REVERT = '0x08c379a0'
  + ethers.AbiCoder.defaultAbiCoder().encode(['string'], ['unknown market']).slice(2);
const CUSTOM = '0xdeadbeef' + '00'.repeat(31) + '07';

let mode = 'legacy';
let revertData = REVERT;
global.fetch = async (_url, opts) => {
  const { id, method } = JSON.parse(opts.body);
  const reply = (body) => ({ json: async () => ({ jsonrpc: '2.0', id, ...body }) });
  if (method !== 'eth_call') return reply({ result: [] });
  if (mode === 'legacy') return reply({ result: revertData });
  if (mode === 'error') {
    const reason = revertData === REVERT ? ': unknown market' : '';
    return reply({ error: { code: 3, message: `execution reverted${reason}`, data: revertData } });
  }
  if (mode === 'halt') return reply({ error: { code: -32000, message: 'out of gas' } });
  // A successful getPosition: size -3, entry price 100.
  return reply({ result: ethers.AbiCoder.defaultAbiCoder().encode(['int128', 'uint256'], [-3n, 100n]) });
};

const chain = require('../src/services/chain');
const ADDR = '0x00000000000000000000000000000000000000aa';

for (const data of [REVERT, CUSTOM, '0x']) {
  test(`a reverted read (${data.slice(0, 10)}) gives the same answer on old and new nodes`, async () => {
    revertData = data;
    mode = 'legacy';
    const legacy = [await chain.getPosition(1, ADDR), await chain.getCollateralRaw(ADDR), await chain.getBestBidAsk(1), await chain.isLiquidatable(1, ADDR)];
    mode = 'error';
    const errors = [await chain.getPosition(1, ADDR), await chain.getCollateralRaw(ADDR), await chain.getBestBidAsk(1), await chain.isLiquidatable(1, ADDR)];
    assert.deepEqual(errors, legacy);
    assert.equal(errors[0].sizeRaw, '0', 'a refused position read is flat');
    assert.equal(errors[1], '0', 'a refused collateral read is zero');
  });
}

test('ethCall hands back the revert bytes of a code-3 error as the result', async () => {
  revertData = REVERT;
  mode = 'error';
  assert.equal(await chain.ethCall('0x12345678', ADDR), REVERT);
});

test('a halt still propagates as an RPC failure', async () => {
  mode = 'halt';
  await assert.rejects(chain.getPosition(1, ADDR), (e) => e.rpcCode === -32000 && /out of gas/.test(e.message) && e.upstream === true);
  await assert.rejects(chain.ethCall('0x12345678', ADDR), /out of gas/);
});

test('a successful read is decoded as before', async () => {
  mode = 'ok';
  const pos = await chain.getPosition(1, ADDR);
  assert.equal(pos.sizeRaw, '-3');
  assert.equal(pos.entryPriceRaw, '100');
});
