import type { Metadata } from 'next';

// Route title (the root layout's template appends "· Mersennet Trade").
export const metadata: Metadata = { title: 'Referrals', description: 'Invite traders and earn a share of their points.' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
