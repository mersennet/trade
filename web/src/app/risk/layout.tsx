import type { Metadata } from 'next';

// Route title (the root layout's template appends "· Mersennet Trade").
export const metadata: Metadata = { title: 'Risk disclosure', description: 'Risks of using the Mersennet Trade testnet terminal.' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
