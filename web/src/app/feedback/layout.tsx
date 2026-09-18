import type { Metadata } from 'next';

// Route title (the root layout's template appends "· Mersennet Trade").
export const metadata: Metadata = { title: 'Feedback', description: 'Report a bug or request a feature on the Mersennet testnet.' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
