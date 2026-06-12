const pool = require('../db/pool');

const SUPPORTED_CHAINS = [
  {
    name: 'Ethereum',
    chainId: 1,
    rpcUrl: 'https://eth.llamarpc.com',
    depositAddress: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
    confirmations: 12,
    nativeSymbol: 'ETH',
  },
  {
    name: 'Arbitrum',
    chainId: 42161,
    rpcUrl: 'https://arb1.arbitrum.io/rpc',
    depositAddress: '0xB27308f9F90D607463bb33eA1BeBb41C27CE5AB6',
    confirmations: 1,
    nativeSymbol: 'ETH',
  },
  {
    name: 'Base',
    chainId: 8453,
    rpcUrl: 'https://mainnet.base.org',
    depositAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    confirmations: 2,
    nativeSymbol: 'ETH',
  },
  {
    name: 'Solana',
    chainId: null,
    rpcUrl: 'https://api.mainnet-beta.solana.com',
    depositAddress: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
    confirmations: 32,
    nativeSymbol: 'SOL',
  },
];

async function initBridgeTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bridge_deposits (
      id SERIAL PRIMARY KEY,
      source_chain TEXT NOT NULL,
      source_chain_id INTEGER,
      source_tx_hash TEXT UNIQUE NOT NULL,
      depositor TEXT NOT NULL,
      asset TEXT NOT NULL,
      amount NUMERIC NOT NULL,
      confirmations INTEGER DEFAULT 0,
      required_confirmations INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      credited BOOLEAN DEFAULT FALSE,
      detected_at TIMESTAMP DEFAULT NOW(),
      confirmed_at TIMESTAMP,
      credited_at TIMESTAMP
    )
  `);
}

module.exports = { initBridgeTables, SUPPORTED_CHAINS };
