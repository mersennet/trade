/**
 * Announcement bar content. Add an entry here to broadcast it; users can
 * dismiss each announcement individually (persisted by id), and the bar
 * rotates through the active set. Keep to 1-3 live items.
 */
export interface Announcement {
  id: string;
  text: string;
  link?: { href: string; label: string };
}

export const ANNOUNCEMENTS: Announcement[] = [
  {
    id: 'walletconnect-2026-08',
    text: 'WalletConnect is live — trade from any mobile wallet by scanning a QR code.',
    link: { href: '/trade', label: 'Try it' },
  },
  {
    id: 'privacy-fork-preview',
    text: 'Privacy hard fork preview: shielded balances and encrypted intents are anchored every block.',
    link: { href: '/trade', label: 'Learn more' },
  },
];
