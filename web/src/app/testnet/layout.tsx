import type { Metadata } from 'next';

// Route title (the root layout's template appends "· Mersennet Trade").
export const metadata: Metadata = { title: 'Testnet guide', description: 'Everything you can test on the Mersennet public testnet, in one page.' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
