const chain = require('./chain');

const RELAYER_ADDRESS = '0x0000000000000000000000000000000000000001';

async function submitGasless(orderParams) {
  return chain.submitOrder({
    ...orderParams,
    owner: orderParams.owner || RELAYER_ADDRESS,
  });
}

module.exports = { submitGasless, RELAYER_ADDRESS };
