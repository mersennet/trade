/**
 * Announcement bar content. Add an entry here to broadcast it; users can
 * dismiss each announcement individually (persisted by id); the bar shows
 * the newest undismissed one and does not rotate.
 */
export interface Announcement {
  id: string;
  text: string;
  link?: { href: string; label: string };
}

// One live item at a time: the bar shows the newest undismissed entry and
// never rotates (motion on a trading screen costs attention). Newest first.
export const ANNOUNCEMENTS: Announcement[] = [
  {
    id: 'switch-weekend-2026-09-18',
    text: 'Two protocol switches this weekend — Sat 19 Sep ~19:00 UTC (block 1,569,600): agent keys for one-click trading and $0.01 ticks on MRSN, SOL, ARB. Sun 20 Sep ~16:00 UTC (block 1,605,600): collateral becomes real MRSN, realized PnL settles at every fill, 10% initial / 5% maintenance margin with liquidations. Deposits you make now carry over; a position larger than 20× your collateral at that block is closed by the keeper. Live countdown on the staking page.',
    link: { href: '/staking', label: 'See the schedule' },
  },
  {
    id: 'vault-oneclick-2026-09-17',
    text: 'The Maker Vault opens Sun 20 Sep (block 1,605,600): pool MRSN behind the market maker, shares track its PnL, deposits earn LP points.',
    link: { href: '/vault', label: 'See the vault' },
  },
  {
    id: 'validators-open-2026-09',
    text: 'The validator set is open — run a node in one command, bond 1,000 MRSN and produce blocks from the next epoch. Node runners earn 500 points a day.',
    link: { href: '/staking', label: 'Become a validator' },
  },
  {
    id: 'staking-live-2026-08',
    text: 'Delegated staking is live — delegate MRSN to a validator and earn block rewards.',
    link: { href: '/staking', label: 'Stake now' },
  },
  {
    id: 'walletconnect-2026-08',
    text: 'WalletConnect is live — trade from any mobile wallet by scanning a QR code.',
    link: { href: '/trade', label: 'Try it' },
  },
];
