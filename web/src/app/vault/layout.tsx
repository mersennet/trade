import type { Metadata } from 'next';

// Route title (the root layout's template appends "· Mersennet Trade").
export const metadata: Metadata = { title: 'Maker Vault', description: 'Pool MRSN behind the market maker; shares track its PnL and earn LP points.' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
