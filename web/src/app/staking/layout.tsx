import type { Metadata } from 'next';

// Route title (the root layout's template appends "· Mersennet Trade").
export const metadata: Metadata = { title: 'Staking & validators', description: 'Delegate MRSN, claim rewards and register your node in the open validator set.' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
