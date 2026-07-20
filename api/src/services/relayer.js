/**
 * Gasless relayer — retired.
 *
 * Previously submitted unsigned mersennet_orders_* RPCs as a system address.
 * That path is closed on the node (allow_unsigned_orders_rpc=false). Clients
 * must sign their own placeOrder/depositCollateral txs.
 */

async function submitGasless() {
  const err = new Error(
    'Gasless relayer is disabled; submit a wallet-signed placeOrder tx via eth_sendRawTransaction'
  );
  err.code = 'SIGNED_ORDER_REQUIRED';
  err.statusCode = 410;
  throw err;
}

module.exports = { submitGasless, RELAYER_ADDRESS: null };
