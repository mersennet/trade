/**
 * Announcement bar content. Add an entry here to broadcast it; users can
 * dismiss each announcement individually (persisted by id); the bar shows
 * the newest undismissed one and does not rotate.
 */
import type { ClobProtocol } from '@/lib/api';

export interface Announcement {
  id: string;
  /** Optional bold, upper-case lead-in before the text ("Next protocol upgrade:") so a time-critical line pops. */
  lead?: string;
  text: string;
  link?: { href: string; label: string };
  /**
   * Optional gate on live protocol state so an entry appears / disappears at
   * a consensus switch by itself (no deploy at the weekend). `p` is null
   * until the first /protocol answer; return false to hide until known.
   * `armed` holds the heights of the switches the network's nodes have
   * configured (from /protocol/switches), so an entry can wait until a
   * release that arms its switch is actually running.
   */
  showWhen?: (p: ClobProtocol | null, armed: Set<number>) => boolean;
}

// One live item at a time: the bar shows the newest undismissed entry and
// never rotates (motion on a trading screen costs attention). Newest first.
export const ANNOUNCEMENTS: Announcement[] = [
  {
    // The day after the MRSN/USD repair (block 2,324,700).
    id: 'mrsn-repaired-2026-10-08',
    text: 'MRSN/USD is repaired: orders at the broken prices were cancelled and positions opened at them were reset to $115. Trading is back to normal.',
    showWhen: (p) => !!p && p.height >= 2324700 && p.height < 2324700 + 43_200,
  },
  {
    // From the 6 Oct sweep until the repair.
    id: 'mrsn-repair-2026-10-08',
    lead: 'MRSN/USD:',
    text: 'the market has been stuck around $16,500 since one order swept its book on 6 Oct, so accounts holding MRSN/USD can\'t place orders or withdraw. The network repairs it on {eta:2324700}: orders at the broken prices are cancelled and positions opened at them are reset to $115. No positions were liquidated; Maker Vault deposits are paused until then.',
    showWhen: (p) => !!p && p.height < 2324700,
  },
  {
    // After the 3 Oct switch.
    id: 'validators-50-live-2026-10-03',
    text: 'The validator set now has 50 slots: register a node with 1,000 MRSN self-stake and it produces blocks from the next hourly epoch. Node runners earn 500 points a day.',
    link: { href: '/staking', label: 'Become a validator' },
    showWhen: (p) => !!p && p.height >= 2127600,
  },
  {
    // Appears once the fleet runs the 30 Sep release (which arms block 2,127,600), until the switch.
    id: 'switch-2026-10-03',
    lead: 'Next protocol upgrade:',
    text: '{eta:2127600} — the validator set grows from 12 to 50 slots, so every registered validator with the minimum self-stake produces blocks. Validators: upgrade to the 30 Sep release before that block.',
    link: { href: 'https://explorer.mersennet.com/upgrades', label: 'Upgrade schedule' },
    showWhen: (p, armed) => !!p && armed.has(2127600) && p.height < 2127600,
  },
  {
    // After the 29 Sep switch: the two changes, past tense. Hides itself until then.
    id: 'fees-reasons-live-2026-09-29',
    text: 'Live since block 1,969,200: a refused order now tells you why (on chain and in eth_call) and costs 20k gas instead of the whole limit; the base fee has a 1 gwei floor — a trade costs about 0.00007 MRSN, half of every block\'s fees fund the protocol treasury, a quarter pays the block proposer, a quarter is burned.',
    link: { href: 'https://docs.mersennet.com/architecture/tokenomics/#transaction-fees', label: 'How fees work' },
    showWhen: (p) => !!p?.revertReasonsActive && !!p?.fees?.active,
  },
  {
    // Until the 29 Sep switch.
    id: 'switch-2026-09-29',
    lead: 'Next protocol upgrade:',
    text: '{eta:1969200} — refused orders return their reason and charge 20k gas instead of the whole limit, and the base fee gets a 1 gwei floor (about 0.00007 MRSN per trade; 50% treasury / 25% proposer / 25% burned). Validators: upgrade to release 9be4f83 before that block.',
    link: { href: 'https://explorer.mersennet.com/upgrades', label: 'Upgrade schedule' },
    showWhen: (p) => !!p && !!p.switches?.feeFloorHeight && !(p.fees?.active),
  },
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
    text: 'One-click trading now runs on agent keys and MRSN, SOL and ARB trade on $0.01 ticks. Next upgrade {eta:1605600}: collateral becomes real MRSN with 10% initial / 5% maintenance margin — positions larger than 20× your collateral at that block are closed by the keeper.',
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
    text: 'The Maker Vault opens at the next upgrade, {eta:1605600}: pool MRSN behind the market maker, shares track its PnL, deposits earn LP points.',
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
