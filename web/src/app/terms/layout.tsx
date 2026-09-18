import type { Metadata } from 'next';

// Route title (the root layout's template appends "· Mersennet Trade").
export const metadata: Metadata = { title: 'Terms of use', description: 'Terms of use of the Mersennet Trade testnet terminal.' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
