/**
 * Print the deterministic bot wallet addresses (maker + N takers) for a given
 * BOT_SEED. Used to bake genesis native-MRSN funding and the indexer's
 * leaderboard/points exclusion list. Run: `node bot-addresses.js [numTakers]`.
 */
const { deriveKey, BOT_SEED } = require('./signer');
const { ethers } = require('ethers');

const numTakers = Number(process.argv[2] || 20);
const labels = ['maker', ...Array.from({ length: numTakers }, (_, i) => `taker-${i}`)];

const rows = labels.map((label) => {
  const wallet = new ethers.Wallet(deriveKey(label));
  return { label, address: wallet.address };
});

if (process.env.JSON === '1') {
  console.log(JSON.stringify(rows.map((r) => r.address)));
} else {
  console.log(`# BOT_SEED=${BOT_SEED}`);
  for (const r of rows) console.log(`${r.address}  ${r.label}`);
}
