import type { Metadata } from 'next';

// Route title (the root layout's template appends "· Mersennet Trade").
export const metadata: Metadata = { title: 'API', description: 'REST and WebSocket endpoints of the Mersennet Trade API.' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
