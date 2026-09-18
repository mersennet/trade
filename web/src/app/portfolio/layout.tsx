import type { Metadata } from 'next';

// Route title (the root layout's template appends "· Mersennet Trade").
export const metadata: Metadata = { title: 'Portfolio', description: 'Your positions, collateral, margin and equity curve, read from the Mersennet chain.' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
