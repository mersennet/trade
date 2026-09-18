import type { Metadata } from 'next';

// Route title (the root layout's template appends "· Mersennet Trade").
export const metadata: Metadata = { title: 'Testnet MRSN', description: 'Claim free testnet MRSN from the Mersennet faucet.' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
