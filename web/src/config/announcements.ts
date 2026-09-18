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
    id: 'vault-oneclick-2026-09-17',
    text: 'New: the maker vault is live — pool MRSN behind the market maker and earn LP points. On 19 Sep (block 1,569,600) one-click trading moves to agent keys and MRSN, SOL and ARB switch to $0.01 ticks.',
    link: { href: '/vault', label: 'Open the vault' },
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
