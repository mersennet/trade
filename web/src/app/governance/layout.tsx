import type { Metadata } from 'next';

// Roadmap preview (see config/previewRoutes.ts): reachable by URL, not indexed.
export const metadata: Metadata = {
  title: 'Governance (preview)',
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
