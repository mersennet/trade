const pool = require('../db/pool');

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

module.exports = { initBridgeTables };
