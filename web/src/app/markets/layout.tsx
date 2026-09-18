import type { Metadata } from 'next';

// Route title (the root layout's template appends "· Mersennet Trade").
export const metadata: Metadata = { title: 'Markets', description: 'Live perpetual markets on the Mersennet order book: prices, 24h volume and open interest.' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
