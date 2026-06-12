const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://mersennet:m3rs3nn3t_db_2026@127.0.0.1:5432/mersennet_trade',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[db] Unexpected pool error:', err.message);
});

module.exports = pool;
