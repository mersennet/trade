const FEE_TIERS = [
  { name: 'Base',     minVolume: 0,           makerFee: 0.0002,  takerFee: 0.0005 },
  { name: 'Bronze',   minVolume: 100_000,     makerFee: 0.00018, takerFee: 0.00045 },
  { name: 'Silver',   minVolume: 1_000_000,   makerFee: 0.00015, takerFee: 0.0004 },
  { name: 'Gold',     minVolume: 10_000_000,  makerFee: 0.0001,  takerFee: 0.00035 },
  { name: 'Platinum', minVolume: 50_000_000,  makerFee: 0.00005, takerFee: 0.0003 },
  { name: 'Diamond',  minVolume: 100_000_000, makerFee: 0,       takerFee: 0.00025 },
];

function getTierForVolume(volume) {
  let matched = FEE_TIERS[0];
  for (const tier of FEE_TIERS) {
    if (volume >= tier.minVolume) matched = tier;
  }
  return matched;
}

module.exports = { FEE_TIERS, getTierForVolume };
