/**
 * Announcement bar content. Add an entry here to broadcast it; users can
 * dismiss each announcement individually (persisted by id); the bar shows
 * the newest undismissed one and does not rotate.
 */
import type { ClobProtocol } from '@/lib/api';

export interface Announcement {
  id: string;
  text: string;
  link?: { href: string; label: string };
  /**
   * Optional gate on live protocol state so an entry appears / disappears at
   * a consensus switch by itself (no deploy at the weekend). `p` is null
   * until the first /protocol answer; return false to hide until known.
   */
  showWhen?: (p: ClobProtocol | null) => boolean;
}

// One live item at a time: the bar shows the newest undismissed entry and
// never rotates (motion on a trading screen costs attention). Newest first.
export const ANNOUNCEMENTS: Announcement[] = [
  {
    // Appears by itself once the settlement switch has passed.
    id: 'settlement-live-2026-09-20',
    text: 'Settlement is live: collateral is real MRSN, realized PnL settles into your balance at every fill, 10% initial / 5% maintenance margin, and the Maker Vault is open for deposits.',
    link: { href: '/vault', label: 'Open the vault' },
    showWhen: (p) => !!p?.settlementActive,
  },
  {
    // Between the two switches (Sat evening → Sun afternoon).
    id: 'ticks-live-2026-09-19',
    text: 'One-click trading now runs on agent keys and MRSN, SOL and ARB trade on $0.01 ticks. Next: Sun 20 Sep ~16:00 UTC (block 1,605,600) collateral becomes real MRSN with 10% initial / 5% maintenance margin — positions larger than 20× your collateral at that block are closed by the keeper.',
    link: { href: '/staking', label: 'See the schedule' },
    showWhen: (p) => !!p?.agentDelegationActive && !p?.settlementActive,
  },
  {
    id: 'switch-weekend-2026-09-18',
    text: 'Two protocol switches this weekend — Sat 19 Sep ~19:00 UTC (block 1,569,600): agent keys for one-click trading and $0.01 ticks on MRSN, SOL, ARB. Sun 20 Sep ~16:00 UTC (block 1,605,600): collateral becomes real MRSN, realized PnL settles at every fill, 10% initial / 5% maintenance margin with liquidations. Deposits you make now carry over; a position larger than 20× your collateral at that block is closed by the keeper. Live countdown on the staking page.',
    link: { href: '/staking', label: 'See the schedule' },
    showWhen: (p) => !!p && !p.agentDelegationActive,
  },
  {
    id: 'vault-oneclick-2026-09-17',
    text: 'The Maker Vault opens Sun 20 Sep (block 1,605,600): pool MRSN behind the market maker, shares track its PnL, deposits earn LP points.',
    link: { href: '/vault', label: 'See the vault' },
    showWhen: (p) => !!p && !p.settlementActive,
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
