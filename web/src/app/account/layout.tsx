import type { Metadata } from 'next';

// Route title (the root layout's template appends "· Mersennet Trade").
export const metadata: Metadata = { title: 'Account summary', description: 'What a wallet has made or lost on every Mersennet product, in MRSN and dollars.' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
