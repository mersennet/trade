/**
 * Canonical bot wallet addresses derived from BOT_SEED.
 * Shared by the market-maker/taker bots (for signing) and by the indexer
 * (to exclude synthetic volume from leaderboard/points).
 */
const { ethers } = require('ethers');

const BOT_SEED = process.env.BOT_SEED || 'mersennet-bot-v1';
const NUM_TAKERS = Number(process.env.NUM_TAKERS || 20);

function deriveKey(label) {
  return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(`${BOT_SEED}:${label}`));
}

function deriveAddress(label) {
  return new ethers.Wallet(deriveKey(label)).address.toLowerCase();
}

function allBotAddresses() {
  const out = [deriveAddress('maker')];
  for (let i = 0; i < NUM_TAKERS; i++) out.push(deriveAddress(`taker-${i}`));
  return out;
}

module.exports = { BOT_SEED, NUM_TAKERS, deriveKey, deriveAddress, allBotAddresses };
