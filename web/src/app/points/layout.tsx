import type { Metadata } from 'next';

// Route title (the root layout's template appends "· Mersennet Trade").
export const metadata: Metadata = { title: 'Points', description: 'Season 1 points for trading, running a verified node, maker-vault deposits and referrals.' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
