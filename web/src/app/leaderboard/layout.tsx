import type { Metadata } from 'next';

// Route title (the root layout's template appends "· Mersennet Trade").
export const metadata: Metadata = { title: 'Leaderboard', description: 'Traders ranked by PnL and volume, Season 1 points and the weekly sprint.' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
