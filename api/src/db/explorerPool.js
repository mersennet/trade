const { Pool } = require('pg');

// The block explorer's indexer keeps every transaction since genesis in the
// `mersennet_explorer` database on the same Postgres cluster (and therefore on
// the standby's replica too). The adoption metrics read it for the numbers the
// trade tables cannot give: wallets funded by the faucet, active senders per
// day, contracts deployed. EXPLORER_DATABASE_URL overrides; by default the
// trade URL with the database name swapped.
function explorerUrl() {
  if (process.env.EXPLORER_DATABASE_URL) return process.env.EXPLORER_DATABASE_URL;
  const base = process.env.DATABASE_URL || '';
  return base.replace(/\/[^/?]+(\?.*)?$/, '/mersennet_explorer$1');
}

const explorerPool = new Pool({
  connectionString: explorerUrl(),
  max: 4,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

explorerPool.on('error', (err) => {
  console.error('[explorer-db] Unexpected pool error:', err.message);
});

module.exports = explorerPool;
