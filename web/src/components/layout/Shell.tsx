'use client';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import Sidebar from '@/components/layout/Sidebar';
import Header from '@/components/layout/Header';
import AnnouncementBar from '@/components/layout/AnnouncementBar';
import PreviewBanner from '@/components/shared/PreviewBanner';
import ErrorBoundary from '@/components/shared/ErrorBoundary';
import Footer from '@/components/beta/Footer';

/**
 * App column. On /trade the column is exactly one viewport tall so the
 * terminal (a flex-1 child) fills it whatever strips sit above it, and the
 * page scrolls inside <main>. Every other page keeps the normal document
 * scroll: when the whole app was made viewport-high (18 Sep) the staking page
 * "ended" at the fold for anyone scrolling with the keyboard or with the
 * pointer over the sidebar — the document had nothing to scroll, and only
 * <main> did.
 */
export default function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const terminal = pathname === '/trade' || pathname.startsWith('/trade/');
  return (
    <div className={cn('flex min-h-[100dvh]', terminal && 'md:h-[100dvh]')}>
      <Sidebar />
      <div className={cn('flex-1 min-w-0 flex flex-col md:ml-[52px] xl:ml-[180px]', terminal && 'md:min-h-0')}>
        {/* One header, one optional dismissible strip. The old beta banner is
            now a compact TESTNET pill inside the header. */}
        <Header />
        <AnnouncementBar />
        <main className={cn('page-glow flex-1 flex flex-col pb-[52px] md:pb-6', terminal && 'md:min-h-0 md:overflow-y-auto')}>
          <PreviewBanner />
          <ErrorBoundary>{children}</ErrorBoundary>
          <Footer />
        </main>
      </div>
    </div>
  );
}
