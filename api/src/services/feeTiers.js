// Planned schedule (30-day volume tiers). The matching engine on the testnet
// charges no maker/taker fee — only the insurance-fund contribution on
// liquidations — so the terminal shows these as the planned schedule and
// estimates 0 for actual fees while FEES_CHARGED is false.
const FEE_TIERS = [
  { name: 'Base',     minVolume: 0,           makerFee: 0,       takerFee: 0.00035 },
  { name: 'Bronze',   minVolume: 100_000,     makerFee: 0,       takerFee: 0.0003 },
  { name: 'Silver',   minVolume: 1_000_000,   makerFee: 0,       takerFee: 0.00025 },
  { name: 'Gold',     minVolume: 10_000_000,  makerFee: 0,       takerFee: 0.0002 },
  { name: 'Platinum', minVolume: 50_000_000,  makerFee: 0,       takerFee: 0.00015 },
  { name: 'Diamond',  minVolume: 100_000_000, makerFee: 0,       takerFee: 0.0001 },
];
const FEES_CHARGED = process.env.FEES_CHARGED === '1';

function getTierForVolume(volume) {
  let matched = FEE_TIERS[0];
  for (const tier of FEE_TIERS) {
    if (volume >= tier.minVolume) matched = tier;
  }
  return matched;
}

module.exports = { FEE_TIERS, FEES_CHARGED, getTierForVolume };
