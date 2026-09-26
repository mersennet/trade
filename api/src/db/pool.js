const { Pool } = require('pg');

// No built-in fallback: a default credential in source is a credential in
// every clone (the one that used to live here was the live password until
// 26 Sep 2026). docker-compose.yml derives DATABASE_URL from POSTGRES_PASSWORD.
// Loud at require time, fatal at first query (pg falls back to PG* env vars
// and fails to connect), so `require()`-only checks such as CI's module-load
// step and unit tests still work without a database.
if (!process.env.DATABASE_URL) {
  console.error('[db] DATABASE_URL is not set (postgresql://user:password@host:5432/mersennet_trade); every query will fail');
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[db] Unexpected pool error:', err.message);
});

module.exports = pool;
