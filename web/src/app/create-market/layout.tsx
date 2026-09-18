import type { Metadata } from 'next';

// Route title (the root layout's template appends "· Mersennet Trade").
export const metadata: Metadata = { title: 'List a market', description: 'List a new perpetual market on the Mersennet order book.' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
